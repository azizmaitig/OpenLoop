/**
 * JSON‑RPC 2.0 stdio transport module.
 *
 * Provides a low‑level JSON‑RPC 2.0 transport over subprocess stdin/stdout.
 * Exports a reusable {@link SpawnedProcess} class and a standalone
 * {@link send} function for one‑shot calls.
 *
 * @module json-rpc
 */

import type { Subprocess } from 'bun';

// ── Types ────────────────────────────────────────────────────────────────────

/** A JSON‑RPC 2.0 request object. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

/** A successful JSON‑RPC 2.0 response. */
export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result: T;
}

/** The error body inside a JSON‑RPC error response. */
export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** An error JSON‑RPC 2.0 response. */
export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: JsonRpcErrorBody;
}

/** Discriminated union of possible JSON‑RPC 2.0 responses. */
export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

// ── Custom Errors ────────────────────────────────────────────────────────────

/**
 * Thrown when the subprocess cannot be spawned (binary not found, permission
 * denied, etc.).
 */
export class SpawnError extends Error {
  constructor(cmd: string) {
    super(`Failed to spawn process: ${cmd}`);
    this.name = 'SpawnError';
  }
}

/**
 * Thrown when the subprocess exits with a non‑zero exit code without producing
 * a parseable JSON‑RPC response.
 */
export class SubprocessError extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, stderr: string) {
    super(`Subprocess exited with code ${exitCode}: ${stderr.slice(0, 200)}`);
    this.name = 'SubprocessError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Thrown when stdout contains data but is not valid JSON‑RPC (either not valid
 * JSON or missing `result`/`error` fields).
 */
export class MalformedResponseError extends Error {
  readonly raw: string;

  constructor(raw: string) {
    super(`Malformed JSON‑RPC response (${raw.length} bytes)`);
    this.name = 'MalformedResponseError';
    this.raw = raw;
  }
}

// ── Internal helpers (not exported) ─────────────────────────────────────────

/**
 * Spawn the subprocess with piped stdio.
 */
async function buildTransport(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Subprocess> {
  let proc: Subprocess;
  try {
    proc = Bun.spawn([cmd, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    });
  } catch (err) {
    throw new SpawnError(cmd);
  }
  if (!proc.pid) throw new SpawnError(cmd);
  return proc;
}

/**
 * Serialise a JSON‑RPC request and write it to the subprocess stdin.
 */
async function writeRequest(proc: Subprocess, request: JsonRpcRequest): Promise<void> {
  proc.stdin.write(JSON.stringify(request));
  proc.stdin.end();
}

/**
 * Collect the full stdout and stderr streams, then wait for the subprocess to
 * exit.  Stream reads may fail when the process is killed by an abort signal —
 * those are caught and ignored.
 */
async function readResponse(
  proc: Subprocess,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = '';
  let stderr = '';
  try {
    [stdout, stderr] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
    ]);
  } catch {
    // Stream read may fail after process is killed by abort signal
  }
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Parse a JSON‑RPC response from the raw stdout text.
 *
 * - If stdout is empty (or whitespace‑only) AND exitCode !== 0 → SubprocessError
 * - If stdout is valid JSON with `result` or `error` fields → returns the parsed response
 * - If stdout is valid JSON but no JSON‑RPC fields → MalformedResponseError
 * - If stdout is not valid JSON → MalformedResponseError
 *
 * @throws {SubprocessError} when the process failed without producing output
 * @throws {MalformedResponseError} when the output is not valid JSON‑RPC
 */
function parseResponse<T>(
  stdout: string,
  stderr: string,
  exitCode: number,
): JsonRpcResponse<T> {
  // No output at all → treat as a process failure
  if (!stdout.trim()) {
    throw new SubprocessError(exitCode, stderr || `Process exited with code ${exitCode}`);
  }

  try {
    const parsed = JSON.parse(stdout) as JsonRpcResponse<T>;
    if ('result' in parsed || 'error' in parsed) {
      return parsed;
    }
    // Parsed as JSON but doesn't look like JSON‑RPC
    throw new MalformedResponseError(stdout);
  } catch (err) {
    if (err instanceof MalformedResponseError || err instanceof SubprocessError) throw err;
    if (err instanceof SyntaxError) {
      throw new MalformedResponseError(stdout);
    }
    throw err;
  }
}

// ── SpawnedProcess (reusable, sequential sends) ─────────────────────────────

/**
 * A reusable JSON‑RPC 2.0 subprocess client.
 *
 * The subprocess is lazily spawned on the first {@link send} call and stays
 * alive for subsequent requests.  Only one request at a time is supported
 * (sequential send).
 *
 * @example
 * ```ts
 * const proc = new SpawnedProcess('my-mcp-server');
 * const resp = await proc.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
 * proc.close();
 * ```
 */
export class SpawnedProcess {
  private _proc: Subprocess | null = null;
  private _cmd: string;
  private _args: string[];
  private _running = false;

  constructor(cmd: string, args: string[] = [], _opts?: Record<string, unknown>) {
    this._cmd = cmd;
    this._args = args;
  }

  /** The subprocess PID, or `undefined` when not yet started. */
  get pid(): number | undefined {
    return this._proc?.pid;
  }

  /** Whether the subprocess is currently alive and handling a request. */
  get running(): boolean {
    return this._running;
  }

  /**
   * Send a JSON‑RPC request and await the response.
   *
   * Lazily spawns the subprocess on the first call.  Only one in‑flight
   * request at a time — calling `send` again before the previous one
   * resolves is unsupported.
   *
   * @param request  The JSON‑RPC 2.0 request object
   * @param opts     Optional `AbortSignal` for timeout / cancellation
   * @returns The JSON‑RPC 2.0 response (success or error)
   */
  async send<T = unknown>(
    request: JsonRpcRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<JsonRpcResponse<T>> {
    // Lazy-spawn on first send
    if (!this._proc) {
      this._proc = await buildTransport(this._cmd, this._args, opts?.signal);
      this._running = true;
    }

    await writeRequest(this._proc, request);
    const { stdout, stderr, exitCode } = await readResponse(this._proc);
    this._running = false;

    return parseResponse<T>(stdout, stderr, exitCode);
  }

  /**
   * Close the subprocess (kill if still running, release resources).
   */
  close(): void {
    this.kill();
    this._proc = null;
  }

  /**
   * Kill the subprocess immediately.
   */
  kill(): void {
    if (this._proc) {
      try {
        this._proc.kill();
      } catch {
        // Already dead
      }
    }
    this._running = false;
  }
}

// ── Standalone one‑shot function ─────────────────────────────────────────────

/**
 * One‑shot JSON‑RPC call: spawn a subprocess, send one request, read the
 * response, then clean up.
 *
 * @param cmd     Binary path
 * @param args    Command‑line arguments
 * @param request JSON‑RPC 2.0 request
 * @param opts    Optional `AbortSignal` for timeout / cancellation
 * @returns The JSON‑RPC 2.0 response
 */
export async function send<T = unknown>(
  cmd: string,
  args: string[],
  request: JsonRpcRequest,
  opts?: { signal?: AbortSignal },
): Promise<JsonRpcResponse<T>> {
  const proc = new SpawnedProcess(cmd, args);
  try {
    return await proc.send<T>(request, opts);
  } finally {
    proc.close();
  }
}
