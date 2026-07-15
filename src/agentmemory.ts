/**
 * agentmemory.ts — HTTP client wrapping agentmemory API (localhost:3111).
 *
 * All functions are fire-and-forget safe: no retry, no blocking, errors
 * swallowed.  Connection refused or timeout → console.error + return null.
 *
 * @module agentmemory
 */

import { mkdir } from 'node:fs/promises';
import type { LoopState } from './types.js';
import { OUTPUT_DIR } from './constants.js';

const AGENTMEMORY_URL = 'http://localhost:3111';
const TIMEOUT_MS = 2000;

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function agentmemoryFetch<T>(path: string, body: unknown): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${AGENTMEMORY_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    console.error('[agentmemory]', path, err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Session path helper ──────────────────────────────────────────────────────

function sessionArchivePath(taskName: string, basePath?: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const root = basePath || '70-Memory/history';
  return `${root}/${y}/${m}/${d}/${hh}/${mm}/${ts}-${taskName}.md`;
}

// ── Exported functions ───────────────────────────────────────────────────────

/**
 * Save a session summary to agentmemory (POST /agentmemory/remember).
 * Fire-and-forget — caller should not await.
 */
export async function saveEpisodic(state: LoopState, taskName: string): Promise<null> {
  await agentmemoryFetch('/agentmemory/remember', {
    type: 'episodic',
    content: JSON.stringify({
      taskName,
      summary: {
        currentState: state.currentState,
        iteration: state.iteration,
        phases: Object.entries(state.phaseResults).map(([name, r]) => ({
          name,
          status: r.status,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
        })),
        errorCount: state.errors.length,
      },
    }),
    concepts: 'agent-loop,session',
    project: `agent-loop/${taskName}`,
  });
  return null;
}

/**
 * Query agentmemory for lessons matching the given task (POST /agentmemory/lesson/recall).
 * Returns parsed results or null on failure.
 */
export async function recallLessons(taskName: string): Promise<unknown[] | null> {
  const result = await agentmemoryFetch<{ results?: unknown[] }>('/agentmemory/lesson/recall', {
    query: taskName,
    project: 'agent-loop',
  });
  return result?.results ?? null;
}

/**
 * Write a session archive markdown file to the vault history path.
 * Falls back to `_agent-loop-output/session-archive/` if the primary path fails.
 * Uses Bun.write() — does NOT touch agentmemory.
 *
 * @param basePath - Optional archive root. Defaults to `70-Memory/history/`.
 */
export async function archiveSession(
  state: LoopState,
  taskName: string,
  basePath?: string,
): Promise<null> {
  const paths: string[] = [
    sessionArchivePath(taskName, basePath),
    sessionArchivePath(taskName, `${OUTPUT_DIR}/session-archive`),
  ];

  const phaseLines = Object.entries(state.phaseResults)
    .map(([name, r]) => `  - name: ${name}\n    status: ${r.status}\n    durationMs: ${r.durationMs}`)
    .join('\n');

  const content = `---
taskName: ${taskName}
finalState: ${state.currentState}
iteration: ${state.iteration}
timestamp: ${state.startTime}
phases:
${phaseLines}
errors: ${state.errors.length > 0 ? '\n' + state.errors.map(e => `  - "${e.replace(/"/g, '\\"')}"`).join('\n') : '[]'}
---

# Session Archive: ${taskName}

**Final State:** ${state.currentState}
**Iteration:** ${state.iteration}
**Start Time:** ${state.startTime}

## Phase Results

${Object.entries(state.phaseResults).map(([name, r]) => `### ${name}

- **Status:** ${r.status}
- **Exit Code:** ${r.exitCode}
- **Duration:** ${r.durationMs}ms
${r.stdout ? `- **stdout:**\n\`\`\`\n${r.stdout}\n\`\`\`` : ''}
${r.stderr ? `- **stderr:**\n\`\`\`\n${r.stderr}\n\`\`\`` : ''}
`).join('\n')}

${state.errors.length > 0 ? `## Errors\n\n${state.errors.map(e => `- ${e}`).join('\n')}` : ''}
`;

  for (const path of paths) {
    try {
      const parent = path.split('/').slice(0, -1).join('/');
      await mkdir(parent, { recursive: true });
      await Bun.write(path, content);
      break; // first successful write wins
    } catch (err) {
      const isLast = path === paths[paths.length - 1];
      if (isLast) {
        console.error('[agentmemory] archiveSession:', err instanceof Error ? err.message : String(err));
      }
    }
  }
  return null;
}

/**
 * Save a lesson via agentmemory (POST /agentmemory/lesson/save).
 * Fire-and-forget — caller should not await.
 */
export async function saveLesson(content: string, context: string): Promise<null> {
  await agentmemoryFetch('/agentmemory/lesson/save', { content, context, project: 'agent-loop' });
  return null;
}

/**
 * Push a health pulse score via agentmemory (POST /agentmemory/remember).
 * Fire-and-forget — caller should not await.
 */
export async function pushPulse(healthScore: number): Promise<null> {
  await agentmemoryFetch('/agentmemory/remember', {
    type: 'pulse',
    content: JSON.stringify({
      score: healthScore,
      timestamp: new Date().toISOString(),
    }),
    project: 'agent-loop',
  });
  return null;
}
