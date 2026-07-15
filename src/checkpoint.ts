import type { CheckpointState, PlanYamlTask } from './types.js'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { OUTPUT_DIR } from './constants.js'

export function checkpointPath(planName: string, outputDir?: string): string {
  return resolve(outputDir ?? OUTPUT_DIR, `checkpoint-${planName}.json`)
}

export async function saveCheckpoint(state: CheckpointState, outputDir?: string): Promise<void> {
  state.updatedAt = new Date().toISOString()
  const filePath = checkpointPath(state.planName, outputDir)
  try {
    const dir = resolve(outputDir ?? OUTPUT_DIR)
    mkdirSync(dir, { recursive: true })
    await Bun.write(filePath, JSON.stringify(state, null, 2))
    console.log('[checkpoint] Saved checkpoint:', filePath)
  } catch (err) {
    console.error('[checkpoint] Failed to save checkpoint:', err)
    throw err
  }
}

export function loadCheckpoint(planName: string, outputDir?: string): CheckpointState | null {
  const path = checkpointPath(planName, outputDir)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as CheckpointState
  } catch (err) {
    console.warn(`[checkpoint] Failed to parse checkpoint for ${planName}:`, err)
    return null
  }
}

export function clearCheckpoint(planName: string, outputDir?: string): void {
  const path = checkpointPath(planName, outputDir)
  if (!existsSync(path)) return
  unlinkSync(path)
  console.log(`[checkpoint] Cleared checkpoint for ${planName}`)
}

export function hasValidCheckpoint(planName: string, planPath: string, outputDir?: string): boolean {
  const state = loadCheckpoint(planName, outputDir)
  if (!state) return false
  if (state.planPath !== planPath) return false
  if (state.completedTaskIds.length === 0) return false
  return true
}

export function filterPendingTasks(tasks: PlanYamlTask[], state: CheckpointState): PlanYamlTask[] {
  return tasks.filter((t) => !state.completedTaskIds.includes(t.id))
}
