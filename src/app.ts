import type { AutomationPoint, Marker, ViewState } from './automation/model';
import { sortPoints, clampTime } from './automation/model';
import { createDefaultAutomation } from './automation/defaults';
import { decodeAudioFile, trimAudioBuffer, type DecodedAudio } from './audio/decoder';
import { PlaybackEngine, type PlaybackState } from './audio/playback';
import { renderOffline } from './audio/renderer';
import { WaveformRenderer } from './waveform/renderer';
import { AutomationEditor } from './ui/automation-editor';
import type { FilterSlope } from './audio/filter';
import moonIcon from '../img/moon.svg';
import sunIcon from '../img/sun.svg';

type Mode = 'trim' | 'markers' | 'filter';

class LowPassEditor {
  private decodedAudio: DecodedAudio | null = null;
  private trimmedBuffer: AudioBuffer | null = null;
  private mode: Mode = 'trim';

  private automationPoints: AutomationPoint[] = [];
  private automationCustomized = false;
  private playbackEngine: PlaybackEngine;
  private trimWaveform: WaveformRenderer | null = null;
  private markerWaveform: WaveformRenderer | null = null;
  private refWaveform: WaveformRenderer | null = null;
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
    this.showModeScreen();
  }

  private setupUI(): void {
    const dropZone = document.getElementById('drop-zone')!;
    const fileInput = document.getElementById('file-input') as HTMLInputElement;
    const openBtn = document.getElementById('open-btn')!;

    this.setupThemeToggle();
    this.setupInfoPopup();

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

    const trimPlayBtn = document.getElementById('trim-play-btn')!;
    const trimStopBtn = document.getElementById('trim-stop-btn')!;
    const markerPlayBtn = document.getElementById('marker-play-btn')!;
    const markerStopBtn = document.getElementById('marker-stop-btn')!;
    const filterPlayBtn = document.getElementById('filter-play-btn')!;
    const filterStopBtn = document.getElementById('filter-stop-btn')!;
    trimPlayBtn.addEventListener('click', () => this.togglePlayback());
    trimStopBtn.addEventListener('click', () => this.stopPlayback());
    markerPlayBtn.addEventListener('click', () => this.togglePlayback());
    markerStopBtn.addEventListener('click', () => this.stopPlayback());
    filterPlayBtn.addEventListener('click', () => this.togglePlayback());
    filterStopBtn.addEventListener('click', () => this.stopPlayback());

    const continueBtn = document.getElementById('continue-btn') as HTMLButtonElement;
    const backBtn = document.getElementById('back-btn')!;
    const filterContinueBtn = document.getElementById('filter-continue-btn')!;
    const markerBackBtn = document.getElementById('marker-back-btn')!;
    continueBtn.addEventListener('click', () => this.enterFilter());
    backBtn.addEventListener('click', () => this.backToTrim());
    filterContinueBtn.addEventListener('click', () => this.enterMarkers());
    markerBackBtn.addEventListener('click', () => this.backToFilter());

    const exportAudioBtn = document.getElementById('export-audio-btn')!;
    const exportTimestampsBtn = document.getElementById('export-timestamps-btn')!;
    exportAudioBtn.addEventListener('click', () => this.exportAudio());
    exportTimestampsBtn.addEventListener('click', () => this.exportTimestamps());

    const slopeSelect = document.getElementById('slope-select') as HTMLSelectElement;
    slopeSelect.addEventListener('change', () => {
      this.filterSlope = parseInt(slopeSelect.value) as FilterSlope;
      this.playbackEngine.setFilterSlope(this.filterSlope);
      this.updateExportInfo();
    });

    const trimCanvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
    this.trimWaveform = new WaveformRenderer(trimCanvas);
    this.trimWaveform.setTrimChangeCallback((start, end) => this.onTrimChange(start, end));
    this.trimWaveform.setSeekCallback((time) => {
      this.playbackEngine.seek(this.clampTrimTime(time - this.trimStart));
      this.updateHomeLines();
    });

    const markerCanvas = document.getElementById('marker-canvas') as HTMLCanvasElement;
    this.markerWaveform = new WaveformRenderer(markerCanvas);
    this.markerWaveform.setTrimVisible(false);
    this.markerWaveform.setMarkerCallbacks(
      (time) => this.addMarker(time),
      (id, time) => this.moveMarker(id, time),
      (id) => this.selectMarker(id),
    );
    this.markerWaveform.setSeekCallback((time) => {
      this.playbackEngine.seek(this.clampTrimTime(time));
      this.updateHomeLines();
    });
    this.markerWaveform.setDeferSeekToDoubleClick(true);

    const refCanvas = document.getElementById('ref-waveform-canvas') as HTMLCanvasElement;
    this.refWaveform = new WaveformRenderer(refCanvas);
    this.refWaveform.setTrimVisible(false);
    this.refWaveform.setMarkersVisible(false);
    this.refWaveform.setSeekCallback((time) => {
      this.playbackEngine.seek(this.clampTrimTime(time));
      this.updateHomeLines();
    });

    this.trimWaveform.setZoomRequestCallback((center, factor, frac) => this.zoomAt(center, factor, frac));
    this.markerWaveform.setZoomRequestCallback((center, factor, frac) => this.zoomAt(center, factor, frac));
    this.refWaveform.setZoomRequestCallback((center, factor, frac) => this.zoomAt(center, factor, frac));
    this.trimWaveform.setPanRequestCallback((delta) => this.panView(delta));
    this.markerWaveform.setPanRequestCallback((delta) => this.panView(delta));
    this.refWaveform.setPanRequestCallback((delta) => this.panView(delta));

    const autoCanvas = document.getElementById('automation-canvas') as HTMLCanvasElement;
    this.automationEditor = new AutomationEditor(autoCanvas, {
      onPointsChange: (points) => this.onPointsChange(points),
      onPointSelect: () => {},
      onSeek: (time) => {
        this.playbackEngine.seek(this.clampTrimTime(time));
        this.updateHomeLines();
      },
    });
    this.automationEditor.setZoomRequestCallback((center, factor, frac) => this.zoomAt(center, factor, frac));
    this.automationEditor.setPanRequestCallback((delta) => this.panView(delta));

    const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement;
    const markerZoomSlider = document.getElementById('marker-zoom-slider') as HTMLInputElement;
    const filterZoomSlider = document.getElementById('filter-zoom-slider') as HTMLInputElement;
    zoomSlider.addEventListener('input', () => this.updateZoom(parseFloat(zoomSlider.value)));
    markerZoomSlider.addEventListener('input', () => this.updateZoom(parseFloat(markerZoomSlider.value)));
    filterZoomSlider.addEventListener('input', () => this.updateZoom(parseFloat(filterZoomSlider.value)));

    const zoomResetBtn = document.getElementById('zoom-reset-btn')!;
    const markerZoomResetBtn = document.getElementById('marker-zoom-reset-btn')!;
    const filterZoomResetBtn = document.getElementById('filter-zoom-reset-btn')!;
    zoomResetBtn.addEventListener('click', () => {
      zoomSlider.value = '1';
      this.updateZoom(1);
    });
    markerZoomResetBtn.addEventListener('click', () => {
      markerZoomSlider.value = '1';
      this.updateZoom(1);
    });
    filterZoomResetBtn.addEventListener('click', () => {
      filterZoomSlider.value = '1';
      this.updateZoom(1);
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

      if (e.code === 'KeyA' && this.mode === 'markers') {
        const hoverTime = this.markerWaveform?.getHoverTime();
        if (hoverTime !== null && hoverTime !== undefined) {
          e.preventDefault();
          this.addMarker(hoverTime);
        }
      }

      if (this.mode === 'markers' && (e.key === 'Delete' || e.key === 'Backspace') && this.selectedMarkerId !== null) {
        e.preventDefault();
        this.deleteMarker(this.selectedMarkerId);
      }
    });
  }

  private getTheme(): 'dark' | 'light' {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  private setTheme(theme: 'dark' | 'light'): void {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('lowpass-theme', theme); } catch {}
    (document.getElementById('theme-icon') as HTMLImageElement).src =
      theme === 'dark' ? moonIcon : sunIcon;
    this.trimWaveform?.render();
    this.markerWaveform?.render();
    this.refWaveform?.render();
    this.automationEditor?.render();
  }

  private setupThemeToggle(): void {
    this.setTheme(this.getTheme());
    document.getElementById('theme-toggle-btn')!.addEventListener('click', () => {
      this.setTheme(this.getTheme() === 'light' ? 'dark' : 'light');
    });
  }

  private setupInfoPopup(): void {
    const overlay = document.getElementById('info-overlay')!;
    const open = () => { overlay.hidden = false; };
    const close = () => { overlay.hidden = true; };

    document.getElementById('info-btn')!.addEventListener('click', open);
    document.getElementById('info-close-btn')!.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) close();
    });
  }

  private clampTrimTime(time: number): number {
    return Math.max(0, Math.min(this.getTrimDuration(), time));
  }

  private async loadFile(file: File): Promise<void> {
    try {
      this.playbackEngine.stop();
      this.decodedAudio = await decodeAudioFile(file);
      this.trimmedBuffer = null;

      document.getElementById('file-name')!.textContent = file.name;
      document.getElementById('clip-info')!.hidden = false;
      document.getElementById('drop-zone')!.hidden = true;
      document.getElementById('trim-content')!.hidden = false;

      this.trimStart = 0;
      this.trimEnd = this.decodedAudio.duration;
      this.markers = [];
      this.nextMarkerId = 1;
      this.selectedMarkerId = null;

      this.automationPoints = createDefaultAutomation(this.getTrimDuration());
      this.automationCustomized = false;
      this.pushUndo();

      this.playbackEngine.setBuffer(this.decodedAudio.buffer);
      this.playbackEngine.setTrim(this.trimStart, this.trimEnd);
      this.playbackEngine.setAutomationPoints(this.automationPoints);
      this.playbackEngine.setFilterSlope(this.filterSlope);

      this.trimWaveform!.setBuffer(this.decodedAudio.buffer);
      this.trimWaveform!.setTrim(this.trimStart, this.trimEnd);
      this.trimWaveform!.setMarkers(this.markers);

      this.automationEditor!.setDuration(this.getTrimDuration());
      this.automationEditor!.setPoints(this.automationPoints);

      this.mode = 'trim';
      this.showModeScreen();

      const continueBtn = document.getElementById('continue-btn') as HTMLButtonElement;
      continueBtn.disabled = false;
      this.updateTrimDisplay();
      this.updateExportButtons();
    } catch (err) {
      console.error('Failed to load audio:', err);
      alert('Failed to load audio file. Please try a different format.');
    }
  }

  private getTrimDuration(): number {
    if (this.mode === 'markers' || this.mode === 'filter') {
      return this.trimmedBuffer?.duration ?? 0;
    }
    return this.trimEnd - this.trimStart;
  }

  private getAxisDuration(): number {
    if (this.mode === 'trim') {
      return this.decodedAudio?.duration ?? 0;
    }
    return this.trimmedBuffer?.duration ?? 0;
  }

  private updateTrimDisplay(): void {
    const trimDurationEl = document.getElementById('trim-duration');
    if (trimDurationEl) {
      trimDurationEl.textContent = this.getTrimDuration().toFixed(2) + 's';
    }
  }

  private updateExportButtons(): void {
    const hasMarkers = this.markers.length > 0;
    const exportTimestampsBtn = document.getElementById('export-timestamps-btn') as HTMLButtonElement;
    if (exportTimestampsBtn) {
      exportTimestampsBtn.disabled = !hasMarkers;
    }
  }

  private updateExportInfo(): void {
    const buffer = this.trimmedBuffer ?? this.decodedAudio?.buffer ?? null;
    const durEl = document.getElementById('export-duration');
    const srEl = document.getElementById('export-samplerate');
    const chEl = document.getElementById('export-channels');
    const slopeEl = document.getElementById('export-slope');
    if (durEl) durEl.textContent = this.getTrimDuration().toFixed(2) + 's';
    if (srEl) srEl.textContent = buffer ? buffer.sampleRate + ' Hz' : '\u2014';
    if (chEl) chEl.textContent = buffer ? String(buffer.numberOfChannels) : '\u2014';
    if (slopeEl) slopeEl.textContent = `${this.filterSlope} dB/oct`;
  }

  private showModeScreen(): void {
    const isTrim = this.mode === 'trim';
    const isMarkers = this.mode === 'markers';
    const isFilter = this.mode === 'filter';

    (document.getElementById('screen-trim') as HTMLElement).hidden = !isTrim;
    (document.getElementById('screen-markers') as HTMLElement).hidden = !isMarkers;
    (document.getElementById('screen-filter') as HTMLElement).hidden = !isFilter;

    document.getElementById('step-trim-ind')!.classList.toggle('active', isTrim);
    document.getElementById('step-markers-ind')!.classList.toggle('active', isMarkers);
    document.getElementById('step-filter-ind')!.classList.toggle('active', isFilter);

    const stageLabel = document.getElementById('stage-label');
    if (stageLabel) {
      stageLabel.textContent =
        this.mode === 'trim'
          ? 'Step 1 of 3 · Trim the clip range'
          : this.mode === 'filter'
            ? 'Step 2 of 3 · Shape the low-pass cutoff'
            : 'Step 3 of 3 · Place markers & export';
    }

    this.automationEditor?.setActive(isFilter);
    this.playbackEngine.setFilterEnabled(!isTrim);

    (document.getElementById('zoom-slider') as HTMLInputElement).value = '1';
    (document.getElementById('marker-zoom-slider') as HTMLInputElement).value = '1';
    (document.getElementById('filter-zoom-slider') as HTMLInputElement).value = '1';

    const axisDuration = this.getAxisDuration();
    if (axisDuration > 0) {
      this.view = { viewStart: 0, viewEnd: axisDuration };
    }
    this.syncView();
  }

  private syncView(): void {
    this.updateHomeLines();
    if (this.mode === 'trim') {
      this.trimWaveform?.setView(this.view);
    } else if (this.mode === 'markers') {
      this.markerWaveform?.setView(this.view);
    } else {
      this.refWaveform?.setView(this.view);
      this.automationEditor?.setView(this.view);
    }
  }

  private updateHomeLines(): void {
    const home = this.playbackEngine.getHomeTime();
    this.trimWaveform?.setHomeTime(home + this.trimStart);
    this.markerWaveform?.setHomeTime(home);
    this.refWaveform?.setHomeTime(home);
    this.automationEditor?.setHomeTime(home);
  }

  private updateZoom(zoom: number): void {
    const axisDuration = this.getAxisDuration();
    if (axisDuration <= 0) return;

    const anchor = Math.max(0, Math.min(axisDuration, this.playbackEngine.getHomeTime()));
    const viewRange = Math.max(1e-6, this.view.viewEnd - this.view.viewStart);
    const frac = Math.max(0, Math.min(1, (anchor - this.view.viewStart) / viewRange));
    const viewWidth = axisDuration / Math.max(1, zoom);
    let viewStart = anchor - frac * viewWidth;
    let viewEnd = viewStart + viewWidth;
    if (viewStart < 0) {
      viewStart = 0;
      viewEnd = viewWidth;
    }
    if (viewEnd > axisDuration) {
      viewEnd = axisDuration;
      viewStart = axisDuration - viewWidth;
    }
    this.view = { viewStart, viewEnd };
    this.syncView();
  }

  private zoomAt(center: number, factor: number, frac = 0.5): void {
    const axisDuration = this.getAxisDuration();
    if (axisDuration <= 0) return;

    const current = axisDuration / Math.max(1e-6, this.view.viewEnd - this.view.viewStart);
    const zoom = Math.max(1, Math.min(50, current * factor));
    const viewWidth = axisDuration / zoom;
    const anchor = Math.max(0, Math.min(axisDuration, center));
    const f = Math.max(0, Math.min(1, frac));
    let viewStart = anchor - f * viewWidth;
    let viewEnd = viewStart + viewWidth;
    if (viewStart < 0) {
      viewStart = 0;
      viewEnd = viewWidth;
    }
    if (viewEnd > axisDuration) {
      viewEnd = axisDuration;
      viewStart = axisDuration - viewWidth;
    }
    this.view = { viewStart, viewEnd };

    const sliderId = this.mode === 'trim' ? 'zoom-slider' : this.mode === 'markers' ? 'marker-zoom-slider' : 'filter-zoom-slider';
    const slider = document.getElementById(sliderId) as HTMLInputElement | null;
    if (slider) slider.value = String(zoom);

    this.syncView();
  }

  private panView(delta: number): void {
    const axisDuration = this.getAxisDuration();
    if (axisDuration <= 0) return;
    const viewRange = this.view.viewEnd - this.view.viewStart;
    if (viewRange >= axisDuration) return;

    // division by 1500 instead of 250 for a more natural scroll amount
    const shift = delta * viewRange / 1500;
    let viewStart = this.view.viewStart + shift;
    let viewEnd = this.view.viewEnd + shift;
    if (viewStart < 0) {
      viewStart = 0;
      viewEnd = viewRange;
    }
    if (viewEnd > axisDuration) {
      viewEnd = axisDuration;
      viewStart = axisDuration - viewRange;
    }
    this.view = { viewStart, viewEnd };
    this.syncView();
  }

  private enterFilter(): void {
    if (!this.decodedAudio) return;
    this.playbackEngine.stop();

    const duration = this.trimEnd - this.trimStart;
    if (duration < 0.05) {
      alert('The trimmed region is too short (minimum 0.05s).');
      return;
    }

    this.trimmedBuffer = trimAudioBuffer(this.decodedAudio.buffer, this.trimStart, this.trimEnd);
    const trimmedDuration = this.trimmedBuffer.duration;

    this.markers = this.markers.filter(m => m.time <= trimmedDuration);
    if (this.selectedMarkerId !== null && !this.markers.some(m => m.id === this.selectedMarkerId)) {
      this.selectedMarkerId = null;
    }

    this.ensureAutomationFits(trimmedDuration);
    this.playbackEngine.setBuffer(this.trimmedBuffer);
    this.playbackEngine.setTrim(0, trimmedDuration);
    this.playbackEngine.setAutomationPoints(this.automationPoints);
    this.playbackEngine.setFilterSlope(this.filterSlope);

    this.refWaveform!.setBuffer(this.trimmedBuffer);
    this.markerWaveform!.setBuffer(this.trimmedBuffer);
    this.markerWaveform!.setTrim(0, trimmedDuration);
    this.markerWaveform!.setMarkers(this.markers);
    this.markerWaveform!.setSelectedMarker(this.selectedMarkerId);

    this.automationEditor!.setDuration(trimmedDuration);
    this.automationEditor!.setPoints(this.automationPoints);

    this.mode = 'filter';
    this.showModeScreen();
    this.updateTrimDisplay();
    this.updateExportInfo();
  }

  private backToTrim(): void {
    if (!this.decodedAudio) return;
    this.playbackEngine.stop();
    this.mode = 'trim';
    this.playbackEngine.setBuffer(this.decodedAudio.buffer);
    this.playbackEngine.setTrim(this.trimStart, this.trimEnd);
    this.showModeScreen();
    this.updateTrimDisplay();
  }

  private enterMarkers(): void {
    if (!this.trimmedBuffer) return;
    this.playbackEngine.stop();
    this.mode = 'markers';
    this.markerWaveform?.setMarkers(this.markers);
    this.markerWaveform?.setSelectedMarker(this.selectedMarkerId);
    this.showModeScreen();
    this.updateTrimDisplay();
    this.updateExportInfo();
    this.updateMarkerDisplay();
    this.updateExportButtons();
  }

  private backToFilter(): void {
    if (!this.trimmedBuffer) return;
    this.playbackEngine.stop();
    this.mode = 'filter';
    this.showModeScreen();
  }

  private ensureAutomationFits(duration: number): void {
    const deduped = new Map<number, AutomationPoint>();
    for (const p of this.automationPoints) {
      const clamped = { ...p, time: clampTime(p.time, duration) };
      deduped.set(clamped.time, clamped);
    }
    let points = sortPoints([...deduped.values()]);
    if (points.length < 2) {
      points = createDefaultAutomation(duration);
    }
    this.automationPoints = points;
    this.pushUndo();
  }

  private onTrimChange(start: number, end: number): void {
    this.trimStart = start;
    this.trimEnd = end;
    this.playbackEngine.setTrim(start, end);

    const duration = this.getTrimDuration();
    if (!this.automationCustomized) {
      this.automationPoints = createDefaultAutomation(duration);
      this.playbackEngine.setAutomationPoints(this.automationPoints);
      this.automationEditor?.setPoints(this.automationPoints);
    }
    this.automationEditor?.setDuration(duration);
    this.updateTrimDisplay();
  }

  private addMarker(time: number): void {
    const t = Math.max(0, Math.min(this.getTrimDuration(), time));
    const marker: Marker = { id: this.nextMarkerId++, time: t };
    this.markers.push(marker);
    this.markers.sort((a, b) => a.time - b.time);
    this.selectedMarkerId = marker.id;
    this.markerWaveform?.setMarkers(this.markers);
    this.markerWaveform?.setSelectedMarker(marker.id);
    this.updateMarkerDisplay();
    this.updateExportButtons();
  }

  private moveMarker(id: number, time: number): void {
    const marker = this.markers.find(m => m.id === id);
    if (!marker) return;
    marker.time = Math.max(0, Math.min(this.getTrimDuration(), time));
    this.markers.sort((a, b) => a.time - b.time);
    this.markerWaveform?.setMarkers(this.markers);
    this.updateMarkerDisplay();
  }

  private selectMarker(id: number | null): void {
    this.selectedMarkerId = id;
    this.markerWaveform?.setSelectedMarker(id);
    this.updateMarkerDisplay();
  }

  private deleteMarker(id: number): void {
    this.markers = this.markers.filter(m => m.id !== id);
    this.selectedMarkerId = null;
    this.markerWaveform?.setMarkers(this.markers);
    this.markerWaveform?.setSelectedMarker(null);
    this.updateMarkerDisplay();
    this.updateExportButtons();
  }

  private updateMarkerDisplay(): void {
    const el = document.getElementById('marker-display') as HTMLElement;
    if (!el) return;
    if (this.selectedMarkerId !== null) {
      const marker = this.markers.find(m => m.id === this.selectedMarkerId);
      if (marker) {
        el.textContent = `Marker: ${marker.time.toFixed(2)}s`;
        el.hidden = false;
        return;
      }
    }
    el.hidden = true;
  }

  private onPointsChange(points: AutomationPoint[]): void {
    this.automationPoints = sortPoints(points);
    this.automationCustomized = true;
    this.playbackEngine.setAutomationPoints(this.automationPoints);
    this.pushUndo();
  }

  private onTimeUpdate(time: number): void {
    if (this.mode === 'trim') {
      this.trimWaveform?.setPlayhead(time + this.trimStart);
    } else if (this.mode === 'markers') {
      this.markerWaveform?.setPlayhead(time);
    } else {
      this.refWaveform?.setPlayhead(time);
      this.automationEditor?.setPlayhead(time);
    }

    const trimDisplay = document.getElementById('trim-time-display');
    if (trimDisplay) {
      trimDisplay.textContent = `${time.toFixed(2)}s`;
    }
    const markerDisplay = document.getElementById('marker-time-display');
    if (markerDisplay) {
      markerDisplay.textContent = `${time.toFixed(2)}s`;
    }
    const filterDisplay = document.getElementById('filter-time-display');
    if (filterDisplay) {
      filterDisplay.textContent = `${time.toFixed(2)}s`;
    }
  }

  private onStateChange(state: PlaybackState): void {
    const label = state === 'playing' ? '⏸ Pause' : '▶ Play';
    document.getElementById('trim-play-btn')!.textContent = label;
    document.getElementById('marker-play-btn')!.textContent = label;
    document.getElementById('filter-play-btn')!.textContent = label;
  }

  private onPlaybackEnd(): void {
    const home = this.playbackEngine.getHomeTime();
    this.trimWaveform?.setPlayhead(home + this.trimStart);
    this.markerWaveform?.setPlayhead(home);
    this.refWaveform?.setPlayhead(home);
    this.automationEditor?.setPlayhead(home);
  }

  private togglePlayback(): void {
    if (!this.decodedAudio) return;
    const state = this.playbackEngine.getState();
    if (state === 'playing') {
      this.playbackEngine.pause();
    } else if (state === 'paused') {
      void this.playbackEngine.play();
    } else {
      void this.playbackEngine.play();
    }
  }

  private stopPlayback(): void {
    this.playbackEngine.stop();
    const home = this.playbackEngine.getHomeTime();
    this.trimWaveform?.setPlayhead(home + this.trimStart);
    this.markerWaveform?.setPlayhead(home);
    this.refWaveform?.setPlayhead(home);
    this.automationEditor?.setPlayhead(home);
  }

  private async exportAudio(): Promise<void> {
    const buffer = this.trimmedBuffer ?? this.decodedAudio?.buffer ?? null;
    if (!buffer) return;

    const start = this.trimmedBuffer ? 0 : this.trimStart;
    const end = this.trimmedBuffer ? buffer.duration : this.trimEnd;

    const btn = document.getElementById('export-audio-btn') as HTMLButtonElement;
    const originalText = btn.textContent;
    btn.textContent = 'Exporting...';
    btn.disabled = true;

    try {
      const blob = await renderOffline(buffer, this.automationPoints, this.filterSlope, start, end);

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

    const lines = this.markers.map(m => m.time.toFixed(2));
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
