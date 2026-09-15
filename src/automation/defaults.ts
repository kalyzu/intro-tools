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

  // Use 18 kHz max to stay away from Nyquist (22.05 kHz @44.1k) and reduce
  // Biquad warping / ringing that caused export transients on drum hits
  // during the 1 s fade. Also add gentle bezier control to smooth the knee
  // at 1.0 / 1.84 where log-linear would have a derivative discontinuity.
  const maxFreq = 18000;
  const points: AutomationPoint[] = [
    { time: 0, frequency: 300, curve: 'smooth', controlFreq: 1200 },
    { time: fadeInEnd, frequency: maxFreq, curve: 'smooth', controlFreq: null },
    { time: fadeOutStart, frequency: maxFreq, curve: 'smooth', controlFreq: 1200 },
    { time: duration, frequency: 300, curve: 'smooth', controlFreq: null },
  ];

  return points;
}
