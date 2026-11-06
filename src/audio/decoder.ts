export interface DecodedAudio {
  buffer: AudioBuffer;
  duration: number;
  sampleRate: number;
  channels: number;
}

const FALLBACK_SAMPLE_RATE = 44100;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 96000;

function asciiAt(view: DataView, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > view.byteLength) return false;
  for (let i = 0; i < text.length; i++) {
    if (view.getUint8(offset + i) !== text.charCodeAt(i)) return false;
  }
  return true;
}

function isValidSampleRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= MIN_SAMPLE_RATE && rate <= MAX_SAMPLE_RATE;
}

function detectWavSampleRate(view: DataView): number | null {
  if (!asciiAt(view, 0, 'RIFF') || !asciiAt(view, 8, 'WAVE')) return null;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkSize = view.getUint32(offset + 4, true);
    if (asciiAt(view, offset, 'fmt ') && chunkSize >= 16 && offset + 16 <= view.byteLength) {
      const rate = view.getUint32(offset + 12, true);
      if (isValidSampleRate(rate)) return rate;
    }
    const next = offset + 8 + chunkSize + (chunkSize & 1);
    if (next <= offset) break;
    offset = next;
  }
  return null;
}

function detectFlacSampleRate(view: DataView): number | null {
  if (!asciiAt(view, 0, 'fLaC') || view.byteLength < 21) return null;
  // First metadata block must be STREAMINFO. Its packed sample rate starts
  // 10 bytes into the block, which is byte 18 of the file.
  if ((view.getUint8(4) & 0x7f) !== 0) return null;

  const b10 = view.getUint8(18);
  const b11 = view.getUint8(19);
  const b12 = view.getUint8(20);
  const rate = (b10 << 12) | (b11 << 4) | (b12 >> 4);
  return isValidSampleRate(rate) ? rate : null;
}

function detectOggSampleRate(view: DataView): number | null {
  if (!asciiAt(view, 0, 'OggS') || view.byteLength < 28) return null;

  const segmentCount = view.getUint8(26);
  const payload = 27 + segmentCount;
  if (payload + 16 > view.byteLength) return null;

  if (view.getUint8(payload) === 0x01 && asciiAt(view, payload + 1, 'vorbis')) {
    const rate = view.getUint32(payload + 12, true);
    return isValidSampleRate(rate) ? rate : null;
  }
  // Opus is always decoded at 48 kHz regardless of the original input rate.
  if (asciiAt(view, payload, 'OpusHead')) return 48000;
  return null;
}

const MP3_RATES_MPEG1 = [44100, 48000, 32000];
const MP3_RATES_MPEG2 = [22050, 24000, 16000];
const MP3_RATES_MPEG25 = [11025, 12000, 8000];
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function id3TagEnd(view: DataView): number {
  if (!asciiAt(view, 0, 'ID3') || view.byteLength < 10) return 0;
  const size =
    ((view.getUint8(6) & 0x7f) << 21) |
    ((view.getUint8(7) & 0x7f) << 14) |
    ((view.getUint8(8) & 0x7f) << 7) |
    (view.getUint8(9) & 0x7f);
  const flags = view.getUint8(5);
  return 10 + size + ((flags & 0x10) !== 0 ? 10 : 0);
}

function detectMp3SampleRate(view: DataView): number | null {
  const offset = id3TagEnd(view);

  const end = Math.min(view.byteLength - 4, offset + 65536);
  for (let i = Math.max(0, offset); i <= end; i++) {
    if (view.getUint8(i) !== 0xff || (view.getUint8(i + 1) & 0xe0) !== 0xe0) continue;

    const versionBits = (view.getUint8(i + 1) >> 3) & 0x03;
    const layerBits = (view.getUint8(i + 1) >> 1) & 0x03;
    const rateIndex = (view.getUint8(i + 2) >> 2) & 0x03;
    // Version 1, layer 0 and rate index 3 are reserved values.
    if (versionBits === 1 || layerBits === 0 || rateIndex === 3) continue;

    const rates =
      versionBits === 3 ? MP3_RATES_MPEG1 : versionBits === 2 ? MP3_RATES_MPEG2 : MP3_RATES_MPEG25;
    const rate = rates[rateIndex];
    if (isValidSampleRate(rate)) return rate;
  }
  return null;
}

function detectAdtsSampleRate(view: DataView): number | null {
  const start = id3TagEnd(view);
  const end = Math.min(view.byteLength - 7, start + 65536);
  for (let i = start; i <= end; i++) {
    // ADTS sync word plus layer bits set to 00.
    if (view.getUint8(i) !== 0xff || (view.getUint8(i + 1) & 0xf6) !== 0xf0) continue;

    // Validate the declared frame length so random sync-like bytes inside
    // other codecs are not mistaken for an ADTS stream.
    const protectionAbsent = (view.getUint8(i + 1) & 0x01) !== 0;
    const headerLength = protectionAbsent ? 7 : 9;
    const frameLength =
      ((view.getUint8(i + 3) & 0x03) << 11) |
      (view.getUint8(i + 4) << 3) |
      (view.getUint8(i + 5) >> 5);
    if (frameLength < headerLength || i + frameLength > view.byteLength) continue;

    const next = i + frameLength;
    if (next + 2 <= view.byteLength && (view.getUint8(next) !== 0xff || (view.getUint8(next + 1) & 0xf6) !== 0xf0)) {
      continue;
    }

    const rateIndex = (view.getUint8(i + 2) >> 2) & 0x0f;
    const rate = ADTS_RATES[rateIndex];
    if (isValidSampleRate(rate)) return rate;
  }
  return null;
}

interface Mp4Box {
  type: string;
  size: number;
  headerSize: number;
}

const MP4_CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function readMp4Box(view: DataView, offset: number, limit: number): Mp4Box | null {
  if (offset + 8 > limit) return null;
  let size = view.getUint32(offset, false);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const high = view.getUint32(offset + 8, false);
    const low = view.getUint32(offset + 12, false);
    if (high > 0x1fffff) return null;
    size = high * 0x100000000 + low;
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) return null;
  const type = String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
  return { type, size, headerSize };
}

function readStsdSampleRate(view: DataView, start: number, end: number): number | null {
  if (start + 8 > end) return null;
  let offset = start + 8; // version/flags + entry count
  while (offset + 8 <= end) {
    const entry = readMp4Box(view, offset, end);
    if (!entry) return null;
    if ((entry.type === 'mp4a' || entry.type === 'alac') && offset + 36 <= end) {
      const rate = view.getUint32(offset + 32, false) >>> 16;
      if (isValidSampleRate(rate)) return rate;
    }
    offset += entry.size;
  }
  return null;
}

function findMp4SampleRate(view: DataView, start: number, end: number, depth = 0): number | null {
  if (depth > 8) return null;
  let offset = start;
  while (offset + 8 <= end) {
    const box = readMp4Box(view, offset, end);
    if (!box) return null;

    if (box.type === 'stsd') {
      const rate = readStsdSampleRate(view, offset + box.headerSize, offset + box.size);
      if (rate !== null) return rate;
    } else if (MP4_CONTAINER_BOXES.has(box.type)) {
      const rate = findMp4SampleRate(view, offset + box.headerSize, offset + box.size, depth + 1);
      if (rate !== null) return rate;
    }
    offset += box.size;
  }
  return null;
}

/**
 * Best-effort source sample-rate detection from the container/codec headers.
 * Decoding at the native rate avoids an unnecessary resample.
 */
export function detectSampleRate(arrayBuffer: ArrayBuffer): number | null {
  if (arrayBuffer.byteLength < 12) return null;
  const view = new DataView(arrayBuffer);

  const wav = detectWavSampleRate(view);
  if (wav !== null) return wav;

  const flac = detectFlacSampleRate(view);
  if (flac !== null) return flac;

  const ogg = detectOggSampleRate(view);
  if (ogg !== null) return ogg;

  if (asciiAt(view, 4, 'ftyp')) {
    const mp4 = findMp4SampleRate(view, 0, view.byteLength);
    if (mp4 !== null) return mp4;
  }

  const adts = detectAdtsSampleRate(view);
  if (adts !== null) return adts;

  return detectMp3SampleRate(view);
}

function createOfflineContext(sampleRate: number): OfflineAudioContext {
  try {
    return new OfflineAudioContext(1, 1, sampleRate);
  } catch {
    return new OfflineAudioContext(1, 1, FALLBACK_SAMPLE_RATE);
  }
}

export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  const detectedRate = detectSampleRate(arrayBuffer);
  const offlineCtx = createOfflineContext(detectedRate ?? FALLBACK_SAMPLE_RATE);
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

  const offset = Math.max(0, Math.floor(start * sampleRate));
  for (let ch = 0; ch < channels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    const available = Math.max(0, Math.min(length, src.length - offset));
    if (available > 0) {
      dst.set(src.subarray(offset, offset + available));
    }
  }
  return out;
}
