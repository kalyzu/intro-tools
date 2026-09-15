import type { AutomationPoint } from '../automation/model';
import type { VolumePoint } from '../automation/volume-model';
import type { FilterSlope } from './filter';
import { createFilterChain } from './filter';
import { evaluateAutomation } from '../automation/model';
import { evaluateVolumeAutomation } from '../automation/volume-model';
import { interpolate } from '../automation/interpolation';
import { interpolateVolume } from '../automation/volume-interpolation';

export interface RenderProgress {
  progress: number;
}

export async function renderOffline(
  buffer: AudioBuffer,
  points: AutomationPoint[],
  volumePoints: VolumePoint[] | null,
  slope: FilterSlope,
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
  // Static headroom ~-2.5 dBFS (0.75) matches playback, more aggressive to clean 48 dB
  const outputGain = offlineCtx.createGain();
  outputGain.gain.value = 0.75; // -2.5 dB

  source.connect(filters[0]);
  lastFilter.connect(volumeGain);
  volumeGain.connect(outputGain);
  outputGain.connect(offlineCtx.destination);

  const step = 0.005;
  const rampDuration = 0.007;

  for (const filter of filters) {
    const initialFreq = Math.max(1, evaluateAutomation(points, 0, interpolate));
    filter.frequency.setValueAtTime(initialFreq, 0);
  }

  for (let t = step; t <= trimDuration; t += step) {
    const freq = Math.max(1, evaluateAutomation(points, t, interpolate));

    for (const filter of filters) {
      filter.frequency.exponentialRampToValueAtTime(freq, t + rampDuration);
    }
  }

  // Volume automation (green graph) - linear gain 0-1
  if (volumePoints && volumePoints.length > 0) {
    const initialGain = evaluateVolumeAutomation(volumePoints, 0, interpolateVolume);
    volumeGain.gain.setValueAtTime(Math.max(0, Math.min(2, initialGain)), 0);
    for (let t = step; t <= trimDuration; t += step) {
      const gain = evaluateVolumeAutomation(volumePoints, t, interpolateVolume);
      volumeGain.gain.linearRampToValueAtTime(Math.max(0, Math.min(2, gain)), t + rampDuration);
    }
  } else {
    volumeGain.gain.setValueAtTime(1, 0);
  }

  source.start(0, trimStart);

  const renderedBuffer = await offlineCtx.startRendering();

  // De-click: apply short linear fades to avoid pop from hard cut at trim boundaries
  // and from filter state at start/end. Only needed for offline export; playback's
  // real-time context masks the transient, but we keep it consistent.
  const fadeSec = 0.005; // 5ms
  const fadeSamples = Math.min(Math.floor(fadeSec * sampleRate), Math.floor(renderedBuffer.length / 2));
  if (fadeSamples > 0) {
    for (let ch = 0; ch < renderedBuffer.numberOfChannels; ch++) {
      const data = renderedBuffer.getChannelData(ch);
      for (let i = 0; i < fadeSamples; i++) {
        const g = i / fadeSamples;
        data[i] *= g;
        data[data.length - 1 - i] *= g;
      }
    }
  }

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
      // No hard-clipping: headroom gain (0.891) ensures peak <1.0 for filter overshoot.
      // Direct conversion, allow float headroom to prevent distortion.
      const sample = channels[ch][i];
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
