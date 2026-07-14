import { describe, expect, test } from 'bun:test';
import { topoSortLayers } from '../src/phase-graph.js';
import type { PhaseDef } from '../src/types.js';

function phase(name: string, dependsOn?: string[]): PhaseDef {
  return {
    name,
    command: 'echo ' + name,
    expectedExitCode: 0,
    timeoutMs: 5000,
    ...(dependsOn ? { dependsOn } : {}),
  };
}

describe('topoSortLayers', () => {
  test('empty list returns empty layers', () => {
    expect(topoSortLayers([])).toEqual([]);
  });

  test('single phase produces one layer with one phase', () => {
    const layers = topoSortLayers([phase('a')]);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveLength(1);
    expect(layers[0][0].name).toBe('a');
  });

  test('no dependsOn — each phase its own sequential layer in order', () => {
    const phases = [phase('a'), phase('b'), phase('c')];
    const layers = topoSortLayers(phases);
    // All have no deps => all go in layer 0
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveLength(3);
    expect(layers[0].map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  test('independent phases share the same layer', () => {
    const phases = [
      phase('a', []),
      phase('b', []),
      phase('c'),
    ];
    const layers = topoSortLayers(phases);
    // All have no deps (or empty array) => all in layer 0
    expect(layers).toHaveLength(1);
    expect(layers[0].map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  test('simple linear chain produces sequential layers', () => {
    const phases = [
      phase('a'),
      phase('b', ['a']),
      phase('c', ['b']),
    ];
    const layers = topoSortLayers(phases);
    expect(layers).toHaveLength(3);
    expect(layers[0].map((p) => p.name)).toEqual(['a']);
    expect(layers[1].map((p) => p.name)).toEqual(['b']);
    expect(layers[2].map((p) => p.name)).toEqual(['c']);
  });

  test('two independent phases in layer0, one depending on both in layer1', () => {
    const phases = [
      phase('a'),
      phase('b'),
      phase('c', ['a', 'b']),
    ];
    const layers = topoSortLayers(phases);
    expect(layers).toHaveLength(2);
    expect(layers[0].map((p) => p.name)).toEqual(['a', 'b']);
    expect(layers[1].map((p) => p.name)).toEqual(['c']);
  });

  test('fan-out: one phase in layer0 fans to two in layer1', () => {
    const phases = [
      phase('a'),
      phase('b', ['a']),
      phase('c', ['a']),
    ];
    const layers = topoSortLayers(phases);
    expect(layers).toHaveLength(2);
    expect(layers[0].map((p) => p.name)).toEqual(['a']);
    expect(layers[1].map((p) => p.name)).toEqual(['b', 'c']);
  });

  test('diamond dependency', () => {
    const phases = [
      phase('a'),
      phase('b', ['a']),
      phase('c', ['a']),
      phase('d', ['b', 'c']),
    ];
    const layers = topoSortLayers(phases);
    expect(layers).toHaveLength(3);
    expect(layers[0].map((p) => p.name)).toEqual(['a']);
    expect(layers[1].map((p) => p.name)).toEqual(['b', 'c']);
    expect(layers[2].map((p) => p.name)).toEqual(['d']);
  });

  test('throws on unknown dependency id', () => {
    const phases = [phase('a', ['nonexistent'])];
    expect(() => topoSortLayers(phases)).toThrow('unknown dependsOn id');
    expect(() => topoSortLayers(phases)).toThrow('nonexistent');
  });

  test('throws on cycle (a depends on b, b depends on a)', () => {
    const phases = [
      phase('a', ['b']),
      phase('b', ['a']),
    ];
    expect(() => topoSortLayers(phases)).toThrow('cycle detected');
  });

  test('throws on self-cycle (a depends on a)', () => {
    const phases = [phase('a', ['a'])];
    expect(() => topoSortLayers(phases)).toThrow('cycle detected');
  });

  test('throws on transitive cycle', () => {
    const phases = [
      phase('a', ['b']),
      phase('b', ['c']),
      phase('c', ['a']),
    ];
    expect(() => topoSortLayers(phases)).toThrow('cycle detected');
  });

  test('preserves order within a layer (declaration order)', () => {
    const phases = [
      phase('z'),
      phase('y'),
      phase('x'),
    ];
    const layers = topoSortLayers(phases);
    expect(layers[0].map((p) => p.name)).toEqual(['z', 'y', 'x']);
  });
});
