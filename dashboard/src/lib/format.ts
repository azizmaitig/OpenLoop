// lib/format.ts — duration / percent / time formatters shared across widgets.

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    const remS = Math.round(s % 60);
    return `${h}h ${remM}m ${remS}s`;
  }
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString();
}

export function formatTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function formatUptime(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatRate(perMin: number | null | undefined): string {
  if (perMin === null || perMin === undefined || Number.isNaN(perMin)) return '—';
  return `${perMin.toFixed(2)}/min`;
}
