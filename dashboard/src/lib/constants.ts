// lib/constants.ts — shared constants for the dashboard.
// Extracted so a single change propagates everywhere and TypeScript catches typos.

export const DEFAULT_WINDOW = '1h';
export const BASE_INTERVAL_MS = 800;
export const CACHE_BUST = '_t';
export type Metric = 'throughput' | 'durationP95' | 'passRate';
