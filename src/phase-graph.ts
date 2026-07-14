import type { PhaseDef } from './types.js';

/**
 * Topological sort of phases into sequential layers.
 *
 * Phases WITHIN a layer have no interdependencies and can run concurrently.
 * Layers themselves must run sequentially.
 *
 * A phase with no `dependsOn` (or empty array) is placed in layer 0 —
 * this preserves the existing sequential-by-declaration-order behavior when
 * the plan's tasks don't use explicit dependencies.
 *
 * @throws Error if a cycle is detected among phases
 * @throws Error if a phase references an unknown dependency id
 */
export function topoSortLayers(phases: PhaseDef[]): PhaseDef[][] {
  if (phases.length === 0) return [];

  const nameToPhase = new Map<string, PhaseDef>();
  for (const p of phases) {
    nameToPhase.set(p.name, p);
  }

  // Validate all dependency references exist
  for (const p of phases) {
    if (p.dependsOn) {
      for (const depId of p.dependsOn) {
        if (!nameToPhase.has(depId)) {
          throw new Error(
            `unknown dependsOn id: "${depId}" referenced by phase "${p.name}"`,
          );
        }
      }
    }
  }

  const placed = new Set<string>();
  const layers: PhaseDef[][] = [];

  // Track which phases have been assigned to a layer
  const remaining = new Set(phases.map((p) => p.name));

  // Iteratively build layers
  while (remaining.size > 0) {
    const layer: PhaseDef[] = [];

    for (const name of remaining) {
      const phase = nameToPhase.get(name)!;
      const deps = phase.dependsOn ?? [];
      // A phase goes into this layer if all its deps are already placed
      if (deps.every((d) => placed.has(d))) {
        layer.push(phase);
      }
    }

    if (layer.length === 0) {
      // No progress — remaining phases all have unmet dependencies => cycle
      const remainingNames = [...remaining];
      const cycles = remainingNames.filter((n) => {
        const deps = nameToPhase.get(n)!.dependsOn ?? [];
        return deps.some((d) => remaining.has(d));
      });
      throw new Error(
        `cycle detected among phases: ${cycles.join(', ')}`,
      );
    }

    for (const p of layer) {
      placed.add(p.name);
      remaining.delete(p.name);
    }

    layers.push(layer);
  }

  return layers;
}
