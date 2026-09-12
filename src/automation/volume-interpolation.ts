import type { VolumePoint } from './volume-model';

function quadraticBezier(t: number, p0: number, p1: number, p2: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

export function interpolateVolumeLinear(a: VolumePoint, b: VolumePoint, t: number): number {
  return a.gain + (b.gain - a.gain) * t;
}

export function interpolateVolumeSmooth(a: VolumePoint, b: VolumePoint, t: number): number {
  if (a.controlGain !== null) {
    const lo = Math.min(a.gain, b.gain);
    const hi = Math.max(a.gain, b.gain);
    const clamped = Math.max(lo, Math.min(hi, a.controlGain));
    return quadraticBezier(t, a.gain, clamped, b.gain);
  }
  // smooth is linear in gain space (no log conversion)
  return a.gain + (b.gain - a.gain) * t;
}

export function interpolateVolume(
  a: VolumePoint,
  b: VolumePoint,
  t: number
): number {
  if (a.curve === 'smooth') {
    return interpolateVolumeSmooth(a, b, t);
  }
  return interpolateVolumeLinear(a, b, t);
}
