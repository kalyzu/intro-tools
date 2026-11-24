/// <reference lib="webworker" />

import { Mp3Encoder } from '@breezystack/lamejs';

interface EncodeRequest {
  channels: Float32Array[];
  sampleRate: number;
  bitrate: number;
}

type EncodeResponse =
  | { type: 'progress'; progress: number }
  | { type: 'done'; blob: Blob }
  | { type: 'error'; message: string };

// 32 MP3 frames (~0.8 s at 44.1 kHz) per call. Larger chunks keep the JS/C++
// boundary overhead low, while still giving the UI frequent progress updates.
const CHUNK_FRAMES = 1152 * 32;

function toInt16(source: Float32Array, start: number, end: number): Int16Array {
  const out = new Int16Array(end - start);
  for (let i = start, j = 0; i < end; i++, j++) {
    // Clamp before scaling: an out-of-range Float32 sample would otherwise wrap
    // around when stored as int16 (e.g. 1.1 -> a full-scale negative pop).
    const sample = source[i];
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    out[j] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const post = (message: EncodeResponse) => workerScope.postMessage(message);

  try {
    const { channels, sampleRate, bitrate } = event.data;
    const channelCount = Math.min(2, channels.length);
    const encoder = new Mp3Encoder(channelCount, sampleRate, bitrate);

    const total = channels[0].length;
    const chunkCount = Math.ceil(total / CHUNK_FRAMES);
    // Cap UI updates at roughly 100 messages regardless of clip length.
    const updateEvery = Math.max(1, Math.floor(chunkCount / 100));
    const chunks: BlobPart[] = [];

    const left = channels[0];
    const right = channelCount > 1 ? channels[1] : null;

    for (let chunk = 0, offset = 0; offset < total; chunk++, offset += CHUNK_FRAMES) {
      const end = Math.min(offset + CHUNK_FRAMES, total);
      const leftChunk = toInt16(left, offset, end);
      const encoded = right
        ? encoder.encodeBuffer(leftChunk, toInt16(right, offset, end))
        : encoder.encodeBuffer(leftChunk);
      if (encoded.length > 0) chunks.push(encoded as unknown as BlobPart);

      if (chunk % updateEvery === 0 || end === total) {
        post({ type: 'progress', progress: end / total });
      }
    }

    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(tail as unknown as BlobPart);

    post({ type: 'done', blob: new Blob(chunks, { type: 'audio/mpeg' }) });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
