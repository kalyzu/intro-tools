export type CurveType = 'linear' | 'smooth';

export interface AutomationPoint {
  time: number;
  frequency: number;
  curve: CurveType;
  controlFreq: number | null;
}

export function evaluateAutomation(
  points: AutomationPoint[],
  time: number,
  interpolateFn: (a: AutomationPoint, b: AutomationPoint, t: number) => number
): number {
  if (points.length === 0) return 20000;
  if (points.length === 1) return points[0].frequency;
  if (time <= points[0].time) return points[0].frequency;
  if (time >= points[points.length - 1].time) return points[points.length - 1].frequency;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (time >= a.time && time <= b.time) {
      const t = (time - a.time) / (b.time - a.time);
      return interpolateFn(a, b, t);
    }
  }
  return points[points.length - 1].frequency;
}

export function sortPoints(points: AutomationPoint[]): AutomationPoint[] {
  return [...points].sort((a, b) => a.time - b.time);
}

export function validatePoints(points: AutomationPoint[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i].time >= points[i + 1].time) return false;
  }
  return true;
}

export function clampFrequency(freq: number): number {
  return Math.max(20, Math.min(20000, freq));
}

export function clampTime(time: number, duration: number): number {
  return Math.max(0, Math.min(duration, time));
}

export function duplicatePoints(points: AutomationPoint[]): AutomationPoint[] {
  return points.map(p => ({ ...p }));
}
