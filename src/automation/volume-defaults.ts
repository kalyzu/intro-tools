import type { VolumePoint } from './volume-model';

export function createDefaultVolumeAutomation(duration: number): VolumePoint[] {
  // Flat 100% volume across the clip
  return [
    { time: 0, gain: 1, curve: 'smooth', controlGain: null },
    { time: duration, gain: 1, curve: 'smooth', controlGain: null },
  ];
}
