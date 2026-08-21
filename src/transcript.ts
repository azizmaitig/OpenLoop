/**
 * transcript.ts — agent-run transcript collection (v11 T4, ADR-0024 D3b).
 *
 * The executor subscribes to the session event stream during the run and feeds
 * every event into a TranscriptCollector. Tool calls (input + result + error),
 * step transitions, agent text and patch parts are captured as they happen —
 * no systematic refetch. Two views are rendered from the same entries:
 *   - bounded text (ADR-0015 tail cap) for the PhaseResult / LLM-graded verify
 *   - full JSONL for the per-run .agent.jsonl offload
 * After a crash, reconstructTranscript() rebuilds the same views from the
 * session message/part endpoints (the refetch fallback).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OUTPUT_DIR } from './constants.js';
import type { OpenCodeStreamEvent } from './opencode-client.js';

/** ADR-0015 tail cap for the in-memory transcript (mirrors PHASE_OUTPUT_TAIL). */
export const DEFAULT_TRANSCRIPT_TAIL = 2000;

export interface ToolCallEntry {
  kind: 'tool';
  ts: number;
  callID: string;
  tool: string;
  state: 'called' | 'success' | 'failed';
  input?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface TextEntry {
  kind: 'text';
  ts: number;
  text: string;
}

export interface StepEntry {
  kind: 'step';
  ts: number;
  status: 'started' | 'ended' | 'failed';
  finish?: string;
  error?: unknown;
}

export interface PartEntry {
  kind: 'part';
  ts: number;
  part: {
    type: string;
    hash?: string;
    files?: string[];
  };
}

export type TranscriptEntry = ToolCallEntry | TextEntry | StepEntry | PartEntry;

/** Shape of the message list served by GET /session/{id}/message. */
export interface TranscriptMessage {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

const SYNC_PART_UPDATED = 'message.part.updated.1';

function partErrorToString(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return JSON.stringify(error);
}

function stringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Collects agent-run events into an ordered, renderable transcript. */
export class TranscriptCollector {
  readonly entries: TranscriptEntry[] = [];
  private readonly toolsByCallId = new Map<string, ToolCallEntry>();
  private lastText = '';

  private push(entry: TranscriptEntry): void {
    this.entries.push(entry);
  }

  private toolState(callID: string, tool: string, input: unknown, ts: number): ToolCallEntry {
    let entry = this.toolsByCallId.get(callID);
    if (entry) return entry;
    entry = { kind: 'tool', ts, callID, tool, state: 'called', input };
    this.toolsByCallId.set(callID, entry);
    this.push(entry);
    return entry;
  }

  /** Handle one parsed event from the session stream. */
  record(event: OpenCodeStreamEvent): void {
    const data = event.data;
    if (!data) return;
    const type = typeof data.type === 'string' ? data.type : '';
    const ts = Date.now();

    switch (type) {
      case 'session.next.tool.called':
      case 'session.next.tool.progress': {
        const callID = typeof data.callID === 'string' ? data.callID : '';
        const tool = typeof data.tool === 'string' ? data.tool : '';
        this.toolState(callID, tool, data.input, ts);
        break;
      }
      case 'session.next.tool.success': {
        const callID = typeof data.callID === 'string' ? data.callID : '';
        const entry = this.toolsByCallId.get(callID);
        if (entry) {
          entry.state = 'success';
          entry.result = data.result ?? data.content;
        }
        break;
      }
      case 'session.next.tool.failed': {
        const callID = typeof data.callID === 'string' ? data.callID : '';
        const entry = this.toolsByCallId.get(callID);
        if (entry) {
          entry.state = 'failed';
          entry.error = data.error;
        }
        break;
      }
      case 'session.next.text.ended': {
        const text = typeof data.text === 'string' ? data.text : '';
        if (text) {
          this.lastText = text;
          this.push({ kind: 'text', ts, text });
        }
        break;
      }
      case 'session.next.step.started':
        this.push({ kind: 'step', ts, status: 'started' });
        break;
      case 'session.next.step.ended':
        this.push({ kind: 'step', ts, status: 'ended', finish: typeof data.finish === 'string' ? data.finish : undefined });
        break;
      case 'session.next.step.failed':
        this.push({ kind: 'step', ts, status: 'failed', error: data.error });
        break;
      case 'sync':
        this.recordSyncEvent(data, ts);
        break;
    }
  }

  private recordSyncEvent(data: Record<string, unknown>, ts: number): void {
    const syncEvent = data.syncEvent as
      | { type?: string; data?: { part?: Record<string, unknown> } }
      | undefined;
    if (!syncEvent || syncEvent.type !== SYNC_PART_UPDATED) return;
    const part = syncEvent.data?.part;
    if (!part) return;
    this.recordPart(part, ts);
  }

  /** Record a Part payload (from a sync event or a refetched message). */
  recordPart(part: Record<string, unknown>, ts: number): void {
    const type = typeof part.type === 'string' ? part.type : '';
    if (type === 'patch') {
      this.push({
        kind: 'part',
        ts,
        part: {
          type: 'patch',
          hash: typeof part.hash === 'string' ? part.hash : undefined,
          files: Array.isArray(part.files) ? part.files.map(String) : undefined,
        },
      });
      return;
    }
    if (type === 'text') {
      const text = typeof part.text === 'string' ? part.text : '';
      if (text) {
        this.lastText = text;
        this.push({ kind: 'text', ts, text });
      }
      return;
    }
    if (type === 'tool') {
      const callID = typeof part.callID === 'string' ? part.callID : '';
      const tool = typeof part.tool === 'string' ? part.tool : '';
      if (callID && this.toolsByCallId.has(callID)) return; // event stream already captured it
      const state = (part.state ?? {}) as { status?: string; input?: unknown; output?: unknown; error?: unknown };
      const entry = this.toolState(callID, tool, state.input, ts);
      if (state.status === 'completed' || state.status === 'success') {
        entry.state = 'success';
        entry.result = state.output;
      } else if (state.status === 'error' || state.status === 'failed') {
        entry.state = 'failed';
        entry.error = state.error;
      }
      return;
    }
    if (type === 'step-start' || type === 'step-finish') {
      this.push({ kind: 'step', ts, status: type === 'step-start' ? 'started' : 'ended' });
    }
  }

  /** Summary counts for the bounded render header. */
  get counts(): { steps: number; tools: number; failedTools: number; patches: number } {
    let steps = 0;
    let patches = 0;
    for (const entry of this.entries) {
      if (entry.kind === 'step') steps++;
      else if (entry.kind === 'part' && entry.part.type === 'patch') patches++;
    }
    let failedTools = 0;
    for (const entry of this.toolsByCallId.values()) {
      if (entry.state === 'failed') failedTools++;
    }
    return { steps, tools: this.toolsByCallId.size, failedTools, patches };
  }

  /** Bounded human-readable transcript (ADR-0015 tail semantics). */
  toBoundedText(tailChars: number = DEFAULT_TRANSCRIPT_TAIL): string {
    const counts = this.counts;
    const header = [
      `steps=${counts.steps} tools=${counts.tools} failedTools=${counts.failedTools} patches=${counts.patches}`,
      this.lastText ? `last-agent-message: ${this.lastText}` : '',
    ].filter(Boolean).join('\n');

    const detailLines: string[] = [];
    for (const entry of this.entries) {
      if (entry.kind === 'tool') {
        const input = truncate(stringify(entry.input), TOOL_INPUT_CAP);
        if (entry.state === 'failed') {
          detailLines.push(`tool:${entry.tool} ${entry.callID} input=${input} → FAILED: ${truncate(partErrorToString(entry.error), TOOL_RESULT_CAP)}`);
        } else if (entry.state === 'success') {
          detailLines.push(`tool:${entry.tool} ${entry.callID} input=${input} → ok: ${truncate(stringify(entry.result), TOOL_RESULT_CAP)}`);
        } else {
          detailLines.push(`tool:${entry.tool} ${entry.callID} input=${input} → running`);
        }
      } else if (entry.kind === 'part' && entry.part.type === 'patch') {
        const files = entry.part.files ? `[${entry.part.files.join(', ')}]` : '';
        detailLines.push(`patch:${entry.part.hash ?? ''} files=${files}`);
      }
    }
    const details = detailLines.join('\n');

    const total = header.length + (details ? 1 + details.length : 0);
    if (total <= tailChars) return total === 0 ? header : `${header}\n${details}`;

    const remaining = tailChars - header.length;
    if (remaining <= 0) return header.slice(0, Math.max(0, tailChars));

    const marker = `... (${detailLines.length} detail entries truncated)`;
    const budget = remaining - (marker.length + 2);
    if (budget <= 0) return `${header}\n${marker}`.slice(0, tailChars);

    return `${header}\n${marker}\n${details.slice(-budget)}`;
  }

  /** Full transcript as JSONL — one JSON object per line, arrival order. */
  toJsonl(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join('\n');
  }
}

/** Rebuild a collector from refetched session messages (post-crash recovery). */
export function reconstructTranscript(messages: TranscriptMessage[]): TranscriptCollector {
  const collector = new TranscriptCollector();
  for (const message of messages) {
    for (const part of message.parts) {
      collector.recordPart(part, Date.now());
    }
  }
  return collector;
}

function slugify(text: string): string {
  return text.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Per-entry caps so one giant tool result (e.g. a recursive ls over hundreds
 * of files) cannot monopolize the bounded-transcript budget and push the
 * structural `tool:`/`patch:` markers out of the tail window.
 */
const TOOL_INPUT_CAP = 200;
const TOOL_RESULT_CAP = 600;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

/**
 * Write the full transcript to `_agent-loop-output/runs/<runName>/<iteration>-<phaseName>.agent.jsonl`
 * (ADR-0015 offload pattern) and return the absolute path.
 */
export function writeTranscriptJsonl(
  collector: TranscriptCollector,
  runName: string,
  iteration: number,
  phaseName: string,
  outputDir?: string,
): string {
  const baseDir = outputDir ?? OUTPUT_DIR;
  const runsDir = resolve(baseDir, 'runs', slugify(runName));
  mkdirSync(runsDir, { recursive: true });
  const path = resolve(runsDir, `${iteration}-${slugify(phaseName)}.agent.jsonl`);
  writeFileSync(path, collector.toJsonl(), 'utf-8');
  return path;
}