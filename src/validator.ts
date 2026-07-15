import type { PhaseDef, PhaseResult, Judgment } from './types.js';
import { buildLlmConfig, buildEvalPrompt, evalWithLlm } from './eval-core.js';

/**
 * Grade a phase's output against its validator.criteria rubric using an LLM.
 * Returns undefined on any failure (no LLM configured, network/parse error) so
 * the caller can fail-open. Mirrors evaluate.ts's non-fatal culture.
 */
export async function validatePhase(
  phase: PhaseDef,
  result: PhaseResult,
): Promise<Judgment | undefined> {
  const v = phase.validator;
  if (!v) return undefined;

  const config = buildLlmConfig(
    v.llm ? { provider: v.llm.provider as 'openai' | 'anthropic' | 'opencode' } : undefined,
  );
  if (!config) return undefined; // fail-open: no LLM configured

  const prompt = buildEvalPrompt({
    phaseName: phase.name,
    command: phase.command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    expectedExitCode: phase.expectedExitCode,
    instruction: `Validate the phase output against this rubric:\n${v.criteria}\n\nReturn JSON: {"passed": boolean, "reason": string, "confidence": number (0-1)}`,
  });

  return evalWithLlm(
    config,
    prompt,
    'You are a strict output validator. Grade the phase output against the rubric and return JSON.',
  );
}
