#!/usr/bin/env bun
/**
 * cli.ts — CLI argument parsing and built-in task registry.
 *
 * Extracted from loop.ts to reduce the entry-point god module.
 */

import type { LoopConfig, PhaseDef } from './types.js';

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

function parseArgs(rawArgs: string[]): ParsedArgs {
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

export type { ParsedArgs };
export { DEMO_TASK, TASK_REGISTRY, printHelp, parseArgs, resolvePhases };
