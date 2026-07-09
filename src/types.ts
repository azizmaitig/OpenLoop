export type StateMachineState = 'init' | 'run' | 'verify' | 'done';

export interface PhaseDef {
  name: string;
  command: string;
  expectedExitCode: number;
  timeoutMs: number;
  llm?:
    | { mcpServer: string; tool: string; prompt: string }
    | { provider: string; prompt: string };
  pluginHooks?: string[];
  /** Optional post-failure recovery: run this command, then re-run the phase. */
  healCommand?: string;
  /** Max heal attempts before terminal failure. Defaults to 1 when healCommand set. */
  maxRetries?: number;
}

export interface Judgment {
  passed: boolean;
  reason: string;
  confidence: number;
}

export interface MemoryConfig {
  enabled: boolean;
  agentmemoryUrl?: string;
  archivePath?: string;
}

export interface LoopConfig {
  taskName: string;
  phases: PhaseDef[];
  maxIterations: number;
  phaseTimeoutMs: number;
  daemon?: { intervalMs: number; port?: number };
  llmController?: boolean;
  plugins?: string[];
  planPath?: string;
  memory?: MemoryConfig;
}

export type OutcomeStatus = 'pass' | 'fail' | 'error';

export interface ExecutionResult {
  status: OutcomeStatus;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface PhaseResult extends ExecutionResult {
  evidencePath: string;
  judgment?: Judgment;
  pluginResults?: Record<string, any>;
}

export interface LoopState {
  currentState: StateMachineState;
  iteration: number;
  phaseResults: Record<string, PhaseResult>;
  startTime: string;
  errors: string[];
  judgment?: Judgment;
}

export interface LoopResult {
  finalState: StateMachineState;
  iterationsCompleted: number;
  allPhasesPassed: boolean;
  totalDurationMs: number;
  judgment?: Judgment;
  phaseResults?: Record<string, PhaseResult>;
}

export interface PlanYamlTask {
  id: string;
  command: string;
  timeoutMs?: number;
  llm?: { mcpServer: string; tool: string; prompt: string } | { provider: string; prompt: string };
  healCommand?: string;
  maxRetries?: number;
}

export interface PlanYamlDoc {
  planName: string;
  tasks: PlanYamlTask[];
}

export interface CheckpointState {
  planPath: string;
  planName: string;
  startedAt: string;
  updatedAt: string;
  completedTaskIds: string[];
  inProgressTaskId: string | null;
  results: Record<string, CheckpointEntry>;
}

export interface CheckpointEntry {
  status: OutcomeStatus;
  durationMs: number;
  exitCode: number;
}

export interface PlanContext {
  planPath: string;
  plan: PlanYamlDoc;
}

export interface DaemonStatus {
  status: 'idle' | 'running' | 'stopped' | 'error';
  uptime: number;
  startTime: string;
  version: string;
  pid: number;
  port: number;
}

// ── Task queue (v6) ──────────────────────────────────────────────────────────

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  command: string;
  lifecycle: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  timeoutMs?: number;
  error?: string;
  result?: ExecutionResult;
  llm?: { mcpServer: string; tool: string; prompt: string };
}

export interface TaskQueueState {
  queue: Task[];
  currentTask: Task | null;
  history: string[];  // completed task IDs, most recent first
}

export interface HistoryEntry {
  task: Task;
  phases: { name: string; command: string; startedAt: string; completedAt: string; exitCode: number; stdout: string; stderr: string; durationMs: number }[];
}

export interface HistoryListEntry {
  id: string;
  command: string;
  status: TaskStatus;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number;
}

export interface HistoryListResponse {
  tasks: HistoryListEntry[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Multi-loop orchestration ──────────────────────────────────────────────────

export type ChildLoopStatus = 'stopped' | 'running' | 'error';

export type TriggerDef =
  | { type: 'cron'; expression: string }
  | { type: 'fileWatch'; watchDir: string; pattern?: string };

export interface ChildLoopDef {
  name: string;
  planPath: string;
  triggers?: TriggerDef[];
  /** Shorthand: creates a fileWatch trigger for this directory */
  watchDir?: string;
  enabled?: boolean;
}

export interface ChildLoopState {
  id: string;
  name: string;
  status: ChildLoopStatus;
  planPath: string;
  triggers: TriggerDef[];
  enabled: boolean;
  createdAt: string;
  startedAt?: string;
  lastRunAt?: string;
  error?: string;
}

export interface ChildLoopSummary {
  id: string;
  name: string;
  status: ChildLoopStatus;
  planPath: string;
  triggerCount: number;
  enabled: boolean;
}

export type StartChildResult = 'ok' | 'not_found' | 'already_running';
export type StopChildResult = 'ok' | 'not_found' | 'not_running';

export interface LoopsConfig {
  loops: ChildLoopDef[];
}

// ── LLM provider (v7) ────────────────────────────────────────────────────────

export type LLMProvider = 'openai' | 'anthropic' | 'opencode';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  endpoint?: string;
  maxTokens?: number;
  temperature?: number;
  opencodeAgent?: string;
}
