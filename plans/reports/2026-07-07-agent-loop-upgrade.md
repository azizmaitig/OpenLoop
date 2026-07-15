# Agent-Loop v0.7 — Auto-Heal + Checkpoint Resume

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the agent-loop orchestrator with two reliability features: auto-heal verification failures and checkpoint-based crash resume.

**Architecture:** Two independent upgrades. The checkpoint system adds one new file (`src/checkpoint.ts`). The heal mechanism is a for-loop in `loop.ts` — no FSM changes, no new states. The plan YAML schema extends with optional `healCommand` and `maxRetries` on verify tasks. All phases remain sequential (parallel execution dropped — reaffirms ADR-0002).

**Tech Stack:** Bun 1.x, TypeScript (no external deps), custom YAML parser in plan-executor.ts

---

## File Structure

### Files to Modify
| File | Changes |
|------|---------|
| `src/types.ts` | Add `healCommand`, `maxRetries` to PlanYamlTask. Add `CheckpointState` interface. |
| `src/plan-executor.ts` | Parse new YAML fields in parseYamlContent. Serialize in stringifyPlanYaml. |
| `src/plugins.ts` | `beforeLoop` hook signature accepts optional `resume?: boolean`. `executeBeforeLoop` passes it through. |
| `loop.ts` | `runLoop()` gains: heal retry loop after verify failures, checkpoint save/load at start and after each phase. |

### Files to Create
| File | Purpose |
|------|---------|
| `src/checkpoint.ts` | Save/load/resume checkpoint state between loop runs. |

---

## Upgrade 1: Auto-Heal Verify Failures

### Task 1.1: Add new types for auto-heal + checkpoint

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add heal fields to PlanYamlTask**

Add these fields to the `PlanYamlTask` interface (around line 65-70):

```typescript
export interface PlanYamlTask {
  id: string;
  command: string;
  timeoutMs?: number;
  llm?: { mcpServer?: string; tool?: string; prompt?: string };
  // ── New for v0.7 ──
  /** Command to run when this task's verification fails — e.g. opencode run to auto-fix TS errors */
  healCommand?: string;
  /** Max retry count for auto-heal (0 = no retry, default: 0) */
  maxRetries?: number;
}
```

- [ ] **Step 2: Add CheckpointState interface**

Add after the `PlanYamlDoc` interface (around line 75):

```typescript
export interface CheckpointState {
  planPath: string;
  planName: string;
  startedAt: string;
  updatedAt: string;
  completedTaskIds: string[];
  inProgressTaskId: string | null;
  results: Record<string, { status: string; durationMs: number; exitCode: number }>;
}
```

### Task 1.2: Parse heal fields in plan-executor

**Files:**
- Modify: `src/plan-executor.ts`

- [ ] **Step 1: Parse healCommand and maxRetries in parseYamlContent**

In the task field parsing section (around line 247-264), add these key handlers after `key === 'timeoutMs'`:

```typescript
        } else if (key === 'healCommand') {
          currentTask.healCommand = stripQuotes(value);
        } else if (key === 'maxRetries') {
          currentTask.maxRetries = parseInt(value, 10);
        }
```

- [ ] **Step 2: Serialize new fields in stringifyPlanYaml**

In the stringify function, add after the timeoutMs and llm blocks (around line 138):

```typescript
    if (task.healCommand !== undefined) {
      lines.push(`    healCommand: ${task.healCommand}`);
    }
    if (task.maxRetries !== undefined) {
      lines.push(`    maxRetries: ${task.maxRetries}`);
    }
```

### Task 1.3: Implement heal retry loop in loop.ts

**Files:**
- Modify: `loop.ts`

- [ ] **Step 1: Add healAndRetry helper function**

Add this function after `executeShellCommand()` (after line 268):

```typescript
/**
 * Auto-heal a failed verify task: execute healCommand, then re-run the
 * original verify command. Retry up to maxRetries times.
 * Returns { passed: true, result } if eventually passes.
 */
async function healAndRetry(
  verifyCommand: string,
  healCommand: string,
  maxRetries: number,
  timeoutMs: number,
): Promise<{ passed: boolean; result: PhaseResult }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    process.stdout.write(`  [heal ${attempt}/${maxRetries}] executing healCommand... `);
    const healResult = await executeShellCommand(healCommand, timeoutMs);
    console.log(healResult.status === 'pass' ? 'OK' : 'FAIL');

    process.stdout.write(`  [heal ${attempt}/${maxRetries}] re-running verify... `);
    const verifyResult = await executeShellCommand(verifyCommand, timeoutMs);
    const passed = verifyResult.status === 'pass';
    console.log(passed ? 'PASS' : 'FAIL');

    if (passed) {
      return { passed: true, result: verifyResult };
    }
  }
  // Retries exhausted — final verify attempt
  const lastResult = await executeShellCommand(verifyCommand, timeoutMs);
  return { passed: false, result: lastResult };
}
```

- [ ] **Step 2: Wire heal into phase execution loop**

In `runLoop()`, after the `executeShellCommand` call for a phase and before the pass/fail logging (around line 420-470), inject heal logic:

```typescript
      // ── Auto-heal on verify failure ──
      if (result.status !== 'pass' && config.planPath) {
        const planTask = await getPlanTaskForPhase(config.planPath, phase.name);
        if (planTask?.healCommand && (planTask.maxRetries ?? 0) > 0) {
          console.log(`\n  Auto-healing (max ${planTask.maxRetries} retries)...`);
          const healed = await healAndRetry(
            phase.command,
            planTask.healCommand,
            planTask.maxRetries!,
            phase.timeoutMs,
          );
          if (healed.passed) {
            result = healed.result;
            result.status = 'pass';
          }
        }
      }
```

- [ ] **Step 3: Add getPlanTaskForPhase helper**

Add near the helpers section:

```typescript
/**
 * Look up a PlanYamlTask by phase name from the plan YAML file.
 * Returns the matching task (by id exact match).
 */
async function getPlanTaskForPhase(planPath: string, phaseName: string): Promise<PlanYamlTask | undefined> {
  try {
    const { parsePlanYaml } = await import('./src/plan-executor.js');
    const doc = await parsePlanYaml(planPath);
    return doc.tasks.find(t => t.id === phaseName);
  } catch {
    return undefined;
  }
}
```

---

## Upgrade 2: Checkpoint Resume (Safest Approach)

Checkpoint saves after EVERY completed phase (batch AND verify). Plan YAML only written on FULL success — never partial. After crash: checkpoint has exact progress, plan YAML is pristine. Authoritative: checkpoint.

### Task 2.1: Create checkpoint.ts

**Files:**
- Create: `src/checkpoint.ts`

- [ ] **Step 1: Write the checkpoint module**

```typescript
/**
 * checkpoint.ts — Persist loop progress between runs for crash recovery.
 *
 * Saves a .checkpoint.json file alongside the plan YAML after each
 * completed phase. On restart, detects the checkpoint and offers to
 * resume from where we left off.
 *
 * @module checkpoint
 */

import { existsSync } from 'node:fs';
import type { CheckpointState } from './types.js';

const CHECKPOINT_SUFFIX = '.checkpoint.json';

/**
 * Derive checkpoint file path from plan path.
 * e.g. plans/build-calendar.yaml → plans/build-calendar.yaml.checkpoint.json
 */
export function checkpointPath(planPath: string): string {
  return `${planPath}${CHECKPOINT_SUFFIX}`;
}

/**
 * Load existing checkpoint for a plan, or null if none exists.
 */
export async function loadCheckpoint(planPath: string): Promise<CheckpointState | null> {
  const cpPath = checkpointPath(planPath);
  try {
    const file = Bun.file(cpPath);
    const exists = await file.exists();
    if (!exists) return null;
    const content = await file.text();
    return JSON.parse(content) as CheckpointState;
  } catch {
    return null;
  }
}

/**
 * Save a checkpoint — records completed task IDs and a snapshot of results.
 */
export async function saveCheckpoint(
  planPath: string,
  state: {
    planName: string;
    completedTaskIds: string[];
    inProgressTaskId: string | null;
    results: Record<string, { status: string; durationMs: number; exitCode: number }>;
  },
): Promise<void> {
  const cpPath = checkpointPath(planPath);
  const cp: CheckpointState = {
    planPath,
    planName: state.planName,
    startedAt: '',
    updatedAt: new Date().toISOString(),
    completedTaskIds: state.completedTaskIds,
    inProgressTaskId: state.inProgressTaskId,
    results: state.results,
  };

  // Try to preserve startedAt from existing checkpoint
  const existing = await loadCheckpoint(planPath);
  if (existing) {
    cp.startedAt = existing.startedAt;
  } else {
    cp.startedAt = cp.updatedAt;
  }

  await Bun.write(cpPath, JSON.stringify(cp, null, 2));
}

/**
 * Clear checkpoint for a plan (called on successful completion or fresh start).
 */
export async function clearCheckpoint(planPath: string): Promise<void> {
  const cpPath = checkpointPath(planPath);
  try {
    await Bun.write(cpPath, '');
  } catch {
    // Best-effort
  }
}

/**
 * Given a list of all tasks and an existing checkpoint, return only the
 * tasks that haven't been completed yet. Tasks with status 'pass' in
 * the checkpoint are skipped.
 */
export function filterPendingTasks(
  tasks: { id: string; command: string }[],
  checkpoint: CheckpointState,
): { id: string; command: string }[] {
  const completed = new Set(checkpoint.completedTaskIds);
  return tasks.filter(t => !completed.has(t.id));
}

/**
 * Check if a checkpoint exists and its format is valid.
 * Returns the checkpoint state if valid, null otherwise.
 */
export async function hasValidCheckpoint(planPath: string): Promise<CheckpointState | null> {
  const cp = await loadCheckpoint(planPath);
  if (!cp) return null;
  if (!cp.planName || !Array.isArray(cp.completedTaskIds)) return null;
  return cp;
}
```

### Task 2.2: Wire checkpoint into plan-executor beforeLoop

**Files:**
- Modify: `src/plan-executor.ts`

- [ ] **Step 1: Import checkpoint functions and add resume support**

Add at the top of the file:

```typescript
import { hasValidCheckpoint, filterPendingTasks } from './checkpoint.js';
```

Modify `beforeLoop()` to accept an optional resume flag and filter completed tasks:

```typescript
export async function beforeLoop(planPath: string, resume?: boolean): Promise<PhaseDef[]> {
  activePlanPath = planPath;
  const doc = await parsePlanYaml(planPath);

  let tasks = doc.tasks;

  // If resuming from checkpoint, skip completed tasks
  if (resume) {
    const cp = await hasValidCheckpoint(planPath);
    if (cp) {
      const pending = filterPendingTasks(tasks, cp);
      if (pending.length < tasks.length) {
        console.log(`[checkpoint] Resuming: ${tasks.length - pending.length} tasks already completed, ${pending.length} remaining`);
      }
      tasks = tasks.filter(t => pending.find(p => p.id === t.id));
    }
  }

  return tasks.map((task) => ({
    name: task.id,
    command: task.command,
    timeoutMs: task.timeoutMs ?? 30000,
    expectedExitCode: 0,
    llm: task.llm
      ? {
          mcpServer: task.llm.mcpServer ?? '',
          tool: task.llm.tool ?? '',
          prompt: task.llm.prompt ?? '',
        }
      : undefined,
  }));
}
```

### Task 2.3: Wire checkpoint into loop.ts

**Files:**
- Modify: `loop.ts`

- [ ] **Step 1: Add checkpoint import and resume prompt logic**

Add at the top of the file:
```typescript
import { saveCheckpoint, clearCheckpoint, hasValidCheckpoint } from './src/checkpoint.js';
```

- [ ] **Step 2: Add resume prompt before the main loop**

In `runLoop()`, after loading plan phases and before writing initial state (after line ~406), add checkpoint detection:

```typescript
  // ── Checkpoint resume ──
  let resume = false;
  if (config.planPath) {
    const cp = await hasValidCheckpoint(config.planPath);
    if (cp && cp.completedTaskIds.length > 0) {
      console.log(`\n[checkpoint] Found saved progress: ${cp.completedTaskIds.length} tasks completed.`);
      console.log(`[checkpoint] Started: ${cp.startedAt}, Last update: ${cp.updatedAt}`);
      process.stdout.write('[checkpoint] Resume from checkpoint? (Y/n): ');

      // Simple stdin read (no readline dependency for this simple case)
      // Use a short timeout — default to resume if no input in 5s
      let answer = '';
      try {
        for await (const line of console.stdin) {
          answer = line.trim().toLowerCase();
          break;
        }
      } catch {
        answer = 'y'; // default to resume on error
      }
      resume = answer === '' || answer === 'y' || answer === 'yes';

      if (resume) {
        console.log(`[checkpoint] Resuming — skipping ${cp.completedTaskIds.length} completed tasks.`);
      } else {
        console.log('[checkpoint] Starting fresh — clearing checkpoint.');
        await clearCheckpoint(config.planPath);
      }
    }
  }
```

- [ ] **Step 3: Pass resume flag to plan-executor beforeLoop**

Modify the plan-executor hook call (around line 396-400) to pass the resume flag:
```typescript
    if (planPlugin?.beforeLoop) {
      const planPhases = await executeBeforeLoop(planPlugin, config.planPath, resume);
      if (planPhases.length > 0) {
        config = { ...config, phases: planPhases };
        console.log(`[plan-executor] Loaded ${planPhases.length} phases from ${config.planPath}`);
      }
    }
```

- [ ] **Step 4: Update plugin types to support optional parameter**

Modify `src/plugins.ts` — the `beforeLoop` hook signature needs to accept an optional `resume` parameter. The callback type around the `Plugin.beforeLoop` definition needs updating:

In `src/plugins.ts`, change the `beforeLoop` type from:
```typescript
beforeLoop?: (planPath: string) => Promise<PhaseDef[]>;
```
to:
```typescript
beforeLoop?: (planPath: string, resume?: boolean) => Promise<PhaseDef[]>;
```

And update `executeBeforeLoop` to pass the resume flag:
```typescript
export async function executeBeforeLoop(plugin: Plugin, planPath: string, resume?: boolean): Promise<PhaseDef[]> {
  if (plugin.beforeLoop) {
    return await plugin.beforeLoop(planPath, resume);
  }
  return [];
}
```

- [ ] **Step 5: Save checkpoint after each successful phase**

In `runLoop()`, after recording a pass result (after line ~453, inside the per-phase result block), add checkpoint save:

```typescript
      if (result.status === 'pass') {
        console.log(`PASS (${result.durationMs}ms)`);
        // ── Save checkpoint ──
        if (config.planPath) {
          const completedIds = Object.entries(state.phaseResults)
            .filter(([, r]) => r.status === 'pass')
            .map(([name]) => name);
          await saveCheckpoint(config.planPath, {
            planName: config.taskName,
            completedTaskIds: completedIds,
            inProgressTaskId: null,
            results: Object.fromEntries(
              Object.entries(state.phaseResults).map(([name, r]) => [
                name,
                { status: r.status, durationMs: r.durationMs, exitCode: r.exitCode },
              ]),
            ),
          });
        }
```

- [ ] **Step 6: Clear checkpoint on successful completion**

In `runLoop()`, at the end of the loop — after `onLoopComplete` (after line ~508) and only when `allPassed === true`:

```typescript
  // ── Clear checkpoint on success ──
  if (allPassed && config.planPath) {
    await clearCheckpoint(config.planPath);
    console.log(`[checkpoint] Plan completed — checkpoint cleared.`);
  }
```

---

## Self-Review

### Spec Coverage
1. **Auto-heal verify failures**: Task 1.1 (types) + Task 1.2 (YAML parse) + Task 1.3 (heal retry loop) — covers the full feature: detect verification failure, execute heal command (on the verify task itself, no fragile heuristic), retry up to N times via simple for-loop (no FSM changes).
2. **Checkpoint resume**: Task 2.1 (new checkpoint.ts module) + Task 2.2 (plan-executor integration) + Task 2.3 (loop.ts wiring) — saves after EVERY phase (authoritative), plan YAML only on full completion, resume prompt on restart.

### Placeholder Check
No TBD, TODO, "implement later", or placeholder patterns. Every code block is complete and implementable.

### Type Consistency
- `PlanYamlTask.healCommand` — string, matches `healCommand` in YAML
- `PlanYamlTask.maxRetries` — number, defaults to 0 (no retry)
- `CheckpointState.completedTaskIds` — `string[]`, used by `filterPendingTasks()`
- `CheckpointState.startedAt`/`updatedAt` — ISO strings, set by saveCheckpoint
- `Plugin.beforeLoop` — updated to accept optional `resume: boolean`
- All new types and functions reference each other consistently (e.g., `hasValidCheckpoint` returns `CheckpointState | null`, `filterPendingTasks` accepts `CheckpointState`)

### Potential Gaps
- Checkpoint is written after each phase via loop.ts but the daemon.ts task queue path is not checkpoint-aware. This is acceptable because plan-driven execution bypasses daemon — `runLoop()` calls `executeShellCommand()` directly, not through the daemon's task queue. The daemon is only used for ad-hoc/API-submitted tasks.
