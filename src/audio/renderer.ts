import type { AutomationPoint } from '../automation/model';
import type { VolumePoint } from '../automation/volume-model';
import type { ReverbPoint } from '../automation/reverb-model';
import type { FilterSlope } from './filter';
import { createFilterChain, createSafetyLimiter } from './filter';
import { createReverbChain, reverbMixGains, type ReverbSettings } from './reverb';
import { evaluateAutomation } from '../automation/model';
import { evaluateVolumeAutomation } from '../automation/volume-model';
import { evaluateReverbAutomation, getReverbMixRange } from '../automation/reverb-model';
import { interpolate } from '../automation/interpolation';
import { interpolateVolume } from '../automation/volume-interpolation';

export interface RenderProgress {
  progress: number;
}

// MP3 supports a fixed set of sample rates. Rendering at one of them lets the
// browser resample natively (only when the source uses an unsupported rate)
// instead of making the encoder handle an invalid rate.
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000] as const;

// Cap the automation curves at ~240k points. setValueCurveAtTime interpolates
// between points at audio rate, so 1 ms resolution is already far finer than a
// filter sweep needs. Building one value per sample instead costs tens of
// millions of function calls (16+ s for a 4 minute clip) and freezes the UI.
const MAX_CURVE_POINTS = 240_000;
const MIN_CURVE_STEP = 0.001;

function toMp3SampleRate(sampleRate: number): number {
  for (let i = MP3_SAMPLE_RATES.length - 1; i >= 0; i--) {
    if (MP3_SAMPLE_RATES[i] <= sampleRate) return MP3_SAMPLE_RATES[i];
  }
  return MP3_SAMPLE_RATES[0];
}

/**
 * Renders the filtered clip offline and returns the raw samples, ready for
 * encoding. The result uses an MP3-supported sample rate and at most 2
 * channels so the encoder can consume it directly.
 */
export async function renderOffline(
  buffer: AudioBuffer,
  points: AutomationPoint[],
  volumePoints: VolumePoint[] | null,
  reverbPoints: ReverbPoint[],
  slope: FilterSlope,
  reverb: ReverbSettings,
  trimStart: number,
  trimEnd: number,
  onProgress?: (p: RenderProgress) => void
): Promise<AudioBuffer> {
  const sampleRate = toMp3SampleRate(buffer.sampleRate);
  // MP3 is mono or stereo. If the source has more channels, let the offline
  // context fold them down instead of allocating/encoding channels that would
  // be discarded.
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const trimDuration = trimEnd - trimStart;
  const trimLength = Math.ceil(trimDuration * sampleRate);

  const offlineCtx = new OfflineAudioContext(channels, trimLength, sampleRate);

  // Report real render progress by suspending the offline graph at a few
  // checkpoints. Rendering runs faster than real time and exposes no progress
  // events, so without this the bar could only jump from 0 to 100.
  if (onProgress && trimDuration > 0.25 && typeof offlineCtx.suspend === 'function') {
    const steps = 20;
    try {
      for (let i = 1; i < steps; i++) {
        const at = (i / steps) * trimDuration;
        offlineCtx
          .suspend(at)
          .then(() => {
            try {
              onProgress({ progress: i / steps });
            } finally {
              void offlineCtx.resume();
            }
          })
          .catch(() => {
            // Ignore: progress reporting is best-effort and must never break
            // the actual export.
          });
      }
    } catch {
      // Same: fall back to no intermediate render progress.
    }
  }

  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;

  const filters = createFilterChain(offlineCtx, slope);
  const lastFilter = filters[filters.length - 1];

  const volumeGain = offlineCtx.createGain();
  // Static headroom ~-2.5 dBFS (0.75) matches playback. It alone cannot cover
  // filter overshoot on hot masters (measured up to ~1.9x on drum transients
  // during fade-out sweeps), so the shared safety limiter catches spikes that
  // would otherwise exceed 1.0 and wrap around int16 below (pop/static).
  const outputGain = offlineCtx.createGain();
  outputGain.gain.value = 0.75; // -2.5 dB
  const limiter = createSafetyLimiter(offlineCtx);
  const fadeGain = offlineCtx.createGain();
  fadeGain.gain.value = 1;

  source.connect(filters[0]);
  lastFilter.connect(volumeGain);
  const reverbActive = getReverbMixRange(reverbPoints).max > 0;
  const reverbChain = reverbActive
    ? createReverbChain(offlineCtx, reverb, evaluateReverbAutomation(reverbPoints, 0))
    : null;
  if (reverbChain) {
    volumeGain.connect(reverbChain.input);
    reverbChain.output.connect(outputGain);
  } else {
    volumeGain.connect(outputGain);
  }
  outputGain.connect(limiter);
  limiter.connect(fadeGain);
  fadeGain.connect(offlineCtx.destination);

  // High-resolution automation for offline: setValueCurveAtTime interpolates
  // between points at audio rate, avoiding the 5ms step / 7ms ramp quantisation
  // that caused transients on lowpass sweeps during export (vs smooth playback).
  // 1 ms breakpoints are inaudibly close to per-sample while keeping generation
  // fast enough that the export UI can paint before the render starts.
  if (trimLength > 0) {
    const curvePoints = Math.max(
      2,
      Math.min(trimLength, MAX_CURVE_POINTS, Math.ceil(trimDuration / MIN_CURVE_STEP) + 1)
    );
    const curveStep = trimDuration / (curvePoints - 1);

    const freqCurve = new Float32Array(curvePoints);
    for (let i = 0; i < curvePoints; i++) {
      freqCurve[i] = Math.max(1, evaluateAutomation(points, i * curveStep, interpolate));
    }
    for (const filter of filters) {
      // @ts-ignore - setValueCurveAtTime is available on OfflineAudioContext
      if (typeof (filter.frequency as any).setValueCurveAtTime === 'function') {
        (filter.frequency as any).setValueCurveAtTime(freqCurve, 0, trimDuration);
      } else {
        // Fallback to coarse ramps if curve not available
        const step = 0.005;
        const rampDuration = 0.007;
        filter.frequency.setValueAtTime(freqCurve[0], 0);
        for (let t = step; t <= trimDuration; t += step) {
          const freq = freqCurve[Math.min(Math.floor(t / curveStep), curvePoints - 1)];
          filter.frequency.exponentialRampToValueAtTime(freq, t + rampDuration);
        }
      }
    }

    if (volumePoints && volumePoints.length > 0) {
      const gainCurve = new Float32Array(curvePoints);
      for (let i = 0; i < curvePoints; i++) {
        gainCurve[i] = Math.max(0, Math.min(2, evaluateVolumeAutomation(volumePoints, i * curveStep, interpolateVolume)));
      }
      // @ts-ignore
      if (typeof (volumeGain.gain as any).setValueCurveAtTime === 'function') {
        (volumeGain.gain as any).setValueCurveAtTime(gainCurve, 0, trimDuration);
      } else {
        const step = 0.005;
        const rampDuration = 0.007;
        volumeGain.gain.setValueAtTime(gainCurve[0], 0);
        for (let t = step; t <= trimDuration; t += step) {
          const gain = gainCurve[Math.min(Math.floor(t / curveStep), curvePoints - 1)];
          volumeGain.gain.linearRampToValueAtTime(gain, t + rampDuration);
        }
      }
    } else {
      volumeGain.gain.setValueAtTime(1, 0);
    }

    if (reverbChain) {
      // Mix automation is smooth and does not need per-sample resolution, so
      // keep the curve at 5 ms. Per-sample arrays would cost hundreds of MB
      // for long clips on top of the filter and volume curves.
      const curveSteps = Math.max(1, Math.ceil(trimDuration / 0.005));
      const dryCurve = new Float32Array(curveSteps + 1);
      const wetCurve = new Float32Array(curveSteps + 1);
      for (let i = 0; i <= curveSteps; i++) {
        const time = (i / curveSteps) * trimDuration;
        const gains = reverbMixGains(evaluateReverbAutomation(reverbPoints, time));
        dryCurve[i] = gains.dry;
        wetCurve[i] = gains.wet;
      }
      // @ts-ignore - setValueCurveAtTime is available on OfflineAudioContext
      reverbChain.dryGain.gain.setValueCurveAtTime(dryCurve, 0, trimDuration);
      // @ts-ignore
      reverbChain.wetGain.gain.setValueCurveAtTime(wetCurve, 0, trimDuration);
    }
  } else {
    volumeGain.gain.setValueAtTime(1, 0);
  }

  // De-click fade (matches playback's fadeGain): 10 ms to cover 300Hz 48dB settle (~7.8ms)
  const fadeSec = 0.01;
  fadeGain.gain.setValueAtTime(0, 0);
  fadeGain.gain.linearRampToValueAtTime(1, fadeSec);
  if (trimDuration > fadeSec * 2) {
    fadeGain.gain.setValueAtTime(1, trimDuration - fadeSec);
    fadeGain.gain.linearRampToValueAtTime(0, trimDuration);
  } else {
    fadeGain.gain.setValueAtTime(1, fadeSec);
    fadeGain.gain.linearRampToValueAtTime(0, trimDuration);
  }

  // The render is exactly as long as the trim, so the reverb tail cannot ring
  // past the end. Fade only the wet path over the last 250 ms; the dry signal
  // keeps its normal 10 ms de-click fade.
  if (reverbChain && trimDuration > 0) {
    const wetFade = Math.min(0.25, trimDuration * 0.5);
    reverbChain.tailGain.gain.setValueAtTime(1, trimDuration - wetFade);
    reverbChain.tailGain.gain.linearRampToValueAtTime(0, trimDuration);
  }

  source.start(0, trimStart);

  const renderedBuffer = await offlineCtx.startRendering();

  if (onProgress) {
    onProgress({ progress: 1 });
  }

  return renderedBuffer;
}
