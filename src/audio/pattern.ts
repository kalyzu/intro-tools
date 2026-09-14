// Pattern matching for drum beats – finds repeating interval from user markers and extends it
// Pure TS, no deps, O(n log n)

export interface Pattern {
  interval: number; // dominant IOI in seconds
  phase: number; // anchor time (first marker % interval)
  confidence: number; // 0-1
  tolerance: number; // absolute seconds
}

export interface PatternOptions {
  toleranceSec?: number; // absolute, default 0.06 (60ms) – matches onset minGap and 50ms eval tol
  toleranceRel?: number; // relative, default 0.08 (8%)
  minRepeats?: number; // minimal occurrences to be considered pattern, default 2
}

/**
 * Find the dominant repeating interval from sorted marker times.
 * Uses histogram clustering of IOIs: intervals within tolerance are grouped.
 * Returns null if not enough markers (<2) or no clear repeat.
 */
export function findRepeatingPattern(
  times: number[],
  _duration: number,
  options: PatternOptions = {}
): Pattern | null {
  const tolAbs = options.toleranceSec ?? 0.06;
  const tolRel = options.toleranceRel ?? 0.08;
  const minRepeats = options.minRepeats ?? 2;

  if (times.length < 2) return null;

  const sorted = [...times].sort((a, b) => a - b);
  // Build IOIs
  const iois: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const d = sorted[i + 1] - sorted[i];
    if (d > 0.04 && d < 2.0) iois.push(d); // ignore too close (<40ms flam) and too long (>2s)
  }
  if (iois.length === 0) return null;

  // Cluster IOIs
  iois.sort((a, b) => a - b);
  type Cluster = { sum: number; count: number; members: number[] };
  const clusters: Cluster[] = [];
  for (const d of iois) {
    let found: Cluster | null = null;
    for (const c of clusters) {
      const mean = c.sum / c.count;
      const tol = Math.max(tolAbs, mean * tolRel);
      if (Math.abs(d - mean) <= tol) {
        found = c;
        break;
      }
    }
    if (found) {
      found.sum += d;
      found.count++;
      found.members.push(d);
    } else {
      clusters.push({ sum: d, count: 1, members: [d] });
    }
  }
  // Find cluster with most members
  clusters.sort((a, b) => b.count - a.count);
  const best = clusters[0];
  if (!best || best.count < minRepeats) {
    // Fallback: use median IOI if not enough repeats but at least 1 interval
    if (iois.length >= 1) {
      const median = iois[Math.floor(iois.length / 2)];
      return { interval: median, phase: sorted[0] % median, confidence: 0.3, tolerance: Math.max(tolAbs, median * tolRel) };
    }
    return null;
  }
  const interval = best.sum / best.count;
  const confidence = Math.min(1, best.count / Math.max(1, iois.length * 0.6) + 0.3); // 0.3 base + up to 0.7 for dominance
  const tolerance = Math.max(tolAbs, interval * tolRel);
  // Phase as first marker modulo interval (or median phase)
  const phase = sorted[0] % interval;
  return { interval, phase, confidence, tolerance };
}

/**
 * Extend a seed pattern (sorted times) to fill duration using interval.
 * Generates times at phase + k*interval that are not already within tolerance of existing markers.
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

  // Determine phase from seed if pattern phase is generic
  // Use first seed time as anchor to keep musical phase, but keep pattern.phase for grid
  // We generate from 0 to duration on the grid, then filter to after last seed
  const interval = pattern.interval;
  const toleranceSec = pattern.tolerance;
  void toleranceSec; // used via 0.03 threshold below for dedup

  // Find the grid that best aligns with seed times: choose offset that minimizes total error
  // Simple: use seedTimes[0] as anchor, generate forward/backward from there
  const anchor = sortedSeed[0] ?? pattern.phase;
  // Generate forward from anchor
  for (let k = 0; ; k++) {
    const t = anchor + k * interval;
    if (t > duration + 0.001) break;
    if (t < -0.001) continue;
    // Skip if already exists within tolerance
    const exists = allExisting.some(et => Math.abs(et - t) < 0.03);
    const alreadyGenerated = result.some(rt => Math.abs(rt - t) < 0.03);
    if (!exists && !alreadyGenerated) {
      // Only generate beyond the last seed to avoid duplicating existing pattern region
      // For "repeat pattern" we want to continue after the last user marker
      if (t > sortedSeed[sortedSeed.length - 1] + 0.02) {
        result.push(t);
      }
    }
  }
  // Also generate backward before first seed if there's headroom (e.g., user started not at 0)
  for (let k = -1; ; k--) {
    const t = anchor + k * interval;
    if (t < -0.001) break;
    if (t > duration) continue;
    const exists = allExisting.some(et => Math.abs(et - t) < 0.03);
    const alreadyGenerated = result.some(rt => Math.abs(rt - t) < 0.03);
    if (!exists && !alreadyGenerated) {
      if (t < sortedSeed[0] - 0.02) {
        result.unshift(t);
      }
    }
    if (k < -100) break; // safety
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
