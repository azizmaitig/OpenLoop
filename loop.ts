#!/usr/bin/env bun
/**
 * loop.ts — CLI entry point for bare-agent agent-loop.
 *
 * Usage:
 *   bun run loop.ts start --help
 *   bun run loop.ts start --task demo
 *   bun run loop.ts start --phases scan,analyze
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { StateMachine } from './src/state-machine.js';
import { writeState, createInitialState } from './src/state.js';
import type { LoopConfig, PhaseDef, LoopState, LoopResult } from './src/types.js';
import { evaluatePhase } from './src/evaluate.js';
import { loadPlugins, executeBeforeLoop, executeAfterLoop } from './src/plugins.js';
import type { Plugin } from './src/plugins.js';
import { startApiServer } from './src/api.js';
import type { ApiHandlers } from './src/api.js';
import { Daemon } from './src/daemon.js';
import { initProject } from './src/init.js';
import { onPhaseFailed, onLoopComplete } from './src/memory-hooks.js';
import { executePhaseGroup } from './src/execute-phases.js';

// ── Built-in tasks ──────────────────────────────────────────────────────────

const DEMO_TASK: LoopConfig = {
  taskName: 'demo',
  maxIterations: 1,
  phaseTimeoutMs: 30000,
  phases: [
    { name: 'scan', command: 'echo "scanning..."', expectedExitCode: 0, timeoutMs: 30000 },
    { name: 'analyze', command: 'echo "analyzed: 42 items"', expectedExitCode: 0, timeoutMs: 30000 },
    { name: 'report', command: 'echo "report generated"', expectedExitCode: 0, timeoutMs: 30000 },
  ],
};

// ponytail: single-entry registry, extend map when new tasks are added
const TASK_REGISTRY: Record<string, LoopConfig> = {
  demo: DEMO_TASK,
};

// ponytail: hardcoded path, make configurable when multi-project support needed
const OUTPUT_DIR = resolve('_agent-loop-output');

// ── Help ────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
Usage: bun run loop.ts <command> [options]

Commands:
  start                        Run loop (phases/task)
  daemon                       Run as persistent daemon (no task execution yet)
  init                         Scaffold STATE.md, LOOP.md, AGENTS.md

Options:
  --phases <name1,name2,...>   Run named phases from the built-in task
  --task <taskDef>             Run a built-in task (default: demo)
  --max-iterations <n>         Max loop iterations (default: 1 for demo)
  --timeout <ms>               Per-phase timeout in ms (default: 30000)
  --daemon                     Run as daemon on interval (no max-iterations cap)
  --llm <server,tool>          Enable LLM controller (sets llmController, configures MCP server/tool)
  --plugins <path1,path2,...>  Load plugin modules from these paths
  --plan <path>                Path to a .plan.yaml file
  --port <number>              HTTP API port (daemon default: 3000, start default: 3099)
  --cron <expression>          Cron schedule for recurring tasks (e.g. "0 9 * * *")
  --watch-dir <path>           Watch directory for .plan.yaml files
  --loops-config <path>        Path to loops.yaml for multi-loop orchestration
  --memory                     Enable agentmemory integration (episodic save, health pulse, lesson extraction)
  --dir <path>                 Target directory for init (default: cwd)
  --force                      Overwrite existing files in init
  --help                       Print this help and exit
`);
}

// ── CLI args parsing ────────────────────────────────────────────────────────

interface ParsedArgs {
  subcommand: string;
  help: boolean;
  initDir: string | undefined;
  initForce: boolean;
  daemon: boolean;
  phaseNames: string[] | undefined;
  taskName: string | undefined;
  maxIterations: number | undefined;
  timeout: number | undefined;
  llmConfig: string | undefined;
  pluginPaths: string | undefined;
  planPath: string | undefined;
  port: number | undefined;
  cron: string | undefined;
  watchDir: string | undefined;
  loopsConfig: string | undefined;
  memory: boolean;
}

export function parseArgs(rawArgs: string[]): ParsedArgs {
  let help = false;
  let subcommand = '';
  let daemon = false;
  let phaseNames: string[] | undefined;
  let taskName: string | undefined;
  let maxIterations: number | undefined;
  let timeout: number | undefined;
  let llmConfig: string | undefined;
  let pluginPaths: string | undefined;
  let planPath: string | undefined;
  let port: number | undefined;
  let cron: string | undefined;
  let watchDir: string | undefined;
  let loopsConfig: string | undefined;
  let memory = false;
  let initDir: string | undefined;
  let initForce = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case 'start':
        subcommand = 'start';
        break;
      case 'init':
        subcommand = 'init';
        break;
      case 'daemon':
        subcommand = 'daemon';
        break;
      case '--phases': {
        const val = rawArgs[++i];
        if (val) phaseNames = val.split(',').map((s) => s.trim());
        break;
      }
      case '--task': {
        taskName = rawArgs[++i];
        break;
      }
      case '--max-iterations': {
        const val = parseInt(rawArgs[++i], 10);
        if (!isNaN(val)) maxIterations = val;
        break;
      }
      case '--timeout': {
        const val = parseInt(rawArgs[++i], 10);
        if (!isNaN(val)) timeout = val;
        break;
      }
      case '--dir': {
        initDir = rawArgs[++i];
        break;
      }
      case '--force':
        initForce = true;
        break;
      case '--daemon':
        daemon = true;
        break;
      case '--llm': {
        llmConfig = rawArgs[++i];
        break;
      }
      case '--plugins': {
        pluginPaths = rawArgs[++i];
        break;
      }
      case '--plan': {
        planPath = rawArgs[++i];
        break;
      }
      case '--port': {
        const val = parseInt(rawArgs[++i], 10);
        if (!isNaN(val)) port = val;
        break;
      }
      case '--cron': {
        cron = rawArgs[++i];
        break;
      }
      case '--watch-dir': {
        watchDir = rawArgs[++i];
        break;
      }
      case '--loops-config': {
        loopsConfig = rawArgs[++i];
        break;
      }
      case '--memory':
        memory = true;
        break;
    }
  }

  return { subcommand, help, initDir, initForce, daemon, phaseNames, taskName, maxIterations, timeout, llmConfig, pluginPaths, planPath, port, cron, watchDir, loopsConfig, memory };
}

// ── Phase resolution ────────────────────────────────────────────────────────

function resolvePhases(
  taskName: string | undefined,
  phaseNames: string[] | undefined,
): LoopConfig {
  const task =
    taskName && TASK_REGISTRY[taskName]
      ? TASK_REGISTRY[taskName]
      : DEMO_TASK;

  let phases: PhaseDef[];
  if (phaseNames && phaseNames.length > 0) {
    phases = task.phases.filter((p) => phaseNames!.includes(p.name));
  } else {
    phases = [...task.phases];
  }

  return { ...task, taskName: taskName ?? task.taskName, phases };
}

// ── State writing helpers ───────────────────────────────────────────────────

async function writeJsonState(filePath: string, state: LoopState): Promise<void> {
  await Bun.write(filePath, JSON.stringify(state, null, 2) + '\n');
}

async function writeBothStates(state: LoopState): Promise<void> {
  await Promise.all([
    writeState(resolve(OUTPUT_DIR, 'STATE.md'), state),
    writeJsonState(resolve(OUTPUT_DIR, 'state.json'), state),
  ]);
}

// ── Transition resolver ──────────────────────────────────────────────────────

/**
 * Resolve the next event for the state machine.
 *
 * When `config.llmController === true`, collects phase judgments via
 * evaluatePhase(), asks the LLM to decide the next event, and falls
 * back to hardcoded logic if the LLM is unavailable or returns an
 * invalid event.
 *
 * Returns an event name validated against the state machine's allowed
 * events for the current state. The caller calls sm.transition() after.
 */
async function resolveTransition(
  sm: StateMachine,
  config: LoopConfig,
  state: LoopState,
  iteration: number,
  allPassed: boolean,
): Promise<string> {
  if (!config.llmController) {
    return resolveHardcoded(allPassed, iteration, config.maxIterations);
  }

  // LLM controller mode
  try {
    // Collect judgments for all executed phases
    const phaseSummaries: { name: string; passed: boolean; reason: string; confidence: number; stdout: string; stderr: string }[] = [];
    for (const phase of config.phases) {
      const result = state.phaseResults[phase.name];
      if (result) {
        const judgment = await evaluatePhase(phase, result);
        phaseSummaries.push({
          name: phase.name,
          passed: judgment.passed,
          reason: judgment.reason,
          confidence: judgment.confidence,
          stdout: result.stdout.slice(0, 500),
          stderr: result.stderr.slice(0, 500),
        });
      }
    }

    // Need at least one phase with llm config to make the transition call
    const llmPhase = config.phases.find(p => p.llm);
    if (!llmPhase?.llm) {
      return resolveHardcoded(allPassed, iteration, config.maxIterations);
    }
    // Transition controller requires MCP-shaped config
    if (!('mcpServer' in llmPhase.llm)) {
      return resolveHardcoded(allPassed, iteration, config.maxIterations);
    }

    const allowed = sm.allowedEvents();
    const promptData = {
      task: 'Decide the next state machine event for a loop orchestrator',
      iteration: iteration + 1,
      maxIterations: config.maxIterations,
      phases: phaseSummaries,
      allPassed,
      instruction: `Return JSON with a single key "event" containing one of: ${allowed.join(', ')}.`,
    };

    const { executeMcpPhase } = await import('./src/mcp.js');
    const evalPhase: PhaseDef = {
      name: 'transition-controller',
      command: 'llm-transition',
      expectedExitCode: 0,
      timeoutMs: config.phaseTimeoutMs,
      llm: {
        mcpServer: llmPhase.llm.mcpServer,
        tool: llmPhase.llm.tool,
        prompt: JSON.stringify(promptData),
      },
    };

    const llmResult = await executeMcpPhase(evalPhase);

    if (llmResult.status === 'pass' && llmResult.stdout) {
      const parsed = JSON.parse(llmResult.stdout);
      // Handle two response shapes: { event: "LOOP" } or nested in result
      let event = parsed.event ?? parsed.result?.event ?? null;
      if (typeof event === 'string') {
        const normalized = event.toUpperCase() as string;
        if (allowed.includes(normalized)) {
          return normalized;
        }
      }
    }
  } catch {
    // Fallback on any LLM error
  }

  return resolveHardcoded(allPassed, iteration, config.maxIterations);
}

function resolveHardcoded(allPassed: boolean, iteration: number, maxIterations: number): string {
  if (allPassed) {
    return iteration < maxIterations - 1 ? 'LOOP' : 'COMPLETE';
  }
  return 'FAILED';
}

// ── Main loop runner ────────────────────────────────────────────────────────

async function runLoop(config: LoopConfig): Promise<number> {
  const sm = new StateMachine();
  let state = createInitialState(config);
  sigintState = state;

  // Load plugins once (v2: no plugins → v1 behavior)
  const plugins = await loadPlugins(config);

  // Plan-driven mode: use plan-executor's beforeLoop to load phases from .plan.yaml
  let planPlugin: Plugin | undefined;
  if (config.planPath) {
    planPlugin = plugins.find(p => p.name === 'plan-executor');
    if (planPlugin?.beforeLoop) {
      const planPhases = await executeBeforeLoop(planPlugin, config.planPath);
      if (planPhases.length > 0) {
        config = { ...config, phases: planPhases };
        console.log(`[plan-executor] Loaded ${planPhases.length} phases from ${config.planPath}`);
      }
    }
  }

  // Write initial state
  await writeBothStates(state);

  let allPassed = true;

  for (let i = 0; i < config.maxIterations; i++) {
    state.iteration = i + 1;
    sigintState = state;

    // ── Transition to RUN ──────────────────────────────────────────────────
    sm.transition('RUN');
    state.currentState = 'run';
    await writeBothStates(state);

    // ── Execute each phase ─────────────────────────────────────────────────
    const phaseResult = await executePhaseGroup(
      { config, plugins, writeState: writeBothStates, onPhaseFailed: (p, r) => onPhaseFailed(p, r, config) },
      state,
      state.iteration,
    );
    allPassed = phaseResult.allPassed;
    state = phaseResult.state;
    sigintState = state;

    // ── Transition to VERIFY ───────────────────────────────────────────────
    sm.transition('VERIFY');
    state.currentState = 'verify';
    sigintState = state;
    await writeBothStates(state);

    // ── Decide next state ──────────────────────────────────────────────────
    const newEvent = await resolveTransition(sm, config, state, i, allPassed);
    sm.transition(newEvent);

    if (newEvent === 'LOOP') {
      state.currentState = 'init';
      state.phaseResults = {};
      sigintState = state;
      console.log(`\n[${state.iteration}/${config.maxIterations}] All passed — looping\n`);
    } else if (newEvent === 'COMPLETE') {
      state.currentState = 'done';
      sigintState = state;
      console.log(`\nLoop COMPLETE — all phases passed`);
    } else if (newEvent === 'FAILED') {
      state.currentState = 'done';
      sigintState = state;
      console.log(`\nLoop FAILED — some phases did not pass`);
      break;
    } else if (newEvent === 'ABORT') {
      state.currentState = 'done';
      sigintState = state;
      console.log(`\nLoop ABORTED`);
      break;
    }
  }

  // Write final state
  await writeBothStates(state);

  await onLoopComplete(state, config).catch(() => {});

  // Plan-driven mode: call afterLoop to write status back to the plan yaml
  if (planPlugin?.afterLoop) {
    const loopResult: LoopResult = {
      finalState: state.currentState,
      iterationsCompleted: state.iteration,
      allPhasesPassed: allPassed,
      totalDurationMs: Date.now() - new Date(state.startTime).getTime(),
      phaseResults: state.phaseResults,
    };
    await executeAfterLoop(planPlugin, loopResult);
  }

  return allPassed ? 0 : 1;
}

// ── Daemon mode ─────────────────────────────────────────────────────────────

/**
 * Run the loop in daemon mode — repeated iterations on an interval.
 *
 * Uses setInterval with config.daemon.intervalMs.
 * On each tick, runs all phases and transitions state.
 * State resets between iterations (phase results cleared).
 * Handles SIGINT/SIGTERM for graceful shutdown (no process.exit(1)).
 */
async function runDaemon(config: LoopConfig): Promise<void> {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  const sm = new StateMachine();
  let state = createInitialState(config);

  const intervalMs = config.daemon?.intervalMs ?? 60000;

  await writeBothStates(state);

  // Load plugins once (v2: no plugins → same daemon behavior)
  const plugins = await loadPlugins(config);

  // Start API server if configured
  if (config.daemon?.port) {
    const apiHandlers: ApiHandlers = {
      getState: () => state,
      startLoop: async () => { running = true; },
      stopLoop: async () => { running = false; },
      triggerIteration: async () => { await tick(); },
    };
    startApiServer(config.daemon.port, apiHandlers);
    console.log(`API server listening on port ${config.daemon.port}`);
  }

  console.log(`Daemon started (interval: ${intervalMs}ms)`);

  let running = true;
  const shutdown = () => {
    if (!running) return;
    running = false;
    state.currentState = 'done';
    writeBothStates(state).catch(() => {});
    console.log('Daemon stopped gracefully');
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let iterationCount = 0;

  async function tick(): Promise<void> {
    if (!running) return;

    iterationCount++;
    state.iteration = iterationCount;
    state.currentState = 'init';
    state.phaseResults = {};
    state.errors = [];

    sm.transition('RUN');
    state.currentState = 'run';
    await writeBothStates(state);

    // ponytail: daemon ignores iteration count, always shows ∞
    const fakeConfig = { ...config, maxIterations: Infinity };
    const phaseResult = await executePhaseGroup(
      { config: fakeConfig, plugins, writeState: writeBothStates, onPhaseFailed: () => {} },
      state,
      state.iteration,
    );
    state = phaseResult.state;

    sm.transition('VERIFY');
    state.currentState = 'verify';
    await writeBothStates(state);

    // ponytail: always loop back — daemon ignores pass/fail, runs until SIGINT
    sm.transition('LOOP');
    state.currentState = 'init';
    state.phaseResults = {};
    await writeBothStates(state);

    console.log(`Daemon iteration ${iterationCount} complete`);
  }

  await tick();
  const intervalId = setInterval(tick, intervalMs);
  // ponytail: unref keeps process alive via the promise below, not the timer
  intervalId.unref();

  await new Promise<void>(() => {});
}

// ── Global state ref for SIGINT handler ─────────────────────────────────────

let sigintState: LoopState | null = null;

process.on('SIGINT', () => {
  console.log('\n[agent-loop] Are you sure you want to exit? (y/N)');

  const timeout = setTimeout(() => {
    console.log('[agent-loop] Continuing...');
  }, 10000).unref();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('', (answer) => {
    clearTimeout(timeout);
    const key = answer.trim().toLowerCase();
    if (key === 'y') {
      if (sigintState) {
        sigintState.currentState = 'done';
        sigintState.errors.push('Aborted by user (SIGINT)');
        writeBothStates(sigintState).catch(() => {});
      }
      console.log('Exiting...');
      process.exit(1);
    } else {
      console.log('[agent-loop] Continuing...');
      rl.close();
    }
  });
});

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  // ── Init mode — scaffold convention files ───────────────────────────────
  if (parsed.subcommand === 'init') {
    const initDir = parsed.initDir ?? resolve('.');
    const result = await initProject(initDir, { force: parsed.initForce });
    for (const name of result.created) {
      console.log(`Created ${name}`);
    }
    for (const warn of result.warnings) {
      console.warn(`Warning: ${warn}`);
    }
    process.exit(result.created.length > 0 ? 0 : 1);
  }

  // ── Daemon mode (v6) ────────────────────────────────────────────────────
  if (parsed.subcommand === 'daemon') {
    const port = parsed.port ?? 3000;
    const daemon = new Daemon(port, undefined, {
      cron: parsed.cron,
      watchDir: parsed.watchDir,
      loopsConfig: parsed.loopsConfig,
      planPath: parsed.planPath,
    });
    await daemon.start();
    return;
  }

  if (parsed.subcommand !== 'start') {
    printHelp();
    process.exit(1);
  }

  // Resolve phase config from built-in tasks
  let config = resolvePhases(parsed.taskName, parsed.phaseNames);

  // Apply CLI overrides
  if (parsed.maxIterations !== undefined) {
    config.maxIterations = Math.min(parsed.maxIterations, 20);
  }
  if (parsed.timeout !== undefined) {
    config.phaseTimeoutMs = parsed.timeout;
    config.phases = config.phases.map((p) => ({ ...p, timeoutMs: parsed.timeout! }));
  }

  if (parsed.llmConfig) {
    const [mcpServer, tool] = parsed.llmConfig.split(',');
    config.llmController = true;
    config.phases = config.phases.map(p => ({
      ...p,
      llm: p.llm ?? { mcpServer, tool, prompt: '{}' },
    }));
  }
  if (parsed.pluginPaths) {
    config.plugins = parsed.pluginPaths.split(',').map(s => s.trim());
  }
  if (parsed.planPath) {
    config.plugins = [...(config.plugins ?? []), './src/plan-executor.ts'];
    config.planPath = parsed.planPath;
  }
  if (parsed.port !== undefined) {
    config.daemon = { ...config.daemon ?? { intervalMs: 60000 }, port: parsed.port };
  }
  if (parsed.memory) {
    config.memory = { enabled: true };
  }

  if (config.phases.length === 0) {
    console.error('Error: no phases to run');
    process.exit(1);
  }

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Daemon mode — run on interval until SIGINT
  if (parsed.daemon) {
    if (!config.daemon) {
      config.daemon = { intervalMs: 60000, port: 3099 };
    }
    await runDaemon(config);
    return;
  }

  // Run the loop (v1)
  const exitCode = await runLoop(config);
  process.exit(exitCode);
}

if (import.meta.main) {
  await main();
}
