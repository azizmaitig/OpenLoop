/**
 * agent-executor.ts — translates a `type: agent` phase into a sidecar
 * conversation and maps the terminal state back to a normal PhaseResult
 * (ADR-0023 decision 4: terminal conversation state → PhaseResult; the
 * 4-state FSM and checkpoint semantics are unchanged).
 *
 * T2 (issue #27): drives the conversation over the REST conversation API
 * (create → send prompt → poll → terminal status), with a hard per-phase
 * timeout abort. Tests run against a stubbed endpoint — zero live
 * OpenHands/Python. Real sidecar spawn/health/restart is T3
 * (src/agent-server.ts).
 */

import type { LoopConfig, PhaseDef, PhaseResult } from './types.js';
import type { AgentConversationStatus, AgentEvent, AgentServerClient } from './agent-server-client.js';
import { getAgentServerManager } from './agent-server.js';
import type { AgentServerManager } from './agent-server.js';

/** How often the executor polls conversation status. */
export const AGENT_POLL_INTERVAL_MS = 250;

/** Fallback per-phase timeout when neither phase.timeoutMs nor config.phaseTimeoutMs is set. */
const DEFAULT_PHASE_TIMEOUT_MS = 30000;

/** Statuses that end the conversation (ADR-0023 decision 4: finished → pass, others → fail). */
const TERMINAL_STATUSES: ReadonlySet<AgentConversationStatus> = new Set([
  'finished',
  'failed',
  'aborted',
  'stopped',
]);

function makeErrorResult(stderr: string, durationMs: number): PhaseResult {
  return { status: 'error', exitCode: -1, stdout: '', stderr, durationMs, evidencePath: '' };
}

/**
 * Execute one agent phase: create a conversation, send the prompt, poll to a
 * terminal status (or timeout/abort), and map the result to a PhaseResult.
 */
export async function executeAgentPhase(
  config: LoopConfig,
  phase: PhaseDef,
  timeoutMs?: number,
  signal?: AbortSignal,
  manager?: AgentServerManager,
): Promise<PhaseResult> {
  const startTime = Date.now();

  // Schema guarantees a prompt at plan load; guard programmatic phases too —
  // an empty prompt would burn a conversation on nothing.
  if (!phase.prompt || phase.prompt.trim() === '') {
    return makeErrorResult(
      `Agent task "${phase.name}" has no prompt — the prompt is what the agent executes.`,
      0,
    );
  }

  // Hard deadline: timeout and external abort both cancel in-flight HTTP.
  const effectiveTimeout = timeoutMs ?? config.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
  const timeoutAc = new AbortController();
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutAc.signal]) : timeoutAc.signal;

  const mgr = manager ?? getAgentServerManager(config);
  let client: AgentServerClient | undefined;
  let conversationId: string | undefined;

  try {
    client = await mgr.getClient(effectiveSignal);
    const conversation = await client.createConversation({
      model: phase.model,
      workspaceType: phase.workspace?.type,
    });
    conversationId = conversation.id;

    await client.sendMessage(conversationId, phase.prompt);

    for (;;) {
      if (effectiveSignal.aborted) {
        return makeErrorResult('cancelled', Date.now() - startTime);
      }
      if (Date.now() - startTime >= effectiveTimeout) {
        timeoutAc.abort();
        return makeErrorResult(
          `Agent task "${phase.name}" timed out after ${effectiveTimeout}ms — conversation still not terminal.`,
          Date.now() - startTime,
        );
      }
      const current = await client.getConversation(conversationId);
      if (TERMINAL_STATUSES.has(current.status)) {
        return mapTerminalResult(current.status, current.events, Date.now() - startTime);
      }
      await sleep(AGENT_POLL_INTERVAL_MS);
    }
  } catch (err) {
    return makeErrorResult(err instanceof Error ? err.message : String(err), Date.now() - startTime);
  } finally {
    if (conversationId) {
      try {
        await client?.deleteConversation(conversationId);
      } catch (err) {
        // Best-effort cleanup — a missed DELETE must never fail the phase.
        console.error(`[agent-executor] conversation cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function mapTerminalResult(
  status: AgentConversationStatus,
  events: AgentEvent[],
  durationMs: number,
): PhaseResult {
  // stdout = last agent message; fall back to the last status event as an
  // event summary when the agent never produced a message (ADR-0023 d4).
  const reversed = [...events].reverse();
  const lastAgentMessage = reversed.find((e) => e.type === 'message' && e.source === 'agent');
  const stdout = lastAgentMessage?.content ?? reversed.find((e) => e.type === 'status_changed')?.content ?? '';

  if (status === 'finished') {
    return { status: 'pass', exitCode: 0, stdout, stderr: '', durationMs, evidencePath: '' };
  }

  const errorEvent = reversed.find((e) => e.type === 'error');
  const stderr = errorEvent?.content
    ? `Agent conversation ended with status "${status}": ${errorEvent.content}`
    : `Agent conversation ended with status "${status}".`;
  return { status: 'fail', exitCode: 1, stdout, stderr, durationMs, evidencePath: '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}