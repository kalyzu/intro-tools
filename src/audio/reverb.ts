export interface ReverbSettings {
  /** Dry/wet mix, 0 = fully dry, 1 = fully wet. */
  mix: number;
  /** Reverb tail length in seconds (-60 dB point). */
  decay: number;
  /** 0 = bright tail, 1 = heavily damped tail. */
  damping: number;
  /** Silence before the reverb starts, in seconds. */
  preDelay: number;
}

export const DEFAULT_REVERB_SETTINGS: ReverbSettings = {
  mix: 0,
  decay: 1.8,
  damping: 0.35,
  preDelay: 0.02,
};

export interface ReverbChain {
  input: GainNode;
  output: GainNode;
  dryGain: GainNode;
  wetGain: GainNode;
  /** Wet path only, used to fade the tail out without touching the dry signal. */
  tailGain: GainNode;
  setMix(mix: number): void;
  dispose(): void;
}

const IR_CACHE_LIMIT = 8;
const impulseCache = new Map<string, Float32Array[]>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Deterministic PRNG so playback and export render an identical impulse. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sanitizeSettings(settings: ReverbSettings): ReverbSettings {
  return {
    mix: clamp01(settings.mix),
    decay: clamp(settings.decay, 0.1, 10),
    damping: clamp01(settings.damping),
    preDelay: clamp(settings.preDelay, 0, 1),
  };
}

/**
 * Build a stereo synthetic impulse response. The tail is decorrelated noise
 * with an exponential envelope and a low-pass cutoff that falls over time, so
 * the reverb darkens naturally instead of sounding like a gated noise burst.
 *
 * The raw samples are cached by the parameters that shape the IR. Mix is
 * intentionally excluded: changing the wet level does not rebuild the impulse.
 */
export function createReverbImpulseSamples(
  sampleRate: number,
  settings: ReverbSettings,
): Float32Array[] {
  const safe = sanitizeSettings(settings);
  const key = [
    sampleRate,
    safe.decay.toFixed(4),
    safe.damping.toFixed(4),
    safe.preDelay.toFixed(4),
  ].join(':');
  const cached = impulseCache.get(key);
  if (cached) return cached;

  const preDelaySamples = Math.floor(safe.preDelay * sampleRate);
  const tailSamples = Math.max(1, Math.ceil(safe.decay * sampleRate));
  const length = preDelaySamples + tailSamples;
  const channels: Float32Array[] = [];

  // One envelope step per sample gives a -60 dB tail without calling exp()
  // for every sample.
  const envelopeStep = Math.exp(-6.907755 / tailSamples);
  const dampingScale = 1 - 0.7 * safe.damping;

  for (let ch = 0; ch < 2; ch++) {
    const data = new Float32Array(length);
    const noise = mulberry32(0x9e3779b9 + ch * 0x85ebca6b);
    let lowpass = 0;
    let alpha = 0;
    let envelope = 1;

    for (let i = 0; i < tailSamples; i++) {
      // Updating the cutoff once per block keeps IR generation cheap while
      // still letting the tail grow progressively darker.
      if ((i & 63) === 0) {
        const progress = i / tailSamples;
        const cutoff = 16000 * Math.exp(-3.2 * progress) + 1400;
        alpha = 1 - Math.exp(-2 * Math.PI * (cutoff * dampingScale) / sampleRate);
      }

      lowpass += ((noise() * 2 - 1) - lowpass) * alpha;
      data[preDelaySamples + i] = lowpass * envelope;
      envelope *= envelopeStep;
    }

    // A non-zero IR sum is DC gain: low-frequency content in the source would
    // turn into a large offset. Remove the tail mean while keeping the
    // pre-delay silent.
    let sum = 0;
    for (let i = preDelaySamples; i < length; i++) sum += data[i];
    const mean = sum / tailSamples;
    if (mean !== 0) {
      for (let i = preDelaySamples; i < length; i++) data[i] -= mean;
    }

    channels.push(data);
  }

  // Normalize both channels by the same peak so the stereo image stays intact.
  // ConvolverNode also normalizes, but keeping the raw IR bounded makes the
  // chain predictable and avoids huge intermediate values.
  let peak = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
    }
  }
  if (peak > 1e-6) {
    const scale = 0.9 / peak;
    for (const data of channels) {
      for (let i = 0; i < data.length; i++) data[i] *= scale;
    }
  }

  if (impulseCache.size >= IR_CACHE_LIMIT) {
    const oldest = impulseCache.keys().next().value;
    if (oldest !== undefined) impulseCache.delete(oldest);
  }
  impulseCache.set(key, channels);
  return channels;
}

export function createReverbImpulse(
  ctx: BaseAudioContext,
  settings: ReverbSettings,
): AudioBuffer {
  const samples = createReverbImpulseSamples(ctx.sampleRate, settings);
  const buffer = ctx.createBuffer(2, samples[0].length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    buffer.getChannelData(ch).set(samples[ch]);
  }
  return buffer;
}

/**
 * Parallel dry/wet reverb. Connect the source to `input` and `output` to the
 * next node in the chain; the dry path keeps the original signal intact.
 */
export function createReverbChain(
  ctx: BaseAudioContext,
  settings: ReverbSettings,
): ReverbChain {
  const safe = sanitizeSettings(settings);
  const input = ctx.createGain();
  const dryGain = ctx.createGain();
  const wetGain = ctx.createGain();
  const tailGain = ctx.createGain();
  const output = ctx.createGain();
  const convolver = ctx.createConvolver();

  convolver.normalize = true;
  convolver.buffer = createReverbImpulse(ctx, safe);

  input.connect(dryGain);
  dryGain.connect(output);
  input.connect(convolver);
  convolver.connect(wetGain);
  wetGain.connect(tailGain);
  tailGain.connect(output);

  // Equal-power crossfade: the total level stays roughly constant as the mix
  // moves from dry to wet. Set the initial values directly to avoid a fade-in
  // when the graph is first built.
  dryGain.gain.value = Math.cos(safe.mix * Math.PI / 2);
  wetGain.gain.value = Math.sin(safe.mix * Math.PI / 2);
  tailGain.gain.value = 1;

  return {
    input,
    output,
    dryGain,
    wetGain,
    tailGain,
    setMix(mix: number): void {
      const value = clamp01(mix);
      const now = ctx.currentTime;
      dryGain.gain.setTargetAtTime(Math.cos(value * Math.PI / 2), now, 0.015);
      wetGain.gain.setTargetAtTime(Math.sin(value * Math.PI / 2), now, 0.015);
    },
    dispose(): void {
      for (const node of [input, dryGain, wetGain, tailGain, convolver, output]) {
        try {
          node.disconnect();
        } catch {}
      }
      convolver.buffer = null;
    },
  };
}
