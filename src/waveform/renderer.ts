export class WaveformRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buffer: AudioBuffer | null = null;
  private peaks: Float32Array | null = null;
  private playheadTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.setupResizeObserver();
  }

  private setupResizeObserver(): void {
    const observer = new ResizeObserver(() => {
      this.render();
    });
    observer.observe(this.canvas);
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    this.peaks = this.extractPeaks(buffer, 2000);
    this.render();
  }

  setPlayhead(time: number): void {
    this.playheadTime = time;
    this.render();
  }

  setPlaying(_playing: boolean): void {
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

  timeToX(time: number): number {
    if (!this.buffer) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return (time / this.buffer.duration) * (rect.width * dpr);
  }

  xToTime(x: number): number {
    if (!this.buffer) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return (x / (rect.width * dpr)) * this.buffer.duration;
  }

  render(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.peaks) return;

    const width = this.canvas.width;
    const height = this.canvas.height;
    const centerY = height / 2;
    const barWidth = width / this.peaks.length;

    this.ctx.fillStyle = '#2a3a4a';
    for (let i = 0; i < this.peaks.length; i++) {
      const x = i * barWidth;
      const amp = this.peaks[i] * centerY * 0.9;
      this.ctx.fillRect(x, centerY - amp, Math.max(1, barWidth - 0.5), amp * 2);
    }

    this.ctx.strokeStyle = '#3d5a80';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(0, centerY);
    this.ctx.lineTo(width, centerY);
    this.ctx.stroke();

    this.drawPlayhead();
  }

  private drawPlayhead(): void {
    const x = this.timeToX(this.playheadTime);
    const height = this.canvas.height;

    this.ctx.strokeStyle = '#ff6b6b';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(x, 0);
    this.ctx.lineTo(x, height);
    this.ctx.stroke();
  }
}
