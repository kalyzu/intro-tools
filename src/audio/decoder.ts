export interface DecodedAudio {
  buffer: AudioBuffer;
  duration: number;
  sampleRate: number;
  channels: number;
}

export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();
  const buffer = await audioContext.decodeAudioData(arrayBuffer);
  audioContext.close();

  return {
    buffer,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
  };
}
