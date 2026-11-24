export interface Mp3EncodeOptions {
  bitrate?: number;
  onProgress?: (progress: number) => void;
}

interface WorkerProgressMessage {
  type: 'progress';
  progress: number;
}

interface WorkerDoneMessage {
  type: 'done';
  blob: Blob;
}

interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

type WorkerResponse = WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage;

/**
 * Encode a rendered AudioBuffer as MP3 in a worker thread so the UI (and the
 * progress bar) stays responsive. The buffer must already use an MP3-supported
 * sample rate and have at most two channels.
 *
 * The channel data is transferred to the worker when possible, which detaches
 * it from the AudioBuffer; treat the buffer as consumed after calling this.
 */
export function encodeMp3(
  buffer: AudioBuffer,
  { bitrate = 192, onProgress }: Mp3EncodeOptions = {}
): Promise<Blob> {
  const channels: Float32Array[] = [];
  for (let i = 0; i < Math.min(2, buffer.numberOfChannels); i++) {
    channels.push(buffer.getChannelData(i));
  }

  return new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL('./mp3-encoder.worker.ts', import.meta.url), {
      type: 'module',
    });

    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress?.(message.progress);
      } else if (message.type === 'done') {
        cleanup();
        resolve(message.blob);
      } else {
        cleanup();
        reject(new Error(message.message));
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'MP3 encoding failed.'));
    };

    try {
      // Transfer the rendered channel data to avoid copying tens of MB on the
      // main thread. The buffer is disposable after render.
      worker.postMessage(
        { channels, sampleRate: buffer.sampleRate, bitrate },
        channels.map((channel) => channel.buffer) as Transferable[]
      );
    } catch {
      // Some engines do not allow transferring AudioBuffer channel storage.
      // Fall back to copying, which is safe but slower.
      const copies = channels.map((channel) => new Float32Array(channel));
      try {
        worker.postMessage(
          { channels: copies, sampleRate: buffer.sampleRate, bitrate },
          copies.map((channel) => channel.buffer) as Transferable[]
        );
      } catch (err) {
        cleanup();
        reject(err);
      }
    }
  });
}
