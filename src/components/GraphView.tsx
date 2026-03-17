import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";

import { applyDagreLayout } from "../layout";
import { buildColorMap } from "../objectTypeColors";
import type {
  ComparisonOutput,
  EventTypeNodeData,
  EventTypePresence,
  ObjectTypeNodeData,
} from "../types";
import { EventTypeNode } from "./EventTypeNode";
import { FloatingEdge } from "./FloatingEdge";
import { ObjectTypeNode } from "./ObjectTypeNode";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: Record<string, any> = {
  eventType: EventTypeNode,
  objectType: ObjectTypeNode,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const edgeTypes: Record<string, any> = {
  floating: FloatingEdge,
};

interface GraphViewProps {
  comparison: ComparisonOutput | null;
  log1EventTypes: string[];
  log2EventTypes: string[];
  /** Increments on every new run — forces the canvas to remount and re-layout. */
  runId: number;
}

function buildGraph(
  comparison: ComparisonOutput,
  log1EventTypes: string[],
  log2EventTypes: string[]
): { nodes: Node[]; edges: Edge[] } {
  const { results, onlyInLog1, onlyInLog2 } = comparison;

  const allObjectTypes = Object.values(results).flatMap((r) =>
    r.objectTypeRelations.map((rel) => rel.objectType)
  );
  const colorMap = buildColorMap(allObjectTypes);

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const allEventTypes = new Set([
    ...log1EventTypes,
    ...log2EventTypes,
    ...onlyInLog1,
    ...onlyInLog2,
  ]);

  for (const eventType of allEventTypes) {
    let presence: EventTypePresence;
    if (onlyInLog1.includes(eventType)) {
      presence = "onlyInLog1";
    } else if (onlyInLog2.includes(eventType)) {
      presence = "onlyInLog2";
    } else {
      presence = "both";
    }

    const result = results[eventType] ?? null;
    const data: EventTypeNodeData = { eventType, presence, result };

    nodes.push({
      id: `evt-${eventType}`,
      type: "eventType",
      position: { x: 0, y: 0 },
      data,
    });

    if (result) {
      for (const rel of result.objectTypeRelations) {
        const objId = `obj-${eventType}|${rel.qualifier}|${rel.objectType}`;
        const data: ObjectTypeNodeData = {
          objectType: rel.objectType,
          qualifier: rel.qualifier,
          medianLog1: rel.medianLog1,
          medianLog2: rel.medianLog2,
          color: colorMap[rel.objectType] ?? "#d1d5db",
        };
        nodes.push({
          id: objId,
          type: "objectType",
          position: { x: 0, y: 0 },
          data,
        });
        edges.push({
          id: `e-${eventType}-${rel.qualifier}-${rel.objectType}`,
          source: `evt-${eventType}`,
          target: objId,
          label: rel.qualifier,
          type: "floating",
        });
      }
    }
  }

  return { nodes, edges };
}

/** Inner canvas — must be mounted inside ReactFlowProvider. */
function FlowCanvas({
  initialNodes,
  initialEdges,
}: {
  initialNodes: Node[];
  initialEdges: Edge[];
}) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const edges = initialEdges; // edges have no interactive positions
  const nodesInitialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const layoutDone = useRef(false);

  // Allow interactive node dragging
  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  // Apply dagre layout once React Flow has measured all node sizes
  useEffect(() => {
    if (nodesInitialized && !layoutDone.current && nodes.length > 0) {
      layoutDone.current = true;
      setNodes((nds) => applyDagreLayout(nds, edges));
      setTimeout(() => fitView({ padding: 0.1 }), 50);
    }
  }, [nodesInitialized, edges, fitView]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      nodesConnectable={false}
      fitView
    >
      <Background />
      <Controls />
      <MiniMap />
    </ReactFlow>
  );
}

export function GraphView({
  comparison,
  log1EventTypes,
  log2EventTypes,
  runId,
}: GraphViewProps) {
  const { nodes, edges } = useMemo(
    () =>
      comparison
        ? buildGraph(comparison, log1EventTypes, log2EventTypes)
        : { nodes: [], edges: [] },
    [comparison, log1EventTypes, log2EventTypes]
  );

  // runId increments on every new run, ensuring FlowCanvas always remounts
  // even when the set of event types hasn't changed.
  const flowKey = comparison ? runId : "empty";

  if (!comparison) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#9ca3af",
          fontSize: "1rem",
        }}
      >
        Load both logs and run a comparison to see the graph.
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <FlowCanvas key={flowKey} initialNodes={nodes} initialEdges={edges} />
    </ReactFlowProvider>
  );
}
