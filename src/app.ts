import type { AutomationPoint } from './automation/model';
import { sortPoints } from './automation/model';
import { createDefaultAutomation } from './automation/defaults';
import { decodeAudioFile, type DecodedAudio } from './audio/decoder';
import { PlaybackEngine, type PlaybackState } from './audio/playback';
import { renderOffline } from './audio/renderer';
import { WaveformRenderer } from './waveform/renderer';
import { AutomationEditor } from './ui/automation-editor';
import type { FilterSlope } from './audio/filter';

class LowPassEditor {
  private decodedAudio: DecodedAudio | null = null;
  private automationPoints: AutomationPoint[] = [];
  private playbackEngine: PlaybackEngine;
  private waveformRenderer: WaveformRenderer | null = null;
  private automationEditor: AutomationEditor | null = null;
  private filterSlope: FilterSlope = 24;
  private fadeInDuration = 1.0;
  private fadeOutDuration = 1.0;
  private undoStack: AutomationPoint[][] = [];
  private redoStack: AutomationPoint[][] = [];
  private maxUndoSize = 50;
  constructor() {
    this.playbackEngine = new PlaybackEngine({
      onTimeUpdate: (t) => this.onTimeUpdate(t),
      onStateChange: (s) => this.onStateChange(s),
      onEnd: () => this.onPlaybackEnd(),
    });

    this.setupUI();
    this.setupKeyboardShortcuts();
  }

  private setupUI(): void {
    const dropZone = document.getElementById('drop-zone')!;
    const fileInput = document.getElementById('file-input') as HTMLInputElement;
    const openBtn = document.getElementById('open-btn')!;

    openBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.loadFile(file);
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file) this.loadFile(file);
    });

    const playBtn = document.getElementById('play-btn')!;
    const stopBtn = document.getElementById('stop-btn')!;
    const exportBtn = document.getElementById('export-btn')!;

    playBtn.addEventListener('click', () => this.togglePlayback());
    stopBtn.addEventListener('click', () => this.stopPlayback());
    exportBtn.addEventListener('click', () => this.exportAudio());

    const slopeSelect = document.getElementById('slope-select') as HTMLSelectElement;
    slopeSelect.addEventListener('change', () => {
      this.filterSlope = parseInt(slopeSelect.value) as FilterSlope;
      this.playbackEngine.setFilterSlope(this.filterSlope);
    });

    const fadeInInput = document.getElementById('fade-in') as HTMLInputElement;
    const fadeOutInput = document.getElementById('fade-out') as HTMLInputElement;

    fadeInInput.addEventListener('change', () => {
      this.fadeInDuration = parseFloat(fadeInInput.value) || 1.0;
      this.applyFadeDurations();
    });
    fadeOutInput.addEventListener('change', () => {
      this.fadeOutDuration = parseFloat(fadeOutInput.value) || 1.0;
      this.applyFadeDurations();
    });

    const waveformCanvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
    this.waveformRenderer = new WaveformRenderer(waveformCanvas);

    waveformCanvas.addEventListener('click', (e) => {
      if (!this.decodedAudio) return;
      const rect = waveformCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = (x / rect.width) * this.decodedAudio.duration;
      this.playbackEngine.seek(time);
    });

    const autoCanvas = document.getElementById('automation-canvas') as HTMLCanvasElement;
    this.automationEditor = new AutomationEditor(autoCanvas, {
      onPointsChange: (points) => this.onPointsChange(points),
      onPointSelect: (index) => this.onPointSelect(index),
      onSeek: (time) => this.playbackEngine.seek(time),
    });
  }

  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayback();
      }

      if (e.code === 'Enter') {
        e.preventDefault();
        this.togglePlayback();
      }

      if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      }

      if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        this.redo();
      }

      if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.redo();
      }
    });
  }

  private async loadFile(file: File): Promise<void> {
    try {
      this.decodedAudio = await decodeAudioFile(file);

      document.getElementById('file-name')!.textContent = file.name;
      document.getElementById('file-duration')!.textContent =
        `${this.decodedAudio.duration.toFixed(2)}s`;
      document.getElementById('clip-info')!.style.display = 'flex';
      document.getElementById('drop-zone')!.style.display = 'none';
      document.getElementById('editor-area')!.style.display = 'flex';

      this.automationPoints = createDefaultAutomation(this.decodedAudio.duration);
      this.pushUndo();

      this.playbackEngine.setBuffer(this.decodedAudio.buffer);
      this.playbackEngine.setAutomationPoints(this.automationPoints);
      this.playbackEngine.setFilterSlope(this.filterSlope);

      this.waveformRenderer!.setBuffer(this.decodedAudio.buffer);
      this.automationEditor!.setDuration(this.decodedAudio.duration);
      this.automationEditor!.setPoints(this.automationPoints);
    } catch (err) {
      console.error('Failed to load audio:', err);
      alert('Failed to load audio file. Please try a different format.');
    }
  }

  private onPointsChange(points: AutomationPoint[]): void {
    this.automationPoints = sortPoints(points);
    this.playbackEngine.setAutomationPoints(this.automationPoints);
    this.pushUndo();
  }

  private onPointSelect(_index: number | null): void {
  }

  private onTimeUpdate(time: number): void {
    this.waveformRenderer?.setPlayhead(time);
    this.automationEditor?.setPlayhead(time);

    const timeDisplay = document.getElementById('time-display');
    if (timeDisplay) {
      timeDisplay.textContent = `${time.toFixed(2)}s`;
    }
  }

  private onStateChange(state: PlaybackState): void {
    const playBtn = document.getElementById('play-btn')!;
    if (state === 'playing') {
      playBtn.textContent = '⏸ Pause';
      this.waveformRenderer?.setPlaying(true);
    } else {
      playBtn.textContent = '▶ Play';
      this.waveformRenderer?.setPlaying(false);
    }
  }

  private onPlaybackEnd(): void {
    this.waveformRenderer?.setPlayhead(0);
    this.automationEditor?.setPlayhead(0);
  }

  private togglePlayback(): void {
    if (!this.decodedAudio) return;
    if (this.playbackEngine.getState() === 'playing') {
      this.playbackEngine.pause();
    } else {
      this.playbackEngine.play();
    }
  }

  private stopPlayback(): void {
    this.playbackEngine.stop();
    this.waveformRenderer?.setPlayhead(0);
    this.automationEditor?.setPlayhead(0);
  }

  private applyFadeDurations(): void {
    if (!this.decodedAudio) return;
    const duration = this.decodedAudio.duration;

    this.automationPoints = createDefaultAutomation(
      duration,
      this.fadeInDuration,
      this.fadeOutDuration
    );

    this.playbackEngine.setAutomationPoints(this.automationPoints);
    this.automationEditor!.setPoints(this.automationPoints);
    this.pushUndo();
  }

  private async exportAudio(): Promise<void> {
    if (!this.decodedAudio) return;

    const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
    const originalText = exportBtn.textContent;
    exportBtn.textContent = 'Exporting...';
    exportBtn.disabled = true;

    try {
      const blob = await renderOffline(
        this.decodedAudio.buffer,
        this.automationPoints,
        this.filterSlope
      );

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = document.getElementById('file-name')!.textContent.replace(/\.[^.]+$/, '');
      a.download = `${baseName}_filtered.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed. Please try again.');
    } finally {
      exportBtn.textContent = originalText;
      exportBtn.disabled = false;
    }
  }

  private pushUndo(): void {
    this.undoStack.push(this.automationPoints.map(p => ({ ...p })));
    if (this.undoStack.length > this.maxUndoSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  private undo(): void {
    if (this.undoStack.length <= 1) return;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    const prev = this.undoStack[this.undoStack.length - 1];
    this.restoreState(prev);
  }

  private redo(): void {
    if (this.redoStack.length === 0) return;
    const next = this.redoStack.pop()!;
    this.undoStack.push(next);
    this.restoreState(next);
  }

  private restoreState(points: AutomationPoint[]): void {
    this.automationPoints = points.map(p => ({ ...p }));
    this.playbackEngine.setAutomationPoints(this.automationPoints);
    this.automationEditor!.setPoints(this.automationPoints);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new LowPassEditor();
});
