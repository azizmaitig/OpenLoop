// lib/types.ts — TypeScript types mirrored from the agent-loop backend
// (src/types.ts, src/events.ts, src/metrics.ts). Kept in sync manually; the
// dashboard is a read-only client, so these are a projection of the server
// contract.
//
// ── WS EVENT CONTRACT (src/events.ts) ──────────────────────────────────────
// Every WS message is a StreamEvent with a `type` discriminator and `data:
// unknown`. The frontend switches on `type` and narrows the payload. The
// full backend event contract lives in src/events.ts — LoopEvent union.
//
// | type                | data shape (narrowed)                   |
// |---------------------|------------------------------------------|
// | state_change        | DaemonState & { children? }              |
// | child_status_change | ChildLoopSummary[]                       |
// | task_event          | unknown                                  |
// | task_completed      | Task (full backend type)                 |
// | phase_start         | { planName, iteration, phaseName, ... }  |
// | phase_complete      | { planName, iteration, phaseName, ... }  |
// | task_started        | { taskId, command, kind }               |
// | task_failed         | { taskId, error }                        |
// | fsm_transition      | { planName, iteration, from, to, event } |
// | iteration_start     | { planName, iteration }                  |
// | iteration_complete  | { planName, iteration, outcome }         |
//
// ── DAG DATA MODEL ─────────────────────────────────────────────────────────
// The DAG visualizer renders a GraphSnapshot (nodes + edges) reconstructed
// from the event stream by useDagGraph. See DagNodeData/DagEdgeData below.
// ───────────────────────────────────────────────────────────────────────────

export type OutcomeStatus = 'pass' | 'fail' | 'error';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ChildLoopStatus = 'stopped' | 'running' | 'error';
export type BudgetStatus = 'ok' | 'warning' | 'exceeded';
export type LoopGrade = 'healthy' | 'degraded' | 'critical';

export interface Task {
  id: string;
  command: string;
  lifecycle: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  timeoutMs?: number;
  error?: string;
  result?: {
    status: OutcomeStatus;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  };
}

export interface DaemonStatus {
  status: 'idle' | 'running' | 'stopped' | 'error';
  uptime: number;
  startTime: string;
  version: string;
  pid: number;
  port: number;
  isPaused?: boolean;
}

export interface CheckpointSummary {
  planName: string;
  updatedAt: string;
  startedAt: string;
  taskCount: number;
}

export interface CheckpointsResponse {
  checkpoints: CheckpointSummary[];
}

export interface DaemonState extends DaemonStatus {
  queueLength: number;
  currentTask: Task | null;
}

export interface TaskMetricsResult {
  totalRuns: number;
  lastN: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  avgDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  throughputTasksPerMin: number;
  throughputWindowMinutes: number;
}

export interface BudgetMetricsResult {
  status: BudgetStatus;
  runsToday: number;
  cap: number;
  remaining: number;
}

export interface TriggerSummary {
  id: string;
  type: string;
  fireCount: number;
  lastFiredAt?: string;
  running: boolean;
}

export interface MetricsResponse {
  taskMetrics: TaskMetricsResult;
  budget: BudgetMetricsResult;
  triggers: TriggerSummary[];
}

export interface HistoryEntryPhase {
  name: string;
  command: string;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface HistoryEntry {
  task: Task;
  phases: HistoryEntryPhase[];
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

export interface ChildLoopSummary {
  id: string;
  name: string;
  status: ChildLoopStatus;
  planPath: string;
  triggerCount: number;
  enabled: boolean;
}

export interface CheckpointEntry {
  status: OutcomeStatus;
  durationMs: number;
  exitCode: number;
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

// ── NEW endpoints (this dashboard release) ─────────────────────────────────

export interface HealthScoreComponents {
  passRate: number;
  errorRate: number;
  budget: number;
  queueDepth: number;
}

export interface HealthScore {
  score: number;
  grade: LoopGrade;
  components: HealthScoreComponents;
  derivedFrom: { window: string; lastN: number };
}

export interface TimeSeriesPoint {
  t: number;
  v: number;
}

export interface TimeSeriesResponse {
  metric: string;
  points: TimeSeriesPoint[];
}

// ── WS stream ──────────────────────────────────────────────────────────────

export type StreamEventType =
  | 'state_change'
  | 'child_status_change'
  | 'task_event'
  | 'task_completed'
  // ── New event types (agent-loop event contract v1) ─────────────────────
  | 'phase_start'
  | 'phase_complete'
  | 'task_started'
  | 'task_failed'
  | 'fsm_transition'
  | 'iteration_start'
  | 'iteration_complete';

export type StreamStoreTransport = 'ws' | 'poll';

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  timestamp: string;
  /** Monotonic sequence number assigned by useLoopStream's flush(). Used by
   *  DagScreen as a high-water mark so the DAG keeps processing new events
   *  even after the EVENT_CAP is hit. */
  seq?: number;
}

// ── DAG data model (plan-execution DAG visualizer) ─────────────────────────

export type DagNodeStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'idle';

export type DagNodeKind = 'phase' | 'task' | 'loop' | 'gate';

export interface DagNodeData {
  id: string;
  label: string;
  kind: DagNodeKind;
  status: DagNodeStatus;
  command?: string;
  input?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  dependsOn?: string[];
  iteration?: number;
  planName?: string;
}

export interface DagEdgeData {
  id: string;
  source: string;
  target: string;
}

export interface GraphSnapshot {
  nodes: DagNodeData[];
  edges: DagEdgeData[];
  updatedAt: string;
}
