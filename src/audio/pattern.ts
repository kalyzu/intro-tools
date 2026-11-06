// Pattern matching for drum beats – finds repeating interval from user markers and extends it
// Pure TS, no deps, O(n log n)

export interface Pattern {
  interval: number; // average interval, for consumers that need a single estimate
  intervals: number[]; // repeating interval sequence in seconds
  nextIntervalIndex: number; // next position in intervals after the seed markers
  phase: number; // first marker time
  confidence: number; // 0-1
  tolerance: number; // absolute seconds
}

export interface PatternOptions {
  toleranceSec?: number; // absolute, default 0.06 (60ms) – matches onset minGap and 50ms eval tol
  toleranceRel?: number; // relative, default 0.08 (8%)
  minRepeats?: number; // minimal occurrences to be considered pattern, default 2
}

/**
 * Infer a repeating interval sequence from sorted marker times. Repeated
 * sequences are averaged by position; otherwise all observed intervals form
 * the seed sequence, allowing uneven rhythms to be continued.
 */
export function findRepeatingPattern(
  times: number[],
  _duration: number,
  options: PatternOptions = {}
): Pattern | null {
  const tolAbs = options.toleranceSec ?? 0.06;
  const tolRel = options.toleranceRel ?? 0.08;
  const minRepeats = Math.max(2, options.minRepeats ?? 2);

  if (times.length < 2) return null;

  const sorted = [...times].sort((a, b) => a - b);
  const iois: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const d = sorted[i + 1] - sorted[i];
    if (d > 0) iois.push(d);
  }
  if (iois.length === 0) return null;

  // Find the shortest repeated IOI sequence (e.g. A-B-C-A-B-C).
  let intervals = iois;
  let cycles = 1;
  for (let period = 1; period <= Math.floor(iois.length / minRepeats); period++) {
    const groups = Array.from({ length: period }, () => [] as number[]);
    for (let i = 0; i < iois.length; i++) groups[i % period].push(iois[i]);
    const repeats = Math.min(...groups.map(group => group.length));
    if (repeats < minRepeats) continue;

    const matches = groups.every(group => {
      const mean = group.reduce((sum, value) => sum + value, 0) / group.length;
      const tolerance = Math.max(tolAbs, mean * tolRel);
      return group.every(value => Math.abs(value - mean) <= tolerance);
    });
    if (matches) {
      intervals = groups.map(group => group.reduce((sum, value) => sum + value, 0) / group.length);
      cycles = repeats;
      break;
    }
  }
  const interval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const tolerance = Math.max(tolAbs, interval * tolRel);
  const confidence = cycles > 1 ? Math.min(1, 0.5 + cycles * 0.1) : 0.3;
  return {
    interval,
    intervals,
    nextIntervalIndex: iois.length % intervals.length,
    phase: sorted[0],
    confidence,
    tolerance,
  };
}

/**
 * Repeat the seed's interval sequence after its last marker and before its first.
 */
export function extendPattern(
  seedTimes: number[],
  pattern: Pattern,
  duration: number,
  existingTimes: number[] = []
): number[] {
  const sortedSeed = [...seedTimes].sort((a, b) => a - b);
  const allExisting = [...existingTimes, ...sortedSeed].sort((a, b) => a - b);
  const result: number[] = [];

  if (sortedSeed.length < 2 || pattern.intervals.length === 0) return result;

  const isExisting = (time: number) => allExisting.some(existing => Math.abs(existing - time) < 0.03);
  const first = sortedSeed[0];
  const last = sortedSeed[sortedSeed.length - 1];
  let time = last;
  let index = pattern.nextIntervalIndex;
  while (time < duration) {
    time += pattern.intervals[index];
    index = (index + 1) % pattern.intervals.length;
    if (time <= duration && !isExisting(time)) result.push(time);
  }

  time = first;
  index = pattern.intervals.length - 1;
  while (time > 0) {
    time -= pattern.intervals[index];
    index = (index - 1 + pattern.intervals.length) % pattern.intervals.length;
    if (time >= 0 && !isExisting(time)) result.push(time);
  }

  return result.sort((a, b) => a - b);
}

/**
 * Smart combine: Use pattern to filter/correct raw detections.
 * Given raw onsets (high recall) and pattern, keep only those near grid and fill gaps.
 */
export function quantizeToPattern(
  rawTimes: number[],
  pattern: Pattern,
  duration: number
): { filtered: number[]; filled: number[] } {
  const tol = pattern.tolerance;
  const interval = pattern.interval;
  // Simpler: generate grid from phase
  const gridTimes: number[] = [];
  for (let k = 0; k * interval <= duration + interval; k++) {
    const t = pattern.phase + k * interval;
    // Also try anchor at 0
    const t2 = k * interval;
    if (t >= 0 && t <= duration) gridTimes.push(t);
    if (t2 >= 0 && t2 <= duration && Math.abs(t2 - t) > 0.01) gridTimes.push(t2);
  }
  gridTimes.sort((a, b) => a - b);

  const filtered: number[] = [];
  const used = new Set<number>();
  for (const raw of rawTimes) {
    // Find nearest grid point
    let bestDist = Infinity;
    let bestGrid = -1;
    for (let i = 0; i < gridTimes.length; i++) {
      const d = Math.abs(raw - gridTimes[i]);
      if (d < bestDist) {
        bestDist = d;
        bestGrid = i;
      }
    }
    if (bestDist < tol) {
      // Snap to grid? Keep raw time but mark as in-pattern
      filtered.push(raw);
      used.add(bestGrid);
    }
  }
  // Find gaps where grid has no raw within tol -> fill
  const filled: number[] = [];
  for (let i = 0; i < gridTimes.length; i++) {
    if (used.has(i)) continue;
    const gt = gridTimes[i];
    // Check if there's any raw near this grid (already filtered)
    const hasRaw = rawTimes.some(rt => Math.abs(rt - gt) < tol);
    if (!hasRaw) {
      // Only fill if it's between first and last raw and not at very start
      if (gt > Math.min(...rawTimes) - interval && gt < Math.max(...rawTimes) + interval) {
        filled.push(gt);
      }
    }
  }
  return { filtered, filled };
}
