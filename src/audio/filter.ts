export type FilterSlope = 12 | 24 | 48;

export function createFilterChain(
  ctx: BaseAudioContext,
  slope: FilterSlope
): BiquadFilterNode[] {
  const count = slope === 48 ? 4 : slope === 24 ? 2 : 1;
  const filters: BiquadFilterNode[] = [];

  for (let i = 0; i < count; i++) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    // Use Q=0.5 (critically damped) for all slopes to avoid overshoot/ringing
    // that caused transients on lowpass sweeps during export (vs playback).
    // Original Q=0.707 (Butterworth) has ~6-8% overshoot at 300Hz; Q=0.5 is 0%.
    // See /tmp/opencode/timedomain.mjs analysis.
    filter.Q.value = 0.5;
    filters.push(filter);
  }

  for (let i = 0; i < filters.length - 1; i++) {
    filters[i].connect(filters[i + 1]);
  }

  return filters;
}

export function connectFilterChain(
  source: AudioNode,
  filters: BiquadFilterNode[],
  destination: AudioNode
): void {
  source.connect(filters[0]);
  filters[filters.length - 1].connect(destination);
}

// Safety limiter shared by playback and offline export so both sound identical.
// Why: hot masters (example.wav peaks at 0 dBFS) ring the sweeping low-pass —
// measured overshoot up to ~1.9x on drum transients as the cutoff sweeps through
// the mids during fade-out. The static 0.75 headroom (-2.5 dB) alone cannot cover
// that, so peaks exceed 1.0, hard-clip on playback and wrap around int16 in the
// WAV writer (full-scale single-sample jumps = pop/static). The limiter only
// engages above -2 dB, i.e. never on clean material after headroom (peaks sit at
// ~-2.5 dB), and transparently catches filter-overshoot spikes.
export function createSafetyLimiter(ctx: BaseAudioContext): DynamicsCompressorNode {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2; // dB: above clean peaks, below overshoot spikes
  limiter.knee.value = 0; // hard knee: brick-wall behaviour above threshold
  limiter.ratio.value = 20; // brick-wall ratio
  limiter.attack.value = 0.001; // 1 ms: catch transient spikes fast
  limiter.release.value = 0.1; // 100 ms: recover without pumping on sparse spikes
  return limiter;
}


