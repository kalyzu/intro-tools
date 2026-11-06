// Bass/snare onset detection – no classification, hi-hats ignored
// Vanilla TS, no external deps, linear-time analysis with fixed-size windows
// Design: 2-band (low 20-150Hz, mid 150-4000Hz) log-energy flux, weighted, detrended, adaptive threshold

export interface OnsetOptions {
  sensitivity?: number; // 0..1, higher = more sensitive (more false positives). Default 0.25
  minGapSec?: number; // minimum inter-onset, default 0.20
}

export function detectDrumOnsets(
  buffer: AudioBuffer,
  options: OnsetOptions = {}
): number[] {
  const sensitivity = options.sensitivity ?? 0.25;
  const minGapSec = options.minGapSec ?? 0.2;

  const offset = Math.max(0, 0.05 - sensitivity * 0.04);

  const sr = buffer.sampleRate;
  const mono = mixToMono(buffer);

  // Band split via manual biquad (RBJ) – keeps testability without OfflineAudioContext
  const low = applyLowpass(mono, 120, 0.707, sr);
  const mid = applyBandpass(mono, 150, 4000, sr);

  const N = 2048;
  const hop = 256;
  const nFrames = Math.max(1, 1 + Math.floor((mono.length - N) / hop));
  const times = new Float64Array(nFrames);
  const rmsLow = new Float64Array(nFrames);
  const rmsMid = new Float64Array(nFrames);

  for (let i = 0; i < nFrames; i++) {
    const start = i * hop;
    let sumLow = 0;
    let sumMid = 0;
    for (let j = 0; j < N; j++) {
      const idx = start + j;
      if (idx >= low.length) break;
      const lv = low[idx];
      const mv = mid[idx];
      sumLow += lv * lv;
      sumMid += mv * mv;
    }
    rmsLow[i] = Math.sqrt(sumLow / N + 1e-12);
    rmsMid[i] = Math.sqrt(sumMid / N + 1e-12);
    times[i] = (start + N / 2) / sr;
  }

  const logELow = rmsLow.map(v => Math.log(v + 1e-9));
  const logEMid = rmsMid.map(v => Math.log(v + 1e-9));

  const fluxLow = new Float64Array(nFrames);
  const fluxMid = new Float64Array(nFrames);
  for (let i = 1; i < nFrames; i++) {
    fluxLow[i] = Math.max(0, logELow[i] - logELow[i - 1]);
    fluxMid[i] = Math.max(0, logEMid[i] - logEMid[i - 1]);
  }

  const wLow = 0.4;
  const flux = new Float64Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    flux[i] = wLow * fluxLow[i] + (1 - wLow) * fluxMid[i];
  }

  // Detrend: subtract median filter (17 ~ 0.1s)
  const fluxDetrended = new Float64Array(nFrames);
  const med17 = medianFilter(flux, 17);
  for (let i = 0; i < nFrames; i++) fluxDetrended[i] = flux[i] - med17[i];

  const med11 = medianFilter(fluxDetrended, 11);
  const deviations = new Float64Array(nFrames);
  for (let i = 0; i < nFrames; i++) deviations[i] = Math.abs(fluxDetrended[i] - med11[i]);
  const localMad = medianFilter(deviations, 31);
  const thresh = new Float64Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const noiseFloor = localMad[i] * 1.4826 * 4;
    thresh[i] = med11[i] + Math.max(offset, noiseFloor);
  }

  const strongPeakIdxs: number[] = [];
  const weakPeakIdxs: number[] = [];
  for (let i = 1; i < nFrames - 1; i++) {
    if (fluxDetrended[i] > fluxDetrended[i - 1] && fluxDetrended[i] > fluxDetrended[i + 1]) {
      // 5-point local max
      let isMax = true;
      for (let k = Math.max(0, i - 2); k <= Math.min(nFrames - 1, i + 2); k++) {
        if (fluxDetrended[k] > fluxDetrended[i]) {
          isMax = false;
          break;
        }
      }
      if (isMax) {
        if (fluxDetrended[i] > thresh[i]) strongPeakIdxs.push(i);
        else if (fluxDetrended[i] > thresh[i] * 0.75) weakPeakIdxs.push(i);
      }
    }
  }

  const peakIdxs = [...strongPeakIdxs];
  // Keep a weaker onset only when it forms a close double-hit with a strong one.
  for (const candidate of weakPeakIdxs) {
    const time = times[candidate];
    if (strongPeakIdxs.some(index => {
      const distance = Math.abs(times[index] - time);
      return distance >= minGapSec && distance <= 0.11;
    })) {
      peakIdxs.push(candidate);
    }
  }
  peakIdxs.sort((a, b) => a - b);

  const peakTimes = peakIdxs.map(i => times[i]);
  const peakFlux = peakIdxs.map(i => fluxDetrended[i]);

  // Enforce min gap, keep higher flux on conflict (prefer stronger onset)
  const filtered: number[] = [];
  const filteredFlux: number[] = [];
  for (let k = 0; k < peakTimes.length; k++) {
    const t = peakTimes[k];
    const f = peakFlux[k];
    if (filtered.length === 0 || t - filtered[filtered.length - 1] >= minGapSec) {
      filtered.push(t);
      filteredFlux.push(f);
    } else {
      // conflict: keep higher flux
      if (f > filteredFlux[filteredFlux.length - 1]) {
        filtered[filtered.length - 1] = t;
        filteredFlux[filteredFlux.length - 1] = f;
      }
    }
  }

  // Clamp to buffer duration and sort
  const duration = buffer.duration;
  const result = filtered.filter(t => t >= 0 && t <= duration).sort((a, b) => a - b);
  // Overlapping frames and the band filters put the detected peak slightly
  // before the transient's audible attack.
  return result.map(time => Math.min(duration, time + (N / 4 + hop) / sr));
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0) as Float32Array;
  const len = buffer.length;
  const out = new Float32Array(len);
  const chans: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) chans.push(buffer.getChannelData(ch) as Float32Array);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let ch = 0; ch < chans.length; ch++) sum += chans[ch][i];
    out[i] = sum / chans.length;
  }
  return out;
}

function applyLowpass(input: Float32Array, fc: number, Q: number, sr: number): Float32Array {
  const w0 = (2 * Math.PI * fc) / sr;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);
  const b0 = (1 - cosw0) / 2;
  const b1 = 1 - cosw0;
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  const b0a = b0 / a0,
    b1a = b1 / a0,
    b2a = b2 / a0,
    a1a = a1 / a0,
    a2a = a2 / a0;
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < input.length; n++) {
    const x0 = input[n];
    const y0 = b0a * x0 + b1a * x1 + b2a * x2 - a1a * y1 - a2a * y2;
    out[n] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function applyBandpass(input: Float32Array, lowFc: number, highFc: number, sr: number): Float32Array {
  // Bandpass 150-4000 via HP 150 + LP 4000
  const hp = applyHighpass(input, lowFc, 0.707, sr);
  return applyLowpass(hp, highFc, 0.707, sr);
}

function applyHighpass(input: Float32Array, fc: number, Q: number, sr: number): Float32Array {
  const w0 = (2 * Math.PI * fc) / sr;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);
  const b0 = (1 + cosw0) / 2;
  const b1 = -(1 + cosw0);
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  const b0a = b0 / a0,
    b1a = b1 / a0,
    b2a = b2 / a0,
    a1a = a1 / a0,
    a2a = a2 / a0;
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < input.length; n++) {
    const x0 = input[n];
    const y0 = b0a * x0 + b1a * x1 + b2a * x2 - a1a * y1 - a2a * y2;
    out[n] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function medianFilter(arr: Float64Array | Float32Array, kernel: number): Float64Array {
  const out = new Float64Array(arr.length);
  const half = Math.floor(kernel / 2);
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(arr.length, i + half + 1);
    const window = Array.from(arr.slice(start, end) as any) as number[];
    window.sort((a, b) => a - b);
    out[i] = window[Math.floor(window.length / 2)];
  }
  return out;
}
