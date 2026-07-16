// lib/dag-layout.ts — dagre auto-layout for DAG nodes. Re-computes x/y
// positions from the node/edge graph whenever nodes change (top-down, TB).
//
// The loop node (kind === 'loop') is laid out by hand at top-center because
// dagre is a DAG-only engine and cannot handle the cycle introduced by the
// LOOP back-edge. Phase nodes are still laid out by dagre in their sub-DAG.

import dagre from '@dagrejs/dagre';
import type { DagNodeData, DagEdgeData } from './types';

export const NODE_W = 220;
export const NODE_H = 80;

export interface PositionedNode {
  id: string;
  position: { x: number; y: number };
}

/**
 * Compute positions for the given nodes and edges.
 * Loop nodes are hand-positioned at top-center.
 * Phase/task/gate nodes are laid out by dagre.
 * Back-edges (loop-back-*) are excluded from dagre to avoid cycles.
 * Returns a map of nodeId → {x,y}. Nodes not in the graph get x=0,y=0.
 */
export function computeLayout(
  nodes: DagNodeData[],
  edges: DagEdgeData[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  // Partition nodes: loop nodes vs everything else
  const loopNodes = nodes.filter((n) => n.kind === 'loop');
  const otherNodes = nodes.filter((n) => n.kind !== 'loop');

  // Exclude any edge touching a loop node from dagre (they form cycles)
  const loopNodeIds = new Set(nodes.filter((n) => n.kind === 'loop').map((n) => n.id));
  const dagreEdges = edges.filter((e) => !loopNodeIds.has(e.source) && !loopNodeIds.has(e.target));

  if (otherNodes.length === 0) {
    // Only loop nodes — center them
    for (const n of loopNodes) {
      positions.set(n.id, {
        x: n.id.charCodeAt(n.id.length - 1) * 50,
        y: 40,
      });
    }
    return positions;
  }

  // Lay out the phase/task/gate sub-DAG with dagre
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 30, marginy: 30 });

  for (const n of otherNodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  }
  for (const e of dagreEdges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  // Extract dagre positions
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;

  for (const n of otherNodes) {
    const dagNode = g.node(n.id);
    if (dagNode) {
      const x = dagNode.x - NODE_W / 2;
      const y = dagNode.y - NODE_H / 2;
      positions.set(n.id, { x, y });
      if (x < minX) minX = x;
      if (x + NODE_W > maxX) maxX = x + NODE_W;
      if (y < minY) minY = y;
      if (y + NODE_H > maxY) maxY = y + NODE_H;
    } else {
      positions.set(n.id, { x: 0, y: 0 });
    }
  }

  // Position loop nodes at top-center of the dagre layout
  const layoutCenterX = minX === Infinity ? 0 : (minX + maxX) / 2;
  const loopTopY = minY === Infinity ? 40 : Math.max(10, minY - NODE_H - 50);

  for (const n of loopNodes) {
    positions.set(n.id, { x: layoutCenterX - NODE_W / 2, y: loopTopY });
  }

  return positions;
}
