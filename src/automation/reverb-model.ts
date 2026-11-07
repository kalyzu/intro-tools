import type { VolumePoint } from './volume-model';
import { clampVolumeTime, evaluateVolumeAutomation, sortVolumePoints } from './volume-model';
import { interpolateVolume } from './volume-interpolation';

/**
 * Reverb mix uses the same point/curve shape as volume automation. Keeping the
 * type shared means the existing line editor works unchanged for both lanes.
 */
export type ReverbPoint = VolumePoint;

export function createDefaultReverbAutomation(duration: number): ReverbPoint[] {
  // Flat 0% mix so reverb stays fully bypassed until the line is raised.
  return [
    { time: 0, gain: 0, curve: 'smooth', controlGain: null },
    { time: duration, gain: 0, curve: 'smooth', controlGain: null },
  ];
}

export function evaluateReverbAutomation(points: ReverbPoint[], time: number): number {
  return Math.max(0, Math.min(1, evaluateVolumeAutomation(points, time, interpolateVolume)));
}

export function getReverbMixRange(points: ReverbPoint[]): { min: number; max: number } {
  if (points.length === 0) return { min: 0, max: 0 };

  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    min = Math.min(min, point.gain);
    max = Math.max(max, point.gain);
  }
  return { min, max };
}

export function ensureReverbPoints(points: ReverbPoint[], duration: number): ReverbPoint[] {
  const deduped = new Map<number, ReverbPoint>();
  for (const point of points) {
    const clamped = { ...point, time: clampVolumeTime(point.time, duration) };
    deduped.set(clamped.time, clamped);
  }

  const sorted = sortVolumePoints([...deduped.values()]);
  return sorted.length >= 2 ? sorted : createDefaultReverbAutomation(duration);
}
