import type { AutomationPoint } from './model';

const MIN_FREQ = 20;
const MAX_FREQ = 20000;

function freqToLog(freq: number): number {
  return Math.log(freq / MIN_FREQ) / Math.log(MAX_FREQ / MIN_FREQ);
}

function logToFreq(log: number): number {
  return MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, log);
}

function quadraticBezier(t: number, p0: number, p1: number, p2: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

export function interpolateLinear(a: AutomationPoint, b: AutomationPoint, t: number): number {
  return a.frequency + (b.frequency - a.frequency) * t;
}

export function interpolateSmooth(a: AutomationPoint, b: AutomationPoint, t: number): number {
  const logA = freqToLog(a.frequency);
  const logB = freqToLog(b.frequency);

  if (a.controlFreq !== null) {
    const lo = Math.min(a.frequency, b.frequency);
    const hi = Math.max(a.frequency, b.frequency);
    const clamped = Math.max(lo, Math.min(hi, a.controlFreq));
    const logC = freqToLog(clamped);
    const logVal = quadraticBezier(t, logA, logC, logB);
    return logToFreq(logVal);
  }

  const logVal = logA + (logB - logA) * t;
  return logToFreq(logVal);
}

export function interpolate(
  a: AutomationPoint,
  b: AutomationPoint,
  t: number
): number {
  if (a.curve === 'smooth') {
    return interpolateSmooth(a, b, t);
  }
  return interpolateLinear(a, b, t);
}
