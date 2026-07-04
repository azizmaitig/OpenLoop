export type StateMachineState = 'init' | 'run' | 'verify' | 'done';

export interface PhaseDef {
  name: string;
  command: string;
  expectedExitCode: number;
  timeoutMs: number;
  llm?: { mcpServer: string; tool: string; prompt: string };
  pluginHooks?: string[];
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
  memory?: MemoryConfig;
}

export interface PhaseResult {
  status: 'pass' | 'fail' | 'error';
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
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
}
