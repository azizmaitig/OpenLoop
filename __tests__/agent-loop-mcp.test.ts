import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';

const MCP_DIR = 'D:\\projects\\obsidian\\second brain\\.opencode\\mcp-servers\\agent-loop-mcp';

let child: ChildProcess;

function sendRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    let buf = '';

    const listener = (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            child?.stdout?.removeListener('data', listener);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
            return;
          }
        } catch {}
      }
    };

    child.stdout!.on('data', listener);
    child.stdin!.write(req);

    setTimeout(() => {
      child?.stdout?.removeListener('data', listener);
      reject(new Error(`Timeout waiting for ${method}`));
    }, 10000);
  });
}

describe('agent-loop-mcp', () => {
  beforeAll(() => {
    child = spawn('npx.cmd', ['-y', 'tsx', 'src/index.ts'], {
      cwd: MCP_DIR,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: true,
    });
  });

  afterAll(() => {
    child?.kill();
  });

  it('should expose all 8 tools', async () => {
    const result = await sendRequest('tools/list') as { tools: { name: string }[] };
    expect(result.tools).toBeDefined();
    const names = result.tools.map(t => t.name).sort();
    expect(names).toEqual([
      'enqueue_task',
      'get_status',
      'get_task',
      'list_history',
      'list_loops',
      'pause_loop',
      'start_loop',
      'stop_loop',
    ]);
  });

  it('get_status should return daemon state', async () => {
    const result = await sendRequest('tools/call', {
      name: 'get_status',
      arguments: {},
    }) as { content: { type: string; text: string }[] };
    const text = result.content?.[0]?.text || '';
    const state = JSON.parse(text);
    expect(state).toHaveProperty('status');
    expect(state).toHaveProperty('uptime');
    expect(state).toHaveProperty('queueLength');
  });

  it('enqueue_task should reject empty command', async () => {
    const result = await sendRequest('tools/call', {
      name: 'enqueue_task',
      arguments: { command: '' },
    }) as { content: { type: string; text: string }[] };
    const text = result.content?.[0]?.text || '';
    expect(text).toContain('error');
  });

  it('list_loops should return array', async () => {
    const result = await sendRequest('tools/call', {
      name: 'list_loops',
      arguments: {},
    }) as { content: { type: string; text: string }[] };
    const text = result.content?.[0]?.text || '';
    const data = JSON.parse(text);
    expect(Array.isArray(data)).toBe(true);
  });
});
