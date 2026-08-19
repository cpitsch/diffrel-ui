import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";

import { buildColorMap } from "../../objectTypeColors";
import type { ProcessModelData } from "../../processModel";
import type { LogSummary } from "../../types";
import { ActivityNode, type ActivityNodeData } from "./ActivityNode";
import { TerminalNode, type TerminalNodeData } from "./TerminalNode";
import { Legend } from "./Legend";
import { DFG_EDGE_TYPES, type DfgEdgeData } from "./vendor/dfg/DfgEdge";
import {
  DFG_END_ID,
  DFG_START_ID,
  OCEL_NODE_HEIGHT,
  OCEL_NODE_WIDTH,
  TERM_NODE_SIZE,
} from "./vendor/dfg/util/dfg-model";
import { createElkGraphLayout, type DfgLayoutNode } from "./vendor/elk-layout/dfg";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NODE_TYPES: Record<string, any> = {
  activity: ActivityNode,
  terminal: TerminalNode,
};

const START_COLOR = "#a855f7";
const END_COLOR = "#ef4444";

interface ProcessModelViewProps {
  log1Summary: LogSummary | null;
  log2Summary: LogSummary | null;
  /** Fetched once in App.tsx as soon as both logs are loaded — this view only renders it. */
  data: ProcessModelData | null;
  isPending: boolean;
  error: string | null;
}

function buildProcessModelGraph(
  data: ProcessModelData | null,
  colorMap: Record<string, string>,
): { nodes: Node[]; edges: Edge[] } {
  if (!data) return { nodes: [], edges: [] };
  const { skeleton, comparison, drilldowns } = data;

  // An activity's occurrence count differs per object type (each object-type DFG only "sees" the
  // events touching objects of that type); take the max as a representative size, not the sum
  // (summing would multiply-count events that relate to several object types).
  const activityCounts = new Map<string, number>();
  for (const dfg of Object.values(skeleton.objectTypeToDfg)) {
    for (const [activity, count] of Object.entries(dfg.activities)) {
      activityCounts.set(activity, Math.max(activityCounts.get(activity) ?? 0, count));
    }
  }

  const e2eSignificant = new Set<string>();
  for (const result of Object.values(comparison.results)) {
    if (result.mode === "E2E" && result.isSignificant) {
      e2eSignificant.add(result.groupKey);
    }
  }

  const nodes: Node[] = [];
  for (const [activity, count] of activityCounts) {
    const deviatingObjectTypes = (drilldowns[activity] ?? []).map((d) => ({
      objectType: d.objectType,
      color: colorMap[d.objectType] ?? "#9ca3af",
    }));
    nodes.push({
      id: activity,
      type: "activity",
      position: { x: 0, y: 0 },
      data: {
        activity,
        count,
        deviatingObjectTypes,
        e2eSignificant: e2eSignificant.has(activity),
      } satisfies ActivityNodeData,
    });
  }

  const edges: Edge[] = [];
  for (const [objectType, dfg] of Object.entries(skeleton.objectTypeToDfg)) {
    const color = colorMap[objectType] ?? "#9ca3af";
    const startId = `${DFG_START_ID}::${objectType}`;
    const endId = `${DFG_END_ID}::${objectType}`;
    const hasTerminals = dfg.startActivities.length > 0 || dfg.endActivities.length > 0;

    if (hasTerminals) {
      nodes.push({
        id: startId,
        type: "terminal",
        position: { x: 0, y: 0 },
        data: { kind: "start", color: START_COLOR } satisfies TerminalNodeData,
      });
      nodes.push({
        id: endId,
        type: "terminal",
        position: { x: 0, y: 0 },
        data: { kind: "end", color: END_COLOR } satisfies TerminalNodeData,
      });
    }

    for (const [from, to, count] of dfg.directlyFollowsRelations) {
      edges.push({
        id: `dfg::${objectType}::${from}->${to}`,
        source: from,
        target: to,
        type: "default",
        data: {
          label: String(count),
          color,
          group: objectType,
          deviation: {
            significant: e2eSignificant.has(from) || e2eSignificant.has(to),
          },
        } satisfies DfgEdgeData,
      });
    }
    for (const act of dfg.startActivities) {
      edges.push({
        id: `dfg::${objectType}::START->${act}`,
        source: startId,
        target: act,
        type: "default",
        data: { label: "", color, group: objectType } satisfies DfgEdgeData,
      });
    }
    for (const act of dfg.endActivities) {
      edges.push({
        id: `dfg::${objectType}::${act}->END`,
        source: act,
        target: endId,
        type: "default",
        data: { label: "", color, group: objectType } satisfies DfgEdgeData,
      });
    }
  }

  return { nodes, edges };
}

const emptyStateStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "#9ca3af",
  fontSize: "1rem",
  textAlign: "center",
  padding: "0 2rem",
};

const errorBannerStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 10,
  background: "#fef2f2",
  color: "#991b1b",
  border: "1px solid #fecaca",
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: "0.8rem",
  maxWidth: "80%",
  wordBreak: "break-word",
};

export function ProcessModelView({
  log1Summary,
  log2Summary,
  data,
  isPending,
  error,
}: ProcessModelViewProps) {
  const colorMap = useMemo(() => {
    if (!log1Summary || !log2Summary) return {};
    return buildColorMap([...log1Summary.objectTypes, ...log2Summary.objectTypes]);
  }, [log1Summary, log2Summary]);

  const { nodes, edges } = useMemo(
    () => buildProcessModelGraph(data, colorMap),
    [data, colorMap],
  );

  if (!data) {
    return (
      <div style={emptyStateStyle}>
        {isPending
          ? "Discovering process model…"
          : error
            ? `Failed to discover process model: ${error}`
            : "Load both logs to discover the process model."}
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {error && <div style={errorBannerStyle}>{error}</div>}
      <ReactFlowProvider>
        <ProcessModelCanvas
          key={JSON.stringify(Object.keys(data.skeleton.objectTypeToDfg))}
          initialNodes={nodes}
          initialEdges={edges}
          colorMap={colorMap}
        />
      </ReactFlowProvider>
    </div>
  );
}

/** Fixed per-type footprint (matches the CSS in ActivityNode.module.css / TerminalNode.tsx) — the
 *  vendored ELK layout wants sizes up front, not measured DOM dimensions, so layout can run
 *  synchronously on data arrival instead of waiting for a render + ResizeObserver round trip. */
function nodeSize(n: DfgLayoutNode): { width: number; height: number } {
  if (n.type === "terminal") return { width: TERM_NODE_SIZE, height: TERM_NODE_SIZE };
  return { width: OCEL_NODE_WIDTH, height: OCEL_NODE_HEIGHT };
}

function ProcessModelCanvas({
  initialNodes,
  initialEdges,
  colorMap,
}: {
  initialNodes: Node[];
  initialEdges: Edge[];
  colorMap: Record<string, string>;
}) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);
  const { fitView } = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    // The layout function mutates in place, so hand it fresh copies rather than the props arrays.
    const nodesCopy = initialNodes.map((n) => ({ ...n, position: { ...n.position } }));
    const edgesCopy = initialEdges.map((e) => ({ ...e, data: { ...e.data } }));
    createElkGraphLayout("TB")(nodesCopy, edgesCopy, nodeSize)
      .then(() => {
        if (cancelled) return;
        setNodes(nodesCopy);
        setEdges(edgesCopy);
        setTimeout(() => fitView({ padding: 0.15 }), 50);
      })
      .catch((err) => {
        console.error("[ProcessModel] layout failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [initialNodes, initialEdges, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={DFG_EDGE_TYPES}
      fitView
    >
      <Background />
      <Controls />
      <Legend colorMap={colorMap} />
    </ReactFlow>
  );
}
