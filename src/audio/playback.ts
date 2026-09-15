import type { AutomationPoint } from '../automation/model';
import type { VolumePoint } from '../automation/volume-model';
import type { FilterSlope } from './filter';
import { createFilterChain } from './filter';
import { evaluateAutomation } from '../automation/model';
import { evaluateVolumeAutomation } from '../automation/volume-model';
import { interpolate } from '../automation/interpolation';
import { interpolateVolume } from '../automation/volume-interpolation';

export type PlaybackState = 'stopped' | 'playing' | 'paused';

export interface PlaybackCallbacks {
  onTimeUpdate: (time: number) => void;
  onStateChange: (state: PlaybackState) => void;
  onEnd: () => void;
}

export class PlaybackEngine {
  private audioContext: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private analyser: AnalyserNode | null = null;
  private volumeGain: GainNode | null = null;
  private outputGain: GainNode | null = null;
  private fadeGain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private state: PlaybackState = 'stopped';
  private startTime = 0;
  private pauseTime = 0;
  private homeTime = 0;
  private automationPoints: AutomationPoint[] = [];
  private volumePoints: VolumePoint[] = [];
  private filterSlope: FilterSlope = 24;
  private filterEnabled = true;
  private callbacks: PlaybackCallbacks;
  private updateInterval = 0;
  private trimStart = 0;
  private trimEnd = 0;

  constructor(callbacks: PlaybackCallbacks) {
    this.callbacks = callbacks;
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    this.trimEnd = buffer.duration;
  }

  setTrim(start: number, end: number): void {
    this.trimStart = start;
    this.trimEnd = end;
  }

  setFilterSlope(slope: FilterSlope): void {
    this.filterSlope = slope;
  }

  setFilterEnabled(enabled: boolean): void {
    if (this.filterEnabled === enabled) return;
    this.filterEnabled = enabled;
    if (this.state === 'playing') {
      const time = this.getCurrentTime();
      this.stop();
      this.play(Math.max(0, time));
    }
  }

  getTrimDuration(): number {
    return this.trimEnd - this.trimStart;
  }

  setAutomationPoints(points: AutomationPoint[]): void {
    this.automationPoints = points;
    if (this.state === 'playing') {
      this.rescheduleFilter();
    }
  }

  setVolumePoints(points: VolumePoint[]): void {
    this.volumePoints = points;
    if (this.state === 'playing') {
      this.rescheduleVolume();
    }
  }

  getState(): PlaybackState {
    return this.state;
  }

  getCurrentTime(): number {
    if (this.state === 'playing' && this.audioContext) {
      return this.pauseTime + (this.audioContext.currentTime - this.startTime) - this.trimStart;
    }
    return this.pauseTime - this.trimStart;
  }

  play(startFromTrim?: number): void {
    if (!this.buffer) return;

    if (this.state === 'paused' && startFromTrim === undefined) {
      this.resume();
      return;
    }

    this.cleanup();

    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch {}
    }

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch (err) {
      console.error('Failed to create AudioContext:', err);
      this.state = 'stopped';
      this.callbacks.onStateChange(this.state);
      return;
    }
    this.audioContext = ctx;

    const start = startFromTrim ?? this.homeTime;
    this.homeTime = Math.max(0, Math.min(this.getTrimDuration(), start));
    const offset = start + this.trimStart;
    const clampedOffset = Math.max(this.trimStart, Math.min(this.trimEnd, offset));

    this.startTime = ctx.currentTime;
    this.pauseTime = clampedOffset;

    this.buildGraph(ctx);

    const trimDuration = this.trimEnd - clampedOffset;
    try {
      this.source!.start(0, clampedOffset);
      if (trimDuration > 0) {
        this.source!.stop(ctx.currentTime + trimDuration);
      }
    } catch (err) {
      console.error('Failed to start playback:', err);
      this.stop();
      return;
    }

    this.scheduleFilterAutomation(clampedOffset);
    this.scheduleVolumeAutomation(clampedOffset);
    this.scheduleFadeAutomation(clampedOffset);

    this.state = 'playing';
    this.callbacks.onStateChange(this.state);

    this.source!.onended = () => {
      if (this.state === 'playing') {
        this.stop();
        this.callbacks.onEnd();
      }
    };

    this.startUpdateLoop();
  }

  private resume(): void {
    if (!this.audioContext || !this.buffer) return;

    const clampedOffset = Math.max(this.trimStart, Math.min(this.trimEnd, this.pauseTime));

    this.buildGraph(this.audioContext);
    this.startTime = this.audioContext.currentTime;

    const trimDuration = this.trimEnd - clampedOffset;
    try {
      this.source!.start(0, clampedOffset);
      if (trimDuration > 0) {
        this.source!.stop(this.audioContext.currentTime + trimDuration);
      }
    } catch (err) {
      console.error('Failed to resume playback:', err);
      this.stop();
      return;
    }

    this.scheduleFilterAutomation(clampedOffset);
    this.scheduleVolumeAutomation(clampedOffset);
    this.scheduleFadeAutomation(clampedOffset);

    this.state = 'playing';
    this.callbacks.onStateChange(this.state);

    this.source!.onended = () => {
      if (this.state === 'playing') {
        this.stop();
        this.callbacks.onEnd();
      }
    };

    this.startUpdateLoop();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.pauseTime = this.trimStart;
    this.cleanup();
    this.state = 'stopped';
    this.callbacks.onStateChange(this.state);
    this.callbacks.onTimeUpdate(this.homeTime);
  }

  stop(): void {
    this.pauseTime = this.trimStart;
    this.cleanup();
    this.state = 'stopped';
    this.callbacks.onStateChange(this.state);
    this.callbacks.onTimeUpdate(this.homeTime);
  }

  getHomeTime(): number {
    return this.homeTime;
  }

  seek(trimTime: number): void {
    const wasPlaying = this.state === 'playing';
    if (wasPlaying) {
      this.pause();
    }
    const clamped = Math.max(0, Math.min(this.getTrimDuration(), trimTime));
    this.homeTime = clamped;
    this.pauseTime = clamped + this.trimStart;
    this.callbacks.onTimeUpdate(clamped);
    if (wasPlaying) {
      this.play(clamped);
    }
  }

  private cleanup(): void {
    clearInterval(this.updateInterval);
    if (this.source) {
      this.source.onended = null;
    }
    try {
      this.source?.stop();
      this.source?.disconnect();
    } catch {}
    try {
      this.filters.forEach(f => {
        f.frequency.cancelScheduledValues(0);
        f.disconnect();
      });
    } catch {}
    try {
      this.analyser?.disconnect();
    } catch {}
    try {
      this.volumeGain?.disconnect();
    } catch {}
    try {
      this.volumeGain?.gain.cancelScheduledValues(0);
    } catch {}
    try {
      this.outputGain?.disconnect();
    } catch {}
    try {
      this.fadeGain?.disconnect();
    } catch {}
    try {
      this.fadeGain?.gain.cancelScheduledValues(0);
    } catch {}
    this.source = null;
    this.filters = [];
    this.analyser = null;
    this.volumeGain = null;
    this.outputGain = null;
    this.fadeGain = null;
  }

  private buildGraph(ctx: AudioContext): void {
    const source = ctx.createBufferSource();
    source.buffer = this.buffer!;
    this.source = source;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    this.analyser = analyser;

    const volumeGain = ctx.createGain();
    this.volumeGain = volumeGain;

    // Static headroom: ~-2.5 dBFS (0.75) to prevent filter overshoot (1.059/1.078) from hard-clipping.
    // More aggressive than -1dB to clean 24/48 dB (12 was already clean at -1dB, 48 peaked at 0.96).
    // Consistent gain for entire signal, no limiter/compressor, applied to playback and offline.
    const outputGain = ctx.createGain();
    outputGain.gain.value = 0.75; // -2.5 dB ≈ 0.75, approx -2 to -3 dB range
    this.outputGain = outputGain;

    const fadeGain = ctx.createGain();
    fadeGain.gain.value = 1;
    this.fadeGain = fadeGain;

    if (this.filterEnabled) {
      this.filters = createFilterChain(ctx, this.filterSlope);
      source.connect(this.filters[0]);
      this.filters[this.filters.length - 1].connect(volumeGain);
    } else {
      this.filters = [];
      source.connect(volumeGain);
    }
    volumeGain.connect(analyser);
    analyser.connect(outputGain);
    outputGain.connect(fadeGain);
    fadeGain.connect(ctx.destination);
  }

  private scheduleFilterAutomation(bufStartTime: number): void {
    if (!this.audioContext || this.filters.length === 0) return;

    const acNow = this.audioContext.currentTime;
    const step = 0.005;
    const rampDuration = 0.007;

    for (const filter of this.filters) {
      filter.frequency.cancelScheduledValues(0);

      const trimTime = bufStartTime - this.trimStart;
      const initialFreq = Math.max(1, evaluateAutomation(this.automationPoints, trimTime, interpolate));
      filter.frequency.setValueAtTime(initialFreq, acNow);

      for (let t = bufStartTime + step; t <= this.trimEnd; t += step) {
        const trimT = t - this.trimStart;
        const freq = Math.max(1, evaluateAutomation(this.automationPoints, trimT, interpolate));
        const rampEnd = acNow + (t - bufStartTime) + rampDuration;
        filter.frequency.exponentialRampToValueAtTime(freq, rampEnd);
      }
    }
  }

  private rescheduleFilter(): void {
    if (this.state !== 'playing' || !this.audioContext || this.filters.length === 0) return;
    const bufTime = this.pauseTime + (this.audioContext.currentTime - this.startTime);
    this.scheduleFilterAutomation(bufTime);
  }

  private scheduleVolumeAutomation(bufStartTime: number): void {
    if (!this.audioContext || !this.volumeGain) return;

    const acNow = this.audioContext.currentTime;
    const step = 0.005;
    const rampDuration = 0.007;

    const gainNode = this.volumeGain;
    gainNode.gain.cancelScheduledValues(0);

    const trimTime = bufStartTime - this.trimStart;
    const initialGain = evaluateVolumeAutomation(this.volumePoints, Math.max(0, trimTime), interpolateVolume);
    gainNode.gain.setValueAtTime(Math.max(0, Math.min(2, initialGain)), acNow);

    for (let t = bufStartTime + step; t <= this.trimEnd; t += step) {
      const trimT = t - this.trimStart;
      const gain = evaluateVolumeAutomation(this.volumePoints, Math.max(0, trimT), interpolateVolume);
      const rampEnd = acNow + (t - bufStartTime) + rampDuration;
      gainNode.gain.linearRampToValueAtTime(Math.max(0, Math.min(2, gain)), rampEnd);
    }
  }

  private rescheduleVolume(): void {
    if (this.state !== 'playing' || !this.audioContext || !this.volumeGain) return;
    const bufTime = this.pauseTime + (this.audioContext.currentTime - this.startTime);
    this.scheduleVolumeAutomation(bufTime);
  }

  private scheduleFadeAutomation(bufStartTime: number): void {
    if (!this.audioContext || !this.fadeGain) return;
    const acNow = this.audioContext.currentTime;
    const fadeSec = 0.005;
    const trimDuration = this.trimEnd - Math.max(this.trimStart, bufStartTime);
    // Start at 0, ramp to 1 over fadeSec, hold, then ramp to 0 at end
    this.fadeGain.gain.cancelScheduledValues(0);
    this.fadeGain.gain.setValueAtTime(0, acNow);
    this.fadeGain.gain.linearRampToValueAtTime(1, acNow + fadeSec);
    if (trimDuration > fadeSec * 2) {
      this.fadeGain.gain.setValueAtTime(1, acNow + trimDuration - fadeSec);
      this.fadeGain.gain.linearRampToValueAtTime(0, acNow + trimDuration);
    } else {
      // Very short clip: just stay at 1 and ramp out at end
      this.fadeGain.gain.setValueAtTime(1, acNow + fadeSec);
      this.fadeGain.gain.linearRampToValueAtTime(0, acNow + trimDuration);
    }
  }

  private startUpdateLoop(): void {
    clearInterval(this.updateInterval);
    this.updateInterval = window.setInterval(() => {
      if (this.state === 'playing') {
        const trimTime = this.getCurrentTime();
        if (trimTime >= this.getTrimDuration()) {
          this.stop();
          this.callbacks.onEnd();
        } else {
          this.callbacks.onTimeUpdate(trimTime);
        }
      }
    }, 16);
  }

  destroy(): void {
    this.cleanup();
    this.audioContext?.close();
    this.audioContext = null;
  }
}