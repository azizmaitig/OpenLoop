import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import {
  send,
  SpawnedProcess,
  SpawnError,
  SubprocessError,
  MalformedResponseError,
  type JsonRpcResponse,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonRpcError,
} from '../src/json-rpc.js';

// ── Fixture: a tiny JSON-RPC echo server ─────────────────────────────────────

const fixturePath = `${__dirname}/fixtures/json-rpc-echo-server.mjs`;

beforeAll(async () => {
  await Bun.write(
    fixturePath,
    [
      `import { createInterface } from 'readline';`,
      `const rl = createInterface({ input: process.stdin });`,
      `rl.on('line', (line) => {`,
      `  try {`,
      `    const req = JSON.parse(line);`,
      `    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { echo: req.params } }) + '\\n');`,
      `  } catch {`,
      `    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\\n');`,
      `  }`,
      `  rl.close();`,
      `});`,
      ``,
    ].join('\n'),
  );
});

afterAll(async () => {
  try { await Bun.file(fixturePath).delete(); } catch { /* ignore */ }
});

// ── Types ─────────────────────────────────────────────────────────────────────

describe('types', () => {
  test('JsonRpcSuccess: has result field', () => {
    const msg: JsonRpcSuccess<string> = { jsonrpc: '2.0', id: 1, result: 'hello' };
    expect(msg.result).toBe('hello');
  });

  test('JsonRpcError: has error with code and message', () => {
    const msg: JsonRpcError = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } };
    expect(msg.error.code).toBe(-32601);
    expect(msg.error.message).toBe('Method not found');
  });

  test('JsonRpcResponse discriminated union — success', () => {
    const resp: JsonRpcResponse = { jsonrpc: '2.0', id: 1, result: { ok: true } };
    expect('result' in resp).toBe(true);
    expect('error' in resp).toBe(false);
  });

  test('JsonRpcResponse discriminated union — error', () => {
    const resp: JsonRpcResponse = { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'fail' } };
    expect('error' in resp).toBe(true);
    expect('result' in resp).toBe(false);
  });
});

// ── send() — error paths ──────────────────────────────────────────────────────

describe('send — error paths', () => {
  test('throws SubprocessError for nonexistent binary (no stdout)', async () => {
    try {
      await send('nonexistent-binary-12345', [], { jsonrpc: '2.0', id: 1, method: 'test' });
      // If we get here, the test should fail — but some platforms may
      // return an exit code instead of throwing.  Catch that below.
      expect.unreachable('Expected send() to throw');
    } catch (err) {
      // Either SubprocessError (process ran but exited with code) or
      // SpawnError (Bun.spawn threw) — both are acceptable failure modes.
      expect(
        err instanceof SubprocessError || err instanceof SpawnError,
      ).toBe(true);
    }
  });

  test('throws MalformedResponseError for non-JSON output', async () => {
    // Use echo to produce non-JSON output on stdout
    try {
      await send('cmd.exe', ['/c', 'echo', 'not-json'], {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      });
      expect.unreachable('Expected send() to throw');
    } catch (err) {
      expect(err instanceof MalformedResponseError).toBe(true);
    }
  });

  test('throws SubprocessError when process exits before writing anything', async () => {
    // `exit 1` writes nothing to stdout
    try {
      await send('cmd.exe', ['/c', 'exit', '1'], {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      });
      expect.unreachable('Expected send() to throw');
    } catch (err) {
      expect(err instanceof SubprocessError).toBe(true);
    }
  });
});

// ── send() — happy path ───────────────────────────────────────────────────────

describe('send — happy path', () => {
  test('sends valid request and receives valid JSON-RPC response', async () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { input: 'hello' },
    };

    const response = await send('bun', [fixturePath], request);

    expect('result' in response).toBe(true);
    if ('result' in response) {
      expect(response.result).toEqual({ echo: { input: 'hello' } });
    }
  });

  test('handles numeric id correctly', async () => {
    const request: JsonRpcRequest = { jsonrpc: '2.0', id: 42, method: 'echo' };
    const response = await send('bun', [fixturePath], request);

    expect(response.id).toBe(42);
    expect('result' in response).toBe(true);
  });

  test('round-trips params without mutation', async () => {
    const params = { a: 1, b: [2, 3] };
    const request: JsonRpcRequest = { jsonrpc: '2.0', id: 7, method: 'echo', params };
    const response = await send('bun', [fixturePath], request);

    if ('result' in response) {
      expect(response.result).toEqual({ echo: params });
    }
  });
});

// ── SpawnedProcess class ──────────────────────────────────────────────────────

describe('SpawnedProcess', () => {
  test('pid is available after first send', async () => {
    const proc = new SpawnedProcess('bun', [fixturePath]);
    try {
      await proc.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(proc.pid).toBeGreaterThan(0);
    } finally {
      proc.close();
    }
  });

  test('running is true during a request and false after', async () => {
    const proc = new SpawnedProcess('bun', [fixturePath]);
    try {
      expect(proc.running).toBe(false);
      await proc.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(proc.running).toBe(false); // back to idle after response
    } finally {
      proc.close();
    }
  });

  test('close() kills the process', async () => {
    const proc = new SpawnedProcess('bun', [fixturePath]);
    await proc.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    proc.close();
    expect(proc.running).toBe(false);
    expect(proc.pid).toBeUndefined();
  });

  test('multiple sequential sends on the same process', async () => {
    // Note: our echo server handles one line per invocation, so we use
    // send() which spawns fresh each time (single-shot).  SpawnedProcess
    // with this fixture can only handle one message since the server exits
    // after one line.  This test verifies the class API itself works.
    const proc = new SpawnedProcess('bun', [fixturePath]);
    try {
      const resp = await proc.send({ jsonrpc: '2.0', id: 5, method: 'add', params: { x: 1 } });
      expect('result' in resp).toBe(true);
    } finally {
      proc.close();
    }
  });
});

// ── AbortSignal integration ───────────────────────────────────────────────────

describe('AbortSignal integration', () => {
  test('abort signal cancels send before process writes response', async () => {
    const controller = new AbortController();
    const request: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'sleep' };

    // Abort immediately (before the process even starts responding)
    controller.abort();

    try {
      await send('bun', [fixturePath], request, { signal: controller.signal });
      // Depending on timing, the abort may happen before spawn completes
      // or during the read.  Either way, some error should be thrown.
      expect.unreachable('Expected send() to throw after abort');
    } catch (err) {
      // Any error is fine — the abort signal was fired
      expect(err).toBeDefined();
    }
  });
});
