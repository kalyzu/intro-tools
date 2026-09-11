import type { AutomationPoint } from './model';

export function createDefaultAutomation(duration: number, fadeIn = 1.0, fadeOut = 1.0): AutomationPoint[] {
  const effectiveFadeIn = Math.min(fadeIn, duration / 2);
  const effectiveFadeOut = Math.min(fadeOut, duration / 2);
  const minGap = 0.05;

  let fadeOutStart = duration - effectiveFadeOut;
  let fadeInEnd = effectiveFadeIn;

  if (fadeInEnd + minGap > fadeOutStart) {
    const mid = duration / 2;
    fadeInEnd = Math.max(0, mid - minGap);
    fadeOutStart = Math.min(duration, mid + minGap);
  }

  const points: AutomationPoint[] = [
    { time: 0, frequency: 300, curve: 'smooth', controlFreq: null },
    { time: fadeInEnd, frequency: 20000, curve: 'smooth', controlFreq: null },
    { time: fadeOutStart, frequency: 20000, curve: 'smooth', controlFreq: null },
    { time: duration, frequency: 300, curve: 'smooth', controlFreq: null },
  ];

  return points;
}
