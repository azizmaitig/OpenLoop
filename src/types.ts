import type { PermissionRule } from './opencode-client.js';

export type StateMachineState = 'init' | 'run' | 'verify' | 'done';

export interface ValidatorDef {
  /** Rubric the phase output is graded against by an LLM. */
  criteria: string;
  /** Re-run the phase command on validation failure (Conductor caps at 1). Default 1. */
  maxRetries?: number;
  /** Optional LLM override; defaults to env-based config (LLM_PROVIDER/LLM_API_KEY/LLM_MODEL). */
  llm?: { provider: string; prompt?: string };
}

export interface ValidationResult {
  passed: boolean;
  reason: string;
  confidence: number;
  /** Number of re-run attempts before finalizing. */
  retriesUsed: number;
}

/** Per-task model override for agent tasks (v10, ADR-0023). Overrides sidecar defaults at conversation creation. */
export interface AgentTaskModel {
  provider: string;
  model: string;
}

/** Workspace for agent tasks (v10, ADR-0023). local (default) = loop working dir; docker = sandboxed /workspace mount. */
export interface AgentTaskWorkspace {
  type: 'local' | 'docker';
}

export interface PhaseDef {
  name: string;
  /** Task-kind discriminator (v10): 'command' (default) | 'agent'. Mutually exclusive with command when 'agent'. */
  type?: 'command' | 'agent';
  /** Shell command for command phases. Absent when type: agent. */
  command?: string;
  /** Required when type: agent — the prompt handed to the agent backend. */
  prompt?: string;
  /** Agent backend name (openhands today, ACP later). */
  agent?: string;
  /** Per-task model override for agent phases. */
  model?: AgentTaskModel;
  /** Workspace for agent phases: local (default) or docker sandbox. */
  workspace?: AgentTaskWorkspace;
  /** Run this shell phase inside the isolated worktree (T6). Requires ExecutionDeps.target. */
  worktree?: boolean;
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
  /** Path to a file this phase MUST produce. Checked after the command exits 0. */
  produces?: string;
  /** If true, the produces file must be non-empty. */
  producedMustHaveContent?: boolean;
  /** IDs of phases that must complete before this one runs (parallel DAG). */
  dependsOn?: string[];
  /** References a composite id for atomic composite expansion. Internal use. */
  use?: string;
  /** Optional LLM validator gate (Conductor-style). Runs after command succeeds. */
  validator?: ValidatorDef;
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
  /** Agent Server sidecar config (v10, ADR-0023). Defaults in DEFAULT_CONFIG. */
  agentServer?: AgentServerConfig;
  /** opencode server config (v11, ADR-0024). Defaults in DEFAULT_CONFIG. */
  opencodeServer?: OpenCodeServerConfig;
}

export interface OpenCodeServerConfig {
  /** Base URL of the opencode server REST API (default http://127.0.0.1:4096). */
  url: string;
  /** Idle timeout (ms) after a StepFinishPart before the executor hands off (default 60000). */
  idleTimeoutMs?: number;
  /** Tail cap (chars) for the bounded transcript in the PhaseResult (ADR-0015, default 2000). */
  transcriptTailChars?: number;
  /** Optional PermissionRuleset additions, appended after the built-in denies (last rule wins). */
  permissionOverrides?: PermissionRule[];
}

export interface AgentServerConfig {
  /** true: the loop spawns and manages the sidecar process. false: connect to a BYO server URL. */
  manage: boolean;
  /** Base URL of the Agent Server REST API. */
  url: string;
  /** Port the sidecar listens on (spawn arg when manage: true). */
  port: number;
  /** How long a freshly spawned sidecar has to become healthy, in ms (default 5000). */
  readyTimeoutMs?: number;
  /** Restart budget after the initial spawn (default 3). */
  maxRestarts?: number;
  /** Server-level LLM defaults supplied to every agent conversation; per-task model blocks override the model part. */
  defaults?: {
    provider?: string;
    /** Model name — either a full "provider/model" string or the model half of the provider pair. */
    model?: string;
    /** OpenAI-compatible base URL (e.g. an opencode compat shim). */
    baseUrl?: string;
    /** API key — LiteLLM requires a non-empty value even for keyless gateways. */
    apiKey?: string;
  };
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
  /** Path to the full stdout offload file, set when stdout exceeds the inline tail cap. */
  stdoutPath?: string;
  /** Path to the full stderr offload file, set when stderr exceeds the inline tail cap. */
  stderrPath?: string;
  /** Bounded agent-run transcript (ADR-0015 tail) — evidence for LLM-graded verify (v11 T4). */
  transcript?: string;
  /** Path to the full .agent.jsonl transcript offload, set when a run name is available. */
  transcriptPath?: string;
  judgment?: Judgment;
  pluginResults?: Record<string, any>;
  /** Advisory validation result from the LLM validator gate. Never hard-fails. */
  validation?: ValidationResult;
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
  /** Task-kind discriminator (v10): 'command' (default) | 'agent'. Mutually exclusive with `command` when 'agent'. */
  type?: 'command' | 'agent';
  /** Shell command for command tasks. Must be absent when type: agent. */
  command?: string;
  /** Required when type: agent — the prompt handed to the agent backend. */
  prompt?: string;
  /** Agent backend name (openhands today, ACP later). */
  agent?: string;
  /** Per-task model override for agent tasks. */
  model?: AgentTaskModel;
  /** Workspace for agent tasks: local (default) or docker sandbox. */
  workspace?: AgentTaskWorkspace;
  /** Run this task inside the isolated worktree (T6). Requires a plan-level target. */
  worktree?: boolean;
  timeoutMs?: number;
  llm?: { mcpServer: string; tool: string; prompt: string } | { provider: string; prompt: string };
  healCommand?: string;
  maxRetries?: number;
  /** Path to a file this task MUST produce. The executor checks existence (and optionally non-empty) after the command exits 0. */
  produces?: string;
  /** If true, the produces file must be non-empty (default: false = existence check only). */
  producedMustHaveContent?: boolean;
  /** IDs of sibling tasks that must complete before this one runs. */
  dependsOn?: string[];
  /** References a composite id declared in the top-level composites block. */
  use?: string;
  /** Optional LLM validator gate (Conductor-style). Runs after command succeeds. */
  validator?: ValidatorDef;
}

/** A reusable composite phase sequence defined in a plan YAML. */
export interface CompositeDef {
  id: string;
  phases: PlanYamlTask[];
  /** If true, the composite is inlined as a single atomic phase (one command, one eval). */
  atomic?: boolean;
}

export interface PlanYamlDoc {
  planName: string;
  tasks: PlanYamlTask[];
  /** Optional reusable composite phase sequences. */
  composites?: CompositeDef[];
  /**
   * L2 readiness gate (v11 D5, AGENTS.md "No auto-fix until L2 checklist
   * complete"). Human-written plan-level declaration: `l2.checklist: done`
   * is REQUIRED before any `type: agent` task can spawn. Absent for
   * command-only (L1) plans — the executor only gates plans that would
   * spawn an agent task. The source of truth lives in
   * `docs/l2-readiness-checklist.md` (mechanic checks + human ticks).
   */
  l2?: { checklist?: 'done' };
  /**
   * Plan-level target (v11 D8/T8): the repo/project the agent tasks work on.
   * Declared by the plan author so the runner can build the TargetSpec
   * (git → worktree isolation, non-git → .bak backup before touch).
   */
  target?: { path: string; branch?: string; isolated?: boolean };
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

export type ChildLoopStatus = 'stopped' | 'running' | 'error' | 'queued';

export type TriggerDef =
  | { type: 'cron'; expression: string; fireCount?: number; lastFiredAt?: string }
  | { type: 'fileWatch'; watchDir: string; pattern?: string; fireCount?: number; lastFiredAt?: string };

export interface ChildLoopDef {
  name: string;
  planPath?: string;
  triggers?: TriggerDef[];
  /** Shorthand: creates a fileWatch trigger for this directory */
  watchDir?: string;
  enabled?: boolean;
}

export interface ChildLoopState {
  id: string;
  name: string;
  status: ChildLoopStatus;
  planPath?: string;
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
  planPath?: string;
  triggerCount: number;
  enabled: boolean;
}

export type StartChildResult = 'ok' | 'not_found' | 'already_running';
export type StopChildResult = 'ok' | 'not_found' | 'not_running';

export interface LoopsConfig {
  loops: ChildLoopDef[];
  /** Max number of concurrently running child loops (default 4). */
  maxConcurrentLoops?: number;
  /** Estimated cost per loop iteration for budget-based concurrency clamping (default 1). */
  avgCostPerLoop?: number;
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
