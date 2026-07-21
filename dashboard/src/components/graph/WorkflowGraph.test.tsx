import { describe, it, expect } from 'vitest';
import { buildRfNodes } from './WorkflowGraph';
import { NODE_W } from '../../lib/dag-layout';
import type { DagNodeData } from '../../lib/types';

describe('buildRfNodes', () => {
  const nodes: DagNodeData[] = [
    { id: 'a', label: 'A', kind: 'phase', status: 'running' },
    { id: 'b', label: 'B', kind: 'phase', status: 'completed' },
  ];

  const positions = new Map([
    ['a', { x: 100, y: 200 }],
    ['b', { x: 300, y: 400 }],
  ]);

  it('merges dragged position over layout position', () => {
    const dragged = new Map([['a', { x: 999, y: 888 }]]);
    const result = buildRfNodes(nodes, positions, dragged);
    expect(result.find((n) => n.id === 'a')!.position).toEqual({ x: 999, y: 888 });
    expect(result.find((n) => n.id === 'b')!.position).toEqual({ x: 300, y: 400 });
  });

  it('falls back to layout position when node was not dragged', () => {
    const result = buildRfNodes(nodes, positions, new Map());
    expect(result.find((n) => n.id === 'a')!.position).toEqual({ x: 100, y: 200 });
    expect(result.find((n) => n.id === 'b')!.position).toEqual({ x: 300, y: 400 });
  });

  it('falls back to {x:0,y:0} for nodes absent from layout positions', () => {
    const emptyPos = new Map();
    const result = buildRfNodes(nodes, emptyPos, new Map());
    expect(result.find((n) => n.id === 'a')!.position).toEqual({ x: 0, y: 0 });
  });

  it('sets draggable=true and width=NODE_W on every node', () => {
    const result = buildRfNodes(nodes, positions, new Map());
    for (const n of result) {
      expect(n.draggable).toBe(true);
      expect(n.width).toBe(NODE_W);
    }
  });

  it('returns one node per input dag node', () => {
    const result = buildRfNodes(nodes, positions, new Map());
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });
});
