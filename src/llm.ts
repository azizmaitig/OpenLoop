import type { LLMConfig } from './types.js';

/**
 * Call an LLM provider via raw fetch. No SDK dependencies.
 *
 * Supports OpenAI and Anthropic. Uses config.endpoint as the base URL
 * when set (for local/self-hosted models like Ollama).
 *
 * @throws if the API returns a non-2xx status, or the response is
 *   unparseable, or the content is empty.
 */
export async function callLLM(
  config: LLMConfig,
  prompt: string,
  system?: string,
): Promise<string> {
  const baseUrl = config.endpoint?.replace(/\/+$/, '') ?? '';
  const maxTokens = config.maxTokens ?? 1024;

  if (config.provider === 'openai') {
    return callOpenAI(config, baseUrl, prompt, system, maxTokens);
  }

  if (config.provider === 'anthropic') {
    return callAnthropic(config, baseUrl, prompt, system, maxTokens);
  }

  if (config.provider === 'opencode') {
    return callOpenCode(prompt, config.opencodeAgent);
  }

  throw new Error(`Unknown LLM provider: ${config.provider satisfies never}`);
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

async function callOpenAI(
  config: LLMConfig,
  baseUrl: string,
  prompt: string,
  system: string | undefined,
  maxTokens: number,
): Promise<string> {
  const url = baseUrl
    ? `${baseUrl}/v1/chat/completions`
    : 'https://api.openai.com/v1/chat/completions';

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      { role: 'user' as const, content: prompt },
    ],
    max_tokens: maxTokens,
  };
  if (config.temperature !== undefined) body.temperature = config.temperature;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const snippet = await safeBodySnippet(res);
    throw new Error(
      `OpenAI API error (${res.status}): ${snippet}`,
    );
  }

  const data: unknown = await res.json();
  const text = extractContent(data, 'choices[0].message.content');
  return text;
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function callAnthropic(
  config: LLMConfig,
  baseUrl: string,
  prompt: string,
  system: string | undefined,
  maxTokens: number,
): Promise<string> {
  const url = baseUrl
    ? `${baseUrl}/v1/messages`
    : 'https://api.anthropic.com/v1/messages';

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    messages: [{ role: 'user' as const, content: prompt }],
  };
  if (system) body.system = system;
  if (config.temperature !== undefined) body.temperature = config.temperature;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const snippet = await safeBodySnippet(res);
    throw new Error(
      `Anthropic API error (${res.status}): ${snippet}`,
    );
  }

  const data: unknown = await res.json();
  const text = extractContent(data, 'content[0].text');
  return text;
}

// ── opencode ────────────────────────────────────────────────────────────────

async function callOpenCode(
  prompt: string,
  agent?: string,
): Promise<string> {
  const tmpFile = `opencode-prompt-${Date.now()}.tmp`;
  await Bun.write(tmpFile, prompt);
  // Force flush: read back what we wrote so PowerShell sees the data
  await Bun.file(tmpFile).text();
  const psCmd = `opencode run (Get-Content -Raw '${tmpFile}') --format json --no-replay --auto${agent ? ` --agent ${agent}` : ''}`;
  const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', psCmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]);
  try { Bun.spawnSync(['cmd.exe', '/c', `del "${tmpFile}"`]); } catch { /* cleanup */ }

  if (exitCode !== 0) {
    throw new Error(`opencode run failed (${exitCode}): ${(stderr || stdout).trim().slice(0, 200)}`);
  }

  const parts: string[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'text' && event.part?.text) {
        parts.push(event.part.text);
      }
    } catch {
      // skip unparseable lines
    }
  }

  const result = parts.join('\n').trim();
  if (!result) {
    throw new Error(`opencode returned empty response: ${stdout.slice(0, 300)}`);
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Try to read up to 200 bytes from a non-ok response body.
 * Returns a fallback on any error so we never throw *during* error handling.
 */
async function safeBodySnippet(res: Response): Promise<string> {
  try {
    const raw = await res.text();
    return raw.slice(0, 200) || '(empty body)';
  } catch {
    return '(unreadable body)';
  }
}

/**
 * Drill into a parsed JSON response using a dotted path key and return the
 * string value.  Throws if the path doesn't resolve to a string.
 *
 * Examples:
 *   extractContent(data, 'choices[0].message.content')  // OpenAI
 *   extractContent(data, 'content[0].text')              // Anthropic
 */
function extractContent(data: unknown, path: string): string {
  let val: unknown = data;

  // Split on dots, handling array-index brackets like choices[0]
  const segments = path.split('.').filter(Boolean);

  for (const seg of segments) {
    // If segment looks like `choices[0]`, parse the key and index
    const bracketMatch = seg.match(/^(\w+)\[(\d+)\]$/);
    if (bracketMatch) {
      const [, key, indexStr] = bracketMatch;
      const idx = Number(indexStr);
      const obj = val as Record<string, unknown> | undefined | null;
      const arr = obj?.[key];
      if (!Array.isArray(arr) || !(idx in arr)) {
        throw new Error(
          `Cannot resolve ${path}: ${key}[${idx}] not found in response`,
        );
      }
      val = arr[idx];
    } else {
      const obj = val as Record<string, unknown> | undefined | null;
      if (!obj || !(seg in obj)) {
        throw new Error(
          `Cannot resolve ${path}: key "${seg}" not found in response`,
        );
      }
      val = obj[seg];
    }
  }

  if (typeof val !== 'string') {
    throw new Error(
      `Expected string at ${path}, got ${typeof val}: ${JSON.stringify(val).slice(0, 100)}`,
    );
  }

  return val;
}
