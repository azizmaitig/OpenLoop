import type { Judgment, LLMConfig } from './types.js';
import { callLLM } from './llm.js';

/**
 * Information needed to build an evaluation prompt from a phase result.
 */
export interface EvalRequest {
  phaseName: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  expectedExitCode: number;
  /** Optional custom instruction for the LLM (appended to the standard one). */
  instruction?: string;
}

// ── Env-based LLM config ─────────────────────────────────────────────────────

/**
 * Build LLM config from environment variables, merging optional overrides.
 *
 * Reads LLM_PROVIDER, LLM_API_KEY, LLM_MODEL from the environment.
 * Any non-empty field in `overrides` takes precedence over the env var.
 * Returns undefined when a required field (provider, apiKey, model) is missing
 * after merging, so callers can fall back cleanly.
 */
export function buildLlmConfig(overrides?: Partial<LLMConfig>): LLMConfig | undefined {
  const provider = (overrides?.provider || Bun.env.LLM_PROVIDER || '') as LLMConfig['provider'];
  const apiKey = overrides?.apiKey || Bun.env.LLM_API_KEY || '';
  const model = overrides?.model || Bun.env.LLM_MODEL || '';

  if (!provider || !apiKey || !model) return undefined;

  return {
    provider,
    apiKey,
    model,
    temperature: overrides?.temperature ?? 0,
    endpoint: overrides?.endpoint,
    maxTokens: overrides?.maxTokens,
    opencodeAgent: overrides?.opencodeAgent,
  };
}

// ── Prompt construction ──────────────────────────────────────────────────────

/**
 * Build a standardized JSON-serialised evaluation prompt from a phase result.
 *
 * The default instruction asks the LLM to return JSON with `passed` (boolean),
 * `reason` (string), and `confidence` (0-1 number).
 */
export function buildEvalPrompt(req: EvalRequest): string {
  return JSON.stringify({
    task: `Phase "${req.phaseName}" ran: ${req.command}`,
    stdout: req.stdout.slice(0, 3000),
    stderr: req.stderr,
    exitCode: req.exitCode,
    expectedExitCode: req.expectedExitCode,
    instruction:
      req.instruction ||
      'Return JSON: {"passed": boolean, "reason": string, "confidence": number (0-1)}',
  });
}

// ── Response parsing ─────────────────────────────────────────────────────────

/**
 * Parse JSON from an LLM response, handling markdown code blocks and
 * surrounding explanatory text.
 *
 * Tries three strategies in order:
 * 1. Direct JSON.parse
 * 2. Extract from ```json … ``` block
 * 3. Greedy brace-match for the first { … } object
 *
 * Returns null when none succeed.
 */
export function parseJsonResponse(text: string): Record<string, unknown> | null {
  // Direct parse
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  // Extract from markdown ```json ... ``` block
  const jsonBlock = text.match(/```(?:json)\s*\n?([\s\S]*?)```/);
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock[1].trim());
    } catch {
      /* fall through */
    }
  }

  // Find the first { ... } object (greedy)
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      /* fall through */
    }
  }

  return null;
}

// ── High-level eval helpers ──────────────────────────────────────────────────

/**
 * Call the LLM with a prompt, parse the JSON response, and return a Judgment.
 *
 * Returns undefined on any failure (network, parse, missing fields) so the
 * caller can decide its own fallback behaviour.
 */
export async function evalWithLlm(
  config: LLMConfig,
  prompt: string,
  system?: string,
): Promise<Judgment | undefined> {
  try {
    const text = await callLLM(config, prompt, system);
    const parsed = parseJsonResponse(text);
    if (!parsed) return undefined;
    return {
      passed: Boolean(parsed.passed),
      reason: String(parsed.reason || 'LLM evaluation'),
      confidence: Number(parsed.confidence) || 0.5,
    };
  } catch {
    return undefined;
  }
}

/**
 * Build a Judgment from exit-code comparison — a simple, deterministic eval
 * that does not require an LLM.
 */
export function exitCodeJudgment(
  exitCode: number,
  expectedExitCode: number,
  reason?: string,
): Judgment {
  return {
    passed: exitCode === expectedExitCode,
    reason: reason || 'exit code',
    confidence: 1.0,
  };
}
