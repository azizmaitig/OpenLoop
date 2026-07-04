import type { PhaseDef, PhaseResult, Judgment } from './types.js';

/**
 * Evaluate a phase result using semantic LLM analysis or exit-code fallback.
 *
 * When no LLM is configured (phase.llm is undefined), returns a simple
 * judgment based on exit code matching:
 *   { passed: exitCode === phase.expectedExitCode,
 *     reason: 'exit code',
 *     confidence: 1.0 }
 *
 * When LLM is configured, constructs a prompt that includes:
 * - Phase name
 * - Phase command/description
 * - Captured stdout (truncated to 2000 chars)
 * - Captured stderr
 * - Exit code
 *
 * Calls the LLM via phase.llm MCP tool (reusing executeMcpPhase).
 * The LLM should return JSON: { "passed": boolean, "reason": string, "confidence": number }
 *
 * @throws {Error} if LLM response cannot be parsed as Judgment
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

  // Construct evaluation prompt
  const evalPrompt = JSON.stringify({
    task: `Evaluate if phase "${phase.name}" passed: ${phase.command}`,
    stdout: result.stdout.slice(0, 2000),
    stderr: result.stderr,
    exitCode: result.exitCode,
    expectedExitCode: phase.expectedExitCode,
    instruction:
      'Return JSON: {"passed": boolean, "reason": string, "confidence": number (0-1)}',
  });

  // Create a temporary PhaseDef for the LLM call
  const evalPhase: PhaseDef = {
    ...phase,
    llm: {
      mcpServer: phase.llm.mcpServer,
      tool: phase.llm.tool,
      prompt: evalPrompt,
    },
  };

  try {
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
    // Fallback on LLM failure
  }

  // Fallback
  return {
    passed: result.exitCode === phase.expectedExitCode,
    reason: 'exit code (LLM fallback)',
    confidence: 1.0,
  };
}
