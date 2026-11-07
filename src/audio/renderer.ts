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
): Promise<Blob> {
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const trimDuration = trimEnd - trimStart;
  const trimLength = Math.ceil(trimDuration * sampleRate);

  const offlineCtx = new OfflineAudioContext(channels, trimLength, sampleRate);

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

  // Sample-accurate automation for offline: use setValueCurveAtTime (per-sample)
  // to avoid the 5ms step / 7ms ramp quantisation that caused transients on
  // lowpass sweeps during export (vs smooth playback). Playback keeps the
  // coarse ramps for real-time performance; offline can afford per-sample.
  if (trimLength > 0) {
    const freqCurve = new Float32Array(trimLength);
    for (let i = 0; i < trimLength; i++) {
      const t = i / sampleRate;
      freqCurve[i] = Math.max(1, evaluateAutomation(points, t, interpolate));
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
          const freq = freqCurve[Math.min(Math.floor(t * sampleRate), freqCurve.length - 1)];
          filter.frequency.exponentialRampToValueAtTime(freq, t + rampDuration);
        }
      }
    }

    if (volumePoints && volumePoints.length > 0) {
      const gainCurve = new Float32Array(trimLength);
      for (let i = 0; i < trimLength; i++) {
        const t = i / sampleRate;
        gainCurve[i] = Math.max(0, Math.min(2, evaluateVolumeAutomation(volumePoints, t, interpolateVolume)));
      }
      // @ts-ignore
      if (typeof (volumeGain.gain as any).setValueCurveAtTime === 'function') {
        (volumeGain.gain as any).setValueCurveAtTime(gainCurve, 0, trimDuration);
      } else {
        const step = 0.005;
        const rampDuration = 0.007;
        volumeGain.gain.setValueAtTime(gainCurve[0], 0);
        for (let t = step; t <= trimDuration; t += step) {
          const gain = gainCurve[Math.min(Math.floor(t * sampleRate), gainCurve.length - 1)];
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

  return audioBufferToWav(renderedBuffer);
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1;
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const dataLength = buffer.length * blockAlign;
  const bufferLength = 44 + dataLength;

  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, bufferLength - 8, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  const channels: Float32Array[] = [];
  for (let i = 0; i < numChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      // Clamp: the limiter above keeps peaks under 1.0, but never trust float
      // for int16 — an unclamped over-1.0 sample wraps around in setInt16
      // (e.g. 1.1 -> large negative), a full-scale single-sample pop/static.
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
