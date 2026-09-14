import type { ViewState, Marker } from '../automation/model';

const TRIM_HANDLE_WIDTH = 8;

export class WaveformRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buffer: AudioBuffer | null = null;
  private playheadTime = 0;
  private homeTime = 0;
  private view: ViewState = { viewStart: 0, viewEnd: 10 };
  private trimStart = 0;
  private trimEnd = 10;
  private markers: Marker[] = [];
  private selectedMarkerId: number | null = null;
  private suggestedMarkers: Marker[] = [];
  private suggestedVisible = true;
  private selectedSuggestedMarkerId: number | null = null;
  private paddingLeft = 60;
  private paddingRight = 20;

  private isDraggingTrimStart = false;
  private isDraggingTrimEnd = false;
  private isDraggingMarker = false;
  private dragMarkerId: number | null = null;
  private isDraggingSuggestedMarker = false;
  private dragSuggestedMarkerId: number | null = null;
  private trimVisible = true;
  private markersVisible = true;
  private showBorder = false;

  // Audacity-style cached peak envelope (min/max per block)
  private peakCache: {
    blockSize: number;
    numBlocks: number;
    channelMins: Float32Array[];
    channelMaxs: Float32Array[];
  } | null = null;
  private static readonly BASE_BLOCK_SIZE = 256;

  private onTrimChange: ((start: number, end: number) => void) | null = null;
  private onMarkerAdd: ((time: number) => void) | null = null;
  private onMarkerMove: ((id: number, time: number) => void) | null = null;
  private onMarkerSelect: ((id: number | null) => void) | null = null;
  private onSuggestedMarkerMove: ((id: number, time: number) => void) | null = null;
  private onSuggestedMarkerSelect: ((id: number | null) => void) | null = null;
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

  setSuggestedMarkerCallbacks(
    onMove: (id: number, time: number) => void,
    onSelect: (id: number | null) => void
  ): void {
    this.onSuggestedMarkerMove = onMove;
    this.onSuggestedMarkerSelect = onSelect;
  }

  setSeekCallback(cb: (time: number) => void): void {
    this.onSeek = cb;
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    this.buildPeakCache();
    this.render();
  }

  private buildPeakCache(): void {
    if (!this.buffer) {
      this.peakCache = null;
      return;
    }
    const blockSize = WaveformRenderer.BASE_BLOCK_SIZE;
    const channels = this.buffer.numberOfChannels;
    const length = this.buffer.length;
    const numBlocks = Math.ceil(length / blockSize);
    const channelMins: Float32Array[] = [];
    const channelMaxs: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) {
      const data = this.buffer.getChannelData(ch);
      const mins = new Float32Array(numBlocks);
      const maxs = new Float32Array(numBlocks);
      for (let b = 0; b < numBlocks; b++) {
        const start = b * blockSize;
        const end = Math.min(start + blockSize, length);
        let min = Infinity;
        let max = -Infinity;
        for (let i = start; i < end; i++) {
          const v = data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        if (min === Infinity) min = 0;
        if (max === -Infinity) max = 0;
        mins[b] = min;
        maxs[b] = max;
      }
      channelMins.push(mins);
      channelMaxs.push(maxs);
    }
    this.peakCache = { blockSize, numBlocks, channelMins, channelMaxs };
  }

  private getPeakForRange(s0: number, s1: number): { min: number; max: number } {
    if (!this.buffer || !this.peakCache) return { min: 0, max: 0 };
    const { blockSize, channelMins, channelMaxs } = this.peakCache;
    const bufferLength = this.buffer.length;
    s0 = Math.max(0, Math.min(bufferLength, s0));
    s1 = Math.max(0, Math.min(bufferLength, s1));
    if (s1 <= s0) s1 = Math.min(bufferLength, s0 + 1);
    const rangeLen = s1 - s0;
    if (rangeLen <= blockSize * 2) {
      let min = Infinity;
      let max = -Infinity;
      for (let ch = 0; ch < this.buffer.numberOfChannels; ch++) {
        const data = this.buffer.getChannelData(ch);
        for (let i = s0; i < s1; i++) {
          const v = data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (min === Infinity) min = 0;
      if (max === -Infinity) max = 0;
      return { min, max };
    }
    const startBlock = Math.floor(s0 / blockSize);
    const endBlock = Math.ceil(s1 / blockSize);
    let min = Infinity;
    let max = -Infinity;
    for (let ch = 0; ch < channelMins.length; ch++) {
      const mins = channelMins[ch];
      const maxs = channelMaxs[ch];
      const firstBlockStart = startBlock * blockSize;
      const firstBlockEnd = Math.min((startBlock + 1) * blockSize, bufferLength);
      if (s0 > firstBlockStart && s0 < firstBlockEnd) {
        const data = this.buffer.getChannelData(ch);
        for (let i = s0; i < Math.min(s1, firstBlockEnd); i++) {
          const v = data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      } else if (s0 <= firstBlockStart) {
        if (startBlock < mins.length) {
          if (mins[startBlock] < min) min = mins[startBlock];
          if (maxs[startBlock] > max) max = maxs[startBlock];
        }
      }
      for (let b = startBlock + 1; b < endBlock - 1; b++) {
        if (b < 0 || b >= mins.length) continue;
        if (mins[b] < min) min = mins[b];
        if (maxs[b] > max) max = maxs[b];
      }
      if (endBlock - 1 > startBlock) {
        const lastBlock = endBlock - 1;
        const lastBlockStart = lastBlock * blockSize;
        const lastBlockEnd = Math.min((lastBlock + 1) * blockSize, bufferLength);
        if (s1 > lastBlockStart && s1 < lastBlockEnd) {
          const data = this.buffer.getChannelData(ch);
          for (let i = Math.max(s0, lastBlockStart); i < s1; i++) {
            const v = data[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
        } else if (s1 >= lastBlockEnd) {
          if (lastBlock < mins.length) {
            if (mins[lastBlock] < min) min = mins[lastBlock];
            if (maxs[lastBlock] > max) max = maxs[lastBlock];
          }
        }
      }
    }
    if (min === Infinity) min = 0;
    if (max === -Infinity) max = 0;
    return { min, max };
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

  setSuggestedMarkers(markers: Marker[]): void {
    this.suggestedMarkers = markers;
    this.render();
  }

  setSuggestedVisible(visible: boolean): void {
    this.suggestedVisible = visible;
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
    if (id !== null) this.selectedSuggestedMarkerId = null;
    this.render();
  }

  setSelectedSuggestedMarker(id: number | null): void {
    this.selectedSuggestedMarkerId = id;
    if (id !== null) this.selectedMarkerId = null;
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

  private findSuggestedMarkerAt(coords: { x: number; y: number }): number | null {
    if (!this.suggestedVisible) return null;
    const hitRadius = 10 * (window.devicePixelRatio || 1);
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const h = rect.height * dpr;
    const markerY = h * 0.15;
    for (const m of this.suggestedMarkers) {
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

    const suggestedId = this.findSuggestedMarkerAt(coords);
    if (suggestedId !== null) {
      this.isDraggingSuggestedMarker = true;
      this.dragSuggestedMarkerId = suggestedId;
      this.selectedSuggestedMarkerId = suggestedId;
      this.selectedMarkerId = null;
      this.onSuggestedMarkerSelect?.(suggestedId);
      this.onMarkerSelect?.(null);
      this.render();
      return;
    }

    const markerId = this.markersVisible ? this.findMarkerAt(coords) : null;
    if (markerId !== null) {
      this.isDraggingMarker = true;
      this.dragMarkerId = markerId;
      this.selectedMarkerId = markerId;
      this.selectedSuggestedMarkerId = null;
      this.onMarkerSelect?.(markerId);
      this.onSuggestedMarkerSelect?.(null);
      this.render();
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

    // Clicked empty - deselect both
    this.selectedMarkerId = null;
    this.selectedSuggestedMarkerId = null;
    this.onMarkerSelect?.(null);
    this.onSuggestedMarkerSelect?.(null);
    this.render();

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

    if (this.isDraggingSuggestedMarker && this.dragSuggestedMarkerId !== null) {
      const time = this.xToTime(coords.x);
      const clamped = Math.max(this.view.viewStart, Math.min(this.view.viewEnd, time));
      this.onSuggestedMarkerMove?.(this.dragSuggestedMarkerId, clamped);
      return;
    }

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
    const suggestedId = this.findSuggestedMarkerAt(coords);

    if (handle || markerId !== null || suggestedId !== null) {
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
    this.isDraggingSuggestedMarker = false;
    this.dragSuggestedMarkerId = null;
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
    const suggestedId = this.findSuggestedMarkerAt(coords);
    if (markerId !== null || suggestedId !== null) return;

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

    if (!this.buffer) return;

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
    if (!this.buffer) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const graphWidth = w - (this.paddingLeft + this.paddingRight) * dpr;
    const startX = this.paddingLeft * dpr;
    if (graphWidth <= 0) return;

    const sampleRate = this.buffer.sampleRate;
    const viewDuration = this.view.viewEnd - this.view.viewStart;
    const centerY = h / 2;
    const amplitudeScale = centerY * 0.9;

    ctx.fillStyle = this.cssVar('--waveform-fill', '#2a3a4a');

    // Audacity-style: per-pixel min/max envelope, not averaged
    for (let px = 0; px < graphWidth; px++) {
      const t0 = this.view.viewStart + (px / graphWidth) * viewDuration;
      const t1 = this.view.viewStart + ((px + 1) / graphWidth) * viewDuration;
      const s0 = Math.floor(t0 * sampleRate);
      const s1 = Math.ceil(t1 * sampleRate);
      const { min, max } = this.getPeakForRange(s0, s1);
      if (min === 0 && max === 0) continue;
      const yMin = centerY + min * amplitudeScale;
      const yMax = centerY + max * amplitudeScale;
      const y = Math.min(yMin, yMax);
      const height = Math.max(1, Math.abs(yMax - yMin));
      ctx.fillRect(startX + px, y, 1, height);
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

    // Draw suggested (green) first, so yellow appears on top if overlapping
    if (this.suggestedVisible) {
      for (const m of this.suggestedMarkers) {
        const mx = this.timeToX(m.time);
        const isSelected = m.id === this.selectedSuggestedMarkerId;

        ctx.strokeStyle = isSelected ? '#ff6b6b' : '#4caf50';
        ctx.lineWidth = isSelected ? 2 : 1.5;
        ctx.setLineDash(isSelected ? [] : [4 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.moveTo(mx, 0);
        ctx.lineTo(mx, h);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = isSelected ? '#ff6b6b' : '#4caf50';
        ctx.beginPath();
        // Diamond shape for suggested to distinguish from yellow circles
        const r = isSelected ? 5 * dpr : 4 * dpr;
        ctx.moveTo(mx, markerY - r);
        ctx.lineTo(mx + r, markerY);
        ctx.lineTo(mx, markerY + r);
        ctx.lineTo(mx - r, markerY);
        ctx.closePath();
        ctx.fill();

        if (isSelected) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        ctx.fillStyle = isSelected ? '#ff6b6b' : '#4caf50';
        ctx.font = `bold ${10 * dpr}px "SF Mono", "Fira Code", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(m.time.toFixed(2) + 's', mx, markerY - 6 * dpr);
      }
    }

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
