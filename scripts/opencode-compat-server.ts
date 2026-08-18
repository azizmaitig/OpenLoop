/**
 * opencode-compat-server.ts — OpenAI-compatible shim over `opencode serve`.
 *
 * Bridges the gap between the OpenHands agent-server (LiteLLM, OpenAI-compatible
 * chat completions) and opencode's native server API — opencode v1.18.x has NO
 * /chat/completions route, so the agent-server cannot call it directly.
 *
 * Translates POST /chat/completions → opencode session flow:
 *   create session → send message (system + role-marked transcript) → wait
 *   → map { info, parts } back to an OpenAI chat completion response.
 *
 * Run:    bun scripts/opencode-compat-server.ts [--port 4097]
 * Env:    OPENCODE_SERVER_URL (default http://127.0.0.1:4096)
 *         OPENCODE_SHIM_MODEL (default openai/deepseek-v4-flash-free)
 *
 * The default model mirrors the LiteLLM prefix the agent-server sends
 * (`openai/...` for OpenAI-compatible endpoints); opencode serve resolves
 * the actual model by its id.
 *
 * Auth is ignored (the shim is loopback; opencode serve handles its own auth).
 * streaming is not supported — the agent-server uses non-stream completions.
 */

function parsePort(argv: string[]): number {
  const eq = argv.find((a) => a.startsWith('--port='));
  if (eq) return Number(eq.split('=')[1]);
  const idx = argv.indexOf('--port');
  if (idx !== -1 && argv[idx + 1] !== undefined) return Number(argv[idx + 1]);
  return 4097;
}

const PORT = parsePort(process.argv);
const OPCODE_URL = process.env.OPENCODE_SERVER_URL ?? 'http://127.0.0.1:4096';
const SHIM_MODEL = process.env.OPENCODE_SHIM_MODEL ?? 'openai/deepseek-v4-flash-free';

interface ChatMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

interface OpenCodeSession {
  id: string;
}

interface OpenCodeMessageResult {
  info: {
    tokens?: { input?: number; output?: number; reasoning?: number };
    cost?: number;
    finish?: string;
    error?: { name?: string; data?: { message?: string } };
  };
  parts: Array<{ type: string; text?: string; ignored?: boolean }>;
}

function resolveModel(requested: string): { providerID: string; modelID: string } {
  const m = requested ?? '';
  if (m.includes('/')) {
    const [providerID, modelID] = m.split('/');
    return { providerID, modelID };
  }
  const [providerID, modelID] = SHIM_MODEL.split('/');
  return { providerID, modelID: m || modelID };
}

function messageText(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return (msg.content ?? [])
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n');
}

async function oc(path: string, body?: unknown, init: RequestInit = {}): Promise<unknown> {
  const method = init.method ?? (body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`${OPCODE_URL}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: init.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`opencode ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function chatCompletion(request: {
  model?: string;
  messages?: ChatMessage[];
}): Promise<unknown> {
  const messages = request.messages ?? [];
  if (messages.length === 0) {
    throw new Error('no messages in request');
  }
  const model = resolveModel(request.model ?? SHIM_MODEL);
  const system = messages
    .filter((m) => m.role === 'system')
    .map(messageText)
    .join('\n\n');
  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `[${m.role.toUpperCase()}]\n${messageText(m)}`)
    .join('\n\n');

  const session = (await oc('/session', { title: 'chat-completion' })) as OpenCodeSession;
  try {
    const result = (await oc(`/session/${session.id}/message`, {
      model,
      ...(system ? { system } : {}),
      parts: [{ type: 'text', text: transcript }],
    })) as OpenCodeMessageResult;

    if (result.info.error) {
      const err = result.info.error;
      throw new Error(`${err.name ?? 'error'}: ${err.data?.message ?? 'unknown'}`);
    }

    const text = result.parts
      .filter((p) => p.type === 'text' && !p.ignored && p.text)
      .map((p) => p.text)
      .join('\n');

    return {
      id: `chatcmpl-${session.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model ?? SHIM_MODEL,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: result.info.finish ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: result.info.tokens?.input ?? 0,
        completion_tokens: result.info.tokens?.output ?? 0,
        total_tokens:
          (result.info.tokens?.input ?? 0) + (result.info.tokens?.output ?? 0),
      },
    };
  } finally {
    try {
      await oc(`/session/${session.id}`, undefined, { method: 'DELETE' });
    } catch {
      // best-effort cleanup — a missed delete must never fail the completion
    }
  }
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }
      if (req.method === 'GET' && url.pathname === '/models') {
        const [providerID, modelID] = SHIM_MODEL.split('/');
        return Response.json({
          object: 'list',
          data: [{ id: modelID, object: 'model', owned_by: providerID }],
        });
      }
      if (req.method === 'POST' && url.pathname === '/chat/completions') {
        const body = (await req.json()) as { stream?: boolean } & Parameters<typeof chatCompletion>[0];
        if (body.stream) {
          return Response.json({ error: { message: 'streaming is not supported by the opencode compat shim' } }, { status: 400 });
        }
        const result = await chatCompletion(body);
        return Response.json(result);
      }
      return Response.json({ error: { message: `not found: ${req.method} ${url.pathname}` } }, { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[opencode-compat] ${req.method} ${url.pathname} failed: ${msg}`);
      return Response.json({ error: { message: msg } }, { status: 502 });
    }
  },
});

console.log(`[opencode-compat] listening on http://127.0.0.1:${PORT} -> opencode serve ${OPCODE_URL} (model ${SHIM_MODEL})`);