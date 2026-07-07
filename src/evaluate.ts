import type { PhaseDef, PhaseResult, Judgment, LLMConfig, LLMProvider } from './types.js';
import { callLLM } from './llm.js';

/**
 * Evaluate a phase result using semantic LLM analysis or exit-code fallback.
 *
 * When no LLM is configured (phase.llm is undefined), returns a simple
 * judgment based on exit code matching:
 *   { passed: exitCode === phase.expectedExitCode,
 *     reason: 'exit code',
 *     confidence: 1.0 }
 *
 * When LLM is configured, the path depends on the llm shape:
 * - `provider` field → calls callLLM() directly with the prompt
 * - `mcpServer` field → constructs a prompt and calls via executeMcpPhase()
 *
 * Both LLM paths expect the response to be JSON:
 *   { "passed": boolean, "reason": string, "confidence": number }
 *
 * Both fall back to exit-code judgment on any failure.
 */
export async function evaluatePhase(
  phase: PhaseDef,
  result: PhaseResult,
): Promise<Judgment> {
  // If phase has no LLM config, use exit code fallback
  if (!phase.llm) {
    return {
      passed: result.exitCode === phase.expectedExitCode,
      reason: 'exit code',
      confidence: 1.0,
    };
  }

  try {
    if ('provider' in phase.llm) {
      // ── Direct LLM path ──────────────────────────────────────────────
      const config: LLMConfig = {
        provider: phase.llm.provider as LLMProvider,
        apiKey: Bun.env.LLM_API_KEY ?? '',
        model: Bun.env.LLM_MODEL ?? '',
      };

      // Use the plan's prompt as the system instruction when available,
      // with stdout injected as context. Fall back to generic eval prompt.
      const systemPrompt = phase.llm.prompt || 'You are an evaluation assistant.';
      const evalPrompt = JSON.stringify({
        task: `Phase "${phase.name}" ran: ${phase.command}`,
        stdout: result.stdout.slice(0, 3000),
        stderr: result.stderr,
        exitCode: result.exitCode,
        expectedExitCode: phase.expectedExitCode,
        instruction:
          'Return JSON: {"passed": boolean, "reason": string, "confidence": number (0-1)}',
      });
      const response = await callLLM(config, evalPrompt, systemPrompt);
      const parsed = tryExtractJson(response);
      if (!parsed) throw new Error('Could not extract JSON from LLM response');
      return {
        passed: Boolean(parsed.passed),
        reason: String(parsed.reason || 'LLM evaluation'),
        confidence: Number(parsed.confidence) || 0.5,
      };
    }

    // ── MCP path (existing) ────────────────────────────────────────────
    const evalPhase: PhaseDef = {
      ...phase,
      llm: {
        mcpServer: phase.llm.mcpServer,
        tool: phase.llm.tool,
        prompt: evalPrompt,
      },
    };

    // Import dynamically to avoid circular dependency
    const { executeMcpPhase } = await import('./mcp.js');
    const llmResult = await executeMcpPhase(evalPhase);

    if (llmResult.status === 'pass' && llmResult.stdout) {
      const parsed = JSON.parse(llmResult.stdout);
      return {
        passed: Boolean(parsed.passed),
        reason: String(parsed.reason || 'LLM evaluation'),
        confidence: Number(parsed.confidence) || 0.5,
      };
    }
  } catch {
    // Fallback on LLM failure (both paths)
  }

  // Fallback
  return {
    passed: result.exitCode === phase.expectedExitCode,
    reason: 'exit code (LLM fallback)',
    confidence: 1.0,
  };
}

/**
 * Try to parse JSON from an LLM response, handling markdown code blocks
 * and surrounding explanatory text.
 */
function tryExtractJson(text: string): Record<string, unknown> | null {
  // Direct parse
  try { return JSON.parse(text); } catch { /* fall through */ }

  // Extract from markdown ```json ... ``` block
  const jsonBlock = text.match(/```(?:json)\s*\n?([\s\S]*?)```/);
  if (jsonBlock) {
    try { return JSON.parse(jsonBlock[1].trim()); } catch { /* fall through */ }
  }

  // Find the first { ... } object (greedy)
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { /* fall through */ }
  }

  return null;
}
