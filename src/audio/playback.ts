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
  private animationFrame = 0;
  private automationPoints: AutomationPoint[] = [];
  private filterSlope: FilterSlope = 24;
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

  getTrimDuration(): number {
    return this.trimEnd - this.trimStart;
  }

  setAutomationPoints(points: AutomationPoint[]): void {
    this.automationPoints = points;
    if (this.state === 'playing') {
      this.rescheduleFilter();
    }
  }

  setFilterSlope(slope: FilterSlope): void {
    this.filterSlope = slope;
  }

  getState(): PlaybackState {
    return this.state;
  }

  getCurrentTime(): number {
    if (this.state === 'playing' && this.audioContext) {
      const bufTime = this.pauseTime + (this.audioContext.currentTime - this.startTime);
      return bufTime - this.trimStart;
    }
    return this.pauseTime - this.trimStart;
  }

  play(startFromTrim?: number): void {
    if (!this.buffer) return;

    if (this.state === 'paused' && startFromTrim === undefined) {
      this.resume();
      return;
    }

    this.stop();

    const offset = (startFromTrim ?? (this.pauseTime - this.trimStart)) + this.trimStart;
    const clampedOffset = Math.max(this.trimStart, Math.min(this.trimEnd, offset));

    this.audioContext = new AudioContext();
    this.source = this.audioContext.createBufferSource();
    this.source.buffer = this.buffer;

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;

    this.filters = createFilterChain(this.audioContext, this.filterSlope);
    const lastFilter = this.filters[this.filters.length - 1];

    this.source.connect(this.filters[0]);
    lastFilter.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    this.startTime = this.audioContext.currentTime;
    this.pauseTime = clampedOffset;

    this.scheduleFilterAutomation(clampedOffset);

    this.source.start(0, clampedOffset);
    this.state = 'playing';
    this.callbacks.onStateChange(this.state);

    this.source.onended = () => {
      if (this.state === 'playing') {
        this.stop();
        this.callbacks.onEnd();
      }
    };

    this.startUpdateLoop();
  }

  private resume(): void {
    if (!this.audioContext || !this.buffer) return;

    this.source = this.audioContext.createBufferSource();
    this.source.buffer = this.buffer;

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;

    this.filters = createFilterChain(this.audioContext, this.filterSlope);
    const lastFilter = this.filters[this.filters.length - 1];

    this.source.connect(this.filters[0]);
    lastFilter.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    this.startTime = this.audioContext.currentTime;
    this.scheduleFilterAutomation(this.pauseTime);

    this.source.start(0, this.pauseTime);
    this.state = 'playing';
    this.callbacks.onStateChange(this.state);

    this.source.onended = () => {
      if (this.state === 'playing') {
        this.stop();
        this.callbacks.onEnd();
      }
    };

    this.startUpdateLoop();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    const bufTime = this.pauseTime + (this.audioContext!.currentTime - this.startTime);
    this.pauseTime = bufTime;
    this.cleanup();
    this.state = 'paused';
    this.callbacks.onStateChange(this.state);
  }

  stop(): void {
    this.pauseTime = this.trimStart;
    this.cleanup();
    this.state = 'stopped';
    this.callbacks.onStateChange(this.state);
    this.callbacks.onTimeUpdate(0);
  }

  seek(trimTime: number): void {
    const wasPlaying = this.state === 'playing';
    if (wasPlaying) {
      this.pause();
    }
    const clamped = Math.max(0, Math.min(this.getTrimDuration(), trimTime));
    this.pauseTime = clamped + this.trimStart;
    this.callbacks.onTimeUpdate(clamped);
    if (wasPlaying) {
      this.play(clamped);
    }
  }

  private cleanup(): void {
    cancelAnimationFrame(this.animationFrame);
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
