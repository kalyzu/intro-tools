# Low-Pass Editor

A lightweight, client-side web application for applying animated low-pass filters to audio clips with beat marker alignment.

## Purpose

Import an audio clip, visually create a low-pass cutoff automation curve, align beat markers, and export the processed audio — all in the browser with zero server dependency.

## Features

### Trim

Import any browser-supported audio format (WAV, MP3, OGG, FLAC, AAC). Drag blue handles on the waveform to set start and end trim points. All subsequent processing operates only on the trimmed region.

### Low-Pass Filter

Draw a cutoff automation curve over time with:

- Draggable points (click and drag to reposition)
- Quadratic bezier control handles (click the curve between points, drag to bend)
- Right-click to toggle between smooth and linear interpolation
- Double-click to add new points
- Delete/Backspace to remove selected points
- 12, 24, or 48 dB/octave slope options

The filter uses Web Audio API with overlapping exponential ramps to eliminate clicks and pops during playback and export.

### Beat Alignment

Double-click the waveform to place timestamp markers. Drag markers to align them precisely with drum transients or other events. Zoom up to 50x for sample-level precision. Selected markers show their exact timestamp. Delete markers with the Delete key.

### Zoom

A synchronized zoom slider controls the visible time range for both the waveform and automation editor. Time axis labels adapt to the zoom level.

### Export

- **Export Audio** — downloads the trimmed and filtered clip as a 16-bit WAV file
- **Export Timestamps** — downloads marker times as a plain text file (one timestamp per line, in seconds)

## Architecture

```
src/
├── audio/
│   ├── decoder.ts      # Web Audio API file decoding
│   ├── filter.ts       # Low-pass filter chain creation
│   ├── playback.ts     # Real-time playback with pre-scheduled automation
│   └── renderer.ts     # Offline WAV export via OfflineAudioContext
├── automation/
│   ├── model.ts        # Automation points, markers, view state
│   ├── interpolation.ts # Linear and quadratic bezier interpolation
│   └── defaults.ts     # Default fade-in/fade-out automation
├── waveform/
│   └── renderer.ts     # Canvas waveform with trim handles and markers
├── ui/
│   └── automation-editor.ts # Canvas automation editor with control handles
├── app.ts              # Application orchestrator
└── style.css           # Dark theme
```

## Development

```bash
npm install
npm run dev      # Development server at http://localhost:5173
npm run build    # Production build in dist/
```

## Tech Stack

- Vanilla TypeScript
- Vite
- Web Audio API (AudioContext, OfflineAudioContext, BiquadFilterNode)
- Canvas 2D for waveform and automation rendering
- Zero runtime dependencies

## Browser Support

Modern Chromium and Firefox desktop browsers. Designed for Linux desktop use under tiling Wayland compositors.
