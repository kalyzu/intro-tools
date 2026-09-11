export type FilterSlope = 12 | 24 | 48;

export function createFilterChain(
  ctx: BaseAudioContext,
  slope: FilterSlope
): BiquadFilterNode[] {
  const count = slope === 48 ? 4 : slope === 24 ? 2 : 1;
  const filters: BiquadFilterNode[] = [];

  for (let i = 0; i < count; i++) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = slope === 12 ? 0.5 : 0.7;
    filters.push(filter);
  }

  for (let i = 0; i < filters.length - 1; i++) {
    filters[i].connect(filters[i + 1]);
  }

  return filters;
}

export function connectFilterChain(
  source: AudioNode,
  filters: BiquadFilterNode[],
  destination: AudioNode
): void {
  source.connect(filters[0]);
  filters[filters.length - 1].connect(destination);
}


