import type { ServerWebSocket } from 'bun';
import type { Task, DaemonStatus, ChildLoopDef, ChildLoopState, ChildLoopSummary, StartChildResult, StopChildResult } from './types.js';

// ── Handler interface ──────────────────────────────────────────────────────────

export interface HttpServerHandlers {
  getState: () => DaemonStatus & { queueLength: number; currentTask: Task | null };
  stopDaemon: () => void;
  enqueueTask: (command: string, timeoutMs?: number, llm?: string) => Task;
  /** Called by the HTTP server after a task is successfully enqueued via POST /task */
  onTaskEnqueued?: () => void;
  listChildren: () => ChildLoopSummary[];
  startChild: (id: string) => Promise<StartChildResult>;
  stopChild: (id: string) => Promise<StopChildResult>;
  addChild: (def: ChildLoopDef) => string;
  removeChild: (id: string) => boolean;
  getChildState: (id: string) => ChildLoopState | undefined;
  listTaskHistory: (baseDir: string, page: number, pageSize: number) => Promise<{ tasks: unknown[]; total: number; page: number; pageSize: number }>;
  readTaskHistory: (baseDir: string, id: string) => Promise<unknown>;
  baseDir: string;
}

export interface HttpServerInstance {
  readonly port: number;
  stop: () => void;
  broadcast: (type: string, data: unknown) => void;
}

// ── Safe command check ─────────────────────────────────────────────────────────

const SHELL_METACHARS = /[;&|`$\n\r]/;

function isSafeCommand(cmd: string): boolean {
  return !SHELL_METACHARS.test(cmd);
}

// ── Auth ───────────────────────────────────────────────────────────────────────

function isAuthorized(req: Request): boolean {
  const apiKey = process.env.LOOP_API_KEY;
  if (!apiKey) return true; // No key configured = open access
  const auth = req.headers.get('Authorization');
  return auth === `Bearer ${apiKey}`;
}

// ── Server factory ─────────────────────────────────────────────────────────────

export function startHttpServer(
  port: number,
  handlers: HttpServerHandlers,
  dashboardHtml?: string,
): HttpServerInstance {
  const wsClients = new Set<ServerWebSocket<unknown>>();

  function broadcast(type: string, data: unknown): void {
    const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    for (const ws of wsClients) {
      try { ws.send(message); } catch { wsClients.delete(ws); }
    }
  }

  const server = Bun.serve({
    port,
    websocket: {
      open: (ws) => {
        wsClients.add(ws);
        ws.send(JSON.stringify({
          type: 'state_change',
          data: { ...handlers.getState(), children: handlers.listChildren() },
          timestamp: new Date().toISOString(),
        }));
      },
      close: (ws) => {
        wsClients.delete(ws);
      },
      message: () => {},
    },
    fetch: async (req) => {
      const url = new URL(req.url);

      // GET /health
      if (url.pathname === '/health' && req.method === 'GET') {
        const state = handlers.getState();
        return Response.json({ status: 'ok', uptime: state.uptime });
      }

      // GET /state
      if (url.pathname === '/state' && req.method === 'GET') {
        return Response.json(handlers.getState());
      }

      // GET /api/version
      if (url.pathname === '/api/version' && req.method === 'GET') {
        return Response.json({ version: '0.6.0' });
      }

      // POST /stop
      if (url.pathname === '/stop' && req.method === 'POST') {
        if (!isAuthorized(req)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        setTimeout(() => handlers.stopDaemon(), 50);
        return Response.json({ status: 'ok' });
      }

      // POST /task — enqueue a new task
      if (url.pathname === '/task' && req.method === 'POST') {
        if (!isAuthorized(req)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        try {
          const body = await req.json();
          if (!body || typeof body.command !== 'string' || body.command.trim().length === 0) {
            return Response.json({ error: 'command is required' }, { status: 400 });
          }
          if (!isSafeCommand(body.command)) {
            return Response.json({ error: 'command rejected: unsafe shell metacharacters' }, { status: 400 });
          }
          const task = handlers.enqueueTask(body.command, body.timeoutMs, body.llm);
          // Defer processing so the 201 response is sent before the task moves to 'running'
          setTimeout(() => handlers.onTaskEnqueued?.(), 0);
          return Response.json({ id: task.id, status: task.status }, { status: 201 });
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 });
        }
      }

      // GET /api/history — paginated task history
      if (url.pathname === '/api/history' && req.method === 'GET') {
        const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        const pageSize = Math.max(1, Math.min(100, parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20));
        const result = await handlers.listTaskHistory(handlers.baseDir, page, pageSize);
        return Response.json(result);
      }

      // GET /api/tasks/:id — single task detail
      const tasksMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (tasksMatch && req.method === 'GET') {
        const taskId = tasksMatch[1];
        const entry = await handlers.readTaskHistory(handlers.baseDir, taskId);
        if (!entry) {
          return Response.json({ error: 'task not found' }, { status: 404 });
        }
        return Response.json(entry);
      }

      // POST /loops/:id/start — start a child loop
      const loopsStartMatch = url.pathname.match(/^\/loops\/([^/]+)\/start$/);
      if (loopsStartMatch && req.method === 'POST') {
        if (!isAuthorized(req)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        const started = await handlers.startChild(loopsStartMatch[1]);
        if (started === 'not_found') {
          return Response.json({ error: 'child loop not found' }, { status: 404 });
        }
        if (started === 'already_running') {
          return Response.json({ error: 'child loop already running' }, { status: 409 });
        }
        return Response.json({ status: 'ok' });
      }

      // POST /loops/:id/stop — stop a child loop
      const loopsStopMatch = url.pathname.match(/^\/loops\/([^/]+)\/stop$/);
      if (loopsStopMatch && req.method === 'POST') {
        if (!isAuthorized(req)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        const stopped = await handlers.stopChild(loopsStopMatch[1]);
        if (stopped === 'not_found') {
          return Response.json({ error: 'child loop not found' }, { status: 404 });
        }
        if (stopped === 'not_running') {
          return Response.json({ error: 'child loop is not running' }, { status: 409 });
        }
        return Response.json({ status: 'ok' });
      }

      // GET /loops — list all child loops
      if (url.pathname === '/loops' && req.method === 'GET') {
        return Response.json(handlers.listChildren());
      }

      // POST /loops — create a new child loop
      if (url.pathname === '/loops' && req.method === 'POST') {
        if (!isAuthorized(req)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        try {
          const body = await req.json();
          if (!body || typeof body.name !== 'string' || typeof body.planPath !== 'string') {
            return Response.json({ error: 'name and planPath are required' }, { status: 400 });
          }
          const id = handlers.addChild(body);
          return Response.json({ id, status: 'created' }, { status: 201 });
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 });
        }
      }

      // DELETE /loops/:id — remove a child loop
      const loopsDeleteMatch = url.pathname.match(/^\/loops\/([^/]+)$/);
      if (loopsDeleteMatch && req.method === 'DELETE') {
        if (!isAuthorized(req)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        const removed = handlers.removeChild(loopsDeleteMatch[1]);
        if (!removed) {
          return Response.json({ error: 'child loop not found' }, { status: 404 });
        }
        return Response.json({ status: 'ok' });
      }

      // GET /loops/:id — single child loop state
      if (loopsDeleteMatch && req.method === 'GET') {
        const child = handlers.getChildState(loopsDeleteMatch[1]);
        if (!child) {
          return Response.json({ error: 'child loop not found' }, { status: 404 });
        }
        return Response.json(child);
      }

      // WebSocket upgrade
      if (url.pathname === '/ws') {
        const upgraded = server.upgrade(req, { data: {} });
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
        return;
      }

      // GET /dashboard — serve the SPA
      if (url.pathname === '/dashboard' && req.method === 'GET') {
        if (!dashboardHtml) {
          return new Response('Dashboard not available', { status: 404 });
        }
        return new Response(dashboardHtml, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      return new Response('Not found', { status: 404 });
    },
  });

  return {
    port: server.port!,
    stop: () => { server.stop(true); },
    broadcast,
  };
}
