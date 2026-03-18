import "@xyflow/react/dist/style.css";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";

import { applyElkLayout, applyHierarchicalLayout } from "../layout";
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
  runId: number;
}

// Set to true to include event types that appear in only one of the two logs.
const SHOW_SINGLE_LOG_EVENT_TYPES = false;

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
    ...(SHOW_SINGLE_LOG_EVENT_TYPES ? onlyInLog1 : []),
    ...(SHOW_SINGLE_LOG_EVENT_TYPES ? onlyInLog2 : []),
  ]);

  for (const eventType of allEventTypes) {
    let presence: EventTypePresence;
    if (onlyInLog1.includes(eventType)) presence = "onlyInLog1";
    else if (onlyInLog2.includes(eventType)) presence = "onlyInLog2";
    else presence = "both";

    if (!SHOW_SINGLE_LOG_EVENT_TYPES && presence !== "both") continue;

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

function FlowCanvas({
  initialNodes,
  initialEdges,
}: {
  initialNodes: Node[];
  initialEdges: Edge[];
}) {
  type LayoutMode = "force" | "hierarchical";

  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const nodesRef = useRef<Node[]>(initialNodes);
  const nodesInitialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("force");

  // Unidirectional: source → targets only (event nodes pull their object children)
  const childrenOf = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of initialEdges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      map.get(e.source)!.add(e.target);
    }
    return map;
  }, [initialEdges]);

  const animRef = useRef<number | null>(null);
  // Per-child data captured at drag start
  const dragParentPos = useRef<{ x: number; y: number } | null>(null);
  const dragParentSize = useRef<{ w: number; h: number }>({ w: 180, h: 60 });
  const childIds = useRef<Set<string>>(new Set());
  // original center-to-center distance from parent to each child
  const childDist = useRef<Map<string, number>>(new Map());
  // child node sizes for separation
  const childSize = useRef<Map<string, { w: number; h: number }>>(new Map());

  const displayEdges = useMemo(() => {
    if (layoutMode === "force") return initialEdges;
    return initialEdges.map((e) => ({
      ...e,
      type: undefined,
      sourceHandle: "bottom",
      targetHandle: "top",
    }));
  }, [initialEdges, layoutMode]);

  useEffect(() => {
    if (!nodesInitialized) return;
    const layoutFn = layoutMode === "force" ? applyElkLayout : applyHierarchicalLayout;
    layoutFn(nodesRef.current, initialEdges).then((laid) => {
      setNodes(laid);
      nodesRef.current = laid;
      setTimeout(() => fitView({ padding: 0.15 }), 50);
    });
  }, [nodesInitialized, layoutMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDragging = useRef(false);
  const LERP = 0.06;

  const runSpring = useCallback(() => {
    let stillMoving = false;
    const parent = dragParentPos.current;
    if (!parent) { animRef.current = null; return; }

    const pcx = parent.x + dragParentSize.current.w / 2;
    const pcy = parent.y + dragParentSize.current.h / 2;

    setNodes((nds) => {
      // Pass 1: lerp each child toward its radial target
      // (parent center + current direction × original distance)
      let next = nds.map((n) => {
        if (!childIds.current.has(n.id)) return n;
        const sz = childSize.current.get(n.id) ?? { w: 180, h: 60 };
        const ccx = n.position.x + sz.w / 2;
        const ccy = n.position.y + sz.h / 2;
        const dx = ccx - pcx;
        const dy = ccy - pcy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetDist = childDist.current.get(n.id) ?? dist;
        const tx = pcx + (dx / dist) * targetDist - sz.w / 2;
        const ty = pcy + (dy / dist) * targetDist - sz.h / 2;
        const ex = tx - n.position.x;
        const ey = ty - n.position.y;
        if (Math.abs(ex) > 0.5 || Math.abs(ey) > 0.5) stillMoving = true;
        return { ...n, position: { x: n.position.x + ex * LERP, y: n.position.y + ey * LERP } };
      });

      // Pass 2: separate overlapping children from each other
      const childList = next.filter((n) => childIds.current.has(n.id));
      for (let i = 0; i < childList.length; i++) {
        for (let j = i + 1; j < childList.length; j++) {
          const a = childList[i];
          const b = childList[j];
          const asz = childSize.current.get(a.id) ?? { w: 180, h: 60 };
          const bsz = childSize.current.get(b.id) ?? { w: 180, h: 60 };
          const minD = (Math.max(asz.w, asz.h) + Math.max(bsz.w, bsz.h)) / 2 + 8;
          const dx = (b.position.x + bsz.w / 2) - (a.position.x + asz.w / 2);
          const dy = (b.position.y + bsz.h / 2) - (a.position.y + asz.h / 2);
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist < minD) {
            const push = (minD - dist) / (2 * dist);
            const ai = next.findIndex((n) => n.id === a.id);
            const bi = next.findIndex((n) => n.id === b.id);
            next[ai] = { ...next[ai], position: { x: next[ai].position.x - dx * push, y: next[ai].position.y - dy * push } };
            next[bi] = { ...next[bi], position: { x: next[bi].position.x + dx * push, y: next[bi].position.y + dy * push } };
            stillMoving = true;
          }
        }
      }

      nodesRef.current = next;
      return next;
    });

    animRef.current = (isDragging.current || stillMoving)
      ? requestAnimationFrame(runSpring)
      : null;
  }, []);

  useEffect(() => () => { if (animRef.current) cancelAnimationFrame(animRef.current); }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => {
      const next = applyNodeChanges(changes, nds);
      nodesRef.current = next;
      return next;
    });
  }, []);

  const onNodeDragStart = useCallback((_: React.MouseEvent, node: Node) => {
    isDragging.current = true;
    if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null; }

    const children = childrenOf.get(node.id);
    if (!children || children.size === 0) return;

    const parentNode = nodesRef.current.find((n) => n.id === node.id);
    const pw = parentNode?.measured?.width ?? 180;
    const ph = parentNode?.measured?.height ?? 60;
    dragParentSize.current = { w: pw, h: ph };
    dragParentPos.current = { ...node.position };

    const pcx = node.position.x + pw / 2;
    const pcy = node.position.y + ph / 2;

    childIds.current = new Set(children);
    childDist.current.clear();
    childSize.current.clear();

    for (const n of nodesRef.current) {
      if (!children.has(n.id)) continue;
      const cw = n.measured?.width ?? 180;
      const ch = n.measured?.height ?? 60;
      const ccx = n.position.x + cw / 2;
      const ccy = n.position.y + ch / 2;
      childDist.current.set(n.id, Math.sqrt((ccx - pcx) ** 2 + (ccy - pcy) ** 2));
      childSize.current.set(n.id, { w: cw, h: ch });
    }

    animRef.current = requestAnimationFrame(runSpring);
  }, [childrenOf, runSpring]);

  const onNodeDrag = useCallback((_: React.MouseEvent, node: Node) => {
    dragParentPos.current = { ...node.position };
  }, []);

  const onNodeDragStop = useCallback(() => {
    isDragging.current = false;
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={displayEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      nodesConnectable={false}
      fitView
    >
      <Background />
      <Controls />
      <MiniMap />
      <Panel position="top-right">
        <button
          onClick={() => setLayoutMode((m) => m === "force" ? "hierarchical" : "force")}
          style={{
            padding: "4px 10px",
            fontSize: "12px",
            background: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: "4px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
            cursor: "pointer",
          }}
        >
          {layoutMode === "force" ? "Hierarchical" : "Force"} layout
        </button>
      </Panel>
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
