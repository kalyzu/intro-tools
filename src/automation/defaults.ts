import type { AutomationPoint } from './model';

export function createDefaultAutomation(duration: number, fadeIn?: number, fadeOut?: number): AutomationPoint[] {
  const effectiveFadeIn = Math.min(fadeIn ?? duration * 0.1, duration / 2);
  const effectiveFadeOut = Math.min(fadeOut ?? duration * 0.1, duration / 2);
  const minGap = Math.min(0.05, duration / 3);

  let fadeOutStart = duration - effectiveFadeOut;
  let fadeInEnd = effectiveFadeIn;

  if (fadeInEnd + minGap > fadeOutStart) {
    const mid = duration / 2;
    fadeInEnd = mid - minGap / 2;
    fadeOutStart = mid + minGap / 2;
  }

  const maxFreq = 20000;
  const points: AutomationPoint[] = [
    { time: 0, frequency: 300, curve: 'smooth', controlFreq: 1200 },
    { time: fadeInEnd, frequency: maxFreq, curve: 'smooth', controlFreq: null },
    { time: fadeOutStart, frequency: maxFreq, curve: 'smooth', controlFreq: 1200 },
    { time: duration, frequency: 300, curve: 'smooth', controlFreq: null },
  ];

  return points;
}
