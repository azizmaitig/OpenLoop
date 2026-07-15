// lib/dag-layout.ts — dagre auto-layout for DAG nodes. Re-computes x/y
// positions from the node/edge graph whenever nodes change (top-down, TB).

import dagre from '@dagrejs/dagre';
import type { DagNodeData, DagEdgeData } from './types';

export const NODE_W = 220;
export const NODE_H = 80;

export interface PositionedNode {
  id: string;
  position: { x: number; y: number };
}

/**
 * Compute dagre positions for the given nodes and edges.
 * Returns a map of nodeId → {x,y}. Nodes not in the graph get x=0,y=0.
 */
export function computeLayout(
  nodes: DagNodeData[],
  edges: DagEdgeData[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 30, marginy: 30 });

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const dagNode = g.node(n.id);
    positions.set(n.id, {
      x: dagNode ? dagNode.x - NODE_W / 2 : 0,
      y: dagNode ? dagNode.y - NODE_H / 2 : 0,
    });
  }
  return positions;
}
