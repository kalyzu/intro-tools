import type { ViewState, Marker } from '../automation/model';

const TRIM_HANDLE_WIDTH = 8;

export class WaveformRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buffer: AudioBuffer | null = null;
  private peaks: Float32Array | null = null;
  private playheadTime = 0;
  private homeTime = 0;
  private view: ViewState = { viewStart: 0, viewEnd: 10 };
  private trimStart = 0;
  private trimEnd = 10;
  private markers: Marker[] = [];
  private selectedMarkerId: number | null = null;
  private paddingLeft = 60;
  private paddingRight = 20;

  private isDraggingTrimStart = false;
  private isDraggingTrimEnd = false;
  private isDraggingMarker = false;
  private dragMarkerId: number | null = null;
  private trimVisible = true;
  private markersVisible = true;
  private showBorder = false;

  private onTrimChange: ((start: number, end: number) => void) | null = null;
  private onMarkerAdd: ((time: number) => void) | null = null;
  private onMarkerMove: ((id: number, time: number) => void) | null = null;
  private onMarkerSelect: ((id: number | null) => void) | null = null;
  private onSeek: ((time: number) => void) | null = null;
  private onZoomRequest: ((centerTime: number, factor: number, frac: number) => void) | null = null;
  private onPanRequest: ((delta: number) => void) | null = null;

  private hoverX: number | null = null;
  private deferSeekToDoubleClick = false;
  private pendingSeekTimer: number | null = null;
  private lastEmptyClickTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.setupResizeObserver();
    this.setupEvents();
  }

  private setupResizeObserver(): void {
    const observer = new ResizeObserver(() => this.render());
    observer.observe(this.canvas);
  }

  private setupEvents(): void {
    this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
    this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
    this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
    this.canvas.addEventListener('mouseleave', this.onMouseLeave.bind(this));
    this.canvas.addEventListener('dblclick', this.onDoubleClick.bind(this));
    this.canvas.addEventListener('wheel', this.onWheel.bind(this));
  }

  setZoomRequestCallback(cb: (centerTime: number, factor: number, frac: number) => void): void {
    this.onZoomRequest = cb;
  }

  setPanRequestCallback(cb: (delta: number) => void): void {
    this.onPanRequest = cb;
  }

  setDeferSeekToDoubleClick(defer: boolean): void {
    this.deferSeekToDoubleClick = defer;
  }

  getHoverTime(): number | null {
    if (this.hoverX === null) return null;
    const t = this.xToTime(this.hoverX);
    if (t < this.view.viewStart || t > this.view.viewEnd) return null;
    return t;
  }

  setTrimChangeCallback(cb: (start: number, end: number) => void): void {
    this.onTrimChange = cb;
  }

  setMarkerCallbacks(
    onAdd: (time: number) => void,
    onMove: (id: number, time: number) => void,
    onSelect: (id: number | null) => void
  ): void {
    this.onMarkerAdd = onAdd;
    this.onMarkerMove = onMove;
    this.onMarkerSelect = onSelect;
  }

  setSeekCallback(cb: (time: number) => void): void {
    this.onSeek = cb;
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    this.peaks = this.extractPeaks(buffer, 4000);
    this.render();
  }

  setView(view: ViewState): void {
    this.view = view;
    this.render();
  }

  setTrim(start: number, end: number): void {
    this.trimStart = start;
    this.trimEnd = end;
    this.render();
  }

  setTrimVisible(visible: boolean): void {
    this.trimVisible = visible;
    this.render();
  }

  setMarkersVisible(visible: boolean): void {
    this.markersVisible = visible;
    this.render();
  }

  setShowBorder(show: boolean): void {
    this.showBorder = show;
    this.render();
  }

  setMarkers(markers: Marker[]): void {
    this.markers = markers;
    this.render();
  }

  setSelectedMarker(id: number | null): void {
    this.selectedMarkerId = id;
    this.render();
  }

  setPlayhead(time: number): void {
    this.playheadTime = time;
    this.render();
  }

  setHomeTime(time: number): void {
    this.homeTime = time;
    this.render();
  }

  getPaddingLeft(): number {
    return this.paddingLeft;
  }

  getPaddingRight(): number {
    return this.paddingRight;
  }

  private getCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top) * dpr,
    };
  }

  private timeToX(time: number): number {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width * dpr;
    const graphWidth = w - (this.paddingLeft + this.paddingRight) * dpr;
    return this.paddingLeft * dpr + ((time - this.view.viewStart) / (this.view.viewEnd - this.view.viewStart)) * graphWidth;
  }

  private xToTime(x: number): number {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width * dpr;
    const graphWidth = w - (this.paddingLeft + this.paddingRight) * dpr;
    return this.view.viewStart + ((x - this.paddingLeft * dpr) / graphWidth) * (this.view.viewEnd - this.view.viewStart);
  }

  private cssVar(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  private extractPeaks(buffer: AudioBuffer, resolution: number): Float32Array {
    const channelData = buffer.getChannelData(0);
    const peaks = new Float32Array(resolution);
    const samplesPerPeak = Math.floor(channelData.length / resolution);

    for (let i = 0; i < resolution; i++) {
      let max = 0;
      const start = i * samplesPerPeak;
      const end = Math.min(start + samplesPerPeak, channelData.length);
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }

    return peaks;
  }

  private findTrimHandleAt(coords: { x: number; y: number }): 'start' | 'end' | null {
    const handleW = TRIM_HANDLE_WIDTH * (window.devicePixelRatio || 1);
    const startX = this.timeToX(this.trimStart);
    const endX = this.timeToX(this.trimEnd);

    if (Math.abs(coords.x - startX) < handleW) return 'start';
    if (Math.abs(coords.x - endX) < handleW) return 'end';
    return null;
  }

  private findMarkerAt(coords: { x: number; y: number }): number | null {
    const hitRadius = 10 * (window.devicePixelRatio || 1);
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const h = rect.height * dpr;
    const markerY = h * 0.15;

    for (const m of this.markers) {
      const mx = this.timeToX(m.time);
      if (Math.abs(coords.x - mx) < hitRadius && Math.abs(coords.y - markerY) < hitRadius * 2) {
        return m.id;
      }
    }
    return null;
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const coords = this.getCanvasCoords(e);

    const markerId = this.markersVisible ? this.findMarkerAt(coords) : null;
    if (markerId !== null) {
      this.isDraggingMarker = true;
      this.dragMarkerId = markerId;
      this.onMarkerSelect?.(markerId);
      return;
    }

    const handle = this.trimVisible ? this.findTrimHandleAt(coords) : null;
    if (handle === 'start') {
      this.isDraggingTrimStart = true;
      return;
    }
    if (handle === 'end') {
      this.isDraggingTrimEnd = true;
      return;
    }

    this.onMarkerSelect?.(null);

    const time = this.xToTime(coords.x);
    if (time >= this.view.viewStart && time <= this.view.viewEnd) {
      if (this.deferSeekToDoubleClick) {
        this.scheduleDeferredSeek(time);
      } else {
        this.onSeek?.(time);
      }
    }
  }

  private scheduleDeferredSeek(time: number): void {
    const now = performance.now();
    this.clearPendingSeek();

    if (this.lastEmptyClickTime !== 0 && now - this.lastEmptyClickTime < 400) {
      this.lastEmptyClickTime = now;
      return;
    }

    this.lastEmptyClickTime = now;
    this.pendingSeekTimer = window.setTimeout(() => {
      if (this.pendingSeekTimer !== null) {
        this.pendingSeekTimer = null;
        this.onSeek?.(time);
      }
    }, 300);
  }

  private clearPendingSeek(): void {
    if (this.pendingSeekTimer !== null) {
      window.clearTimeout(this.pendingSeekTimer);
      this.pendingSeekTimer = null;
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.onPanRequest && e.shiftKey) {
      const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      this.onPanRequest(delta);
      return;
    }
    if (!this.onZoomRequest) return;
    const coords = this.getCanvasCoords(e);
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const graphWidth = rect.width * dpr - (this.paddingLeft + this.paddingRight) * dpr;
    const frac = Math.max(0, Math.min(1, (coords.x - this.paddingLeft * dpr) / Math.max(1, graphWidth)));
    const center = this.xToTime(coords.x);
    const factor = Math.pow(1.5, -e.deltaY / 100);
    this.onZoomRequest(center, factor, frac);
  }

  private onMouseMove(e: MouseEvent): void {
    const coords = this.getCanvasCoords(e);
    this.hoverX = coords.x;

    if (this.isDraggingMarker && this.dragMarkerId !== null) {
      const time = this.xToTime(coords.x);
      const clamped = Math.max(this.view.viewStart, Math.min(this.view.viewEnd, time));
      this.onMarkerMove?.(this.dragMarkerId, clamped);
      return;
    }

    if (this.isDraggingTrimStart) {
      const time = this.xToTime(coords.x);
      const clamped = Math.max(0, Math.min(this.trimEnd - 0.1, time));
      this.trimStart = clamped;
      this.onTrimChange?.(this.trimStart, this.trimEnd);
      this.render();
      return;
    }

    if (this.isDraggingTrimEnd) {
      const time = this.xToTime(coords.x);
      const duration = this.buffer?.duration ?? 0;
      const clamped = Math.max(this.trimStart + 0.1, Math.min(duration, time));
      this.trimEnd = clamped;
      this.onTrimChange?.(this.trimStart, this.trimEnd);
      this.render();
      return;
    }

    const handle = this.trimVisible ? this.findTrimHandleAt(coords) : null;
    const markerId = this.markersVisible ? this.findMarkerAt(coords) : null;

    if (handle || markerId !== null) {
      this.canvas.style.cursor = 'ew-resize';
    } else {
      this.canvas.style.cursor = 'crosshair';
    }
    this.render();
  }

  private onMouseUp(): void {
    this.isDraggingTrimStart = false;
    this.isDraggingTrimEnd = false;
    this.isDraggingMarker = false;
    this.dragMarkerId = null;
  }

  private onMouseLeave(): void {
    this.hoverX = null;
    this.onMouseUp();
    this.render();
  }

  private onDoubleClick(e: MouseEvent): void {
    if (!this.markersVisible) return;
    const coords = this.getCanvasCoords(e);
    this.clearPendingSeek();
    const markerId = this.findMarkerAt(coords);
    if (markerId !== null) return;

    const time = this.xToTime(coords.x);
    if (time >= this.view.viewStart && time <= this.view.viewEnd) {
      this.onMarkerAdd?.(time);
    }
    this.lastEmptyClickTime = 0;
  }

  render(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);

    if (!this.peaks) return;

    if (this.showBorder) {
      this.drawBorder(w, h);
    }
    this.drawWaveform(w, h);
    if (this.trimVisible) {
      this.drawTrimRegion(w, h);
      this.drawTrimHandles(w, h);
    }
    if (this.markersVisible) {
      this.drawMarkers(w, h);
    }
    this.drawHoverLine(h);
    this.drawHomeLine(h);
    this.drawPlayhead(h);
  }

  private drawBorder(w: number, h: number): void {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const x = this.paddingLeft * dpr;
    const y = 4 * dpr;
    const bw = w - (this.paddingLeft + this.paddingRight) * dpr;
    const bh = h - 8 * dpr;
    if (bw <= 0 || bh <= 0) return;
    ctx.save();
    ctx.strokeStyle = this.cssVar('--grid-border', '#2a4a5a');
    ctx.lineWidth = 1.5 * dpr;
    // Rounded rect for a nice look
    const radius = 6 * dpr;
    ctx.beginPath();
    // @ts-ignore - roundRect may not be in older TS lib
    if ((ctx as any).roundRect) {
      (ctx as any).roundRect(x, y, bw, bh, radius);
    } else {
      ctx.rect(x, y, bw, bh);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawHoverLine(h: number): void {
    if (this.hoverX === null) return;
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(240, 192, 64, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(this.hoverX, 0);
    ctx.lineTo(this.hoverX, h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawHomeLine(h: number): void {
    if (this.homeTime < this.view.viewStart || this.homeTime > this.view.viewEnd) return;
    const x = this.timeToX(this.homeTime);
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(79, 170, 247, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  private drawTrimRegion(w: number, h: number): void {
    const ctx = this.ctx;
    const startX = this.timeToX(this.trimStart);
    const endX = this.timeToX(this.trimEnd);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(0, 0, startX, h);
    ctx.fillRect(endX, 0, w - endX, h);
  }

  private drawWaveform(w: number, h: number): void {
    if (!this.peaks || !this.buffer) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const centerY = h / 2;
    const graphWidth = w - (this.paddingLeft + this.paddingRight) * dpr;
    const startX = this.paddingLeft * dpr;

    const viewDuration = this.view.viewEnd - this.view.viewStart;
    const peaksPerSecond = this.peaks.length / this.buffer.duration;

    ctx.fillStyle = this.cssVar('--waveform-fill', '#2a3a4a');
    for (let px = 0; px < graphWidth; px++) {
      const t = this.view.viewStart + (px / graphWidth) * viewDuration;
      const peakIndex = Math.max(0, Math.min(this.peaks.length - 1, Math.floor(t * peaksPerSecond)));
      const amp = this.peaks[peakIndex] * centerY * 0.9;
      ctx.fillRect(startX + px, centerY - amp, 1, amp * 2);
    }
  }

  private drawTrimHandles(_w: number, h: number): void {
    const ctx = this.ctx;
    const startX = this.timeToX(this.trimStart);
    const endX = this.timeToX(this.trimEnd);
    const handleW = TRIM_HANDLE_WIDTH * (window.devicePixelRatio || 1);

    ctx.fillStyle = '#4fc3f7';
    ctx.fillRect(startX - handleW / 2, 0, handleW, h);
    ctx.fillRect(endX - handleW / 2, 0, handleW, h);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;

    const gripLines = 3;
    const gripSpacing = 6 * (window.devicePixelRatio || 1);

    for (let i = 0; i < gripLines; i++) {
      const y = h / 2 + (i - 1) * gripSpacing;
      ctx.beginPath();
      ctx.moveTo(startX - 2, y);
      ctx.lineTo(startX + 2, y);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(endX - 2, y);
      ctx.lineTo(endX + 2, y);
      ctx.stroke();
    }
  }

  private drawMarkers(_w: number, h: number): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const markerY = h * 0.15;

    for (const m of this.markers) {
      const mx = this.timeToX(m.time);
      const isSelected = m.id === this.selectedMarkerId;

      ctx.strokeStyle = isSelected ? '#ff6b6b' : '#f0c040';
      ctx.lineWidth = isSelected ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, h);
      ctx.stroke();

      ctx.fillStyle = isSelected ? '#ff6b6b' : '#f0c040';
      ctx.beginPath();
      ctx.arc(mx, markerY, isSelected ? 5 * dpr : 4 * dpr, 0, Math.PI * 2);
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.fillStyle = isSelected ? '#ff6b6b' : '#f0c040';
      ctx.font = `bold ${10 * dpr}px "SF Mono", "Fira Code", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(m.time.toFixed(2) + 's', mx, markerY - 6 * dpr);
    }
  }

  private drawPlayhead(h: number): void {
    const x = this.timeToX(this.playheadTime);
    const ctx = this.ctx;

    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}
