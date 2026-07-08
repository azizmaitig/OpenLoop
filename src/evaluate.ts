import type { PhaseDef, PhaseResult, Judgment } from './types.js';
import {
  buildLlmConfig,
  buildEvalPrompt,
  evalWithLlm,
  exitCodeJudgment,
} from './eval-core.js';

/**
 * Evaluate a phase result using semantic LLM analysis or exit-code fallback.
 *
 * When no LLM is configured (phase.llm is undefined), returns a simple
 * judgment based on exit code matching.
 *
 * When LLM is configured, the path depends on the llm shape:
 * - `provider` field → calls callLLM() directly via eval-core
 * - `mcpServer` field → constructs a prompt and calls via executeMcpPhase()
 *
 * Both paths fall back to exit-code judgment on any failure.
 */
export async function evaluatePhase(
  phase: PhaseDef,
  result: PhaseResult,
): Promise<Judgment> {
  // If phase has no LLM config, use exit code fallback
  if (!phase.llm) {
    return exitCodeJudgment(result.exitCode, phase.expectedExitCode);
  }

  try {
    if ('provider' in phase.llm) {
      // ── Direct LLM path ──────────────────────────────────────────────
      const config = buildLlmConfig({
        provider: phase.llm.provider as 'openai' | 'anthropic' | 'opencode',
      });
      if (!config) throw new Error('LLM config incomplete');

      const systemPrompt =
        phase.llm.prompt || 'You are an evaluation assistant.';
      const prompt = buildEvalPrompt({
        phaseName: phase.name,
        command: phase.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        expectedExitCode: phase.expectedExitCode,
      });

      const judgment = await evalWithLlm(config, prompt, systemPrompt);
      if (judgment) return judgment;
      throw new Error('evalWithLlm returned undefined');
    }

    // ── MCP path ───────────────────────────────────────────────────────
    const prompt = buildEvalPrompt({
      phaseName: phase.name,
      command: phase.command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      expectedExitCode: phase.expectedExitCode,
    });
    const mcpLlm = phase.llm as { mcpServer: string; tool: string; prompt: string };
    const evalPhase: PhaseDef = {
      ...phase,
      llm: { mcpServer: mcpLlm.mcpServer, tool: mcpLlm.tool, prompt },
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

  return exitCodeJudgment(
    result.exitCode,
    phase.expectedExitCode,
    'exit code (LLM fallback)',
  );
}
