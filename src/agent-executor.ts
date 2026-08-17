/**
 * agent-executor.ts — translates a `type: agent` phase into a sidecar
 * conversation and maps the terminal state back to a normal PhaseResult
 * (ADR-0023 decision 4: terminal conversation state → PhaseResult; the
 * 4-state FSM and checkpoint semantics are unchanged).
 *
 * T2 (issue #27): drives the conversation over the REST conversation API
 * (create → send prompt → poll → terminal status), with a per-phase timeout
 * abort. Tests run against a stubbed endpoint — zero live OpenHands/Python.
 * Real sidecar spawn/health/restart is T3 (src/agent-server.ts).
 */

import type { LoopConfig, PhaseDef, PhaseResult } from './types.js';
import { createAgentServerClient } from './agent-server-client.js';
import type { AgentConversationStatus, AgentEvent } from './agent-server-client.js';
import { DEFAULT_AGENT_SERVER_CONFIG } from './config.js';

/** How often the executor polls conversation status. */
export const AGENT_POLL_INTERVAL_MS = 250;

/** Statuses that end the conversation (ADR-0023 decision 4: finished → pass, others → fail). */
const TERMINAL_STATUSES: ReadonlySet<AgentConversationStatus> = new Set([
  'finished',
  'failed',
  'aborted',
  'stopped',
]);

/**
 * Execute one agent phase: create a conversation, send the prompt, poll to a
 * terminal status (or timeout/abort), and map the result to a PhaseResult.
 */
export async function executeAgentPhase(
  config: LoopConfig,
  phase: PhaseDef,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PhaseResult> {
  const startTime = Date.now();

  // Schema guarantees a prompt at plan load; guard programmatic phases too —
  // an empty prompt would burn a conversation on nothing.
  if (!phase.prompt || phase.prompt.trim() === '') {
    return {
      status: 'error',
      exitCode: -1,
      stdout: '',
      stderr: `Agent task "${phase.name}" has no prompt — the prompt is what the agent executes.`,
      durationMs: 0,
      evidencePath: '',
    };
  }

  const baseUrl = config.agentServer?.url ?? DEFAULT_AGENT_SERVER_CONFIG.url;
  const client = createAgentServerClient(baseUrl);
  let conversationId: string | undefined;

  try {
    const conversation = await client.createConversation({
      model: phase.model,
      workspaceType: phase.workspace?.type,
    });
    conversationId = conversation.id;

    await client.sendMessage(conversationId, phase.prompt);

    for (;;) {
      if (signal?.aborted) {
        return {
          status: 'error',
          exitCode: -1,
          stdout: '',
          stderr: 'cancelled',
          durationMs: Date.now() - startTime,
          evidencePath: '',
        };
      }
      if (Date.now() - startTime >= timeoutMs) {
        return {
          status: 'error',
          exitCode: -1,
          stdout: '',
          stderr: `Agent task "${phase.name}" timed out after ${timeoutMs}ms — conversation still not terminal.`,
          durationMs: Date.now() - startTime,
          evidencePath: '',
        };
      }
      const current = await client.getConversation(conversationId);
      if (TERMINAL_STATUSES.has(current.status)) {
        return mapTerminalResult(current.status, current.events, Date.now() - startTime);
      }
      await sleep(AGENT_POLL_INTERVAL_MS);
    }
  } catch (err) {
    return {
      status: 'error',
      exitCode: -1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      evidencePath: '',
    };
  } finally {
    if (conversationId) {
      try {
        await client.deleteConversation(conversationId);
      } catch {
        // Best-effort cleanup — a missed DELETE must never fail the phase.
      }
    }
  }
}

function mapTerminalResult(
  status: AgentConversationStatus,
  events: AgentEvent[],
  durationMs: number,
): PhaseResult {
  // stdout = last agent message (ADR-0023 decision 4: "stdout = last agent
  // message / event summary").
  const lastAgentMessage = [...events]
    .reverse()
    .find((e) => e.type === 'message' && e.source === 'agent');
  const stdout = lastAgentMessage?.content ?? '';

  if (status === 'finished') {
    return { status: 'pass', exitCode: 0, stdout, stderr: '', durationMs, evidencePath: '' };
  }

  const errorEvent = [...events].reverse().find((e) => e.type === 'error');
  const stderr = errorEvent?.content
    ? `Agent conversation ended with status "${status}": ${errorEvent.content}`
    : `Agent conversation ended with status "${status}".`;
  return { status: 'fail', exitCode: 1, stdout, stderr, durationMs, evidencePath: '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}