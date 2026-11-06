# Achieving ~90% Accurate Kick and Snare Onset Timestamp Detection in the Browser with JavaScript

**Goal**: Detect the onset timestamps of bass drum (kick) hits and snare hits with approximately 90% accuracy (measured by F-measure with a typical ±50 ms tolerance window) entirely client-side in a web browser using JavaScript.

Differentiation between the two is not required. The output is simply two independent lists of timestamps: one for kick onsets and one for snare onsets.

This is achievable. Band-focused DSP methods regularly reach 80–95% on clean or drum-focused material. Hybrid approaches or lightweight machine learning can push reliability higher across varied material. Browser constraints (CPU budget, latency) shape the practical choices.

## 1. What “Onset Detection” Means Here

An **onset** is the moment a sound begins — the attack/transient of a drum hit.

We care about two separate signals:
- **Kick / bass drum onsets**: Strong low-frequency energy (typically dominant below ~150 Hz, often 40–130 Hz sub-bass).
- **Snare onsets**: Broadband energy with emphasis in the midrange (roughly 150–2 kHz+).

Accuracy is usually reported as precision, recall, and F-measure against human annotations, allowing a small time window (commonly 25–50 ms). Each instrument is evaluated independently.

## 2. Browser Constraints and Real-Time Reality

- **Web Audio API** provides `AnalyserNode` (FFT), filters, and `AudioWorklet` (preferred for low-latency processing).
- Main-thread processing is fine for offline analysis of files; real-time mic or playback needs careful budgeting.
- Heavy models or large FFTs can cause dropouts. Prefer small frames (512–1024 samples) and hop sizes (128–256).
- Everything must stay in JavaScript / WebAssembly. No Python/librosa at runtime.

**Latency target**: Sub-50 ms is realistic with AudioWorklet for interactive use.

## 3. The Smart Approach (Recommended Path)

**Run two independent, band-focused onset detectors.** No classification or differentiation step is needed.

1. **Baseline (fastest path to high accuracy)**: Separate energy or spectral-flux onset detection in a low band (kick) and a mid band (snare), each with its own adaptive peak picking.
2. **Production-friendly**: Use or adapt existing JS libraries (essentia.js, Meyda, or custom band processing). You can still use packages like `@audio/mir-drums` and simply discard the hi-hat results and ignore type labels if desired.
3. **Higher robustness**: Per-band candidate detection followed by optional confirmation (e.g., a lightweight TensorFlow.js model trained only on kick or only on snare).
4. **Domain adaptation**: Tune thresholds and band edges on your specific material.
5. **Evaluate rigorously**: Compute F-measure separately for kick timestamps and snare timestamps.

This progression routinely crosses 90% on drum loops, electronic music, and reasonably clear acoustic drum tracks for each instrument independently.

## 4. Method 1: Independent Band-Focused DSP (Lightweight, Recommended Starting Point)

Classic and effective. Process the low band and the mid band completely separately.

### Pipeline (applied independently to each band)
1. Convert to mono and optionally normalize.
2. (Optional) Emphasize percussive content.
3. Isolate the relevant frequency band:
   - **Kick**: ~30–150 Hz or 40–130 Hz (low-pass or band energy).
   - **Snare**: ~150–2000 Hz (band-pass or mid-band energy).
4. Compute an onset detection function (ODF) on that band only:
   - Energy envelope (rectify + smooth).
   - Spectral flux (positive frame-to-frame magnitude differences).
   - High-frequency content (HFC) for percussive attacks.
5. Peak pick with:
   - Adaptive threshold (local mean + factor × local standard deviation, or median-based).
   - Minimum inter-onset interval (~40–80 ms) to avoid double triggers.
6. Output a list of timestamps for that instrument.

No comparison between bands is required. Each detector simply reports when its band shows a clear onset.

### Typical Parameters
- Frame size: 512–1024 samples
- Hop size: 128–256 samples (~3–6 ms at 44.1 kHz)
- Smoothing window for envelope: 10–30 ms
- Adaptive threshold factor: 1.5–3.0 (tune separately for kick and snare)
- Minimum distance between onsets: 50 ms

This approach alone can deliver >90% F-measure on clean drum loops and many electronic tracks for each instrument.

## 5. Method 2: Leverage Existing JavaScript Libraries

### essentia.js (WASM-powered, comprehensive MIR)
Provides `OnsetDetection` (methods: hfc, complex, flux, etc.) and peak picking. Run it on filtered or band-limited versions of the signal for kick and snare separately.

### Meyda
Fast feature extraction (energy, spectral flux-related features). Compute energy or other features on band-filtered audio for each instrument.

### Custom or simpler approaches
- Low-pass filter + peak detection for kicks (classic technique from many beat-detection articles).
- Mid-band energy or flux for snares.
- Custom `AnalyserNode` + ScriptProcessor/AudioWorklet for full control.

Packages such as `@audio/mir-drums` can still be used; simply take the timestamps of the events it labels as kick or snare and ignore everything else.

## 6. Method 3: Hybrid DSP + Lightweight Machine Learning (Optional)

When pure band energy is insufficient for one of the instruments:

1. Run a sensitive onset detector on the target band to get candidates.
2. For each candidate, extract a short mel-spectrogram patch focused on the relevant frequency range.
3. Confirm with a small, instrument-specific model in **TensorFlow.js** (trained only on kicks or only on snares).

Models can be kept tiny. This is rarely necessary if the material is reasonably clean.

## 7. Practical Implementation Outline (Real-Time or Offline)

```js
// Conceptual sketch: two independent detectors
const analyser = audioContext.createAnalyser();
analyser.fftSize = 1024;
const freqData = new Uint8Array(analyser.frequencyBinCount);

function process() {
  analyser.getByteFrequencyData(freqData);
  
  // Kick: low-band energy
  const kickEnergy = sumBins(freqData, kickLowBin, kickHighBin);
  // Update kick ODF / envelope, detect peaks → push timestamp to kickOnsets[]
  
  // Snare: mid-band energy
  const snareEnergy = sumBins(freqData, snareLowBin, snareHighBin);
  // Update snare ODF / envelope, detect peaks → push timestamp to snareOnsets[]
  
  requestAnimationFrame(process); // or better: AudioWorklet
}
```

**Better real-time**: Move the analysis into an `AudioWorkletProcessor` so it runs on the audio thread with sample-accurate timing. You can maintain two independent peak-picking states.

For offline file analysis, decode with `AudioContext.decodeAudioData`, process the entire `Float32Array` once for the kick band and once for the snare band (or in a single pass tracking both), and return two arrays of timestamps.

## 8. Reaching and Measuring 90% Accuracy

| Scenario                        | Expected Accuracy (per instrument) | Notes |
|--------------------------------|------------------------------------|-------|
| Isolated drum hits / loops     | 95%+                              | Trivial with band energy |
| Electronic / drum-machine tracks | 90%+                             | Excellent with band-focused detection |
| Acoustic drum kit (clear mix)  | 85–95%                            | Tuning helps |
| Full mixed music               | 70–90%                            | Harder; band isolation is key |
| Ghost notes / soft hits        | Lower                             | Needs sensitive threshold |

**Evaluation recipe**:
- Annotate or use existing datasets.
- Match detected kick timestamps to ground-truth kicks within ±50 ms (and the same independently for snares).
- Compute precision, recall, F-measure separately for each.
- Iterate on thresholds, band edges, and minimum distance for each instrument.

Domain-specific tuning is the single biggest accuracy lever.

## 9. Common Pitfalls and Mitigations

- **Double triggers** on long decays → Minimum inter-onset interval + peak prominence.
- **Kick vs bass guitar confusion** → Narrower low band + require a sharp attack (high flux).
- **Snare vs other mid-frequency content** → Narrower mid band or additional flux requirement.
- **Latency / dropped frames** → AudioWorklet + modest FFT size.
- **Varying levels** → Always use adaptive (local) thresholds, not fixed.
- **Browser differences** → Stick to standard Web Audio + WASM.

## 10. Recommended Next Steps

1. Prototype a simple low-pass (or low-band energy) peak detector for kicks and a mid-band detector for snares.
2. Visualize the two onset functions and the detected timestamps (waveform + two sets of markers).
3. Measure F-measure separately on a small annotated set for each instrument.
4. If needed, switch to essentia.js onset methods on filtered signals.
5. For interactive apps, port the core loop to AudioWorklet.
6. Optionally add a lightweight confirmation model only if one instrument plateaus below the target.

## Key References and Resources

- Joe Sullivan – “Beat Detection Using JavaScript and the Web Audio API” (classic low-pass + peaks approach, directly useful for kicks).
- essentia.js (OnsetDetection, spectral features, WASM).
- Meyda.js for feature extraction.
- Research literature on Automatic Drum Transcription (ADT): band-energy and spectral-flux methods routinely report high F-measures for kick and snare independently.
- Web Audio API specification and AudioWorklet examples.

With independent band-focused DSP (low band for kicks, mid band for snares) plus modest tuning, 90% accurate onset timestamp detection for each is a realistic and practical goal in the browser today.
