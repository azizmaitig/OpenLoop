/**
 * agent-server-client.ts — minimal REST client for the Agent Server conversation API.
 *
 * T2 contract (stub-defined, refined against the real OpenHands Agent Server in T3):
 *   POST   /api/conversations                → create ({ model?, workspaceType? }) → conversation
 *   POST   /api/conversations/{id}/events    → send a message ({ content })
 *   GET    /api/conversations/{id}           → poll (status + events)
 *   DELETE /api/conversations/{id}           → cleanup
 *
 * Event variants are a discriminated union server-side (research doc: clients must
 * skip unknown variants) — the client passes events through opaquely and lets the
 * executor pick what it needs.
 */

import type { AgentTaskModel, AgentTaskWorkspace } from './types.js';

/** Conversation lifecycle statuses from the Agent Server. */
export type AgentConversationStatus =
  | 'running'
  | 'idle'
  | 'finished'
  | 'failed'
  | 'aborted'
  | 'stopped';

/** One conversation event. Unknown variants are passed through untouched. */
export interface AgentEvent {
  type: string;
  source?: string;
  content?: string;
  timestamp?: number;
}

export interface AgentConversation {
  id: string;
  status: AgentConversationStatus;
  events: AgentEvent[];
}

export interface CreateConversationParams {
  /** Per-task model override (ADR-0023 decision 6). */
  model?: AgentTaskModel;
  /** Workspace kind: local (default) | docker (ADR-0023 decision 5). */
  workspaceType?: AgentTaskWorkspace['type'];
}

export interface AgentServerClient {
  createConversation(params?: CreateConversationParams): Promise<AgentConversation>;
  sendMessage(conversationId: string, message: string): Promise<void>;
  getConversation(conversationId: string): Promise<AgentConversation>;
  deleteConversation(conversationId: string): Promise<void>;
}

export function createAgentServerClient(baseUrl: string): AgentServerClient {
  const conversationUrl = (id?: string): string =>
    `${baseUrl}/api/conversations${id ? `/${encodeURIComponent(id)}` : ''}`;

  async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(`Agent Server request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Agent Server ${method} ${url} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  return {
    createConversation(params) {
      return request<AgentConversation>('POST', conversationUrl(), params);
    },
    async sendMessage(conversationId, message) {
      await request<{ ok: boolean }>('POST', `${conversationUrl(conversationId)}/events`, {
        content: message,
      });
    },
    getConversation(conversationId) {
      return request<AgentConversation>('GET', conversationUrl(conversationId));
    },
    async deleteConversation(conversationId) {
      await request<{ ok: boolean }>('DELETE', conversationUrl(conversationId));
    },
  };
}