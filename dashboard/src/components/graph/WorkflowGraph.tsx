import { useMemo, useCallback, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type OnSelectionChangeParams,
  type NodeChange,
  MarkerType,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import DagNode from './DagNode';
import { computeLayout, NODE_W } from '../../lib/dag-layout';
import { useDagStore } from '../../stores/dag-store';
import type { DagNodeData } from '../../lib/types';

const nodeTypes = { dagNode: DagNode };

/** Build React Flow nodes from DAG data, merging user-dragged positions over layout. */
export function buildRfNodes(
  dagNodes: DagNodeData[],
  positions: Map<string, { x: number; y: number }>,
  selectedNodeId: string | null,
  draggedPositions: Map<string, { x: number; y: number }>,
): Node[] {
  return dagNodes.map((n) => {
    const layoutPos = positions.get(n.id) ?? { x: 0, y: 0 };
    const dragged = draggedPositions.get(n.id);
    return {
      id: n.id,
      type: 'dagNode',
      position: dragged ?? layoutPos,
      data: n as unknown as Record<string, unknown>,
      width: NODE_W,
      draggable: true,
      selected: n.id === selectedNodeId,
    };
  });
}

export function WorkflowGraph() {
  const dagNodes = useDagStore((s) => s.dagNodes);
  const dagEdges = useDagStore((s) => s.dagEdges);
  const selectedNodeId = useDagStore((s) => s.selectedNodeId);
  const setSelectedNode = useDagStore((s) => s.setSelectedNode);

  const posCache = useRef<Map<string, { x: number; y: number }>>(new Map());
  const posSig = useRef('');

  const positions = useMemo(() => {
    const sig =
      dagNodes.map((n) => n.id).join('|') +
      '::' +
      dagEdges.map((e) => e.source + '>' + e.target).join('|');
    if (posSig.current === sig) return posCache.current;
    posCache.current = computeLayout(dagNodes, dagEdges);
    posSig.current = sig;
    return posCache.current;
  }, [dagNodes, dagEdges]);

  const draggedPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === 'position' && !change.dragging && change.position) {
        draggedPositionsRef.current.set(change.id, change.position);
      }
      // selection is handled by onSelectionChange
    }
  }, []);

  const rfNodes: Node[] = useMemo(
    () => buildRfNodes(dagNodes, positions, selectedNodeId, draggedPositionsRef.current),
    [dagNodes, positions, selectedNodeId],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      dagEdges.map((e) => {
        const target = dagNodes.find((n) => n.id === e.target);
        const animated = target?.status === 'running';
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          animated,
          style: {
            stroke: animated ? 'var(--warn)' : 'var(--border)',
            strokeWidth: animated ? 2 : 1.5,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: animated ? 'var(--warn)' : 'var(--text-dim)',
          },
        };
      }),
    [dagEdges, dagNodes],
  );

  const handleSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      if (params.nodes.length === 1) {
        setSelectedNode(params.nodes[0].id);
      } else if (params.nodes.length === 0) {
        setSelectedNode(null);
      }
    },
    [setSelectedNode],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onSelectionChange={handleSelectionChange}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.2}
      maxZoom={3}
      panOnDrag
      selectNodesOnDrag={false}
      nodesDraggable={true}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
      <Controls showInteractive={false} className="dag-controls" />
      <MiniMap
        nodeStrokeColor="var(--border)"
        nodeColor={(n) => {
          const nd = n.data as unknown as DagNodeData | undefined;
          const s = nd?.status;
          if (s === 'running') return 'var(--warn)';
          if (s === 'completed') return 'var(--ok)';
          if (s === 'failed') return 'var(--crit)';
          return 'var(--bg-elev-2)';
        }}
        maskColor="rgba(13,17,23,0.7)"
        style={{ border: '1px solid var(--border)' }}
      />
    </ReactFlow>
  );
}
