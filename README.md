# MGMC

Motion Graphics Music Cutter (MGMC) is a small in-browser tool to cut music for motion graphics. It runs entirely locally — your audio never leaves your machine.

### Backstory

This was made because I found myself in a time-consuming state of using FL Studio for lowpass, and Scratch to measure the timestamps. I realized this was a bad workflow, and made this.

### How to use

**Trim**

Import any browser-supported audio format (WAV, MP3, OGG, FLAC, AAC). Drag blue handles on the waveform to set start and end trim points. All other steps use only on the trimmed region.

**Low-Pass Filter**

Draw a cutoff automation curve over time with:

- Draggable points (click and drag to reposition)
- Quadratic bezier control handles (click the curve between points, drag to bend)
- Right-click to toggle between smooth and linear interpolation
- Double-click to add new points
- Delete/Backspace to remove selected points
- 12, 24, or 48 dB/octave slope options

The filter uses Web Audio API with overlapping exponential ramps to eliminate clicks and pops during playback and export.

**Keyframes**

Double-click the waveform or press <kbd>A</kbd> to place a marker. Drag to align precisely with drum beats. Delete markers with the Delete key.

### Export

- **Export Audio** — downloads the trimmed and filtered clip as a 16-bit WAV file
- **Export Timestamps** — downloads marker times as a plain text file (one timestamp per line, in seconds)

## Contribution

Contribution is welcome in the form of issues and pull requests.

**Development**

```bash
npm install
npm run dev      # Development server at http://localhost:5173
npm run build    # Production build in dist/
```

**Tech Stack**

- Vanilla TypeScript
- Vite
- Web Audio API (AudioContext, OfflineAudioContext, BiquadFilterNode)
- Canvas 2D for waveform and automation rendering
- Zero runtime dependencies

**Disclaimer**

This project was built with the use of AI.
