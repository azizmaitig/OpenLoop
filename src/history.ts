import { readdir, readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, HistoryEntry, HistoryListEntry, HistoryListResponse } from './types.js';

const HISTORY_DIR = '_loop-history';

function taskDir(baseDir: string, taskId: string): string {
  return join(baseDir, HISTORY_DIR, taskId);
}

export async function saveTaskHistory(
  baseDir: string,
  task: Task,
  phases?: HistoryEntry['phases'],
): Promise<string> {
  const dir = taskDir(baseDir, task.id);
  mkdirSync(dir, { recursive: true });

  const entry: HistoryEntry = {
    task: {
      id: task.id,
      command: task.command,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      timeoutMs: task.timeoutMs,
      exitCode: task.exitCode,
      stdout: task.stdout,
      stderr: task.stderr,
      durationMs: task.durationMs,
      error: task.error,
    },
    phases: phases ?? [],
  };

  const filePath = join(dir, 'task.json');
  writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
  return filePath;
}

export async function readTaskHistory(
  baseDir: string,
  taskId: string,
): Promise<HistoryEntry | null> {
  const filePath = join(taskDir(baseDir, taskId), 'task.json');
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as HistoryEntry;
  } catch {
    return null;
  }
}

export async function listTaskHistory(
  baseDir: string,
  page: number = 1,
  pageSize: number = 20,
): Promise<HistoryListResponse> {
  const dir = join(baseDir, HISTORY_DIR);
  let taskDirs: string[] = [];

  try {
    taskDirs = await readdir(dir, { withFileTypes: true }).then(entries =>
      entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse()
    );
  } catch {
    // Directory doesn't exist yet
  }

  const total = taskDirs.length;
  const start = (page - 1) * pageSize;
  const pageIds = taskDirs.slice(start, start + pageSize);

  const tasks: HistoryListEntry[] = [];
  for (const taskId of pageIds) {
    const entry = await readTaskHistory(baseDir, taskId);
    if (entry) {
      tasks.push({
        id: entry.task.id,
        command: entry.task.command,
        status: entry.task.status,
        createdAt: entry.task.createdAt,
        completedAt: entry.task.completedAt,
        durationMs: entry.task.durationMs,
        exitCode: entry.task.exitCode,
      });
    }
  }

  return { tasks, total, page, pageSize };
}

export function historyDirExists(baseDir: string): boolean {
  return existsSync(join(baseDir, HISTORY_DIR));
}
