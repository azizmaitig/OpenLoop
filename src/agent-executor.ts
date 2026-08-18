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

import type { LoopConfig, PhaseDef, PhaseResult, AgentTaskModel } from './types.js';
import type { AgentConversationStatus, AgentEvent, AgentServerClient } from './agent-server-client.js';
import { getAgentServerManager, createAgentServerManager } from './agent-server.js';
import type { AgentServerManager } from './agent-server.js';
import { createDockerSpawner, createDockerRunner, DOCKER_WORKSPACE_MOUNT } from './docker.js';
import type { DockerRunner } from './docker.js';
import { buildDenylistPromptInstruction } from './constitution.js';
import { DEFAULT_AGENT_SERVER_CONFIG } from './config.js';

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
  'error',
]);

/**
 * Resolve the "provider/model" string the server's LiteLLM accepts.
 * Per-task `model:` wins; otherwise agentServer.defaults supplies it —
 * as a full "provider/model" string or a provider+model pair.
 */
function resolveLlmModel(
  phaseModel: AgentTaskModel | undefined,
  defaults: { provider?: string; model?: string } | undefined,
): string | undefined {
  if (phaseModel) return `${phaseModel.provider}/${phaseModel.model}`;
  if (!defaults) return undefined;
  if (defaults.model?.includes('/')) return defaults.model;
  if (defaults.provider && defaults.model) return `${defaults.provider}/${defaults.model}`;
  return defaults.model ?? undefined;
}

/** Best-effort final agent text; empty when the endpoint is unavailable. */
async function finalResponseText(
  client: AgentServerClient,
  conversationId: string,
): Promise<string> {
  try {
    return await client.getAgentFinalResponse(conversationId);
  } catch (err) {
    console.error(
      `[agent-executor] agent_final_response unavailable (falling back to events): ${err instanceof Error ? err.message : String(err)}`,
    );
    return '';
  }
}

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
  dockerRunner?: DockerRunner,
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

  let client: AgentServerClient | undefined;
  let conversationId: string | undefined;

  // Workspace targeting (ADR-0023 decision 5): local (default) = the loop's
  // working directory (the L2 git worktree when running L2); docker = the
  // container's /workspace mount (verified agent-server image convention).
  const dockerWorkspace = phase.workspace?.type === 'docker';
  const workingDir = dockerWorkspace ? DOCKER_WORKSPACE_MOUNT : process.cwd();
  // Trust tier (decision 7): the denylist rides inside the prompt as the soft
  // control — the loop's command guard cannot see agent actions. Prepend so a
  // trailing "ignore everything above" cannot neutralize it.
  const effectivePrompt = [buildDenylistPromptInstruction(workingDir), phase.prompt.trim()].join('\n\n');
  // LLM config (decision 6): per-task `model:` wins; agentServer.defaults
  // supplies the endpoint (model/baseUrl/apiKey) the conversation runs on.
  const defaults = config.agentServer?.defaults;
  const model = resolveLlmModel(phase.model, defaults);
  const llm: { model?: string; baseUrl?: string; apiKey?: string } | undefined =
    model || defaults?.baseUrl || defaults?.apiKey
      ? { model, baseUrl: defaults?.baseUrl, apiKey: defaults?.apiKey }
      : undefined;

  // Local tasks share the uvx sidecar singleton (provided manager wins);
  // docker tasks ALWAYS provision their own containerized sidecar per task
  // (one container = one conversation, verified mechanism) — a shared server
  // cannot provide container isolation, so the docker path overrides any
  // provided manager.
  const mgr = dockerWorkspace
    ? createAgentServerManager(
        {
          ...config,
          agentServer: { ...(config.agentServer ?? DEFAULT_AGENT_SERVER_CONFIG), manage: true },
        },
        createDockerSpawner(dockerRunner ?? createDockerRunner()),
      )
    : (manager ?? getAgentServerManager(config));

  try {
    client = await mgr.getClient(effectiveSignal);
    // The prompt rides in `initial_message` at creation (verified server
    // contract) — no separate send call needed.
    const conversation = await client.createConversation({
      workingDir,
      prompt: effectivePrompt,
      llm,
    });
    conversationId = conversation.id;

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
        const finalResponse = await finalResponseText(client, conversationId);
        return mapTerminalResult(current.status, current.events, finalResponse, Date.now() - startTime);
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
    if (dockerWorkspace) {
      try {
        await mgr.stop();
      } catch (err) {
        // Best-effort — a container that fails to stop must never fail the phase.
        console.error(`[agent-executor] docker container cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function mapTerminalResult(
  status: AgentConversationStatus,
  events: AgentEvent[],
  finalResponse: string,
  durationMs: number,
): PhaseResult {
  // stdout = the agent's final response (verified server endpoint); fall back
  // to the last agent message / status event when it is unavailable (ADR-0023 d4).
  const reversed = [...events].reverse();
  const lastAgentMessage = reversed.find((e) => e.type === 'message' && e.source === 'agent');
  const stdout =
    finalResponse ||
    lastAgentMessage?.content ||
    reversed.find((e) => e.type === 'status_changed')?.content ||
    '';

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