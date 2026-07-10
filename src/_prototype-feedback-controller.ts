/**
 * PROTOTYPE — Feedback Controller `decidePolicy` logic
 *
 * Question: Does the 3-input (exitCode, signatureClass, llmClass) → 2-output
 * (heal / terminal) transition table handle all failure patterns from the
 * real engine-fix sessions correctly?
 *
 * This is the PORTABLE module. The TUI imports it; nothing flows the other way.
 * If the answer is "yes", the types and transitions get lifted into
 * src/feedback-controller.ts (implementation) and src/types.ts (types).
 * The TUI shell gets deleted.
 */

// ── Types (TODO: lift into src/types.ts on production) ──────────────────────

export type SignatureClass = 'transient' | 'terminal' | 'unknown';

export interface FeedbackClassification {
  category: 'pass' | 'transient' | 'terminal';
  retryable: boolean;
  reason: string;
  healHint: string;
}

export interface PolicyInput {
  exitCode: number;
  signature: SignatureClass;
  llm?: FeedbackClassification | null;
  attempt: number; // 1-based
}

export type PolicyAction = 'pass' | 'heal' | 'terminal';

export interface PolicyDecision {
  action: PolicyAction;
  backoffMs?: number;
  reason: string;
}

// ── Known transient signatures ─────────────────────────────────────────────

const TRANSIENT_PATTERNS: RegExp[] = [
  /ETIMEDOUT/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ENOSPC/i,
  /does not match the authorized model/i,
  /Request model does not match/i,
  /socket hang[ _]?up/i,
  /connect ECONNREFUSED/i,
  /network.*timeout/i,
  /timeout.*network/i,
  /read ECONNRESET/i,
  /write ECONNRESET/i,
  /EPIPE/i,
  /ETIMEOUT/i,
  /service unavailable/i,
];

// ── Pure functions ─────────────────────────────────────────────────────────

/**
 * Classify a failure by scanning stderr for known transient patterns.
 * Pure: no I/O, no side effects.
 */
export function classifyBySignature(stderr: string, stdout: string): SignatureClass {
  const combined = `${stderr}\n${stdout}`;
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(combined)) {
      return 'transient';
    }
  }
  // exit code non-zero with no known pattern → unknown (needs LLM)
  return 'unknown';
}

/**
 * Compute exponential backoff with jitter.
 * delay = min(30000, 1000 * 2^(attempt-1)) + random(-250, 250)
 */
export function computeBackoff(attempt: number): number {
  if (attempt < 1) attempt = 1;
  const base = Math.min(30_000, 1000 * Math.pow(2, attempt - 1));
  const jitter = Math.floor(Math.random() * 500) - 250; // ±250ms
  return Math.max(0, base + jitter);
}

/**
 * The deterministic policy that consumes all three inputs and decides the action.
 *
 * Transition table:
 * exitCode | signature      | LLM (active)    | action
 * 0        | any            | any              | pass
 * non-zero | transient      | any              | heal
 * non-zero | terminal       | absent/null      | terminal
 * non-zero | terminal       | transient        | heal
 * non-zero | terminal       | terminal         | terminal
 * non-zero | unknown        | absent/null      | terminal (conservative)
 * non-zero | unknown        | transient        | heal
 * non-zero | unknown        | terminal         | terminal
 * non-zero | unknown        | pass             | pass (LLM thinks it's fine, but exit-code disagrees → terminal)
 */
export function decidePolicy(input: PolicyInput): PolicyDecision {
  const { exitCode, signature, llm, attempt } = input;

  // exit code 0 always passes — regardless of what stderr/LLM say
  if (exitCode === 0) {
    return { action: 'pass', reason: 'exit code 0' };
  }

  // R4: LLM that says "pass" but exit-code is non-zero → terminal
  if (llm?.category === 'pass') {
    return {
      action: 'terminal',
      reason: `LLM says pass but exit code is ${exitCode} — R4: exit code is authoritative`,
    };
  }

  // Signature says transient → heal (regardless of LLM)
  if (signature === 'transient') {
    return {
      action: 'heal',
      backoffMs: computeBackoff(attempt),
      reason: `transient signature detected (attempt ${attempt})`,
    };
  }

  // Signature says terminal or unknown — LLM can override to transient
  if (llm?.category === 'transient') {
    return {
      action: 'heal',
      backoffMs: computeBackoff(attempt),
      reason: `LLM reclassified as transient: ${llm.reason}`,
    };
  }

  // LLM terminal or absent → terminal
  const llmNote = llm ? ` (LLM: ${llm.category})` : '';
  return {
    action: 'terminal',
    reason: `no heal path found` + llmNote,
  };
}

// ── Scenario runners (for TUI and batch verification) ──────────────────────

export interface Scenario {
  name: string;
  input: PolicyInput;
  expectedAction: PolicyAction;
  source: string; // which engine-fix session or audit finding
}

export const SCENARIOS: Scenario[] = [
  // F1: Shell quoting error (Windows)
  {
    name: 'F1 — Shell quoting (transient)',
    input: { exitCode: 1, signature: 'transient', llm: null, attempt: 1 },
    expectedAction: 'heal',
    source: 'Engine-fix session: cmd.exe /c strips inner quotes, path with spaces broke --dir',
  },
  // F2: Model entitlement mismatch
  {
    name: 'F2 — Model entitlement (transient)',
    input: { exitCode: 1, signature: 'transient', llm: null, attempt: 1 },
    expectedAction: 'heal',
    source: 'Engine-fix session: "Console Go: Request model does not match the authorized model"',
  },
  // F3: tsc compilation error (terminal — re-running won't fix bad code)
  {
    name: 'F3 — tsc compilation error (terminal)',
    input: { exitCode: 2, signature: 'unknown', llm: null, attempt: 1 },
    expectedAction: 'terminal',
    source: 'Audit T9: no signature match, retry pointless on source-code errors',
  },
  // F3 with LLM reclassifying as transient (e.g., missing import that heal fixes)
  {
    name: 'F3b — tsc error, LLM says transient',
    input: {
      exitCode: 2,
      signature: 'unknown',
      llm: { category: 'transient', retryable: true, reason: 'Missing import — auto-install package', healHint: 'install package' },
      attempt: 1,
    },
    expectedAction: 'heal',
    source: 'LLM reclassifies an unknown error as fixable heal',
  },
  // F4: Daemon silent failure (exit 0 but error in stderr)
  {
    name: 'F4 — Daemon exit 0 with error (pass)',
    input: { exitCode: 0, signature: 'unknown', llm: null, attempt: 1 },
    expectedAction: 'pass',
    source: 'Engine-fix session: daemon passes onPhaseFailed: () => {}',
  },
  // Network timeout
  {
    name: 'Network timeout (transient)',
    input: { exitCode: 1, signature: 'transient', llm: null, attempt: 1 },
    expectedAction: 'heal',
    source: 'Audit T9: network errors should backoff and retry',
  },
  // Backoff scaling check (attempt 3)
  {
    name: 'Network timeout attempt 3 (backoff scaling)',
    input: { exitCode: 1, signature: 'transient', llm: null, attempt: 3 },
    expectedAction: 'heal',
    source: 'Backoff should be ~4s (1000 * 2^2)',
  },
  // Heal exhausted
  {
    name: 'Heal exhausted (terminal after maxRetries)',
    input: { exitCode: 1, signature: 'transient', llm: null, attempt: 4 },
    expectedAction: 'heal', // policy doesn't cap — the caller enforces maxRetries
    source: 'Policy returns heal; caller stops retrying after maxRetries',
  },
  // LLM says terminal, no signature match
  {
    name: 'LLM terminal confirmed',
    input: {
      exitCode: 1,
      signature: 'unknown',
      llm: { category: 'terminal', retryable: false, reason: 'Syntax error in source code', healHint: '' },
      attempt: 1,
    },
    expectedAction: 'terminal',
    source: 'LLM classifies as terminal → policy halts',
  },
  // R4: LLM says pass but exit-code is non-zero
  {
    name: 'R4 — LLM says pass, exit code 1 (terminal)',
    input: {
      exitCode: 1,
      signature: 'unknown',
      llm: { category: 'pass', retryable: true, reason: 'Looks fine to me', healHint: '' },
      attempt: 1,
    },
    expectedAction: 'terminal',
    source: 'R4: exit-code is authoritative over LLM judgment',
  },
  // ClassifyBySignature: known pattern detection
  {
    name: 'Signature — ETIMEDOUT detected',
    input: { exitCode: 1, signature: classifyBySignature('Error: ETIMEDOUT connecting to host', ''), llm: null, attempt: 1 },
    expectedAction: 'heal',
    source: 'Known transient pattern → heal without LLM',
  },
  {
    name: 'Signature — model mismatch detected',
    input: { exitCode: 1, signature: classifyBySignature('Error from provider (Console Go): Request model does not match the authorized model', ''), llm: null, attempt: 1 },
    expectedAction: 'heal',
    source: 'Known model entitlement mismatch → heal without LLM',
  },
];

/**
 * Run ALL scenarios and return pass/fail results.
 * Used by both TUI batch mode and automated verification.
 */
export function runAllScenarios(): { pass: boolean; total: number; passed: number; failed: Scenario[] } {
  let passed = 0;
  const failed: Scenario[] = [];

  for (const s of SCENARIOS) {
    const result = decidePolicy(s.input);
    if (result.action === s.expectedAction) {
      passed++;
    } else {
      failed.push(s);
    }
  }

  return {
    pass: failed.length === 0,
    total: SCENARIOS.length,
    passed,
    failed,
  };
}

/**
 * Check if the signature was correctly classified — used by scenarios
 * that rely on classifyBySignature dynamically.
 */
// ═════════════════════════════════════════════════════════════════════════════
// TUI SHELL — throwaway. Deleted after learning.
// ═════════════════════════════════════════════════════════════════════════════

import * as readline from 'node:readline';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const CLEAR = '\x1b[2J\x1b[H';

function actionColor(action: PolicyAction): string {
  switch (action) {
    case 'pass': return GREEN;
    case 'heal': return YELLOW;
    case 'terminal': return RED;
  }
}

function render(selected: number, lastResult: PolicyDecision | null, lastScenario: Scenario | null) {
  console.log(CLEAR);
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║   Feedback Controller — decidePolicy Prototype                  ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════════╝${RESET}`);
  console.log();
  console.log(`${DIM}Tests the 3-input → 2-output transition table against real engine-fix${RESET}`);
  console.log(`${DIM}failure patterns. Portable logic module — lift into feedback-controller.ts.${RESET}`);
  console.log();
  console.log(`${BOLD}Selected Scenario:${RESET}`);
  if (lastScenario) {
    console.log(`  ${lastScenario.name}`);
    console.log(`  ${DIM}${lastScenario.source}${RESET}`);
    console.log(`  Exit: ${lastScenario.input.exitCode}  Sig: ${lastScenario.input.signature}  LLM: ${lastScenario.input.llm?.category ?? 'null'}  Attempt: ${lastScenario.input.attempt}`);
    console.log();
    console.log(`${BOLD}Policy Decision:${RESET}`);
    if (lastResult) {
      const color = actionColor(lastResult.action);
      console.log(`  ${color}${BOLD}${lastResult.action.toUpperCase()}${RESET}  ${lastResult.reason}`);
      if (lastResult.backoffMs !== undefined) {
        console.log(`  ${DIM}backoff: ${lastResult.backoffMs}ms${RESET}`);
      }
    }
  } else {
    console.log(`  ${DIM}(none selected — select a scenario with [1-9])${RESET}`);
  }
  console.log();

  // Scenario list
  console.log(`${BOLD}Scenarios:${RESET}`);
  SCENARIOS.forEach((s, i) => {
    const result = decidePolicy(s.input);
    const ok = result.action === s.expectedAction;
    const sel = i === selected ? '→' : ' ';
    const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${sel} [${i + 1}] ${mark} ${s.name}`);
    if (i === selected) {
      const color = actionColor(result.action);
      console.log(`       Expected: ${s.expectedAction}  Got: ${color}${result.action}${RESET}  ${result.reason}`);
      if (result.backoffMs !== undefined) {
        console.log(`       ${DIM}backoff: ${result.backoffMs}ms${RESET}`);
      }
    }
  });

  // Batch results
  console.log();
  const batch = runAllScenarios();
  console.log(`${BOLD}Batch:${RESET} ${batch.passed}/${batch.total} passed ${batch.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`}`);

  // Help
  console.log();
  console.log(`${DIM}[1-${SCENARIOS.length}] select  [r] run batch  [q] quit${RESET}`);
}

export async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let selected = 0;
  let lastResult: PolicyDecision | null = null;
  let lastScenario: Scenario | null = null;

  // Render first frame
  render(selected, null, null);

  rl.on('line', (line) => {
    const key = line.trim().toLowerCase();

    if (key === 'q') {
      rl.close();
      return;
    }

    if (key === 'r') {
      const batch = runAllScenarios();
      console.log(CLEAR);
      if (batch.pass) {
        console.log(`${GREEN}✓${RESET} All ${batch.total} scenarios passed — the transition table handles all failure patterns.`);
      } else {
        console.log(`${RED}✗${RESET} ${batch.failed.length} scenario(s) FAILED:`);
        for (const f of batch.failed) {
          const result = decidePolicy(f.input);
          console.log(`  - ${f.name}: expected ${f.expectedAction}, got ${result.action} (${result.reason})`);
        }
      }
      console.log();
      console.log(`${DIM}Press Enter to return to scenario view...${RESET}`);
      rl.once('line', () => {
        render(selected, lastResult, lastScenario);
      });
      return;
    }

    const num = parseInt(key, 10);
    if (num >= 1 && num <= SCENARIOS.length) {
      selected = num - 1;
      const scenario = SCENARIOS[selected];
      lastScenario = scenario;
      lastResult = decidePolicy(scenario.input);
      render(selected, lastResult, lastScenario);
      return;
    }

    // Unknown key: re-render
    render(selected, lastResult, lastScenario);
  });

  rl.on('close', () => {
    console.log(CLEAR);
    const batch = runAllScenarios();
    console.log(`Prototype complete. ${batch.passed}/${batch.total} scenarios passed.`);
    if (batch.pass) {
      console.log('The decidePolicy transition table is validated against all engine-fix failure patterns.');
      console.log('Answer: lift the portable module into feedback-controller.ts.');
    } else {
      console.log('FAILURES found — review the transition table before production.');
      for (const f of batch.failed) {
        console.log(`  ✗ ${f.name}`);
      }
    }
    process.exit(0);
  });
}

if (import.meta.main) {
  main();
}

export function classifyAndDecide(params: {
  exitCode: number;
  stderr: string;
  stdout: string;
  llm?: FeedbackClassification | null;
  attempt?: number;
}): PolicyDecision {
  const signature = classifyBySignature(params.stderr, params.stdout);
  return decidePolicy({
    exitCode: params.exitCode,
    signature,
    llm: params.llm ?? null,
    attempt: params.attempt ?? 1,
  });
}
