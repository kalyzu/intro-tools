import type { AutomationPoint } from '../automation/model';
import type { FilterSlope } from './filter';
import { createFilterChain } from './filter';
import { evaluateAutomation } from '../automation/model';
import { interpolate } from '../automation/interpolation';

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
  private buffer: AudioBuffer | null = null;
  private state: PlaybackState = 'stopped';
  private startTime = 0;
  private pauseTime = 0;
  private homeTime = 0;
  private automationPoints: AutomationPoint[] = [];
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
    this.source = null;
    this.filters = [];
    this.analyser = null;
  }

  private buildGraph(ctx: AudioContext): void {
    const source = ctx.createBufferSource();
    source.buffer = this.buffer!;
    this.source = source;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    this.analyser = analyser;

    if (this.filterEnabled) {
      this.filters = createFilterChain(ctx, this.filterSlope);
      source.connect(this.filters[0]);
      this.filters[this.filters.length - 1].connect(analyser);
    } else {
      this.filters = [];
      source.connect(analyser);
    }
    analyser.connect(ctx.destination);
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