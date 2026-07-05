import type { Task, TaskStatus, TaskQueueState } from './types.js';

let taskIdCounter = 0;

function generateId(): string {
  taskIdCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `task-${ts}-${rand}`;
}

export class TaskQueue {
  private queue: Task[] = [];
  private currentTask: Task | null = null;
  private completedIds: string[] = [];

  enqueue(command: string, opts?: { timeoutMs?: number; llm?: Task['llm'] }): Task {
    const task: Task = {
      id: generateId(),
      command,
      status: 'queued',
      createdAt: new Date().toISOString(),
      timeoutMs: opts?.timeoutMs,
      llm: opts?.llm,
    };
    this.queue.push(task);
    return task;
  }

  dequeue(): Task | null {
    if (this.currentTask) return null;
    const task = this.queue.shift();
    if (!task) return null;
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    this.currentTask = task;
    return task;
  }

  complete(id: string, result: { exitCode: number; stdout: string; stderr: string; durationMs: number }): Task | null {
    const task = this.get(id);
    if (!task || task !== this.currentTask) return null;
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.exitCode = result.exitCode;
    task.stdout = result.stdout;
    task.stderr = result.stderr;
    task.durationMs = result.durationMs;
    this.completedIds.unshift(id);
    this.currentTask = null;
    return task;
  }

  fail(id: string, error: string): Task | null {
    const task = this.get(id);
    if (!task) return null;
    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    task.error = error;
    this.completedIds.unshift(id);
    if (task === this.currentTask) {
      this.currentTask = null;
    } else {
      // Remove from queue if still queued
      this.queue = this.queue.filter(t => t.id !== id);
    }
    return task;
  }

  cancel(id: string): Task | null {
    const task = this.get(id);
    if (!task) return null;
    if (task.status === 'running') return null; // cannot cancel running task
    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();
    this.completedIds.unshift(id);
    this.queue = this.queue.filter(t => t.id !== id);
    return task;
  }

  peek(): Task | null {
    return this.queue[0] ?? null;
  }

  get(id: string): Task | undefined {
    if (this.currentTask?.id === id) return this.currentTask;
    return this.queue.find(t => t.id === id);
  }

  get length(): number {
    return this.queue.length;
  }

  get current(): Task | null {
    return this.currentTask;
  }

  get history(): string[] {
    return [...this.completedIds];
  }

  toJSON(): TaskQueueState {
    return {
      queue: this.queue.map(t => ({ ...t })),
      currentTask: this.currentTask ? { ...this.currentTask } : null,
      history: [...this.completedIds],
    };
  }

  fromJSON(state: TaskQueueState): void {
    this.queue = state.queue.map(t => ({ ...t }));
    this.currentTask = state.currentTask ? { ...state.currentTask } : null;
    this.completedIds = [...state.history];
  }

  allTasks(): Task[] {
    const result: Task[] = [];
    if (this.currentTask) result.push(this.currentTask);
    // queued tasks, oldest first
    for (const t of this.queue) {
      if (t.id !== this.currentTask?.id) result.push(t);
    }
    return result;
  }

  reset(): void {
    this.queue = [];
    this.currentTask = null;
    this.completedIds = [];
  }
}
