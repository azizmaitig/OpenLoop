#!/usr/bin/env bun
/**
 * loop-runner.ts — the core loop iteration extracted from loop.ts.
 *
 * Contains runLoop() (single-run mode) plus the transition resolver
 * (resolveTransition / resolveHardcoded) that decides LOOP/COMPLETE/FAILED.
 */

import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { createLoopContext } from './loop-context.js';
import { updatePhaseResult } from './state.js';
import { executeBeforeLoop, executeAfterLoop } from './plugins.js';
import type { Plugin } from './plugins.js';
import { getPlanDoc } from './plan-executor.js';
import { saveCheckpoint, clearCheckpoint, loadCheckpoint, hasValidCheckpoint } from './checkpoint.js';
import { evaluatePhase } from './evaluate.js';
import { runLoopBody } from './loop-core.js';
import type { StateMachine } from './state-machine.js';
import { onPhaseFailed, onLoopComplete } from './memory-hooks.js';
import { writeBothStates, setCurrentState } from './state.js';
import { applyTransition } from './transition.js';
import type { LoopConfig, LoopState, LoopResult, PhaseDef, PhaseResult, Judgment, PlanYamlTask } from './types.js';

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

    const { executeMcpPhase } = await import('./mcp.js');
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

export interface RunLoopOpts {
  /** Optional broadcast callback for live WS events. */
  broadcast?: (type: string, data: unknown) => void;
  /** Optional abort signal for early termination. */
  signal?: AbortSignal;
  /** When true, skip the interactive checkpoint resume prompt (daemon mode). */
  skipCheckpointPrompt?: boolean;
}

// ── Main loop runner ────────────────────────────────────────────────────────

async function runLoop(config: LoopConfig, broadcast?: RunLoopOpts['broadcast']): Promise<number>;
async function runLoop(config: LoopConfig, opts?: RunLoopOpts): Promise<number>;
async function runLoop(config: LoopConfig, broadcastOrOpts?: RunLoopOpts['broadcast'] | RunLoopOpts): Promise<number> {
  // Normalise overloaded second argument
  let broadcast: RunLoopOpts['broadcast'];
  let signal: RunLoopOpts['signal'];
  let skipCheckpointPrompt: RunLoopOpts['skipCheckpointPrompt'];
  if (broadcastOrOpts && typeof broadcastOrOpts === 'object') {
    broadcast = broadcastOrOpts.broadcast;
    signal = broadcastOrOpts.signal;
    skipCheckpointPrompt = broadcastOrOpts.skipCheckpointPrompt;
  } else {
    broadcast = broadcastOrOpts;
  }
  const { sm, state: loopCtxState, plugins } = await createLoopContext(config);
  let state = loopCtxState;

  // ── Checkpoint resume prompt (skipped in daemon mode) ──
  let resume = false;
  if (config.planPath && !skipCheckpointPrompt) {
    try {
      const { parsePlanYaml } = await import('./plan-executor.js')
      const doc = await parsePlanYaml(config.planPath)
      if (hasValidCheckpoint(doc.planName, config.planPath)) {
        const cp = loadCheckpoint(doc.planName)!
        console.log(`\n[checkpoint] Found saved progress: ${cp.completedTaskIds.length} tasks completed.`)
        console.log(`[checkpoint] Started: ${cp.startedAt}, Last update: ${cp.updatedAt}`)
        process.stdout.write('[checkpoint] Resume from checkpoint? (Y/n): ')

        for await (const line of process.stdin) {
          const answer = line.trim().toLowerCase()
          resume = answer === '' || answer === 'y' || answer === 'yes'
          break
        }

        if (resume) {
          console.log(`[checkpoint] Resuming — skipping ${cp.completedTaskIds.length} completed tasks.`)
        } else {
          console.log('[checkpoint] Starting fresh — clearing checkpoint.')
          clearCheckpoint(doc.planName)
        }
      }
    } catch {
      // If plan parsing fails, continue without checkpoint
    }
  }

  // Plan-driven mode: use plan-executor's beforeLoop to load phases from .plan.yaml
  let planPlugin: Plugin | undefined;
  if (config.planPath) {
    planPlugin = plugins.find(p => p.name === 'plan-executor');
    if (planPlugin?.beforeLoop) {
      const planPhases = await executeBeforeLoop(planPlugin, config.planPath, resume);
      if (planPhases.length > 0) {
        config = { ...config, phases: planPhases };
        console.log(`[plan-executor] Loaded ${planPhases.length} phases from ${config.planPath}`);
      }
      const planDoc = getPlanDoc();
    }
  }

  // Write initial state
  await writeBothStates(state);

  let allPassed = true;

  for (let i = 0; i < config.maxIterations; i++) {
    if (signal?.aborted) {
      console.log(`\nLoop ABORTED via signal — ${i} iteration(s) completed`);
      break;
    }
    try {
      const result = await runLoopBody({
        sm,
        state,
        config,
        plugins,
        iteration: i + 1,
        writeState: writeBothStates,
        onPhaseFailed: (p, r) => onPhaseFailed(p, r, config),
        planPath: config.planPath,
        getPlanDoc,
        logPath: resolve('loop-run-log.md'),
        broadcast,
        // resolveTransition honors maxIterations + pass/fail (0-based index i).
        decideEvent: (passed, postVerifyState) => resolveTransition(sm, config, postVerifyState, i, passed),
      });
      state = result.state;
      allPassed = result.allPassed;

      if (result.event === 'LOOP') {
        console.log(`\n[${state.iteration}/${config.maxIterations}] All passed — looping\n`);
      } else if (result.event === 'COMPLETE') {
        console.log(`\nLoop COMPLETE — all phases passed`);
      } else if (result.event === 'FAILED') {
        console.log(`\nLoop FAILED — some phases did not pass`);
        break;
      } else if (result.event === 'ABORT') {
        console.log(`\nLoop ABORTED`);
        break;
      }
    } catch (err) {
      const msg = `Unhandled error in iteration ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
      state = applyTransition('ABORT', state, sm);
      state.errors.push(msg);
      setCurrentState(state);
      await writeBothStates(state).catch(() => {});
      console.error(`[agent-loop] Fatal error in iteration ${i + 1}:`, err);
      break;
    }
  }

  // Write final state (belt-and-suspenders — try/catch above already writes it)
  await writeBothStates(state).catch(() => {});

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

    // ── Clear checkpoint on full success ──
    if (allPassed && config.planPath) {
      const planDoc = getPlanDoc()
      if (planDoc) {
        clearCheckpoint(planDoc.planName)
        console.log(`[checkpoint] Plan completed — checkpoint cleared.`)
      }
    }
  }

  return allPassed ? 0 : 1;
}

export { runLoop };
