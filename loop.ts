#!/usr/bin/env bun
/**
 * loop.ts — CLI entry point for bare-agent agent-loop.
 *
 * This file is intentionally slim. Most logic lives in:
 *   - src/cli.ts          (arg parsing, help, built-in tasks)
 *   - src/state-writer.ts (state persistence helpers)
 *   - src/loop-runner.ts  (single-run loop runner)
 *   - src/daemon-runner.ts(daemon-mode loop runner)
 *
 * What stays here: main(), crash handlers, and SIGINT handler.
 *
 * Usage:
 *   bun run loop.ts start --help
 *   bun run loop.ts start --task demo
 *   bun run loop.ts start --phases scan,analyze
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import type { LoopConfig, LoopState } from './src/types.js';
import { Daemon } from './src/daemon.js';
import { initProject } from './src/init.js';
import { parseArgs, printHelp, resolvePhases } from './src/cli.js';
import type { ParsedArgs } from './src/cli.js';
import { OUTPUT_DIR, writeBothStates, currentState } from './src/state-writer.js';
import { runLoop } from './src/loop-runner.js';
import { runDaemon } from './src/daemon-runner.js';

// ── Crash safety: unhandled errors should not leave state stuck in 'run' ──

process.on('uncaughtException', (err) => {
  console.error('[agent-loop] Uncaught exception:', err);
  if (currentState.value && currentState.value.currentState === 'run') {
    currentState.value.currentState = 'done';
    currentState.value.errors.push(`Uncaught exception: ${err.message}`);
    writeBothStates(currentState.value).catch(() => {});
  }
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[agent-loop] Unhandled rejection:', err);
  if (currentState.value && currentState.value.currentState === 'run') {
    currentState.value.currentState = 'done';
    currentState.value.errors.push(`Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
    writeBothStates(currentState.value).catch(() => {});
  }
});

// ── SIGINT handler ─────────────────────────────────────────────────────────

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
      if (currentState.value) {
        currentState.value.currentState = 'done';
        currentState.value.errors.push('Aborted by user (SIGINT)');
        writeBothStates(currentState.value).catch(() => {});
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
