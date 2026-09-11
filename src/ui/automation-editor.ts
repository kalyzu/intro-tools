import type { AutomationPoint, CurveType, ViewState } from '../automation/model';
import { evaluateAutomation, clampFrequency, clampTime, sortPoints } from '../automation/model';
import { interpolate } from '../automation/interpolation';

const MIN_FREQ = 20;
const MAX_FREQ = 20000;

const FREQ_LABELS = [
  20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000,
];

const FREQ_LABELS_DISPLAY = [
  '20 Hz', '50 Hz', '100 Hz', '200 Hz', '500 Hz',
  '1 kHz', '2 kHz', '5 kHz', '10 kHz', '20 kHz',
];

export interface AutomationEditorCallbacks {
  onPointsChange: (points: AutomationPoint[]) => void;
  onPointSelect: (index: number | null) => void;
  onSeek: (time: number) => void;
}

export class AutomationEditor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private points: AutomationPoint[] = [];
  private duration = 10;
  private view: ViewState = { viewStart: 0, viewEnd: 10 };
  private selectedIndex: number | null = null;
  private isDraggingPoint = false;
  private dragIndex = -1;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private playheadTime = 0;
  private callbacks: AutomationEditorCallbacks;
  private tooltip: HTMLDivElement | null = null;
  private paddingLeft = 60;
  private paddingRight = 20;
  private paddingTop = 20;
  private paddingBottom = 40;
  private isShiftDown = false;

  private isDraggingControl = false;
  private controlDragSegIndex = -1;
  private hoveredSegment = -1;

  constructor(canvas: HTMLCanvasElement, callbacks: AutomationEditorCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.callbacks = callbacks;
    this.setupEvents();
    this.setupResizeObserver();
    this.createTooltip();
  }

  private createTooltip(): void {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'automation-tooltip';
    this.tooltip.style.display = 'none';
    this.canvas.parentElement?.appendChild(this.tooltip);
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
    this.canvas.addEventListener('contextmenu', this.onContextMenu.bind(this));

    document.addEventListener('keydown', (e) => {
      this.isShiftDown = e.shiftKey;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedIndex !== null) {
          e.preventDefault();
          this.deletePoint(this.selectedIndex);
        }
      }
      if (e.key === 'Escape') {
        this.selectedIndex = null;
        this.callbacks.onPointSelect(null);
        this.render();
      }
    });
    document.addEventListener('keyup', (e) => {
      this.isShiftDown = e.shiftKey;
    });
  }

  setPoints(points: AutomationPoint[]): void {
    this.points = sortPoints(points);
    this.render();
  }

  setDuration(duration: number): void {
    this.duration = duration;
    this.render();
  }

  setView(view: ViewState): void {
    this.view = view;
    this.render();
  }

  setPlayhead(time: number): void {
    this.playheadTime = time;
    this.render();
  }

  getSelectedIndex(): number | null {
    return this.selectedIndex;
  }

  private getGraphBounds(): { x: number; y: number; w: number; h: number } {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: this.paddingLeft * dpr,
      y: this.paddingTop * dpr,
      w: rect.width * dpr - (this.paddingLeft + this.paddingRight) * dpr,
      h: rect.height * dpr - (this.paddingTop + this.paddingBottom) * dpr,
    };
  }

  private timeToX(time: number): number {
    const b = this.getGraphBounds();
    return b.x + ((time - this.view.viewStart) / (this.view.viewEnd - this.view.viewStart)) * b.w;
  }

  private xToTime(x: number): number {
    const b = this.getGraphBounds();
    return this.view.viewStart + ((x - b.x) / b.w) * (this.view.viewEnd - this.view.viewStart);
  }

  private freqToY(freq: number): number {
    const b = this.getGraphBounds();
    const logMin = Math.log(MIN_FREQ);
    const logMax = Math.log(MAX_FREQ);
    const logFreq = Math.log(Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq)));
    const normalized = (logFreq - logMin) / (logMax - logMin);
    return b.y + b.h - normalized * b.h;
  }

  private yToFreq(y: number): number {
    const b = this.getGraphBounds();
    const logMin = Math.log(MIN_FREQ);
    const logMax = Math.log(MAX_FREQ);
    const normalized = 1 - (y - b.y) / b.h;
    const logFreq = logMin + normalized * (logMax - logMin);
    return Math.exp(logFreq);
  }

  private getCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top) * dpr,
    };
  }

  private findPointAt(coords: { x: number; y: number }): number {
    const hitRadius = 12;
    for (let i = 0; i < this.points.length; i++) {
      const px = this.timeToX(this.points[i].time);
      const py = this.freqToY(this.points[i].frequency);
      const dist = Math.sqrt((coords.x - px) ** 2 + (coords.y - py) ** 2);
      if (dist < hitRadius) return i;
    }
    return -1;
  }

  private findControlHandleAt(coords: { x: number; y: number }): number {
    const hitRadius = 14;
    for (let i = 0; i < this.points.length - 1; i++) {
      if (this.points[i].curve !== 'smooth') continue;
      const pA = this.points[i];
      const pB = this.points[i + 1];
      if (pA.controlFreq === null) continue;
      const midTime = (pA.time + pB.time) / 2;
      const hx = this.timeToX(midTime);
      const hy = this.freqToY(pA.controlFreq);
      const dist = Math.sqrt((coords.x - hx) ** 2 + (coords.y - hy) ** 2);
      if (dist < hitRadius) return i;
    }
    return -1;
  }

  private findSegmentAt(coords: { x: number; y: number }): number {
    const hitDist = 12;
    for (let i = 0; i < this.points.length - 1; i++) {
      const pA = this.points[i];
      const pB = this.points[i + 1];
      const xA = this.timeToX(pA.time);
      const xB = this.timeToX(pB.time);
      if (coords.x < xA - 5 || coords.x > xB + 5) continue;

      const steps = 30;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const time = pA.time + t * (pB.time - pA.time);
        const freq = evaluateAutomation(this.points, time, interpolate);
        const sy = this.freqToY(freq);
        if (Math.abs(coords.y - sy) < hitDist) return i;
      }
    }
    return -1;
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const coords = this.getCanvasCoords(e);

    const ctrlIdx = this.findControlHandleAt(coords);
    if (ctrlIdx >= 0) {
      this.isDraggingControl = true;
      this.controlDragSegIndex = ctrlIdx;
      this.selectedIndex = null;
      this.callbacks.onPointSelect(null);
      this.render();
      return;
    }

    const idx = this.findPointAt(coords);
    if (idx >= 0) {
      this.selectedIndex = idx;
      this.isDraggingPoint = true;
      this.dragIndex = idx;
      const px = this.timeToX(this.points[idx].time);
      const py = this.freqToY(this.points[idx].frequency);
      this.dragOffsetX = coords.x - px;
      this.dragOffsetY = coords.y - py;
      this.callbacks.onPointSelect(idx);
      this.render();
      return;
    }

    const segIdx = this.findSegmentAt(coords);
    if (segIdx >= 0) {
      const pA = this.points[segIdx];
      const cursorFreq = this.yToFreq(coords.y);

      if (pA.controlFreq === null) {
        pA.controlFreq = cursorFreq;
      }

      this.isDraggingControl = true;
      this.controlDragSegIndex = segIdx;
      this.selectedIndex = null;
      this.callbacks.onPointSelect(null);
      this.callbacks.onPointsChange([...this.points]);
      this.render();
      return;
    }

    this.selectedIndex = null;
    this.callbacks.onPointSelect(null);
    this.isDraggingPoint = false;

    const time = this.xToTime(coords.x);
    if (time >= this.view.viewStart && time <= this.view.viewEnd) {
      this.callbacks.onSeek(time);
    }
    this.render();
  }

  private onMouseMove(e: MouseEvent): void {
    const coords = this.getCanvasCoords(e);

    if (this.isDraggingControl && this.controlDragSegIndex >= 0) {
      const newFreq = this.yToFreq(coords.y);
      this.points[this.controlDragSegIndex].controlFreq = clampFrequency(newFreq);

      this.showControlTooltip(this.controlDragSegIndex, e.clientX, e.clientY);
      this.callbacks.onPointsChange([...this.points]);
      this.render();
      return;
    }

    if (this.isDraggingPoint && this.dragIndex >= 0) {
      const b = this.getGraphBounds();
      let newX = coords.x - this.dragOffsetX;
      let newY = coords.y - this.dragOffsetY;

      newX = Math.max(b.x, Math.min(b.x + b.w, newX));
      newY = Math.max(b.y, Math.min(b.y + b.h, newY));

      let newTime = this.xToTime(newX);
      let newFreq = this.yToFreq(newY);

      if (this.isShiftDown) {
        newTime = Math.round(newTime * 100) / 100;
        newFreq = Math.round(newFreq / 10) * 10;
      }

      newFreq = clampFrequency(newFreq);
      newTime = clampTime(newTime, this.duration);

      if (this.dragIndex > 0) {
        const prevTime = this.points[this.dragIndex - 1].time;
        newTime = Math.max(prevTime + 0.01, newTime);
      }
      if (this.dragIndex < this.points.length - 1) {
        const nextTime = this.points[this.dragIndex + 1].time;
        newTime = Math.min(nextTime - 0.01, newTime);
      }

      this.points[this.dragIndex].time = newTime;
      this.points[this.dragIndex].frequency = newFreq;

      this.showTooltip(newTime, newFreq, e.clientX, e.clientY);
      this.callbacks.onPointsChange([...this.points]);
      this.render();
      return;
    }

    const ctrlIdx = this.findControlHandleAt(coords);
    const idx = this.findPointAt(coords);
    const segIdx = idx < 0 && ctrlIdx < 0 ? this.findSegmentAt(coords) : -1;

    if (ctrlIdx >= 0) {
      this.canvas.style.cursor = 'grab';
      this.hoveredSegment = -1;
    } else if (idx >= 0) {
      this.canvas.style.cursor = 'grab';
      this.hoveredSegment = -1;
    } else if (segIdx >= 0) {
      this.canvas.style.cursor = 'crosshair';
      this.hoveredSegment = segIdx;
    } else {
      this.canvas.style.cursor = 'crosshair';
      this.hoveredSegment = -1;
    }

    this.render();
  }

  private onMouseUp(): void {
    if (this.isDraggingControl) {
      this.isDraggingControl = false;
      this.controlDragSegIndex = -1;
      this.hideTooltip();
      this.render();
    }
    if (this.isDraggingPoint) {
      this.isDraggingPoint = false;
      this.dragIndex = -1;
      this.hideTooltip();
    }
  }

  private onMouseLeave(): void {
    this.hoveredSegment = -1;
    if (this.isDraggingControl) {
      this.isDraggingControl = false;
      this.controlDragSegIndex = -1;
      this.hideTooltip();
    }
    if (this.isDraggingPoint) {
      this.isDraggingPoint = false;
      this.dragIndex = -1;
      this.hideTooltip();
    }
    this.render();
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const coords = this.getCanvasCoords(e);
    const idx = this.findPointAt(coords);

    if (idx >= 0 && idx < this.points.length) {
      this.points[idx].curve = this.points[idx].curve === 'smooth' ? 'linear' : 'smooth';
      if (this.points[idx].curve === 'linear') {
        this.points[idx].controlFreq = null;
      }
      this.selectedIndex = idx;
      this.callbacks.onPointsChange([...this.points]);
      this.render();
    }
  }

  private onDoubleClick(e: MouseEvent): void {
    const coords = this.getCanvasCoords(e);
    const time = this.xToTime(coords.x);
    const freq = this.yToFreq(coords.y);

    if (time < this.view.viewStart || time > this.view.viewEnd) return;

    let curve: CurveType = 'smooth';
    for (let i = 0; i < this.points.length - 1; i++) {
      if (time > this.points[i].time && time < this.points[i + 1].time) {
        curve = this.points[i].curve;
        break;
      }
    }

    const newPoint: AutomationPoint = {
      time: clampTime(time, this.duration),
      frequency: clampFrequency(freq),
      curve,
      controlFreq: null,
    };

    this.points.push(newPoint);
    this.points = sortPoints(this.points);
    this.selectedIndex = this.points.indexOf(newPoint);
    this.callbacks.onPointsChange([...this.points]);
    this.callbacks.onPointSelect(this.selectedIndex);
    this.render();
  }

  deletePoint(index: number): void {
    if (this.points.length <= 2) return;
    if (index < 0 || index >= this.points.length) return;
    this.points.splice(index, 1);
    this.selectedIndex = null;
    this.callbacks.onPointsChange([...this.points]);
    this.callbacks.onPointSelect(null);
    this.render();
  }

  private showTooltip(time: number, freq: number, clientX: number, clientY: number): void {
    if (!this.tooltip) return;
    const freqStr = freq >= 1000 ? `${(freq / 1000).toFixed(2)} kHz` : `${Math.round(freq)} Hz`;
    this.tooltip.textContent = `${time.toFixed(3)} s  ${freqStr}`;
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${clientX + 15}px`;
    this.tooltip.style.top = `${clientY - 30}px`;
  }

  private showControlTooltip(segIndex: number, clientX: number, clientY: number): void {
    if (!this.tooltip) return;
    const pA = this.points[segIndex];
    const pB = this.points[segIndex + 1];
    if (pA.controlFreq === null) return;
    const midTime = (pA.time + pB.time) / 2;
    const freq = pA.controlFreq;
    const freqStr = freq >= 1000 ? `${(freq / 1000).toFixed(2)} kHz` : `${Math.round(freq)} Hz`;
    this.tooltip.textContent = `${midTime.toFixed(3)} s  ${freqStr}`;
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${clientX + 15}px`;
    this.tooltip.style.top = `${clientY - 30}px`;
  }

  private hideTooltip(): void {
    if (this.tooltip) {
      this.tooltip.style.display = 'none';
    }
  }

  render(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const b = this.getGraphBounds();

    this.drawGrid(b);
    this.drawCurve(b);
    this.drawControlHandles(b);
    this.drawPoints(b);
    this.drawPlayhead(b);
  }

  private drawGrid(b: { x: number; y: number; w: number; h: number }): void {
    const ctx = this.ctx;

    ctx.strokeStyle = '#1a2a3a';
    ctx.lineWidth = 1;

    for (let i = 0; i < FREQ_LABELS.length; i++) {
      const y = this.freqToY(FREQ_LABELS[i]);
      if (y < b.y || y > b.y + b.h) continue;
      ctx.beginPath();
      ctx.moveTo(b.x, y);
      ctx.lineTo(b.x + b.w, y);
      ctx.stroke();

      ctx.fillStyle = '#5a7a9a';
      ctx.font = `${11}px "SF Mono", "Fira Code", monospace`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(FREQ_LABELS_DISPLAY[i], b.x - 8, y);
    }

    const viewDuration = this.view.viewEnd - this.view.viewStart;
    let timeStep: number;
    if (viewDuration > 30) timeStep = 5;
    else if (viewDuration > 10) timeStep = 2;
    else if (viewDuration > 5) timeStep = 1;
    else if (viewDuration > 2) timeStep = 0.5;
    else timeStep = 0.1;

    const firstTick = Math.ceil(this.view.viewStart / timeStep) * timeStep;
    for (let t = firstTick; t <= this.view.viewEnd; t += timeStep) {
      const x = this.timeToX(t);
      ctx.beginPath();
      ctx.moveTo(x, b.y);
      ctx.lineTo(x, b.y + b.h);
      ctx.stroke();

      ctx.fillStyle = '#5a7a9a';
      ctx.font = `${11}px "SF Mono", "Fira Code", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(t >= 10 ? t.toFixed(1) : t.toFixed(2) + 's', x, b.y + b.h + 8);
    }

    ctx.strokeStyle = '#2a4a5a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }

  private drawCurve(_b: { x: number; y: number; w: number; h: number }): void {
    if (this.points.length < 2) return;

    const ctx = this.ctx;

    for (let i = 0; i < this.points.length - 1; i++) {
      const pA = this.points[i];
      const pB = this.points[i + 1];

      ctx.strokeStyle = '#4fc3f7';
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      const steps = Math.max(50, (this.timeToX(pB.time) - this.timeToX(pA.time)) / 2);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const time = pA.time + t * (pB.time - pA.time);
        const freq = evaluateAutomation(this.points, time, interpolate);
        const x = this.timeToX(time);
        const y = this.freqToY(freq);

        if (s === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.stroke();
    }
  }

  private drawControlHandles(_b: { x: number; y: number; w: number; h: number }): void {
    const ctx = this.ctx;

    for (let i = 0; i < this.points.length - 1; i++) {
      const pA = this.points[i];
      const pB = this.points[i + 1];

      if (pA.curve !== 'smooth' || pA.controlFreq === null) continue;

      const midTime = (pA.time + pB.time) / 2;
      const hx = this.timeToX(midTime);
      const hy = this.freqToY(pA.controlFreq);

      const ax = this.timeToX(pA.time);
      const ay = this.freqToY(pA.frequency);
      const bx = this.timeToX(pB.time);
      const by = this.freqToY(pB.frequency);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;

      ctx.strokeStyle = 'rgba(79, 195, 247, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.setLineDash([]);

      const isActive = this.isDraggingControl && this.controlDragSegIndex === i;
      const isHovered = this.hoveredSegment === i;

      ctx.beginPath();
      ctx.arc(hx, hy, isActive ? 6 : isHovered ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#ff6b6b' : '#4fc3f7';
      ctx.fill();
      if (isActive || isHovered) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  private drawPoints(_b: { x: number; y: number; w: number; h: number }): void {
    const ctx = this.ctx;

    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const x = this.timeToX(p.time);
      const y = this.freqToY(p.frequency);
      const isSelected = i === this.selectedIndex;

      ctx.beginPath();
      ctx.arc(x, y, isSelected ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#ff6b6b' : '#4fc3f7';
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  private drawPlayhead(b: { x: number; y: number; w: number; h: number }): void {
    const x = this.timeToX(this.playheadTime);
    if (x < b.x || x > b.x + b.w) return;
    const ctx = this.ctx;

    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, b.y);
    ctx.lineTo(x, b.y + b.h);
    ctx.stroke();

    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.moveTo(x - 5, b.y);
    ctx.lineTo(x + 5, b.y);
    ctx.lineTo(x, b.y + 8);
    ctx.closePath();
    ctx.fill();
  }
}
