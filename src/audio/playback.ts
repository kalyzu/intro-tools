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

  constructor(callbacks: PlaybackCallbacks) {
    this.callbacks = callbacks;
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
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
      return this.pauseTime + (this.audioContext.currentTime - this.startTime);
    }
    return this.pauseTime;
  }

  play(startFrom?: number): void {
    if (!this.buffer) return;

    if (this.state === 'paused' && startFrom === undefined) {
      this.resume();
      return;
    }

    this.stop();

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

    const offset = startFrom ?? this.pauseTime;
    this.startTime = this.audioContext.currentTime;
    this.pauseTime = offset;

    this.scheduleFilterAutomation(offset);

    this.source.start(0, offset);
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
    this.pauseTime = this.getCurrentTime();
    this.cleanup();
    this.state = 'paused';
    this.callbacks.onStateChange(this.state);
  }

  stop(): void {
    this.pauseTime = 0;
    this.cleanup();
    this.state = 'stopped';
    this.callbacks.onStateChange(this.state);
    this.callbacks.onTimeUpdate(0);
  }

  seek(time: number): void {
    const wasPlaying = this.state === 'playing';
    if (wasPlaying) {
      this.pause();
    }
    this.pauseTime = Math.max(0, Math.min(time, this.buffer?.duration ?? 0));
    this.callbacks.onTimeUpdate(this.pauseTime);
    if (wasPlaying) {
      this.play(this.pauseTime);
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

  private scheduleFilterAutomation(startOffset: number): void {
    if (!this.audioContext || this.filters.length === 0) return;

    const duration = this.buffer?.duration ?? 0;
    const acNow = this.audioContext.currentTime;
    const step = 0.005;
    const rampDuration = 0.007;

    for (const filter of this.filters) {
      filter.frequency.cancelScheduledValues(0);

      const initialFreq = Math.max(1, evaluateAutomation(this.automationPoints, startOffset, interpolate));
      filter.frequency.setValueAtTime(initialFreq, acNow);

      for (let t = startOffset + step; t <= duration; t += step) {
        const freq = Math.max(1, evaluateAutomation(this.automationPoints, t, interpolate));
        const rampEnd = acNow + (t - startOffset) + rampDuration;
        filter.frequency.exponentialRampToValueAtTime(freq, rampEnd);
      }
    }
  }

  private rescheduleFilter(): void {
    if (this.state !== 'playing' || !this.audioContext || this.filters.length === 0) return;
    const currentTime = this.getCurrentTime();
    this.scheduleFilterAutomation(currentTime);
  }

  private startUpdateLoop(): void {
    clearInterval(this.updateInterval);
    this.updateInterval = window.setInterval(() => {
      if (this.state === 'playing') {
        this.callbacks.onTimeUpdate(this.getCurrentTime());
      }
    }, 16);
  }

  destroy(): void {
    this.cleanup();
    this.audioContext?.close();
    this.audioContext = null;
  }
}
