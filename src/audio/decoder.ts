export interface DecodedAudio {
  buffer: AudioBuffer;
  duration: number;
  sampleRate: number;
  channels: number;
}

export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  const offlineCtx = new OfflineAudioContext(1, 1, 44100);
  const buffer = await offlineCtx.decodeAudioData(arrayBuffer);

  return {
    buffer,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
  };
}

export function trimAudioBuffer(buffer: AudioBuffer, start: number, end: number): AudioBuffer {
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const length = Math.max(1, Math.round((end - start) * sampleRate));
  const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate });

  const offset = Math.floor(start * sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const s = offset + i;
      dst[i] = s < src.length ? src[s] : 0;
    }
  }
  return out;
}
