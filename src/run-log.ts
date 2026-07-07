import { existsSync, readFileSync } from 'node:fs';

export interface RunLogEntry {
  run_id: string;
  pattern: string;
  runs_count: number;
  outcome: 'pass' | 'fail' | 'error' | 'paused' | 'budget_exit';
  timestamp: string;
  duration_ms: number;
  [key: string]: unknown;
}

const APPEND_MARKER = '<!-- Loop appends below this line -->';

const DEFAULT_TEMPLATE = `# Loop Run Log — YOUR_PROJECT

Append one entry per run. Prune entries older than 30 days.

## Format

\`\`\`json
{"run_id": "...", "pattern": "...", ...}
\`\`\`

## Recent Runs

${APPEND_MARKER}
`;

export async function appendRunLog(path: string, entry: RunLogEntry): Promise<void> {
  let content: string;

  const file = Bun.file(path);
  const exists = await file.exists();

  if (!exists) {
    content = DEFAULT_TEMPLATE;
  } else {
    content = await file.text();
  }

  if (!content.endsWith('\n')) content += '\n';
  content += JSON.stringify(entry) + '\n';

  await Bun.write(path, content);
}

export function readRunLog(path: string, hoursBack?: number): RunLogEntry[] {
  if (!existsSync(path)) return [];

  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');

  // Slice after the append marker to skip template example JSON
  const markerIndex = lines.findIndex(l => l.includes('Loop appends below this line'));
  const dataLines = markerIndex >= 0 ? lines.slice(markerIndex + 1) : lines;

  const now = Date.now();
  const cutoff = hoursBack !== undefined ? now - hoursBack * 3_600_000 : 0;

  const entries: RunLogEntry[] = [];
  for (const line of dataLines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;

    let entry: RunLogEntry;
    try {
      entry = JSON.parse(trimmed) as RunLogEntry;
    } catch {
      continue;
    }

    if (hoursBack !== undefined && entry.timestamp) {
      const entryTime = new Date(entry.timestamp).getTime();
      if (isNaN(entryTime) || entryTime < cutoff) continue;
    }

    entries.push(entry);
  }

  return entries;
}

export async function countRunsLast24h(path: string): Promise<number> {
  const entries = await readRunLog(path, 24);
  return entries.reduce((sum, e) => sum + (e.runs_count || 0), 0);
}
