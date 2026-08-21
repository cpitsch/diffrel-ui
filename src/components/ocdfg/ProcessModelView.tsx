import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { Slider, Text } from "@radix-ui/themes";

import { buildStrokeColorMap } from "../../objectTypeColors";
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
  minEffectSize: number,
): { nodes: Node[]; edges: Edge[]; overlayCoverage: { shown: number; total: number } } {
  if (!data) return { nodes: [], edges: [], overlayCoverage: { shown: 0, total: 0 } };
  const { skeleton, comparison, drilldowns, e2eDrilldowns, followsMode } = data;
  const overlayLabel =
    followsMode === "DirectlyFollows" ? "directly-follows" : "eventually-follows";

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

  // Terminal (start/end) nodes stay per object type — reserved as future O2O anchor points,
  // per the original design; not affected by combining directly-follows arcs below.
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
        data: { kind: "start", color } satisfies TerminalNodeData,
      });
      nodes.push({
        id: endId,
        type: "terminal",
        position: { x: 0, y: 0 },
        data: { kind: "end", color } satisfies TerminalNodeData,
      });
    }

    for (const act of dfg.startActivities) {
      edges.push({
        id: `dfg::${objectType}::START->${act}`,
        source: startId,
        target: act,
        type: "default",
        // No text label: object type is already conveyed by arc color. Text annotations are
        // reserved for the significant overlay below.
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

  // DF backbone: joint (both logs), fan-out-filtered directly-follows arcs from the backend —
  // solid, colored by object type, never dashed.
  for (const edge of skeleton.edges) {
    const { from, to, qualifier } = edge;
    const qualifierLabel = qualifier.join(", ");
    const color = colorMap[qualifier[0]] ?? "#9ca3af";

    edges.push({
      id: `dfg::${from}->${to}::${qualifierLabel}`,
      source: from,
      target: to,
      type: "default",
      // No text label: object type is already conveyed by arc color. Text annotations are
      // reserved for the significant overlay below.
      data: { label: "", color, group: qualifierLabel } satisfies DfgEdgeData,
    });
  }

  // Significant overlay: a separate layer of dashed arcs, one per significant relationship of
  // `followsMode` (eventually- or directly-follows, whichever the data was fetched with) —
  // independent of whether a DF backbone arc already connects the same activities, since
  // eventually-follows can span further than one direct step. A conceptually distinct layer from
  // the DF backbone above. Statistical significance alone is sensitive to sample size, not
  // magnitude, so additionally require the Cliff's delta effect size to clear `minEffectSize`
  // before an edge is shown.
  let overlayShown = 0;
  let overlayTotal = 0;
  for (const [from, results] of Object.entries(e2eDrilldowns)) {
    for (const r of results) {
      overlayTotal++;
      if (Math.abs(r.effectSize) < minEffectSize) continue;
      overlayShown++;
      // In "Single" qualifier-grouping mode every relation is already a lone object type, so
      // this is exact, not a guess; in "Grouped" mode it's still only one of possibly several
      // co-occurring types (data.label carries the full qualifier either way).
      const types = r.qualifier.split(", ");
      const color = colorMap[types[0]] ?? "#9ca3af";
      edges.push({
        id: `e2e-overlay::${from}->${r.objectType}::${r.qualifier}`,
        source: from,
        target: r.objectType,
        type: "default",
        data: {
          label: r.qualifier,
          color,
          group: r.qualifier,
          deviation: { significant: true },
        } satisfies DfgEdgeData,
      });
    }
  }

  const edgesByQualifier: Record<string, number> = {};
  for (const edge of skeleton.edges) {
    const key = edge.qualifier.join(", ");
    edgesByQualifier[key] = (edgesByQualifier[key] ?? 0) + 1;
  }
  console.log(
    `[ProcessModel] rendering ${edges.length} edges total: ${skeleton.edges.length} DF arcs across ${Object.keys(edgesByQualifier).length} distinct object-type combinations, ${overlayShown}/${overlayTotal} significant ${overlayLabel} overlay arcs shown (effect size >= ${minEffectSize})`,
    edgesByQualifier,
  );

  return { nodes, edges, overlayCoverage: { shown: overlayShown, total: overlayTotal } };
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
  // Default is the conventional "medium" cutoff for Cliff's delta (Romano et al., 2006) — the
  // overlay starts out hiding negligible- and small-effect-size deviations, even if significant.
  const [minEffectSize, setMinEffectSize] = useState(0.33);

  const colorMap = useMemo(() => {
    if (!log1Summary || !log2Summary) return {};
    return buildStrokeColorMap([...log1Summary.objectTypes, ...log2Summary.objectTypes]);
  }, [log1Summary, log2Summary]);

  const { nodes, edges, overlayCoverage } = useMemo(
    () => buildProcessModelGraph(data, colorMap, minEffectSize),
    [data, colorMap, minEffectSize],
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
          minEffectSize={minEffectSize}
          onMinEffectSizeChange={setMinEffectSize}
          overlayCoverage={overlayCoverage}
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
  minEffectSize,
  onMinEffectSizeChange,
  overlayCoverage,
}: {
  initialNodes: Node[];
  initialEdges: Edge[];
  colorMap: Record<string, string>;
  minEffectSize: number;
  onMinEffectSizeChange: (v: number) => void;
  overlayCoverage: { shown: number; total: number };
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
      <Panel position="top-right" style={{ top: "50%", transform: "translateY(-50%)" }}>
        <div
          style={{
            background: "#fff",
            border: "1px solid rgba(0,0,0,0.1)",
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: "0.75rem",
          }}
        >
          <Text size="1" weight="medium" mb="1" style={{ display: "block", textAlign: "center" }}>
            Effect size
          </Text>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Slider
              size="1"
              orientation="vertical"
              style={{ height: 96 }}
              min={0}
              max={1}
              step={0.01}
              value={[minEffectSize]}
              onValueChange={([v]) => onMinEffectSizeChange(v)}
            />
            <Text as="div" size="1" color="gray" style={{ textAlign: "center" }}>
              {overlayCoverage.shown} / {overlayCoverage.total} edges
              <br />
              δ ≥ {minEffectSize.toFixed(2)}
            </Text>
          </div>
        </div>
      </Panel>
      <Legend colorMap={colorMap} />
    </ReactFlow>
  );
}
