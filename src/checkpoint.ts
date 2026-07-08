import type { CheckpointState, PlanYamlTask } from './types.js'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Returns the full filesystem path to the checkpoint JSON file for a given plan.
 *
 * @param planName - Unique name of the plan (used in the filename)
 * @param outputDir - Custom output directory; defaults to `_agent-loop-output`
 */
export function checkpointPath(planName: string, outputDir?: string): string {
  return resolve(outputDir ?? '_agent-loop-output', `checkpoint-${planName}.json`)
}

/**
 * Persists a checkpoint state to disk as JSON.
 *
 * Sets `updatedAt` to the current timestamp, ensures the output directory
 * exists, and writes the serialised state.
 *
 * @param state - The checkpoint state to persist
 */
export async function saveCheckpoint(state: CheckpointState, outputDir?: string): Promise<void> {
  state.updatedAt = new Date().toISOString()
  const filePath = checkpointPath(state.planName, outputDir)
  try {
    const dir = resolve(outputDir ?? '_agent-loop-output')
    mkdirSync(dir, { recursive: true })
    await Bun.write(filePath, JSON.stringify(state, null, 2))
    console.log('[checkpoint] Saved checkpoint:', filePath)
  } catch (err) {
    console.error('[checkpoint] Failed to save checkpoint:', err)
    throw err
  }
}

/**
 * Loads a checkpoint state from disk, or returns `null` when no valid file
 * exists or the file contains unparseable JSON.
 *
 * @param planName - Unique name of the plan to load
 * @param outputDir - Custom output directory; defaults to `_agent-loop-output`
 */
export function loadCheckpoint(planName: string, outputDir?: string): CheckpointState | null {
  const path = checkpointPath(planName, outputDir)
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, 'utf-8')
    const state = JSON.parse(raw) as CheckpointState
    return state
  } catch (err) {
    console.warn(`[checkpoint] Failed to parse checkpoint for ${planName}:`, err)
    return null
  }
}

/**
 * Deletes the checkpoint file for a given plan.
 *
 * Silently succeeds when the file does not exist.
 *
 * @param planName - Unique name of the plan to clear
 * @param outputDir - Custom output directory; defaults to `_agent-loop-output`
 */
export function clearCheckpoint(planName: string, outputDir?: string): void {
  const path = checkpointPath(planName, outputDir)
  if (!existsSync(path)) return
  unlinkSync(path)
  console.log(`[checkpoint] Cleared checkpoint for ${planName}`)
}

/**
 * Returns `true` when a checkpoint exists, references the current plan file,
 * and contains at least one completed task.
 *
 * This is a lightweight synchronous check meant to be called before deciding
 * whether to resume from a checkpoint or start fresh.
 *
 * @param planName - Unique name of the plan
 * @param planPath - Absolute path to the plan YAML that should match
 * @param outputDir - Custom output directory; defaults to `_agent-loop-output`
 */
export function hasValidCheckpoint(planName: string, planPath: string, outputDir?: string): boolean {
  const state = loadCheckpoint(planName, outputDir)
  if (!state) return false
  if (state.planPath !== planPath) return false
  if (state.completedTaskIds.length === 0) return false
  return true
}

/**
 * Filters a list of plan tasks, returning only those whose `id` has not
 * yet been recorded as completed in the checkpoint state.
 *
 * Preserves the original task ordering.
 *
 * @param tasks - Full list of plan tasks
 * @param state - Checkpoint state containing completed task IDs
 */
export function filterPendingTasks(tasks: PlanYamlTask[], state: CheckpointState): PlanYamlTask[] {
  return tasks.filter((t) => !state.completedTaskIds.includes(t.id))
}
