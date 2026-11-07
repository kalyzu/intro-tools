import './style.css';
import type { AutomationPoint, Marker, ViewState } from './automation/model';
import { sortPoints, clampTime } from './automation/model';
import { createDefaultAutomation } from './automation/defaults';
import type { VolumePoint } from './automation/volume-model';
import { sortVolumePoints, clampVolumeTime } from './automation/volume-model';
import { createDefaultVolumeAutomation } from './automation/volume-defaults';
import type { ReverbPoint } from './automation/reverb-model';
import { createDefaultReverbAutomation, ensureReverbPoints, getReverbMixRange } from './automation/reverb-model';
import { decodeAudioFile, trimAudioBuffer, type DecodedAudio } from './audio/decoder';
import { PlaybackEngine, type PlaybackState } from './audio/playback';
import { renderOffline } from './audio/renderer';
import { WaveformRenderer } from './waveform/renderer';
import { AutomationEditor } from './ui/automation-editor';
import { VolumeEditor } from './ui/volume-editor';
import { detectDrumOnsets } from './audio/onset';
import { findRepeatingPattern, extendPattern } from './audio/pattern';
import type { FilterSlope } from './audio/filter';
import { DEFAULT_REVERB_SETTINGS, type ReverbSettings } from './audio/reverb';
import moonIcon from '../img/moon.svg';
import sunIcon from '../img/sun.svg';

type Mode = 'trim' | 'markers' | 'filter';

class LowPassEditor {
  private decodedAudio: DecodedAudio | null = null;
  private trimmedBuffer: AudioBuffer | null = null;
  private mode: Mode = 'trim';

  private automationPoints: AutomationPoint[] = [];
  private automationCustomized = false;
  private volumePoints: VolumePoint[] = [];
  private volumeCustomized = false;
  private reverbPoints: ReverbPoint[] = [];
  private reverbCustomized = false;
  private isLoadingAudio = false;
  private playbackEngine: PlaybackEngine;
  private trimWaveform: WaveformRenderer | null = null;
  private markerWaveform: WaveformRenderer | null = null;
  private refWaveform: WaveformRenderer | null = null;
  private automationEditor: AutomationEditor | null = null;
  private volumeEditor: VolumeEditor | null = null;
  private reverbEditor: VolumeEditor | null = null;
  private filterSlope: FilterSlope = 24;
  private reverb: ReverbSettings = { ...DEFAULT_REVERB_SETTINGS };

  private maxUndoSize = 50;

  // Per-page history
  private trimHistory: { trimStart: number; trimEnd: number }[] = [];
  private trimRedoHistory: { trimStart: number; trimEnd: number }[] = [];
  private filterHistory: { automationPoints: AutomationPoint[]; volumePoints: VolumePoint[]; reverbPoints: ReverbPoint[]; filterSlope: FilterSlope; reverb: ReverbSettings }[] = [];
  private filterRedoHistory: typeof this.filterHistory = [];
  private markersHistory: { markers: Marker[]; suggestedMarkers: Marker[]; nextMarkerId: number }[] = [];
  private markersRedoHistory: typeof this.markersHistory = [];

  private trimStart = 0;
  private trimEnd = 0;
  private markers: Marker[] = [];
  private nextMarkerId = 1;
  private selectedMarkerId: number | null = null;
  private suggestedMarkers: Marker[] = [];
  private suggestedVisible = true;
  private selectedSuggestedMarkerId: number | null = null;
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
      this.pushFilterHistory();
      this.updateExportInfo();
    });

    const reverbDecay = document.getElementById('reverb-decay') as HTMLSelectElement;
    reverbDecay.addEventListener('change', () => {
      this.reverb = { ...this.reverb, decay: parseFloat(reverbDecay.value) };
      this.playbackEngine.setReverb(this.reverb);
      this.pushFilterHistory();
      this.updateExportInfo();
    });
    this.syncReverbControls();

    const trimCanvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
    this.trimWaveform = new WaveformRenderer(trimCanvas);
    this.trimWaveform.setTrimChangeCallback((start, end) => this.onTrimChange(start, end));
    this.trimWaveform.setAfterChangeCallback(() => this.pushTrimHistory());
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
    this.markerWaveform.setSuggestedMarkerCallbacks(
      (id, time) => this.moveSuggestedMarker(id, time),
      (id) => this.selectSuggestedMarker(id),
    );
    this.markerWaveform.setSeekCallback((time) => {
      this.playbackEngine.seek(this.clampTrimTime(time));
      this.updateHomeLines();
    });
    this.markerWaveform.setAfterChangeCallback(() => this.pushMarkersHistory());

    const refCanvas = document.getElementById('ref-waveform-canvas') as HTMLCanvasElement;
    this.refWaveform = new WaveformRenderer(refCanvas);
    this.refWaveform.setTrimVisible(false);
    this.refWaveform.setMarkersVisible(false);
    this.refWaveform.setShowBorder(true);
    this.refWaveform.setSeekCallback((time) => {
      this.automationEditor?.clearSelection();
      this.volumeEditor?.clearSelection();
      this.reverbEditor?.clearSelection();
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
      onPointSelect: () => {
        // Any interaction on the filter graph clears the other selections
        // to prevent the "ghost" double-delete bug where a stale selection
        // on another graph is deleted together with the intended one.
        this.volumeEditor?.clearSelection();
        this.reverbEditor?.clearSelection();
      },
      onSeek: (time) => {
        this.playbackEngine.seek(this.clampTrimTime(time));
        this.updateHomeLines();
      },
    });
    this.automationEditor.setZoomRequestCallback((center, factor, frac) => this.zoomAt(center, factor, frac));
    this.automationEditor.setPanRequestCallback((delta) => this.panView(delta));
    this.automationEditor.setAfterChangeCallback(() => this.pushFilterHistory());
    const volumeCanvas = document.getElementById('volume-canvas') as HTMLCanvasElement;
    this.volumeEditor = new VolumeEditor(volumeCanvas, {
      onPointsChange: (points) => this.onVolumePointsChange(points),
      onPointSelect: () => {
        this.automationEditor?.clearSelection();
        this.reverbEditor?.clearSelection();
      },
      onSeek: (time) => {
        this.playbackEngine.seek(this.clampTrimTime(time));
        this.updateHomeLines();
      },
    });
    this.volumeEditor.setZoomRequestCallback((center, factor, frac) => this.zoomAt(center, factor, frac));
    this.volumeEditor.setPanRequestCallback((delta) => this.panView(delta));
    this.volumeEditor.setAfterChangeCallback(() => this.pushFilterHistory());

    const reverbCanvas = document.getElementById('reverb-canvas') as HTMLCanvasElement;
    this.reverbEditor = new VolumeEditor(reverbCanvas, {
      onPointsChange: (points) => this.onReverbPointsChange(points),
      onPointSelect: () => {
        this.automationEditor?.clearSelection();
        this.volumeEditor?.clearSelection();
      },
      onSeek: (time) => {
        this.playbackEngine.seek(this.clampTrimTime(time));
        this.updateHomeLines();
      },
    }, {
      color: '#a855f7',
      colorLight: 'rgba(168, 85, 247, 0.25)',
      selectionStroke: 'rgba(168, 85, 247, 0.9)',
      selectionFill: 'rgba(168, 85, 247, 0.15)',
    });
    this.reverbEditor.setZoomRequestCallback((center, factor, frac) => this.zoomAt(center, factor, frac));
    this.reverbEditor.setPanRequestCallback((delta) => this.panView(delta));
    this.reverbEditor.setAfterChangeCallback(() => this.pushFilterHistory());

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
      zoomSlider.value = '0';
      this.updateZoom(0);
    });
    markerZoomResetBtn.addEventListener('click', () => {
      markerZoomSlider.value = '0';
      this.updateZoom(0);
    });
    filterZoomResetBtn.addEventListener('click', () => {
      filterZoomSlider.value = '0';
      this.updateZoom(0);
    });

    const trimUndoBtn = document.getElementById('trim-undo-btn') as HTMLButtonElement | null;
    const trimRedoBtn = document.getElementById('trim-redo-btn') as HTMLButtonElement | null;
    const filterUndoBtn = document.getElementById('filter-undo-btn') as HTMLButtonElement | null;
    const filterRedoBtn = document.getElementById('filter-redo-btn') as HTMLButtonElement | null;
    const markersUndoBtn = document.getElementById('markers-undo-btn') as HTMLButtonElement | null;
    const markersRedoBtn = document.getElementById('markers-redo-btn') as HTMLButtonElement | null;
    trimUndoBtn?.addEventListener('click', () => this.undo());
    trimRedoBtn?.addEventListener('click', () => this.redo());
    filterUndoBtn?.addEventListener('click', () => this.undo());
    filterRedoBtn?.addEventListener('click', () => this.redo());
    markersUndoBtn?.addEventListener('click', () => this.undo());
    markersRedoBtn?.addEventListener('click', () => this.redo());

    const suggestBtn = document.getElementById('suggest-btn') as HTMLButtonElement | null;
    const toggleSuggestedBtn = document.getElementById('toggle-suggested-btn') as HTMLButtonElement | null;
    const applySuggestedBtn = document.getElementById('apply-suggested-btn') as HTMLButtonElement | null;
    const clearSuggestedBtn = document.getElementById('clear-suggested-btn') as HTMLButtonElement | null;
    const suggestPatternBtn = document.getElementById('suggest-pattern-btn') as HTMLButtonElement | null;
    suggestBtn?.addEventListener('click', () => this.generateSuggested());
    toggleSuggestedBtn?.addEventListener('click', () => this.toggleSuggested());
    applySuggestedBtn?.addEventListener('click', () => this.applySuggested());
    clearSuggestedBtn?.addEventListener('click', () => this.clearSuggested());
    suggestPatternBtn?.addEventListener('click', () => this.generatePatternSuggested());
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

      if (this.mode === 'markers' && (e.key === 'Delete' || e.key === 'Backspace')) {
        const suggestedIds = this.markerWaveform?.getSelectedSuggestedIds?.() ?? [];
        const markerIds = this.markerWaveform?.getSelectedMarkerIds?.() ?? [];
        if (suggestedIds.length > 0) {
          e.preventDefault();
          // Delete all selected suggested (green) in one undo
          const toDelete = new Set(suggestedIds);
          this.suggestedMarkers = this.suggestedMarkers.filter(m => !toDelete.has(m.id));
          this.selectedSuggestedMarkerId = null;
          this.markerWaveform?.setSuggestedMarkers(this.suggestedMarkers);
          this.markerWaveform?.setSelectedSuggestedMarker(null);
          this.updateMarkerDisplay();
          this.updateExportButtons();
          this.updateSuggestedButtons();
          this.pushMarkersHistory();
        } else if (markerIds.length > 0) {
          e.preventDefault();
          const toDelete = new Set(markerIds);
          this.markers = this.markers.filter(m => !toDelete.has(m.id));
          this.selectedMarkerId = null;
          this.markerWaveform?.setMarkers(this.markers);
          this.markerWaveform?.setSelectedMarker(null);
          this.updateMarkerDisplay();
          this.updateExportButtons();
          this.pushMarkersHistory();
        } else if (this.selectedSuggestedMarkerId !== null) {
          e.preventDefault();
          this.deleteSuggestedMarker(this.selectedSuggestedMarkerId);
        } else if (this.selectedMarkerId !== null) {
          e.preventDefault();
          this.deleteMarker(this.selectedMarkerId);
        }
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
    this.volumeEditor?.render();
    this.reverbEditor?.render();
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

  private setLoading(loading: boolean, message?: string): void {
    const indicator = document.getElementById('loading-indicator');
    const label = document.getElementById('loading-label');
    if (label && message) label.textContent = message;
    if (indicator) indicator.hidden = !loading;
  }

  private yieldToUI(): Promise<void> {
    return new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  }

  private async loadFile(file: File): Promise<void> {
    if (this.isLoadingAudio) return;
    this.isLoadingAudio = true;
    const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
    const openButton = document.getElementById('open-btn') as HTMLButtonElement | null;
    const dropZone = document.getElementById('drop-zone');
    if (fileInput) fileInput.disabled = true;
    if (openButton) openButton.disabled = true;
    dropZone?.setAttribute('aria-busy', 'true');
    this.setLoading(true, 'Loading audio…');
    try {
      this.playbackEngine.stop();
      // Drop references to the previous file before decoding so its decoded
      // and trimmed buffers can be garbage-collected while the new file loads.
      this.decodedAudio = null;
      this.trimmedBuffer = null;
      this.playbackEngine.clearBuffer();
      this.trimWaveform?.clearBuffer();
      this.markerWaveform?.clearBuffer();
      this.refWaveform?.clearBuffer();

      await this.yieldToUI();
      this.decodedAudio = await decodeAudioFile(file);

      this.setLoading(true, 'Preparing waveform…');
      await this.yieldToUI();

      document.getElementById('file-name')!.textContent = file.name;
      document.getElementById('clip-info')!.hidden = false;
      document.getElementById('drop-zone')!.hidden = true;
      document.getElementById('trim-content')!.hidden = false;

      this.trimStart = 0;
      this.trimEnd = this.decodedAudio.duration;
      this.mode = 'trim';
      this.markers = [];
      this.nextMarkerId = 1;
      this.selectedMarkerId = null;
      this.suggestedMarkers = [];
      this.selectedSuggestedMarkerId = null;
      this.suggestedVisible = true;

      this.automationPoints = createDefaultAutomation(this.getTrimDuration());
      this.automationCustomized = false;
      this.volumePoints = createDefaultVolumeAutomation(this.getTrimDuration());
      this.volumeCustomized = false;
      this.reverbPoints = createDefaultReverbAutomation(this.getTrimDuration());
      this.reverbCustomized = false;
      this.reverb = { ...DEFAULT_REVERB_SETTINGS };
      this.syncReverbControls();
      // Per-page history
      this.trimHistory = [];
      this.trimRedoHistory = [];
      this.filterHistory = [];
      this.filterRedoHistory = [];
      this.markersHistory = [];
      this.markersRedoHistory = [];
      this.pushTrimHistory();
      this.pushFilterHistory();
      this.pushMarkersHistory();

      this.playbackEngine.setBuffer(this.decodedAudio.buffer);
      this.playbackEngine.setTrim(this.trimStart, this.trimEnd);
      this.playbackEngine.setAutomationPoints(this.automationPoints);
      this.playbackEngine.setVolumePoints(this.volumePoints);
      this.playbackEngine.setFilterSlope(this.filterSlope);
      this.playbackEngine.setReverb(this.reverb);
      this.playbackEngine.setReverbPoints(this.reverbPoints);

      this.trimWaveform!.setBuffer(this.decodedAudio.buffer);
      this.trimWaveform!.setTrim(this.trimStart, this.trimEnd);
      this.trimWaveform!.setMarkers(this.markers);

      this.automationEditor!.setDuration(this.getTrimDuration());
      this.automationEditor!.setPoints(this.automationPoints);
      this.volumeEditor!.setDuration(this.getTrimDuration());
      this.volumeEditor!.setPoints(this.volumePoints);
      this.reverbEditor!.setDuration(this.getTrimDuration());
      this.reverbEditor!.setPoints(this.reverbPoints);

      this.showModeScreen();

      const continueBtn = document.getElementById('continue-btn') as HTMLButtonElement;
      continueBtn.disabled = false;
      this.updateTrimDisplay();
      this.updateExportButtons();
    } catch (err) {
      console.error('Failed to load audio:', err);
      // The previous buffers were released up front, so return to an empty
      // state instead of leaving the editor showing stale controls.
      this.decodedAudio = null;
      this.trimmedBuffer = null;
      this.mode = 'trim';
      const clipInfo = document.getElementById('clip-info');
      const trimContent = document.getElementById('trim-content');
      if (clipInfo) clipInfo.hidden = true;
      if (trimContent) trimContent.hidden = true;
      if (dropZone) dropZone.hidden = false;
      this.showModeScreen();
      alert('Failed to load audio file. Please try a different format.');
    } finally {
      this.isLoadingAudio = false;
      if (fileInput) fileInput.disabled = false;
      if (openButton) openButton.disabled = false;
      dropZone?.removeAttribute('aria-busy');
      this.setLoading(false);
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
    const reverbEl = document.getElementById('export-reverb');
    if (durEl) durEl.textContent = this.getTrimDuration().toFixed(2) + 's';
    if (srEl) srEl.textContent = buffer ? buffer.sampleRate + ' Hz' : '\u2014';
    if (chEl) chEl.textContent = buffer ? String(buffer.numberOfChannels) : '\u2014';
    if (slopeEl) slopeEl.textContent = `${this.filterSlope} dB/oct`;
    if (reverbEl) {
      const range = getReverbMixRange(this.reverbPoints);
      if (range.max <= 0) {
        reverbEl.textContent = 'Off';
      } else {
        const minPercent = Math.round(range.min * 100);
        const maxPercent = Math.round(range.max * 100);
        const mix = minPercent === maxPercent
          ? `${maxPercent}%`
          : `${minPercent}\u2013${maxPercent}%`;
        reverbEl.textContent = `${mix} \u00b7 ${this.reverb.decay.toFixed(1)} s`;
      }
    }
  }

  private syncReverbControls(): void {
    const decay = document.getElementById('reverb-decay') as HTMLSelectElement | null;
    if (decay) decay.value = String(this.reverb.decay);
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
            ? 'Step 2 of 3 · Shape the low-pass & reverb'
            : 'Step 3 of 3 · Place markers & export';
    }

    this.automationEditor?.setActive(isFilter);
    this.volumeEditor?.setActive(isFilter);
    this.reverbEditor?.setActive(isFilter);
    this.playbackEngine.setFilterEnabled(!isTrim);
    this.playbackEngine.setReverbEnabled(!isTrim);

    (document.getElementById('zoom-slider') as HTMLInputElement).value = '0';
    (document.getElementById('marker-zoom-slider') as HTMLInputElement).value = '0';
    (document.getElementById('filter-zoom-slider') as HTMLInputElement).value = '0';

    const axisDuration = this.getAxisDuration();
    if (axisDuration > 0) {
      this.view = { viewStart: 0, viewEnd: axisDuration };
    }
    this.syncView();
    this.updateUndoRedoButtons();
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
      this.volumeEditor?.setView(this.view);
      this.reverbEditor?.setView(this.view);
    }
  }

  private updateHomeLines(): void {
    const home = this.playbackEngine.getHomeTime();
    this.trimWaveform?.setHomeTime(home + this.trimStart);
    this.markerWaveform?.setHomeTime(home);
    this.refWaveform?.setHomeTime(home);
    this.automationEditor?.setHomeTime(home);
    this.volumeEditor?.setHomeTime(home);
    this.reverbEditor?.setHomeTime(home);
  }

  private getMaximumZoom(): number {
    const buffer = this.mode === 'trim' ? this.decodedAudio?.buffer : this.trimmedBuffer;
    if (!buffer) return 1;
    const canvasId = this.mode === 'trim'
      ? 'waveform-canvas'
      : this.mode === 'markers'
        ? 'marker-canvas'
        : 'ref-waveform-canvas';
    const canvas = document.getElementById(canvasId);
    const canvasWidth = canvas?.getBoundingClientRect().width || window.innerWidth;
    const graphWidth = Math.max(1, canvasWidth - 80);
    return Math.max(1, (buffer.length / graphWidth));
  }

  private zoomFromSlider(value: number): number {
    const fraction = Math.max(0, Math.min(100, value)) / 100;
    return Math.exp(Math.log(this.getMaximumZoom()) * fraction);
  }

  private sliderFromZoom(zoom: number): number {
    const maxZoom = this.getMaximumZoom();
    if (maxZoom <= 1) return 0;
    return Math.round(100 * Math.log(Math.max(1, Math.min(maxZoom, zoom))) / Math.log(maxZoom));
  }

  private updateZoom(sliderValue: number): void {
    const axisDuration = this.getAxisDuration();
    if (axisDuration <= 0) return;

    const anchor = Math.max(0, Math.min(axisDuration, this.playbackEngine.getHomeTime()));
    const viewRange = Math.max(1e-6, this.view.viewEnd - this.view.viewStart);
    const frac = Math.max(0, Math.min(1, (anchor - this.view.viewStart) / viewRange));
    const viewWidth = axisDuration / this.zoomFromSlider(sliderValue);
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
    const zoom = Math.max(1, Math.min(this.getMaximumZoom(), current * factor));
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
    if (slider) slider.value = String(this.sliderFromZoom(zoom));

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
    this.suggestedMarkers = this.suggestedMarkers.filter(m => m.time <= trimmedDuration);
    if (this.selectedSuggestedMarkerId !== null && !this.suggestedMarkers.some(m => m.id === this.selectedSuggestedMarkerId)) {
      this.selectedSuggestedMarkerId = null;
    }

    this.ensureAutomationFits(trimmedDuration);
    this.ensureVolumeFits(trimmedDuration);
    this.ensureReverbFits(trimmedDuration);
    this.playbackEngine.setBuffer(this.trimmedBuffer);
    this.playbackEngine.setTrim(0, trimmedDuration);
    this.playbackEngine.setAutomationPoints(this.automationPoints);
    this.playbackEngine.setVolumePoints(this.volumePoints);
    this.playbackEngine.setFilterSlope(this.filterSlope);
    this.playbackEngine.setReverb(this.reverb);
    this.playbackEngine.setReverbPoints(this.reverbPoints);

    this.refWaveform!.setBuffer(this.trimmedBuffer);
    this.markerWaveform!.setBuffer(this.trimmedBuffer);
    this.markerWaveform!.setTrim(0, trimmedDuration);
    this.markerWaveform!.setMarkers(this.markers);
    this.markerWaveform!.setSelectedMarker(this.selectedMarkerId);
    this.markerWaveform!.setSuggestedMarkers(this.suggestedMarkers);
    this.markerWaveform!.setSuggestedVisible(this.suggestedVisible);
    this.markerWaveform!.setSelectedSuggestedMarker(this.selectedSuggestedMarkerId);

    this.automationEditor!.setDuration(trimmedDuration);
    this.automationEditor!.setPoints(this.automationPoints);
    this.volumeEditor!.setDuration(trimmedDuration);
    this.volumeEditor!.setPoints(this.volumePoints);
    this.reverbEditor!.setDuration(trimmedDuration);
    this.reverbEditor!.setPoints(this.reverbPoints);

    // Push initial state for filter page if not already
    if (this.filterHistory.length === 0) {
      this.pushFilterHistory();
    }
    if (this.markersHistory.length === 0) {
      this.pushMarkersHistory();
    }

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
    this.markerWaveform?.setSuggestedMarkers(this.suggestedMarkers);
    this.markerWaveform?.setSuggestedVisible(this.suggestedVisible);
    this.markerWaveform?.setSelectedSuggestedMarker(this.selectedSuggestedMarkerId);
    this.showModeScreen();
    this.updateTrimDisplay();
    this.updateExportInfo();
    this.updateMarkerDisplay();
    this.updateExportButtons();
    this.updateSuggestedButtons();
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
    // Do not push history here - caller will handle per-page history
  }

  private ensureVolumeFits(duration: number): void {
    const deduped = new Map<number, VolumePoint>();
    for (const p of this.volumePoints) {
      const clamped = { ...p, time: clampVolumeTime(p.time, duration) };
      deduped.set(clamped.time, clamped);
    }
    let points = sortVolumePoints([...deduped.values()]);
    if (points.length < 2) {
      points = createDefaultVolumeAutomation(duration);
    }
    this.volumePoints = points;
    // Do not push history here - caller will handle per-page history
  }

  private ensureReverbFits(duration: number): void {
    this.reverbPoints = ensureReverbPoints(this.reverbPoints, duration);
    // Do not push history here - caller will handle per-page history
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
    if (!this.volumeCustomized) {
      this.volumePoints = createDefaultVolumeAutomation(duration);
      this.playbackEngine.setVolumePoints(this.volumePoints);
      this.volumeEditor?.setPoints(this.volumePoints);
    }
    if (!this.reverbCustomized) {
      this.reverbPoints = createDefaultReverbAutomation(duration);
      this.playbackEngine.setReverbPoints(this.reverbPoints);
      this.reverbEditor?.setPoints(this.reverbPoints);
    }
    this.automationEditor?.setDuration(duration);
    this.volumeEditor?.setDuration(duration);
    this.reverbEditor?.setDuration(duration);
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
    this.pushMarkersHistory();
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
    this.pushMarkersHistory();
  }

  private updateMarkerDisplay(): void {
    const el = document.getElementById('marker-display') as HTMLElement;
    if (el) {
      if (this.selectedMarkerId !== null) {
        const marker = this.markers.find(m => m.id === this.selectedMarkerId);
        if (marker) {
          el.textContent = `Marker: ${marker.time.toFixed(2)}s`;
          el.hidden = false;
        } else {
          el.hidden = true;
        }
      } else if (this.selectedSuggestedMarkerId !== null) {
        const sel = this.suggestedMarkers.find(m => m.id === this.selectedSuggestedMarkerId);
        if (sel) {
          el.textContent = `Suggested: ${sel.time.toFixed(2)}s`;
          el.hidden = false;
          el.style.color = 'var(--success)';
        } else {
          el.hidden = true;
        }
      } else {
        el.hidden = true;
      }
    }
    // Keep beat display in sync when idle (not playing)
    if (this.playbackEngine.getState() !== 'playing') {
      const beatLabel = document.getElementById('beat-display-label');
      const beatLight = document.getElementById('beat-display-light');
      if (beatLabel && beatLight) {
        if (this.selectedMarkerId !== null) {
          const sel = this.markers.find(m => m.id === this.selectedMarkerId);
          beatLabel.textContent = sel ? `♪ ${sel.time.toFixed(2)}s` : '—';
        } else if (this.selectedSuggestedMarkerId !== null) {
          const sel = this.suggestedMarkers.find(m => m.id === this.selectedSuggestedMarkerId);
          beatLabel.textContent = sel ? `♪ ${sel.time.toFixed(2)}s` : '—';
        } else {
          beatLabel.textContent = '—';
          beatLight.classList.remove('active');
        }
      }
    }
    this.updateSuggestedButtons();
  }

  private updateSuggestedButtons(): void {
    const toggleBtn = document.getElementById('toggle-suggested-btn') as HTMLButtonElement | null;
    const applyBtn = document.getElementById('apply-suggested-btn') as HTMLButtonElement | null;
    if (toggleBtn) {
      toggleBtn.textContent = this.suggestedVisible ? 'Hide Suggested' : 'Show Suggested';
      toggleBtn.disabled = this.suggestedMarkers.length === 0;
    }
    if (applyBtn) {
      applyBtn.disabled = this.suggestedMarkers.length === 0;
    }
  }

  private generateSuggested(): void {
    if (!this.trimmedBuffer) return;

    // If green suggestions already exist, correct them instead of adding new ones
    if (this.suggestedMarkers.length > 0) {
      const freshTimes = detectDrumOnsets(this.trimmedBuffer);
      let corrected = 0;
      for (const sm of this.suggestedMarkers) {
        // Find closest fresh detection within 60ms
        let best: number | null = null;
        let bestDist = Infinity;
        for (const t of freshTimes) {
          const d = Math.abs(t - sm.time);
          if (d < bestDist && d < 0.06) {
            bestDist = d;
            best = t;
          }
        }
        if (best !== null) {
          const clamped = Math.max(0, Math.min(this.getTrimDuration(), best));
          // Avoid colliding with existing official markers
          const collides = this.markers.some(m => Math.abs(m.time - clamped) < 0.03);
          if (!collides) {
            sm.time = clamped;
            corrected++;
          }
        } else {
          // Fallback: snap to pattern grid if available
          const allTimes = [...this.markers, ...this.suggestedMarkers].map(m => m.time).sort((a, b) => a - b);
          const pattern = findRepeatingPattern(allTimes, this.getTrimDuration());
          if (pattern) {
            const gridTimes = [...allTimes, ...extendPattern(allTimes, pattern, this.getTrimDuration(), allTimes)];
            let bestGrid: number | null = null;
            let bestGridDist = Infinity;
            for (const gridTime of gridTimes) {
              const d = Math.abs(gridTime - sm.time);
              if (d < bestGridDist && d < pattern.tolerance) {
                bestGridDist = d;
                bestGrid = gridTime;
              }
            }
            if (bestGrid !== null) {
              const clamped = Math.max(0, Math.min(this.getTrimDuration(), bestGrid));
              if (!this.markers.some(m => Math.abs(m.time - clamped) < 0.03)) {
                sm.time = clamped;
                corrected++;
              }
            }
          }
        }
      }
      this.suggestedMarkers.sort((a, b) => a.time - b.time);
      this.markerWaveform?.setSuggestedMarkers(this.suggestedMarkers);
      this.updateMarkerDisplay();
      this.updateSuggestedButtons();
      this.pushMarkersHistory();
      return;
    }

    // No existing suggestions: generate fresh from detection
    const times = detectDrumOnsets(this.trimmedBuffer);
    const newMarkers: Marker[] = [];
    for (const t of times) {
      const clamped = Math.max(0, Math.min(this.getTrimDuration(), t));
      const exists = [...this.markers, ...newMarkers].some(m => Math.abs(m.time - clamped) < 0.03);
      if (exists) continue;
      newMarkers.push({ id: this.nextMarkerId++, time: clamped });
    }
    newMarkers.sort((a, b) => a.time - b.time);
    this.suggestedMarkers = newMarkers;
    this.suggestedVisible = true;
    this.selectedSuggestedMarkerId = null;
    this.selectedMarkerId = null;
    this.markerWaveform?.setSuggestedMarkers(this.suggestedMarkers);
    this.markerWaveform?.setSuggestedVisible(this.suggestedVisible);
    this.markerWaveform?.setSelectedMarker(null);
    this.markerWaveform?.setSelectedSuggestedMarker(null);
    this.updateMarkerDisplay();
    this.updateSuggestedButtons();
    this.pushMarkersHistory();
  }

  private generatePatternSuggested(): void {
    if (!this.trimmedBuffer) return;
    if (this.markers.length < 2) {
      alert('Place at least 2 yellow markers to detect a pattern (e.g., 2-3 beats).');
      return;
    }
    const times = this.markers.map(m => m.time).sort((a, b) => a - b);
    const duration = this.getTrimDuration();
    const pattern = findRepeatingPattern(times, duration);
    if (!pattern) {
      alert('Could not find a repeating pattern. Try more evenly spaced markers.');
      return;
    }
    const existingTimes = this.markers.map(m => m.time);
    const extended = extendPattern(times, pattern, duration, existingTimes);
    if (extended.length === 0) {
      alert(`Pattern found: interval ${pattern.interval.toFixed(3)}s (confidence ${(pattern.confidence * 100).toFixed(0)}%), but no new markers to add. Try extending the trim or adding more markers.`);
      return;
    }
    const newMarkers: Marker[] = extended.map(t => ({ id: this.nextMarkerId++, time: Math.max(0, Math.min(duration, t)) }));
    // Merge with existing suggested, dedup 30ms
    const merged = [...this.suggestedMarkers];
    for (const nm of newMarkers) {
      const exists = [...this.markers, ...merged].some(m => Math.abs(m.time - nm.time) < 0.03);
      if (!exists) merged.push(nm);
    }
    merged.sort((a, b) => a.time - b.time);
    this.suggestedMarkers = merged;
    this.suggestedVisible = true;
    this.selectedSuggestedMarkerId = null;
    this.selectedMarkerId = null;
    this.markerWaveform?.setSuggestedMarkers(this.suggestedMarkers);
    this.markerWaveform?.setSuggestedVisible(true);
    this.markerWaveform?.setSelectedMarker(null);
    this.markerWaveform?.setSelectedSuggestedMarker(null);
    this.updateMarkerDisplay();
    this.updateSuggestedButtons();
    console.log(`Pattern: interval ${pattern.interval.toFixed(3)}s confidence ${(pattern.confidence * 100).toFixed(0)}% tolerance ${pattern.tolerance.toFixed(3)}s extended ${extended.length} markers`);
  }

  private toggleSuggested(): void {
    this.suggestedVisible = !this.suggestedVisible;
    this.markerWaveform?.setSuggestedVisible(this.suggestedVisible);
    this.updateSuggestedButtons();
  }

  private applySuggested(): void {
    if (this.suggestedMarkers.length === 0) return;
    // Merge suggested into official, sorted, dedup within 30ms
    for (const sm of this.suggestedMarkers) {
      const exists = this.markers.some(m => Math.abs(m.time - sm.time) < 0.03);
      if (!exists) {
        this.markers.push({ ...sm });
      }
    }
    this.markers.sort((a, b) => a.time - b.time);
    this.suggestedMarkers = [];
    this.suggestedVisible = true;
    this.selectedSuggestedMarkerId = null;
    this.markerWaveform?.setSuggestedMarkers([]);
    this.markerWaveform?.setSuggestedVisible(true);
    this.markerWaveform?.setMarkers(this.markers);
    this.updateMarkerDisplay();
    this.updateExportButtons();
    this.updateSuggestedButtons();
  }

  private clearSuggested(): void {
    this.suggestedMarkers = [];
    this.selectedSuggestedMarkerId = null;
    this.markerWaveform?.setSuggestedMarkers([]);
    this.markerWaveform?.setSelectedSuggestedMarker(null);
    this.updateMarkerDisplay();
    this.updateSuggestedButtons();
  }

  private moveSuggestedMarker(id: number, time: number): void {
    const m = this.suggestedMarkers.find(x => x.id === id);
    if (!m) return;
    m.time = Math.max(0, Math.min(this.getTrimDuration(), time));
    this.suggestedMarkers.sort((a, b) => a.time - b.time);
    this.markerWaveform?.setSuggestedMarkers(this.suggestedMarkers);
    this.updateMarkerDisplay();
  }

  private selectSuggestedMarker(id: number | null): void {
    this.selectedSuggestedMarkerId = id;
    if (id !== null) this.selectedMarkerId = null;
    this.markerWaveform?.setSelectedSuggestedMarker(id);
    this.markerWaveform?.setSelectedMarker(null);
    this.updateMarkerDisplay();
  }

  private deleteSuggestedMarker(id: number): void {
    this.suggestedMarkers = this.suggestedMarkers.filter(m => m.id !== id);
    this.selectedSuggestedMarkerId = null;
    this.markerWaveform?.setSuggestedMarkers(this.suggestedMarkers);
    this.markerWaveform?.setSelectedSuggestedMarker(null);
    this.updateMarkerDisplay();
    this.updateSuggestedButtons();
  }

  private onPointsChange(points: AutomationPoint[]): void {
    this.automationPoints = sortPoints(points);
    this.automationCustomized = true;
    this.playbackEngine.setAutomationPoints(this.automationPoints);
    // History pushed at drag start via onBeforeChange, not here
    this.updateUndoRedoButtons();
  }

  private onVolumePointsChange(points: VolumePoint[]): void {
    this.volumePoints = sortVolumePoints(points);
    this.volumeCustomized = true;
    this.playbackEngine.setVolumePoints(this.volumePoints);
    // History pushed at drag start via onBeforeChange, not here
    this.updateUndoRedoButtons();
  }

  private onReverbPointsChange(points: ReverbPoint[]): void {
    this.reverbPoints = sortVolumePoints(points);
    this.reverbCustomized = true;
    this.playbackEngine.setReverbPoints(this.reverbPoints);
    this.updateExportInfo();
    // History pushed at drag end via onAfterChange, not here
    this.updateUndoRedoButtons();
  }

  private onTimeUpdate(time: number): void {
    if (this.mode === 'trim') {
      this.trimWaveform?.setPlayhead(time + this.trimStart);
    } else if (this.mode === 'markers') {
      this.markerWaveform?.setPlayhead(time);
    } else {
      this.refWaveform?.setPlayhead(time);
      this.automationEditor?.setPlayhead(time);
      this.volumeEditor?.setPlayhead(time);
      this.reverbEditor?.setPlayhead(time);
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

    this.updateBeatDisplay(time);
  }

  private updateBeatDisplay(time: number): void {
    const light = document.getElementById('beat-display-light');
    const label = document.getElementById('beat-display-label');
    if (!light || !label) return;

    const allMarkers = this.suggestedVisible ? [...this.markers, ...this.suggestedMarkers] : this.markers;
    if (allMarkers.length === 0) {
      label.textContent = '—';
      light.classList.remove('active');
      return;
    }

    // Immediate on/off, no debounce or timeout — on when playhead is at a marker
    const threshold = 0.03; // 30ms : tight enough for “now”, wide enough for 16ms update
    let hit: Marker | null = null;
    for (const m of allMarkers) {
      if (Math.abs(m.time - time) < threshold) {
        hit = m;
        break;
      }
    }

    if (hit) {
      light.classList.add('active');
      label.textContent = `♪ ${hit.time.toFixed(2)}s`;
    } else {
      light.classList.remove('active');
      if (this.playbackEngine.getState() !== 'playing') {
        const sel =
          this.selectedMarkerId !== null
            ? this.markers.find(m => m.id === this.selectedMarkerId)
            : this.selectedSuggestedMarkerId !== null
              ? this.suggestedMarkers.find(m => m.id === this.selectedSuggestedMarkerId)
              : null;
        label.textContent = sel ? `♪ ${sel.time.toFixed(2)}s` : '—';
      } else {
        label.textContent = '—';
      }
    }
  }

  private clearBeatDisplay(): void {
    const light = document.getElementById('beat-display-light');
    const label = document.getElementById('beat-display-label');
    if (light) light.classList.remove('active');
    if (label) label.textContent = '—';
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
    this.volumeEditor?.setPlayhead(home);
    this.reverbEditor?.setPlayhead(home);
    this.clearBeatDisplay();
    // Show selected marker after stop if any
    if (this.selectedMarkerId !== null) {
      const sel = this.markers.find(m => m.id === this.selectedMarkerId);
      const label = document.getElementById('beat-display-label');
      if (sel && label) label.textContent = `♪ ${sel.time.toFixed(2)}s`;
    }
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
    this.volumeEditor?.setPlayhead(home);
    this.reverbEditor?.setPlayhead(home);
    this.clearBeatDisplay();
    if (this.selectedMarkerId !== null) {
      const sel = this.markers.find(m => m.id === this.selectedMarkerId);
      const label = document.getElementById('beat-display-label');
      if (sel && label) label.textContent = `♪ ${sel.time.toFixed(2)}s`;
    }
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
      const blob = await renderOffline(buffer, this.automationPoints, this.volumePoints, this.reverbPoints, this.filterSlope, this.reverb, start, end);

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
    const content = lines.join('\n');
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

  // Per-page history
  private pushTrimHistory(): void {
    this.trimHistory.push({ trimStart: this.trimStart, trimEnd: this.trimEnd });
    if (this.trimHistory.length > this.maxUndoSize) this.trimHistory.shift();
    this.trimRedoHistory = [];
    this.updateUndoRedoButtons();
  }

  private pushFilterHistory(): void {
    this.filterHistory.push({
      automationPoints: this.automationPoints.map(p => ({ ...p })),
      volumePoints: this.volumePoints.map(p => ({ ...p })),
      reverbPoints: this.reverbPoints.map(p => ({ ...p })),
      filterSlope: this.filterSlope,
      reverb: { ...this.reverb },
    });
    if (this.filterHistory.length > this.maxUndoSize) this.filterHistory.shift();
    this.filterRedoHistory = [];
    this.updateUndoRedoButtons();
  }

  private pushMarkersHistory(): void {
    this.markersHistory.push({
      markers: this.markers.map(m => ({ ...m })),
      suggestedMarkers: this.suggestedMarkers.map(m => ({ ...m })),
      nextMarkerId: this.nextMarkerId,
    });
    if (this.markersHistory.length > this.maxUndoSize) this.markersHistory.shift();
    this.markersRedoHistory = [];
    this.updateUndoRedoButtons();
  }

  private updateUndoRedoButtons(): void {
    const mode = this.mode;
    let canUndo = false, canRedo = false;
    if (mode === 'trim') {
      canUndo = this.trimHistory.length > 1;
      canRedo = this.trimRedoHistory.length > 0;
      const undoBtn = document.getElementById('trim-undo-btn') as HTMLButtonElement | null;
      const redoBtn = document.getElementById('trim-redo-btn') as HTMLButtonElement | null;
      if (undoBtn) undoBtn.disabled = !canUndo;
      if (redoBtn) redoBtn.disabled = !canRedo;
    } else if (mode === 'filter') {
      canUndo = this.filterHistory.length > 1;
      canRedo = this.filterRedoHistory.length > 0;
      const undoBtn = document.getElementById('filter-undo-btn') as HTMLButtonElement | null;
      const redoBtn = document.getElementById('filter-redo-btn') as HTMLButtonElement | null;
      if (undoBtn) undoBtn.disabled = !canUndo;
      if (redoBtn) redoBtn.disabled = !canRedo;
    } else if (mode === 'markers') {
      canUndo = this.markersHistory.length > 1;
      canRedo = this.markersRedoHistory.length > 0;
      const undoBtn = document.getElementById('markers-undo-btn') as HTMLButtonElement | null;
      const redoBtn = document.getElementById('markers-redo-btn') as HTMLButtonElement | null;
      if (undoBtn) undoBtn.disabled = !canUndo;
      if (redoBtn) redoBtn.disabled = !canRedo;
    }
    // Also update legacy buttons if exist
    const legacyUndo = document.getElementById('undo-btn') as HTMLButtonElement | null;
    const legacyRedo = document.getElementById('redo-btn') as HTMLButtonElement | null;
    if (legacyUndo) legacyUndo.disabled = !canUndo;
    if (legacyRedo) legacyRedo.disabled = !canRedo;
  }

  private undoTrim(): void {
    if (this.trimHistory.length <= 1) return;
    const current = this.trimHistory.pop()!;
    this.trimRedoHistory.push(current);
    const prev = this.trimHistory[this.trimHistory.length - 1];
    this.trimStart = prev.trimStart;
    this.trimEnd = prev.trimEnd;
    this.playbackEngine.setTrim(this.trimStart, this.trimEnd);
    this.trimWaveform?.setTrim(this.trimStart, this.trimEnd);
    this.updateTrimDisplay();
    this.updateUndoRedoButtons();
  }

  private redoTrim(): void {
    if (this.trimRedoHistory.length === 0) return;
    const next = this.trimRedoHistory.pop()!;
    this.trimHistory.push(next);
    this.trimStart = next.trimStart;
    this.trimEnd = next.trimEnd;
    this.playbackEngine.setTrim(this.trimStart, this.trimEnd);
    this.trimWaveform?.setTrim(this.trimStart, this.trimEnd);
    this.updateTrimDisplay();
    this.updateUndoRedoButtons();
  }

  private undoFilter(): void {
    if (this.filterHistory.length <= 1) return;
    const current = this.filterHistory.pop()!;
    this.filterRedoHistory.push(current);
    const prev = this.filterHistory[this.filterHistory.length - 1];
    this.automationPoints = prev.automationPoints.map(p => ({ ...p }));
    this.volumePoints = prev.volumePoints.map(p => ({ ...p }));
    this.reverbPoints = prev.reverbPoints.map(p => ({ ...p }));
    this.filterSlope = prev.filterSlope;
    this.reverb = { ...prev.reverb };
    this.playbackEngine.setAutomationPoints(this.automationPoints);
    this.playbackEngine.setVolumePoints(this.volumePoints);
    this.playbackEngine.setReverbPoints(this.reverbPoints);
    this.playbackEngine.setFilterSlope(this.filterSlope);
    this.playbackEngine.setReverb(this.reverb);
    this.automationEditor?.setPoints(this.automationPoints);
    this.volumeEditor?.setPoints(this.volumePoints);
    this.reverbEditor?.setPoints(this.reverbPoints);
    this.syncReverbControls();
    const slopeSelect = document.getElementById('slope-select') as HTMLSelectElement | null;
    if (slopeSelect) slopeSelect.value = String(this.filterSlope);
    this.updateExportInfo();
    this.updateUndoRedoButtons();
  }

  private redoFilter(): void {
    if (this.filterRedoHistory.length === 0) return;
    const next = this.filterRedoHistory.pop()!;
    this.filterHistory.push(next);
    this.automationPoints = next.automationPoints.map(p => ({ ...p }));
    this.volumePoints = next.volumePoints.map(p => ({ ...p }));
    this.reverbPoints = next.reverbPoints.map(p => ({ ...p }));
    this.filterSlope = next.filterSlope;
    this.reverb = { ...next.reverb };
    this.playbackEngine.setAutomationPoints(this.automationPoints);
    this.playbackEngine.setVolumePoints(this.volumePoints);
    this.playbackEngine.setReverbPoints(this.reverbPoints);
    this.playbackEngine.setFilterSlope(this.filterSlope);
    this.playbackEngine.setReverb(this.reverb);
    this.automationEditor?.setPoints(this.automationPoints);
    this.volumeEditor?.setPoints(this.volumePoints);
    this.reverbEditor?.setPoints(this.reverbPoints);
    this.syncReverbControls();
    const slopeSelect = document.getElementById('slope-select') as HTMLSelectElement | null;
    if (slopeSelect) slopeSelect.value = String(this.filterSlope);
    this.updateExportInfo();
    this.updateUndoRedoButtons();
  }

  private undoMarkers(): void {
    if (this.markersHistory.length <= 1) return;
    const current = this.markersHistory.pop()!;
    this.markersRedoHistory.push(current);
    const prev = this.markersHistory[this.markersHistory.length - 1];
    this.markers = prev.markers.map(m => ({ ...m }));
    this.suggestedMarkers = prev.suggestedMarkers.map(m => ({ ...m }));
    this.nextMarkerId = prev.nextMarkerId;
    this.selectedMarkerId = null;
    this.selectedSuggestedMarkerId = null;
    this.markerWaveform?.setMarkers(this.markers);
    this.markerWaveform?.setSuggestedMarkers(this.suggestedMarkers);
    this.markerWaveform?.setSelectedMarker(null);
    this.markerWaveform?.setSelectedSuggestedMarker(null);
    this.updateMarkerDisplay();
    this.updateExportButtons();
    this.updateSuggestedButtons();
    this.updateUndoRedoButtons();
  }

  private redoMarkers(): void {
    if (this.markersRedoHistory.length === 0) return;
    const next = this.markersRedoHistory.pop()!;
    this.markersHistory.push(next);
    this.markers = next.markers.map(m => ({ ...m }));
    this.suggestedMarkers = next.suggestedMarkers.map(m => ({ ...m }));
    this.nextMarkerId = next.nextMarkerId;
    this.selectedMarkerId = null;
    this.selectedSuggestedMarkerId = null;
    this.markerWaveform?.setMarkers(this.markers);
    this.markerWaveform?.setSuggestedMarkers(this.suggestedMarkers);
    this.markerWaveform?.setSelectedMarker(null);
    this.markerWaveform?.setSelectedSuggestedMarker(null);
    this.updateMarkerDisplay();
    this.updateExportButtons();
    this.updateSuggestedButtons();
    this.updateUndoRedoButtons();
  }

  private undo(): void {
    if (this.mode === 'trim') {
      this.undoTrim();
    } else if (this.mode === 'filter') {
      this.undoFilter();
    } else if (this.mode === 'markers') {
      this.undoMarkers();
    }
  }

  private redo(): void {
    if (this.mode === 'trim') {
      this.redoTrim();
    } else if (this.mode === 'filter') {
      this.redoFilter();
    } else if (this.mode === 'markers') {
      this.redoMarkers();
    }
  }

}

document.addEventListener('DOMContentLoaded', () => {
  new LowPassEditor();
});
