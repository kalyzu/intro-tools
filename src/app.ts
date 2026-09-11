import type { AutomationPoint, Marker, ViewState } from './automation/model';
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
  private undoStack: AutomationPoint[][] = [];
  private redoStack: AutomationPoint[][] = [];
  private maxUndoSize = 50;

  private trimStart = 0;
  private trimEnd = 0;
  private markers: Marker[] = [];
  private nextMarkerId = 1;
  private selectedMarkerId: number | null = null;
  private view: ViewState = { viewStart: 0, viewEnd: 10 };

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
    const exportAudioBtn = document.getElementById('export-audio-btn')!;
    const exportTimestampsBtn = document.getElementById('export-timestamps-btn')!;

    playBtn.addEventListener('click', () => this.togglePlayback());
    stopBtn.addEventListener('click', () => this.stopPlayback());
    exportAudioBtn.addEventListener('click', () => this.exportAudio());
    exportTimestampsBtn.addEventListener('click', () => this.exportTimestamps());

    const slopeSelect = document.getElementById('slope-select') as HTMLSelectElement;
    slopeSelect.addEventListener('change', () => {
      this.filterSlope = parseInt(slopeSelect.value) as FilterSlope;
      this.playbackEngine.setFilterSlope(this.filterSlope);
    });

    const waveformCanvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
    this.waveformRenderer = new WaveformRenderer(waveformCanvas);

    this.waveformRenderer.setTrimChangeCallback((start, end) => {
      this.trimStart = start;
      this.trimEnd = end;
      this.playbackEngine.setTrim(start, end);
      this.updateTrimDisplay();
    });

    this.waveformRenderer.setMarkerCallbacks(
      (time) => this.addMarker(time),
      (id, time) => this.moveMarker(id, time),
      (id) => this.selectMarker(id),
    );

    this.waveformRenderer.setSeekCallback((time) => {
      this.playbackEngine.seek(time);
    });

    const autoCanvas = document.getElementById('automation-canvas') as HTMLCanvasElement;
    this.automationEditor = new AutomationEditor(autoCanvas, {
      onPointsChange: (points) => this.onPointsChange(points),
      onPointSelect: (_index) => {},
      onSeek: (time) => this.playbackEngine.seek(time),
    });

    const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement;
    zoomSlider.addEventListener('input', () => {
      this.updateZoom(parseFloat(zoomSlider.value));
    });

    const zoomResetBtn = document.getElementById('zoom-reset-btn')!;
    zoomResetBtn.addEventListener('click', () => {
      if (!this.decodedAudio) return;
      this.view = { viewStart: 0, viewEnd: this.decodedAudio.duration };
      this.syncView();
      zoomSlider.value = '1';
    });
  }

  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

      if (e.code === 'Space') {
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

      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedMarkerId !== null) {
        e.preventDefault();
        this.deleteMarker(this.selectedMarkerId);
      }
    });
  }

  private async loadFile(file: File): Promise<void> {
    try {
      this.decodedAudio = await decodeAudioFile(file);

      document.getElementById('file-name')!.textContent = file.name;
      document.getElementById('clip-info')!.style.display = 'flex';
      document.getElementById('drop-zone')!.style.display = 'none';
      document.getElementById('editor-area')!.style.display = 'flex';

      this.trimStart = 0;
      this.trimEnd = this.decodedAudio.duration;
      this.view = { viewStart: 0, viewEnd: this.decodedAudio.duration };
      this.markers = [];
      this.nextMarkerId = 1;
      this.selectedMarkerId = null;

      this.automationPoints = createDefaultAutomation(this.getTrimDuration());
      this.pushUndo();

      this.playbackEngine.setBuffer(this.decodedAudio.buffer);
      this.playbackEngine.setTrim(this.trimStart, this.trimEnd);
      this.playbackEngine.setAutomationPoints(this.automationPoints);
      this.playbackEngine.setFilterSlope(this.filterSlope);

      this.waveformRenderer!.setBuffer(this.decodedAudio.buffer);
      this.waveformRenderer!.setView(this.view);
      this.waveformRenderer!.setTrim(this.trimStart, this.trimEnd);
      this.waveformRenderer!.setMarkers(this.markers);

      this.automationEditor!.setDuration(this.getTrimDuration());
      this.automationEditor!.setView(this.view);
      this.automationEditor!.setPoints(this.automationPoints);

      this.updateTrimDisplay();
      this.updateExportButtons();
    } catch (err) {
      console.error('Failed to load audio:', err);
      alert('Failed to load audio file. Please try a different format.');
    }
  }

  private getTrimDuration(): number {
    return this.trimEnd - this.trimStart;
  }

  private updateTrimDisplay(): void {
    const trimDurationEl = document.getElementById('trim-duration');
    if (trimDurationEl) {
      trimDurationEl.textContent = this.getTrimDuration().toFixed(2) + 's';
    }
    this.automationEditor?.setDuration(this.getTrimDuration());
    this.automationEditor?.setPoints(this.automationPoints);
  }

  private updateExportButtons(): void {
    const hasMarkers = this.markers.length > 0;
    const exportTimestampsBtn = document.getElementById('export-timestamps-btn') as HTMLButtonElement;
    if (exportTimestampsBtn) {
      exportTimestampsBtn.disabled = !hasMarkers;
      exportTimestampsBtn.style.opacity = hasMarkers ? '1' : '0.4';
    }
  }

  private syncView(): void {
    this.waveformRenderer?.setView(this.view);
    this.automationEditor?.setView(this.view);
  }

  private updateZoom(zoom: number): void {
    if (!this.decodedAudio) return;
    const fullDuration = this.decodedAudio.duration;
    const viewDuration = fullDuration / zoom;
    const center = (this.view.viewStart + this.view.viewEnd) / 2;
    const half = viewDuration / 2;
    this.view = {
      viewStart: Math.max(0, center - half),
      viewEnd: Math.min(fullDuration, center + half),
    };
    this.syncView();
  }

  private addMarker(time: number): void {
    const marker: Marker = { id: this.nextMarkerId++, time };
    this.markers.push(marker);
    this.markers.sort((a, b) => a.time - b.time);
    this.selectedMarkerId = marker.id;
    this.waveformRenderer?.setMarkers(this.markers);
    this.waveformRenderer?.setSelectedMarker(marker.id);
    this.updateMarkerDisplay();
    this.updateExportButtons();
  }

  private moveMarker(id: number, time: number): void {
    const marker = this.markers.find(m => m.id === id);
    if (!marker) return;
    marker.time = time;
    this.markers.sort((a, b) => a.time - b.time);
    this.waveformRenderer?.setMarkers(this.markers);
    this.updateMarkerDisplay();
  }

  private selectMarker(id: number | null): void {
    this.selectedMarkerId = id;
    this.waveformRenderer?.setSelectedMarker(id);
    this.updateMarkerDisplay();
  }

  private deleteMarker(id: number): void {
    this.markers = this.markers.filter(m => m.id !== id);
    this.selectedMarkerId = null;
    this.waveformRenderer?.setMarkers(this.markers);
    this.waveformRenderer?.setSelectedMarker(null);
    this.updateMarkerDisplay();
    this.updateExportButtons();
  }

  private updateMarkerDisplay(): void {
    const el = document.getElementById('marker-display');
    if (!el) return;
    if (this.selectedMarkerId !== null) {
      const marker = this.markers.find(m => m.id === this.selectedMarkerId);
      if (marker) {
        el.textContent = `Marker: ${marker.time.toFixed(3)}s`;
        el.style.display = 'block';
        return;
      }
    }
    el.style.display = 'none';
  }

  private onPointsChange(points: AutomationPoint[]): void {
    this.automationPoints = sortPoints(points);
    this.playbackEngine.setAutomationPoints(this.automationPoints);
    this.pushUndo();
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
    } else {
      playBtn.textContent = '▶ Play';
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
      this.playbackEngine.play(0);
    }
  }

  private stopPlayback(): void {
    this.playbackEngine.stop();
    this.waveformRenderer?.setPlayhead(0);
    this.automationEditor?.setPlayhead(0);
  }

  private async exportAudio(): Promise<void> {
    if (!this.decodedAudio) return;

    const btn = document.getElementById('export-audio-btn') as HTMLButtonElement;
    const originalText = btn.textContent;
    btn.textContent = 'Exporting...';
    btn.disabled = true;

    try {
      const blob = await renderOffline(
        this.decodedAudio.buffer,
        this.automationPoints,
        this.filterSlope,
        this.trimStart,
        this.trimEnd
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
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }

  private exportTimestamps(): void {
    if (this.markers.length === 0) return;

    const lines = this.markers.map(m => m.time.toFixed(6));
    const content = lines.join('\n') + '\n';
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = document.getElementById('file-name')!.textContent.replace(/\.[^.]+$/, '');
    a.download = `${baseName}_timestamps.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
