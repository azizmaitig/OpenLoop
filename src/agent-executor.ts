/**
 * agent-executor.ts — drives one opencode session per `type: agent` phase
 * (v11, ADR-0024): assertHealthy → createSession → sendPrompt (task prompt +
 * DONE convention) → watch the event stream until the DONE marker, or a
 * StepFinishPart + idle timeout, or the hard timeoutMs cap → abort the
 * session on failure/timeout → map the terminal state to a normal PhaseResult.
 * 1 task = 1 session = 1 PhaseResult = 1 verify gate. The verify phase is the
 * real gate — the DONE marker signals finished, not succeeded.
 */

import type { LoopConfig, PhaseDef, PhaseResult } from './types.js';
import type { AgentServerManager } from './agent-server.js';
import type { DockerRunner } from './docker.js';
import {
  createOpenCodeClient,
  type OpenCodeClient,
  type OpenCodeMessage,
  type OpenCodeSessionModel,
  type OpenCodeStreamEvent,
} from './opencode-client.js';
import { DEFAULT_OPENCODE_SERVER_CONFIG } from './config.js';
import {
  auditTranscriptEntries,
  buildDenylistPromptInstruction,
  buildPermissionRuleset,
  formatAuditIncidentReport,
} from './constitution.js';
import {
  TranscriptCollector,
  reconstructTranscript,
  writeTranscriptJsonl,
  DEFAULT_TRANSCRIPT_TAIL,
} from './transcript.js';

/** The agent must reply exactly this when the task is done. */
export const DONE_MARKER = 'DONE';

/** Instruction appended to every agent prompt (D3a convention). */
export const DONE_CONVENTION_INSTRUCTION = `When you have completed the task, reply exactly ${DONE_MARKER}.`;

/** Fallback per-phase timeout when neither phase.timeoutMs nor config.phaseTimeoutMs is set. */
const DEFAULT_PHASE_TIMEOUT_MS = 30000;

/** Fallback idle timeout after a StepFinishPart when config.opencodeServer.idleTimeoutMs is unset. */
const DEFAULT_IDLE_TIMEOUT_MS = 60000;

/**
 * First-event budget on the session event stream: if no event arrives within
 * this window the stream is treated as silent (opencode 1.18.19 per-session
 * SSE defect — delivers 0 bytes even on a live session) and the executor
 * falls back to message polling (ADR-0024 D3b).
 */
const DEFAULT_STREAM_SILENT_TIMEOUT_MS = 10000;

/** Poll interval for the D3b message-poll fallback (ms). */
const MESSAGE_POLL_INTERVAL_MS = 2000;

/** Event types on the opencode session stream (SessionDurableEvent). */
const EVENT_TEXT_ENDED = 'session.next.text.ended';
const EVENT_STEP_ENDED = 'session.next.step.ended';
const EVENT_STEP_FAILED = 'session.next.step.failed';

/**
 * Build the prompt sent to the agent: the denylist rides inside the prompt as
 * the soft control (the loop's command guard cannot see agent actions), then
 * the task prompt, then the DONE convention as the final instruction.
 */
export function buildAgentPrompt(prompt: string, workingDir: string): string {
  return [
    buildDenylistPromptInstruction(workingDir),
    prompt.trim(),
    DONE_CONVENTION_INSTRUCTION,
  ].join('\n\n');
}

function hasDoneMarker(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === DONE_MARKER);
}

function makeErrorResult(stderr: string, durationMs: number): PhaseResult {
  return { status: 'error', exitCode: -1, stdout: '', stderr, durationMs, evidencePath: '' };
}

type AgentOutcome =
  | { kind: 'done'; stdout: string; via: 'done-marker' | 'step-idle' | 'stream-end' | 'message-poll' }
  | { kind: 'timeout'; stdout: string }
  | { kind: 'error'; stdout: string; detail: string }
  | { kind: 'aborted' }
  | { kind: 'silent' };

/** Optional run context for the .agent.jsonl offload (set by execute-phases). */
export interface AgentPhaseOpts {
  runName?: string;
  iteration?: number;
  outputDir?: string;
  /** Worktree workspace id — the session is created inside it (T6 isolation). */
  workspaceID?: string;
  /** Worktree directory — the denylist prompt is anchored here (T6 isolation). */
  worktreeDir?: string;
}

/** Attach the bounded transcript to a result and offload the full JSONL when a run name is known. */
function withTranscript(
  result: PhaseResult,
  collector: TranscriptCollector,
  opts: AgentPhaseOpts | undefined,
  tailChars: number,
  phaseName: string,
): PhaseResult {
  const augmented = { ...result, transcript: collector.toBoundedText(tailChars) };
  if (opts?.runName) {
    const path = writeTranscriptJsonl(
      collector,
      opts.runName,
      opts.iteration ?? 1,
      phaseName,
      opts.outputDir,
    );
    augmented.transcriptPath = path;
    augmented.evidencePath = path;
  }
  return augmented;
}

/**
 * Consume the event stream until completion: DONE marker in a text event,
 * StepFinishPart + idle timeout, stream close, hard deadline, or failure.
 * Every event is fed to the collector for transcript assembly.
 * Never throws — failures become outcomes.
 */
async function collectOutcome(
  events: AsyncIterable<OpenCodeStreamEvent>,
  opts: {
    hardDeadlineMs: number;
    idleTimeoutMs: number;
    signal: AbortSignal;
    collector: TranscriptCollector;
    /** If set, treat a stream that delivers NO first event within this budget as silent. */
    streamSilentTimeoutMs?: number;
  },
): Promise<AgentOutcome> {
  const iter = events[Symbol.asyncIterator]();
  let stepEnded = false;
  let stepEndedAt = 0;
  let lastText = '';
  const streamStart = Date.now();

  for (;;) {
    if (opts.signal.aborted) return { kind: 'aborted' };
    const now = Date.now();
    if (now >= opts.hardDeadlineMs) return { kind: 'timeout', stdout: lastText };

    const idleDeadline = stepEnded ? stepEndedAt + opts.idleTimeoutMs : Infinity;
    // While no event has arrived yet, the silent budget also bounds the wait:
    // a stream that delivers nothing (opencode 1.18.19 defect) must fall back
    // to message polling BEFORE the hard deadline turns it into a timeout.
    const silentDeadline =
      opts.streamSilentTimeoutMs !== undefined && lastText === '' && !stepEnded
        ? streamStart + opts.streamSilentTimeoutMs
        : Infinity;
    const nextTimer = Math.min(opts.hardDeadlineMs, idleDeadline, silentDeadline);
    const waitMs = Math.max(0, nextTimer - now);

    let raced: IteratorResult<OpenCodeStreamEvent> | 'timer';
    try {
      raced = await Promise.race([
        iter.next(),
        sleep(waitMs).then(() => 'timer' as const),
      ]);
    } catch (err) {
      if (opts.signal.aborted) return { kind: 'aborted' };
      return { kind: 'error', stdout: lastText, detail: err instanceof Error ? err.message : String(err) };
    }

    if (raced === 'timer') {
      if (Date.now() >= opts.hardDeadlineMs) return { kind: 'timeout', stdout: lastText };
      if (stepEnded) return { kind: 'done', stdout: lastText, via: 'step-idle' };
      // No first event within the silent budget and no step ended yet — the
      // stream is delivering nothing (opencode 1.18.19 defect). Signal the
      // caller to fall back to message polling (ADR-0024 D3b).
      if (opts.streamSilentTimeoutMs !== undefined && Date.now() - streamStart >= opts.streamSilentTimeoutMs) {
        return { kind: 'silent' };
      }
      continue; // idle elapsed before any step finished — the hard cap still bounds the wait
    }

    if (raced.done) return { kind: 'done', stdout: lastText, via: 'stream-end' };

    const ev = raced.value;
    opts.collector.record(ev);
    const type = typeof ev.data?.type === 'string' ? ev.data.type : ev.event;

    if (type === EVENT_STEP_FAILED) {
      return {
        kind: 'error',
        stdout: lastText,
        detail: typeof ev.data?.error === 'string' ? ev.data.error : 'agent step failed',
      };
    }
    if (type === EVENT_STEP_ENDED) {
      const finish = typeof ev.data?.finish === 'string' ? ev.data.finish : '';
      if (finish === 'error' || finish === 'aborted') {
        return { kind: 'error', stdout: lastText, detail: `agent step finished with "${finish}"` };
      }
      if (!stepEnded) {
        stepEnded = true;
        stepEndedAt = Date.now();
      }
      continue;
    }
    if (type === EVENT_TEXT_ENDED) {
      const text = typeof ev.data?.text === 'string' ? ev.data.text : '';
      if (text) lastText = text;
      if (hasDoneMarker(text)) return { kind: 'done', stdout: text, via: 'done-marker' };
    }
  }
}

/**
 * D3b fallback: poll the session's stored messages until an assistant reply
 * has a terminal `finish` (openCode marks it on the last message). Rebuilds
 * the transcript from the refetched messages — the same reconstruction the
 * live integration test uses. Bounded by the hard deadline and the signal.
 */
async function collectOutcomeByMessagePolling(
  client: OpenCodeClient,
  sessionId: string,
  opts: {
    hardDeadlineMs: number;
    signal: AbortSignal;
    collector: TranscriptCollector;
  },
): Promise<AgentOutcome> {
  let lastText = '';
  for (;;) {
    if (opts.signal.aborted) return { kind: 'aborted' };
    const now = Date.now();
    if (now >= opts.hardDeadlineMs) return { kind: 'timeout', stdout: lastText };

    let messages: OpenCodeMessage[];
    try {
      messages = await client.listMessages(sessionId);
    } catch (err) {
      return { kind: 'error', stdout: lastText, detail: err instanceof Error ? err.message : String(err) };
    }

    // An assistant message with a non-empty finish is the terminal reply.
    const lastAssistant = [...messages].reverse().find((m) => m.info?.role === 'assistant' && typeof m.info?.finish === 'string' && m.info.finish !== '');
    if (lastAssistant) {
      opts.collector.entries.length = 0;
      for (const msg of messages) for (const part of msg.parts) opts.collector.recordPart(part, Date.now());
      const textParts = lastAssistant.parts.filter((p) => p.type === 'text').map((p) => String(p.text ?? ''));
      lastText = textParts[textParts.length - 1] ?? '';
      return { kind: 'done', stdout: lastText, via: 'message-poll' };
    }

    await sleep(MESSAGE_POLL_INTERVAL_MS);
  }
}

async function abortBestEffort(
  client: OpenCodeClient,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  try {
    await client.abortSession(sessionId);
  } catch (err) {
    // Best-effort cleanup — a failed abort must never fail the phase.
    console.error(`[agent-executor] session abort failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Execute one agent phase: one opencode session, prompt + DONE convention,
 * event-driven completion, session abort on failure/timeout.
 * `manager`/`dockerRunner` are legacy OpenHands params (ADR-0023) kept for
 * call-site compatibility — v11 sessions are pure HTTP, no sidecar process.
 */
export async function executeAgentPhase(
  config: LoopConfig,
  phase: PhaseDef,
  timeoutMs?: number,
  signal?: AbortSignal,
  _manager?: AgentServerManager,
  _dockerRunner?: DockerRunner,
  opts?: AgentPhaseOpts,
): Promise<PhaseResult> {
  const startTime = Date.now();

  // Schema guarantees a prompt at plan load; guard programmatic phases too —
  // an empty prompt would burn a session on nothing.
  if (!phase.prompt || phase.prompt.trim() === '') {
    return makeErrorResult(
      `Agent task "${phase.name}" has no prompt — the prompt is what the agent executes.`,
      0,
    );
  }

  const effectiveTimeout = timeoutMs ?? config.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
  const idleTimeoutMs = config.opencodeServer?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const streamSilentTimeoutMs = config.opencodeServer?.streamSilentTimeoutMs ?? DEFAULT_STREAM_SILENT_TIMEOUT_MS;
  const tailChars = config.opencodeServer?.transcriptTailChars ?? DEFAULT_TRANSCRIPT_TAIL;
  const baseUrl = config.opencodeServer?.url ?? DEFAULT_OPENCODE_SERVER_CONFIG.url;
  const client = createOpenCodeClient(baseUrl);
  const timeoutAc = new AbortController();
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutAc.signal]) : timeoutAc.signal;
  const collector = new TranscriptCollector();

  let sessionId: string | undefined;

  try {
    await client.assertHealthy();
    const session = await client.createSession({
      agent: phase.agent,
      model: resolveModel(phase.model),
      permissionMode: buildPermissionRuleset(config.opencodeServer?.permissionOverrides),
      workspaceID: opts?.workspaceID,
    });
    sessionId = session.id;

    const prompt = buildAgentPrompt(phase.prompt, opts?.worktreeDir ?? process.cwd());
    await client.sendPrompt(sessionId, prompt);

    // Primary: consume the live event stream. If it delivers no first event
    // within streamSilentTimeoutMs (opencode 1.18.19 per-session SSE defect),
    // fall back to polling the stored messages (ADR-0024 D3b) — same
    // reconstruction the live integration test proves.
    let outcome = await collectOutcome(client.streamEvents(sessionId, { signal: effectiveSignal }), {
      hardDeadlineMs: startTime + effectiveTimeout,
      idleTimeoutMs,
      signal: effectiveSignal,
      collector,
      streamSilentTimeoutMs,
    });
    if (outcome.kind === 'silent') {
      outcome = await collectOutcomeByMessagePolling(client, sessionId, {
        hardDeadlineMs: startTime + effectiveTimeout,
        signal: effectiveSignal,
        collector,
      });
    }
    // The message-poll fallback never returns 'silent' — narrow the union so
    // the remaining outcome kinds carry stdout. A residual 'silent' (defensive)
    // is treated as a timeout.
    if (outcome.kind === 'silent') {
      outcome = { kind: 'timeout', stdout: '' };
    }

    const durationMs = Date.now() - startTime;

    // D6.4 post-hoc audit: any denylisted touch in the transcript REJECTS the
    // task regardless of the terminal outcome — the constitution is observed,
    // not just declared. Abort the session since a violation implies the agent
    // acted against the deny ruleset.
    const violations = auditTranscriptEntries(collector.entries);
    if (violations.length > 0) {
      await abortBestEffort(client, sessionId);
      return withTranscript(
        {
          status: 'fail',
          exitCode: 1,
          stdout: outcome.kind === 'aborted' ? '' : outcome.stdout,
          stderr: formatAuditIncidentReport(phase.name, violations),
          durationMs,
          evidencePath: '',
        },
        collector,
        opts,
        tailChars,
        phase.name,
      );
    }

    if (outcome.kind === 'aborted') {
      await abortBestEffort(client, sessionId);
      return withTranscript(makeErrorResult('cancelled', durationMs), collector, opts, tailChars, phase.name);
    }
    if (outcome.kind === 'timeout') {
      await abortBestEffort(client, sessionId);
      return withTranscript(
        {
          status: 'fail',
          exitCode: 1,
          stdout: outcome.stdout,
          stderr: `Agent task "${phase.name}" timed out after ${effectiveTimeout}ms — session aborted, verify will judge.`,
          durationMs,
          evidencePath: '',
        },
        collector,
        opts,
        tailChars,
        phase.name,
      );
    }
    if (outcome.kind === 'error') {
      await abortBestEffort(client, sessionId);
      return withTranscript(
        {
          status: 'fail',
          exitCode: 1,
          stdout: outcome.stdout,
          stderr: `Agent task "${phase.name}" failed: ${outcome.detail}`,
          durationMs,
          evidencePath: '',
        },
        collector,
        opts,
        tailChars,
        phase.name,
      );
    }
    // done (DONE marker | StepFinishPart + idle | stream closed): hand off —
    // the verify phase is the real gate, DONE only signals finished.
    return withTranscript(
      {
        status: 'pass',
        exitCode: 0,
        stdout: outcome.stdout,
        stderr: '',
        durationMs,
        evidencePath: '',
      },
      collector,
      opts,
      tailChars,
      phase.name,
    );
  } catch (err) {
    await abortBestEffort(client, sessionId);
    return withTranscript(
      makeErrorResult(err instanceof Error ? err.message : String(err), Date.now() - startTime),
      collector,
      opts,
      tailChars,
      phase.name,
    );
  }
}

/**
 * Rebuild a transcript from the session's stored messages after a crash.
 * Refetch fallback (ADR-0024 D3b): the event stream is the primary source,
 * the message/part endpoints are the post-crash reconstruction path.
 */
export async function reconstructSessionTranscript(
  client: OpenCodeClient,
  sessionId: string,
  tailChars: number = DEFAULT_TRANSCRIPT_TAIL,
): Promise<{ text: string; jsonl: string }> {
  const messages = await client.listMessages(sessionId);
  const collector = reconstructTranscript(messages);
  return { text: collector.toBoundedText(tailChars), jsonl: collector.toJsonl() };
}

function resolveModel(phaseModel: PhaseDef['model']): OpenCodeSessionModel | undefined {
  if (!phaseModel) return undefined;
  return { id: phaseModel.model, providerID: phaseModel.provider };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}