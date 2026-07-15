/**
 * routes.ts — HTTP/WS route handlers for the daemon.
 *
 * All routes receive a DaemonAPI seam — they never touch Daemon internals.
 */

import type { ServerWebSocket } from 'bun';
import type { DaemonAPI } from './daemon-api.js';
import type { LLMConfig, LLMProvider } from './types.js';
import type { StateMdFrontmatter } from './state.js';
import { computeTaskMetrics, computeBudgetMetrics, computeTriggerMetrics } from './metrics.js';
import { handleDashboardApi } from './dashboard-api.js';
import { join } from 'node:path';
import { VERSION } from './constants.js';

/**
 * Register all HTTP/WS routes on a Bun.serve server config.
 * Returns the fetch handler that the caller passes to Bun.serve().
 */
export function createFetchHandler(api: DaemonAPI): (req: Request) => Response | Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // GET /health
    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - api.startedAt) / 1000),
      });
    }

    // GET /state
    if (url.pathname === '/state' && req.method === 'GET') {
      return Response.json(api.getState());
    }

    // GET /api/version
    if (url.pathname === '/api/version' && req.method === 'GET') {
      return Response.json({ version: VERSION });
    }

    // POST /stop
    if (url.pathname === '/stop' && req.method === 'POST') {
      if (!api.isAuthorized(req)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      setTimeout(() => api.stop(), 50);
      return Response.json({ status: 'ok' });
    }

    // POST /task — enqueue a new task
    if (url.pathname === '/task' && req.method === 'POST') {
      if (!api.isAuthorized(req)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      try {
        const body = await req.json();
        if (!body || typeof body.command !== 'string' || body.command.trim().length === 0) {
          return Response.json({ error: 'command is required' }, { status: 400 });
        }
        if (!api.isSafeCommand(body.command)) {
          return Response.json({ error: 'command rejected: unsafe shell metacharacters' }, { status: 400 });
        }
        const task = api.taskQueue.enqueue(body.command, {
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
          llm: body.llm ?? undefined,
        });
        // Defer processing so the 201 response is sent before the task moves to 'running'
        setTimeout(() => api.maybeProcessQueue(), 0);
        return Response.json({ id: task.id, lifecycle: task.lifecycle }, { status: 201 });
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 });
      }
    }

    // GET /api/history — paginated task history
    if (url.pathname === '/api/history' && req.method === 'GET') {
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      const pageSize = Math.max(1, Math.min(100, parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20));
      const result = await api.listTaskHistory(page, pageSize);
      return Response.json(result);
    }

    // GET /api/tasks/:id — single task detail
    const tasksMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (tasksMatch && req.method === 'GET') {
      const taskId = tasksMatch[1];
      const entry = await api.readTaskHistory(taskId);
      if (!entry) {
        return Response.json({ error: 'task not found' }, { status: 404 });
      }
      return Response.json(entry);
    }

    // POST /loops/:id/start — start a child loop
    const loopsStartMatch = url.pathname.match(/^\/loops\/([^/]+)\/start$/);
    if (loopsStartMatch && req.method === 'POST') {
      if (!api.isAuthorized(req)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const started = await api.orchestrator.startChild(loopsStartMatch[1]);
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
      if (!api.isAuthorized(req)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const stopped = await api.orchestrator.stopChild(loopsStopMatch[1]);
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
      return Response.json(api.orchestrator.listChildren());
    }

    // POST /loops — create a new child loop
    if (url.pathname === '/loops' && req.method === 'POST') {
      if (!api.isAuthorized(req)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      try {
        const body = await req.json();
        if (!body || typeof body.name !== 'string' || typeof body.planPath !== 'string') {
          return Response.json({ error: 'name and planPath are required' }, { status: 400 });
        }
        const id = api.orchestrator.addChild(body);
        return Response.json({ id, status: 'created' }, { status: 201 });
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 });
      }
    }

    // DELETE /loops/:id — remove a child loop
    const loopsDeleteMatch = url.pathname.match(/^\/loops\/([^/]+)$/);
    if (loopsDeleteMatch && req.method === 'DELETE') {
      if (!api.isAuthorized(req)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const removed = api.orchestrator.removeChild(loopsDeleteMatch[1]);
      if (!removed) {
        return Response.json({ error: 'child loop not found' }, { status: 404 });
      }
      return Response.json({ status: 'ok' });
    }

    // GET /loops/:id — single child loop state
    if (loopsDeleteMatch && req.method === 'GET') {
      const child = api.orchestrator.getChildState(loopsDeleteMatch[1]);
      if (!child) {
        return Response.json({ error: 'child loop not found' }, { status: 404 });
      }
      return Response.json(child);
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const upgraded = api.server!.upgrade(req, { data: {} });
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return;
    }

    // Serve dashboard static assets — the SPA's index.html uses `./assets/...`
    // which the browser resolves to `/assets/...` when the page URL has no
    // trailing slash (/dashboard → resolves to /assets/, not /dashboard/assets/).
    if ((url.pathname.startsWith('/dashboard/') || url.pathname.startsWith('/assets/')) && req.method === 'GET') {
      const relativePath = url.pathname.startsWith('/dashboard/')
        ? url.pathname.slice('/dashboard/'.length)
        : url.pathname.slice('/'.length);
      const filePath = join(import.meta.dirname, '..', 'public', 'dashboard', relativePath);
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (exists) {
        return new Response(file);
      }
    }

    // GET /dashboard — serve the SPA
    if (url.pathname === '/dashboard' && req.method === 'GET') {
      if (!api.dashboardHtml) {
        return new Response('Dashboard not available', { status: 404 });
      }
      return new Response(api.dashboardHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // GET /api/metrics — computed task + budget + trigger metrics
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      const window = url.searchParams.get('window') || '1h';
      const lastN = Math.max(1, parseInt(url.searchParams.get('lastN') ?? '100', 10) || 100);
      const taskMetrics = await computeTaskMetrics(api.baseDir, lastN, window);
      const budget = await computeBudgetMetrics(api.baseDir);
      const triggers = computeTriggerMetrics(api.triggerManager.list());
      return Response.json({ taskMetrics, budget, triggers });
    }

    // POST /api/llm — call an LLM provider directly
    if (url.pathname === '/api/llm' && req.method === 'POST') {
      if (!api.isAuthorized(req)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      try {
        const body = await req.json();
        if (!body || typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
          return Response.json({ error: 'prompt is required' }, { status: 400 });
        }
        const config: LLMConfig = {
          provider: (Bun.env.LLM_PROVIDER as LLMProvider) ?? 'openai',
          apiKey: Bun.env.LLM_API_KEY ?? '',
          model: body.model ?? Bun.env.LLM_MODEL ?? 'gpt-4o',
          endpoint: Bun.env.LLM_ENDPOINT || undefined,
          temperature: body.temperature,
        };
        const response = await api.callLLM(config, body.prompt, body.system);
        return Response.json({ response, model: config.model });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    // GET /api/pause — read current pause state
    if (url.pathname === '/api/pause' && req.method === 'GET') {
      const paused = await api.isPaused();
      return Response.json({ paused });
    }

    // POST /api/pause — set pause state
    if (url.pathname === '/api/pause' && req.method === 'POST') {
      if (!api.isAuthorized(req)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      try {
        const body = await req.json();
        if (typeof body.paused !== 'boolean') {
          return Response.json({ error: 'paused must be a boolean' }, { status: 400 });
        }
        const fm: StateMdFrontmatter = {
          last_run: new Date().toISOString(),
          current_state: api.getState().status,
          iteration: 0,
          active_children: 0,
          high_priority: 0,
          watch_items: 0,
          task_count: 0,
          paused: body.paused,
        };
        await api.updateStateMd(fm);
        // If unpausing, kick the queue to resume processing
        if (!body.paused) {
          setTimeout(() => api.maybeProcessQueue(), 0);
        }
        return Response.json({ status: 'ok', paused: body.paused });
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 });
      }
    }

    // Dashboard additive endpoints (design §5). Returns null for non-dashboard
    // routes, so existing handlers above are untouched.
    const dash = await handleDashboardApi(api, url, req, api.tsRing);
    if (dash) return dash;

    return new Response('Not found', { status: 404 });
  };
}
