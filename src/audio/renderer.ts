import type { AutomationPoint } from '../automation/model';
import type { FilterSlope } from './filter';
import { createFilterChain } from './filter';
import { evaluateAutomation } from '../automation/model';
import { interpolate } from '../automation/interpolation';

export interface RenderProgress {
  progress: number;
}

export async function renderOffline(
  buffer: AudioBuffer,
  points: AutomationPoint[],
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

  source.connect(filters[0]);
  lastFilter.connect(offlineCtx.destination);

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
