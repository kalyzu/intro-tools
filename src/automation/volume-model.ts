import type { CurveType } from './model';

export interface VolumePoint {
  time: number;
  gain: number;
  curve: CurveType;
  controlGain: number | null;
}

export function evaluateVolumeAutomation(
  points: VolumePoint[],
  time: number,
  interpolateFn: (a: VolumePoint, b: VolumePoint, t: number) => number
): number {
  if (points.length === 0) return 1;
  if (points.length === 1) return points[0].gain;
  if (time <= points[0].time) return points[0].gain;
  if (time >= points[points.length - 1].time) return points[points.length - 1].gain;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (time >= a.time && time <= b.time) {
      const t = (time - a.time) / (b.time - a.time);
      return interpolateFn(a, b, t);
    }
  }
  return points[points.length - 1].gain;
}

export function sortVolumePoints(points: VolumePoint[]): VolumePoint[] {
  return [...points].sort((a, b) => a.time - b.time);
}

export function clampGain(gain: number): number {
  return Math.max(0, Math.min(1, gain));
}

export function clampVolumeTime(time: number, duration: number): number {
  return Math.max(0, Math.min(duration, time));
}
