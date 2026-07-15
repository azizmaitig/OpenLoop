// lib/api.ts — REST client seam + shared type re-exports.
// Every bearer/auth header and 404→null behavior lives here so hooks stay thin.

import type {
  DaemonState,
  MetricsResponse,
  HistoryListResponse,
  HistoryEntry,
  ChildLoopSummary,
  HealthScore,
  TimeSeriesResponse,
  CheckpointState,
  CheckpointsResponse,
} from './types';
import { CACHE_BUST } from './constants';

export type {
  DaemonState,
  MetricsResponse,
  HistoryListResponse,
  HistoryEntry,
  ChildLoopSummary,
  HealthScore,
  TimeSeriesResponse,
  CheckpointState,
  CheckpointsResponse,
  CheckpointSummary,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public url: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Runtime config: the dashboard can be served with an embedded API key
// (e.g. injected by the daemon build). Falls back to none (localhost open access).
declare global {
  interface Window {
    __LOOP_API_KEY__?: string;
  }
}

function baseUrl(): string {
  return typeof location !== 'undefined' && location.origin ? location.origin : 'http://localhost';
}

function authHeaders(): Record<string, string> {
  const key = typeof window !== 'undefined' ? window.__LOOP_API_KEY__ : undefined;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export interface ApiFetchOptions {
  /** When true, a 404 resolves to `null` instead of throwing (graceful degrade). */
  allowNotFound?: boolean;
  params?: Record<string, string | number | undefined | null> | URLSearchParams;
  /** HTTP method (default GET). */
  method?: string;
  /** Request body string (e.g. JSON.stringify'd). Sets Content-Type: application/json when present. */
  body?: string;
  /** AbortSignal for cancellation (forwarded from TanStack Query callers). */
  signal?: AbortSignal;
}

export async function apiFetch<T>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const url = new URL(path, baseUrl());
  if (opts.params) {
    if (opts.params instanceof URLSearchParams) {
      opts.params.forEach((v, k) => url.searchParams.set(k, v));
    } else {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = { ...authHeaders() };
  if (opts.body) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body,
      signal: opts.signal,
    });
  } catch (err) {
    throw new ApiError(0, `network error: ${String(err)}`, url.toString());
  }

  if (res.status === 404 && opts.allowNotFound) {
    return null as T;
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') msg = body.error;
    } catch {
      /* ignore body parse errors */
    }
    throw new ApiError(res.status, msg, url.toString());
  }

  // 204 / empty body
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

// ── Endpoint helpers (one per backend route) ──────────────────────────────

export function fetchDaemonState(signal?: AbortSignal): Promise<DaemonState> {
  return apiFetch<DaemonState>('/state', { signal });
}

export function fetchMetrics(
  window: string,
  lastN: number,
  signal?: AbortSignal,
): Promise<MetricsResponse> {
  return apiFetch<MetricsResponse>('/api/metrics', {
    params: { window, lastN },
    signal,
  });
}

export function fetchHistory(
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<HistoryListResponse> {
  return apiFetch<HistoryListResponse>('/api/history', {
    params: { page, pageSize },
    signal,
  });
}

export function fetchTask(id: string, signal?: AbortSignal): Promise<HistoryEntry> {
  return apiFetch<HistoryEntry>(`/api/tasks/${encodeURIComponent(id)}`, { signal });
}

export function fetchLoops(signal?: AbortSignal): Promise<ChildLoopSummary[]> {
  return apiFetch<ChildLoopSummary[]>('/loops', { signal });
}

export function fetchHealthScore(
  window: string,
  lastN: number,
  signal?: AbortSignal,
): Promise<HealthScore | null> {
  return apiFetch<HealthScore | null>('/api/health-score', {
    allowNotFound: true,
    params: { window, lastN },
    signal,
  });
}

export function fetchTimeSeries(
  metric: string,
  window: string,
  signal?: AbortSignal,
): Promise<TimeSeriesResponse | null> {
  return apiFetch<TimeSeriesResponse | null>('/api/metrics/timeseries', {
    allowNotFound: true,
    params: { metric, window },
    signal,
  });
}

export function fetchCheckpoint(
  planPath?: string,
  signal?: AbortSignal,
): Promise<CheckpointState | null> {
  return apiFetch<CheckpointState | null>('/api/checkpoint', {
    allowNotFound: true,
    params: planPath ? { planPath } : undefined,
    signal,
  });
}

export function fetchCheckpoints(signal?: AbortSignal): Promise<CheckpointsResponse | null> {
  return apiFetch<CheckpointsResponse | null>('/api/checkpoints', {
    allowNotFound: true,
    signal,
  });
}

export interface PauseResponse {
  paused: boolean;
}

export function fetchPause(signal?: AbortSignal): Promise<PauseResponse> {
  return apiFetch<PauseResponse>('/api/pause', {
    params: { [CACHE_BUST]: Date.now() },
    signal,
  });
}

/** POST to /api/pause to set the daemon paused state. */
export function setPause(paused: boolean, signal?: AbortSignal): Promise<PauseResponse> {
  return apiFetch<PauseResponse>('/api/pause', {
    method: 'POST',
    body: JSON.stringify({ paused }),
    signal,
  });
}
