/**
 * agent-server-client.ts — minimal REST client for the Agent Server conversation API.
 *
 * Contract verified against the REAL OpenHands Agent Server (smoke test, 2026-08-18):
 *   POST   /api/conversations                       → create ({ workspace, agent.llm, initial_message })
 *   POST   /api/conversations/{id}/events           → send a message ({ role, content: [TextContent] })
 *   GET    /api/conversations/{id}                  → poll (execution_status + events)
 *   GET    /api/conversations/{id}/agent_final_response → final agent text (stdout source)
 *   DELETE /api/conversations/{id}                  → cleanup
 *   GET    /health                                  → health (NOT /api/health)
 *
 * Event variants are a discriminated union server-side (research doc: clients must
 * skip unknown variants) — the client passes events through opaquely and lets the
 * executor pick what it needs.
 */

import type { AgentTaskModel } from './types.js';

/** Conversation lifecycle statuses from the Agent Server. */
export type AgentConversationStatus =
  | 'running'
  | 'idle'
  | 'finished'
  | 'failed'
  | 'aborted'
  | 'stopped'
  | 'error';

/** One conversation event. Unknown variants are passed through untouched. */
export interface AgentEvent {
  type: string;
  source?: string;
  content?: string;
}

export interface AgentConversation {
  id: string;
  status: AgentConversationStatus;
  events: AgentEvent[];
}

/** LLM config handed to the server's agent.llm (LiteLLM-backed). */
export interface AgentLlmConfig {
  /** "provider/model" string the server's LiteLLM resolves. */
  model?: string;
  /** OpenAI-compatible base URL (e.g. the opencode compat shim). */
  baseUrl?: string;
  /** API key — LiteLLM requires a non-empty value even for keyless gateways. */
  apiKey?: string;
}

export interface CreateConversationParams {
  /** Directory the agent acts in: loop cwd for local, /workspace for docker. */
  workingDir: string;
  /** Initial user message — carries the denylist instruction + task prompt. */
  prompt: string;
  /** LLM config (per-task model override merged with agentServer.defaults). */
  llm?: AgentLlmConfig;
}

export interface AgentServerClient {
  createConversation(params: CreateConversationParams): Promise<AgentConversation>;
  getConversation(conversationId: string): Promise<AgentConversation>;
  getAgentFinalResponse(conversationId: string): Promise<string>;
  deleteConversation(conversationId: string): Promise<void>;
  checkHealth(): Promise<boolean>;
}

/** Cap on error-body snippets attached to non-2xx failures. */
const ERROR_BODY_SNIPPET_MAX = 200;

/** How long a health probe waits before the backend counts as unhealthy. */
const HEALTH_CHECK_TIMEOUT_MS = 2000;

export function createAgentServerClient(
  baseUrl: string,
  signal?: AbortSignal,
): AgentServerClient {
  const conversationUrl = (id?: string): string =>
    `${baseUrl}/api/conversations${id ? `/${encodeURIComponent(id)}` : ''}`;

  async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      throw new Error(`Agent Server request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Agent Server ${method} ${url} failed (${res.status}): ${text.slice(0, ERROR_BODY_SNIPPET_MAX)}`);
    }
    return (await res.json()) as T;
  }

  return {
    async createConversation(params) {
      const body: Record<string, unknown> = {
        workspace: { working_dir: params.workingDir },
        initial_message: {
          role: 'user',
          content: [{ type: 'text', text: params.prompt }],
        },
      };
      if (params.llm && (params.llm.model || params.llm.baseUrl || params.llm.apiKey)) {
        // The server's LLM model is snake_case (pydantic) — camelCase keys are
        // silently ignored, which would drop the endpoint config entirely.
        body.agent = {
          llm: {
            ...(params.llm.model ? { model: params.llm.model } : {}),
            ...(params.llm.baseUrl ? { base_url: params.llm.baseUrl } : {}),
            ...(params.llm.apiKey ? { api_key: params.llm.apiKey } : {}),
          },
          // The server defaults to ONLY FinishTool + ThinkTool — an agent
          // without file/command tools cannot do real work (verified against
          // the live server, 2026-08-19: "Loaded 0 tools from spec"). The SDK
          // docs' standard set: TerminalTool + FileEditorTool + TaskTrackerTool.
          tools: [
            { name: 'TerminalTool', params: { working_dir: params.workingDir } },
            { name: 'FileEditorTool', params: { working_dir: params.workingDir } },
            { name: 'TaskTrackerTool', params: { working_dir: params.workingDir } },
          ],
        };
      }
      const res = await request<{
        id: string;
        execution_status?: AgentConversationStatus;
        status?: AgentConversationStatus;
        events?: AgentEvent[];
      }>('POST', conversationUrl(), body);
      return {
        id: res.id,
        status: res.execution_status ?? res.status ?? 'running',
        events: res.events ?? [],
      };
    },
    async getConversation(conversationId) {
      const res = await request<{
        id: string;
        execution_status?: AgentConversationStatus;
        status?: AgentConversationStatus;
        events?: AgentEvent[];
      }>('GET', conversationUrl(conversationId));
      return {
        id: res.id,
        status: res.execution_status ?? res.status ?? 'running',
        events: res.events ?? [],
      };
    },
    async getAgentFinalResponse(conversationId) {
      const res = await request<{ response?: string }>(
        'GET',
        `${conversationUrl(conversationId)}/agent_final_response`,
      );
      return res.response ?? '';
    },
    async deleteConversation(conversationId) {
      await request<{ ok: boolean }>('DELETE', conversationUrl(conversationId));
    },
    async checkHealth() {
      try {
        const res = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}