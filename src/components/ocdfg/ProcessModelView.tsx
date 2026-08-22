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
import { SegmentedControl, Slider, Text } from "@radix-ui/themes";

import { buildStrokeColorMap } from "../../objectTypeColors";
import type { ProcessModelData } from "../../processModel";
import type { DfgEdgeSkeleton, LogSummary } from "../../types";
import { ActivityNode, DEVIATING_DOTS_HEIGHT, type ActivityNodeData } from "./ActivityNode";
import { TerminalNode, type TerminalNodeData } from "./TerminalNode";
import { Legend, type ObjectTypeDeviations } from "./Legend";
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

type Coverage = { shown: number; total: number };

/** Which threshold gates a DF backbone arc's visibility: `Ratio` keeps an arc whose fan-out-
 *  relative frequency clears `minFanoutRatio` in at least one log; `Count` keeps, per object type,
 *  that type's top `dfArcCount` arcs by raw occurrence count, ranked independently per log and
 *  unioned. Mutually exclusive — only one is active at a time, toggled for direct comparison
 *  rather than combined. */
type DfFilterMode = "Ratio" | "Count";

const MAX_INITIAL_DF_ARCS = 25;

/** Feature flag: scale DF backbone arc stroke width by occurrence frequency (thicker = more
 *  common), using the same log-scaled formula propel itself uses (ported from the currently-
 *  unused `vendor/dfg/util/svg-export.ts`, which computes this for SVG/PNG export but isn't wired
 *  into the live canvas). `maxDfCount` is taken over the currently *shown* DF arcs only, so the
 *  scale stays meaningful as the Ratio/Count filter changes rather than being dragged down by
 *  arcs that got filtered out. Off switch here in case this turns out to be more visual noise
 *  than signal on top of color-by-object-type and the dashed significance overlay. */
const FREQUENCY_SCALED_EDGE_WIDTH = true;

/** Feature flag: after the normal 25-arc-cap seed search below, keep growing the per-group N
 *  until every activity that has an incoming DF edge somewhere in the full edge set retains at
 *  least one incoming edge in the selection. Doesn't guarantee full graph connectivity (a node's
 *  outgoing edges, or edges deep in an otherwise-sparse neighborhood, aren't covered) — just
 *  removes the worst case, an activity with zero visible arcs (e.g. propel itself has no such
 *  guarantee and can produce this). Off switch here in case this grows the default view too
 *  aggressively on some datasets. */
const SEED_UNTIL_EVERY_NODE_HAS_INPUT = true;

/** Auto-seeds `dfArcCount` similarly to propel's own per-group top-N filter (its `useDfgPanel`
 *  `unionAt`/seed search in `DfgGraph.tsx`): search for the largest per-group N whose *union*
 *  across all object types stays within `MAX_INITIAL_DF_ARCS`, so the initial view stays readable
 *  regardless of how many object types are present. Adapted for two logs: propel ranks a single
 *  log per group, so its union has a closed-form size (groups partition the edge set); here each
 *  group is ranked independently per log and then unioned, so the two logs' top-N sets can
 *  overlap in ways that formula doesn't account for — so this recomputes the real selection at
 *  each N instead of a formula. Union size only grows with N, so the search can stop at the first
 *  N that exceeds the cap. */
function computeDfArcCountSeed(edges: DfgEdgeSkeleton[]): number {
  if (edges.length === 0) return 1;

  const groups = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const type = e.qualifier[0];
    const list = groups.get(type);
    if (list) list.push(i);
    else groups.set(type, [i]);
  });

  // Deterministic tiebreak (matches propel's own `y.count - x.count || x.key.localeCompare(y.key)`):
  // without it, ties at the cutoff resolve via Rust `HashMap`'s randomized iteration order, which
  // isn't even stable across repeated loads of the same log.
  const arcKey = (i: number) => `${edges[i].from}->${edges[i].to}`;

  const rankedByLog1 = new Map<string, number[]>();
  const rankedByLog2 = new Map<string, number[]>();
  let maxGroupSize = 1;
  for (const [type, indices] of groups) {
    maxGroupSize = Math.max(maxGroupSize, indices.length);
    rankedByLog1.set(
      type,
      [...indices].sort(
        (a, b) => edges[b].countLog1 - edges[a].countLog1 || arcKey(a).localeCompare(arcKey(b)),
      ),
    );
    rankedByLog2.set(
      type,
      [...indices].sort(
        (a, b) => edges[b].countLog2 - edges[a].countLog2 || arcKey(a).localeCompare(arcKey(b)),
      ),
    );
  }

  const unionSizeAt = (n: number): number => {
    const keep = new Set<number>();
    for (const type of groups.keys()) {
      for (const i of rankedByLog1.get(type)!.slice(0, n)) keep.add(i);
      for (const i of rankedByLog2.get(type)!.slice(0, n)) keep.add(i);
    }
    return keep.size;
  };

  let seed = 1;
  for (let n = 1; n <= maxGroupSize; n++) {
    if (n > 1 && unionSizeAt(n) > MAX_INITIAL_DF_ARCS) break;
    seed = n;
  }
  if (!SEED_UNTIL_EVERY_NODE_HAS_INPUT) return seed;

  // Keep growing N past the cap, if needed, until every activity that has an incoming DF edge
  // anywhere in the full set retains at least one in the selection. An activity absent from
  // `targetsNeedingCoverage` structurally never has an incoming DF edge (e.g. a pure start
  // activity) and is already guaranteed a visible arc by the always-on start/end terminal loop
  // in `buildProcessModelGraph`, so it correctly isn't required to have one here.
  const targetsNeedingCoverage = new Set(edges.map((e) => e.to));
  const coveredAt = (n: number): boolean => {
    const covered = new Set<string>();
    for (const type of groups.keys()) {
      for (const i of rankedByLog1.get(type)!.slice(0, n)) covered.add(edges[i].to);
      for (const i of rankedByLog2.get(type)!.slice(0, n)) covered.add(edges[i].to);
    }
    for (const t of targetsNeedingCoverage) if (!covered.has(t)) return false;
    return true;
  };
  while (seed < maxGroupSize && !coveredAt(seed)) seed++;
  return seed;
}

function buildProcessModelGraph(
  data: ProcessModelData | null,
  colorMap: Record<string, string>,
  minEffectSize: number,
  dfFilterMode: DfFilterMode,
  minFanoutRatio: number,
  dfArcCount: number,
): {
  nodes: Node[];
  edges: Edge[];
  overlayCoverage: Coverage;
  dfCoverage: Coverage;
  maxGroupSize: number;
} {
  if (!data)
    return {
      nodes: [],
      edges: [],
      overlayCoverage: { shown: 0, total: 0 },
      dfCoverage: { shown: 0, total: 0 },
      maxGroupSize: 1,
    };
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

  // DF backbone: joint (both logs) directly-follows arcs from the backend, kept only if they clear
  // the active threshold in at least one log — evaluated independently per log, then OR'd, so an
  // edge common in one log but rare in the other still shows. `Ratio` mode compares fan-out-
  // relative frequency (count / from-activity's total outgoing count, for this qualifier).
  // `Count` mode instead keeps, per object type, that type's top `dfArcCount` arcs by raw
  // occurrence count — ranked independently per log, then unioned (never a single combined
  // ranking), so a transition that's only common in one log still surfaces. Per-group rather than
  // a single global ranking: a high-cardinality object type (e.g. many Items per event) would
  // otherwise dominate a global top-N and crowd out a sparse type's (e.g. one Order per event)
  // arcs entirely, even though neither type's raw counts are comparable to begin with. Matches
  // propel's own per-group top-N filter. The two modes are offered as an explicit toggle so they
  // can be compared, not combined. Solid, colored by object type, never dashed. Indexed by
  // (from, to, mediating object type) so the significant overlay below can find and highlight an
  // existing arc instead of stacking a duplicate on top of it.
  let keepByCount: Set<number> | null = null;
  let maxGroupSize = 1;
  if (dfFilterMode === "Count") {
    const groups = new Map<string, number[]>();
    skeleton.edges.forEach((e, i) => {
      const type = e.qualifier[0];
      const list = groups.get(type);
      if (list) list.push(i);
      else groups.set(type, [i]);
    });

    // Deterministic tiebreak (matches propel's own `y.count - x.count || x.key.localeCompare(y.key)`
    // and `computeDfArcCountSeed`'s identical tiebreak above) — without it, ties at the cutoff
    // resolve via Rust `HashMap`'s randomized iteration order.
    const arcKey = (i: number) => `${skeleton.edges[i].from}->${skeleton.edges[i].to}`;

    const keep = new Set<number>();
    for (const indices of groups.values()) {
      maxGroupSize = Math.max(maxGroupSize, indices.length);
      const byLog1 = [...indices].sort(
        (a, b) =>
          skeleton.edges[b].countLog1 - skeleton.edges[a].countLog1 ||
          arcKey(a).localeCompare(arcKey(b)),
      );
      const byLog2 = [...indices].sort(
        (a, b) =>
          skeleton.edges[b].countLog2 - skeleton.edges[a].countLog2 ||
          arcKey(a).localeCompare(arcKey(b)),
      );
      for (const i of byLog1.slice(0, dfArcCount)) keep.add(i);
      for (const i of byLog2.slice(0, dfArcCount)) keep.add(i);
    }
    keepByCount = keep;
  }

  // Two passes: the first decides which arcs clear the active threshold and (for the width-
  // scaling feature flag below) finds the max occurrence count among just those kept arcs, so
  // width stays normalized against what's actually visible rather than the full unfiltered set.
  const keepFlags: boolean[] = new Array(skeleton.edges.length);
  let maxDfCount = 1;
  for (let i = 0; i < skeleton.edges.length; i++) {
    const { countLog1, countLog2, fanoutLog1, fanoutLog2 } = skeleton.edges[i];
    const keep =
      dfFilterMode === "Ratio"
        ? (fanoutLog1 > 0 ? countLog1 / fanoutLog1 : 0) >= minFanoutRatio ||
          (fanoutLog2 > 0 ? countLog2 / fanoutLog2 : 0) >= minFanoutRatio
        : keepByCount!.has(i);
    keepFlags[i] = keep;
    if (keep) maxDfCount = Math.max(maxDfCount, countLog1, countLog2);
  }

  const dfBackboneByPairAndType = new Map<string, Edge>();
  let dfShown = 0;
  for (let i = 0; i < skeleton.edges.length; i++) {
    if (!keepFlags[i]) continue;
    dfShown++;
    const { from, to, qualifier, countLog1, countLog2 } = skeleton.edges[i];

    const qualifierLabel = qualifier.join(", ");
    const color = colorMap[qualifier[0]] ?? "#9ca3af";
    // Log-scaled by occurrence count (higher of the two logs — same "OR across logs" philosophy
    // as the filter thresholds above), ported from propel's own SVG-export width formula
    // (`vendor/dfg/util/svg-export.ts`, otherwise unused by the live canvas).
    const strokeWidth = FREQUENCY_SCALED_EDGE_WIDTH
      ? 1 + Math.log2(1 + (6 * Math.max(countLog1, countLog2)) / maxDfCount)
      : undefined;

    const dfEdge: Edge = {
      id: `dfg::${from}->${to}::${qualifierLabel}`,
      source: from,
      target: to,
      type: "default",
      style: strokeWidth !== undefined ? { strokeWidth } : undefined,
      // No text label: object type is already conveyed by arc color. Text annotations are
      // added if the significant overlay below ends up highlighting this exact arc.
      data: { label: "", color, group: qualifierLabel } satisfies DfgEdgeData,
    };
    edges.push(dfEdge);
    for (const t of qualifier) {
      dfBackboneByPairAndType.set(`${from}->${to}::${t}`, dfEdge);
    }
  }
  const dfCoverage: Coverage = { shown: dfShown, total: skeleton.edges.length };

  // Significant overlay: one dashed arc per significant relationship of `followsMode` (eventually-
  // or directly-follows, whichever the data was fetched with). Any directly-follows pair is by
  // definition also an eventually-follows pair, so a significant relation whose (from, to) is
  // already mediated by a DF backbone arc for (one of) the same object type(s) doesn't get a
  // second arc drawn on top — instead the existing backbone arc is highlighted (dashed + labeled)
  // in place. Only relations with no matching backbone arc (genuinely eventual, non-adjacent
  // steps) get their own new arc. Statistical significance alone is sensitive to sample size, not
  // magnitude, so additionally require the Cliff's delta effect size to clear `minEffectSize`
  // before a relation counts as "shown" at all.
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

      const matchedBackboneEdges = types
        .map((t) => dfBackboneByPairAndType.get(`${from}->${r.objectType}::${t}`))
        .filter((e): e is Edge => e !== undefined);

      if (matchedBackboneEdges.length > 0) {
        for (const dfEdge of matchedBackboneEdges) {
          const edgeData = dfEdge.data as DfgEdgeData;
          if (!edgeData.deviation) {
            edgeData.deviation = { significant: true, label: r.qualifier };
            edgeData.label = r.qualifier;
          } else if (!edgeData.label.includes(r.qualifier)) {
            edgeData.label = `${edgeData.label}, ${r.qualifier}`;
            edgeData.deviation.label = edgeData.label;
          }
        }
        continue;
      }

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
  const dfFilterLabel =
    dfFilterMode === "Ratio"
      ? `fan-out ratio >= ${minFanoutRatio}`
      : `top ${dfArcCount} per object type per log`;
  console.log(
    `[ProcessModel] rendering ${edges.length} edges total: ${dfShown}/${skeleton.edges.length} DF arcs shown (${dfFilterLabel}) across ${Object.keys(edgesByQualifier).length} distinct object-type combinations, ${overlayShown}/${overlayTotal} significant ${overlayLabel} overlay arcs shown (effect size >= ${minEffectSize})`,
    edgesByQualifier,
  );

  return {
    nodes,
    edges,
    overlayCoverage: { shown: overlayShown, total: overlayTotal },
    dfCoverage,
    maxGroupSize,
  };
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
  // Two alternative DF backbone thresholds, offered as an explicit toggle for comparison rather
  // than combined. `minFanoutRatio` matches the fan-out ratio that used to be a hardcoded backend
  // constant (`MIN_FANOUT_RATIO`); `dfArcCount` sets how many top arcs to keep *per object type*
  // (propel's own per-group top-N filter — see `buildProcessModelGraph`'s DF backbone comment).
  // Auto-seeded below via `computeDfArcCountSeed` whenever `data` changes, mirroring propel's own
  // union-size search — this recomputes (and overwrites any manual slider position) on every new
  // load, unlike `minEffectSize`/`minFanoutRatio`, which never auto-reset.
  const [dfFilterMode, setDfFilterMode] = useState<DfFilterMode>("Count");
  const [minFanoutRatio, setMinFanoutRatio] = useState(0.05);
  const [dfArcCount, setDfArcCount] = useState(3);

  useEffect(() => {
    if (data) setDfArcCount(computeDfArcCountSeed(data.skeleton.edges));
  }, [data]);

  const colorMap = useMemo(() => {
    if (!log1Summary || !log2Summary) return {};
    return buildStrokeColorMap([...log1Summary.objectTypes, ...log2Summary.objectTypes]);
  }, [log1Summary, log2Summary]);

  // O2O/O2E never appear on canvas (see the "reserved for future O2O" -> Legend-badge design
  // discussion) — just a per-object-type count + target-name tooltip surfaced in the Legend.
  const objectTypeDeviations = useMemo(() => {
    if (!data) return {};
    const result: Record<string, ObjectTypeDeviations> = {};
    for (const ot of new Set([
      ...Object.keys(data.o2oDrilldowns),
      ...Object.keys(data.o2eDrilldowns),
    ])) {
      result[ot] = { o2o: data.o2oDrilldowns[ot] ?? [], o2e: data.o2eDrilldowns[ot] ?? [] };
    }
    return result;
  }, [data]);

  const { nodes, edges, overlayCoverage, dfCoverage, maxGroupSize } = useMemo(
    () =>
      buildProcessModelGraph(
        data,
        colorMap,
        minEffectSize,
        dfFilterMode,
        minFanoutRatio,
        dfArcCount,
      ),
    [data, colorMap, minEffectSize, dfFilterMode, minFanoutRatio, dfArcCount],
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
          objectTypeDeviations={objectTypeDeviations}
          minEffectSize={minEffectSize}
          onMinEffectSizeChange={setMinEffectSize}
          overlayCoverage={overlayCoverage}
          dfFilterMode={dfFilterMode}
          onDfFilterModeChange={setDfFilterMode}
          minFanoutRatio={minFanoutRatio}
          onMinFanoutRatioChange={setMinFanoutRatio}
          dfArcCount={dfArcCount}
          onDfArcCountChange={setDfArcCount}
          maxGroupSize={maxGroupSize}
          dfCoverage={dfCoverage}
        />
      </ReactFlowProvider>
    </div>
  );
}

/** Fixed per-type footprint (matches the CSS in ActivityNode.module.css / TerminalNode.tsx) — the
 *  vendored ELK layout wants sizes up front, not measured DOM dimensions, so layout can run
 *  synchronously on data arrival instead of waiting for a render + ResizeObserver round trip.
 *  ELK routes edge endpoints against exactly the box size it's given here, so an activity node
 *  with deviating-object-type dots (taller than the base card — see `DEVIATING_DOTS_HEIGHT`) must
 *  report that extra height, or incoming arcs terminate at the old, shorter boundary and end up
 *  swallowed inside the actually-taller rendered node. */
function nodeSize(n: DfgLayoutNode): { width: number; height: number } {
  if (n.type === "terminal") return { width: TERM_NODE_SIZE, height: TERM_NODE_SIZE };
  const data = n.data as Partial<ActivityNodeData>;
  const hasDeviatingDots = (data.deviatingObjectTypes?.length ?? 0) > 0;
  return {
    width: OCEL_NODE_WIDTH,
    height: OCEL_NODE_HEIGHT + (hasDeviatingDots ? DEVIATING_DOTS_HEIGHT : 0),
  };
}

function ProcessModelCanvas({
  initialNodes,
  initialEdges,
  colorMap,
  objectTypeDeviations,
  minEffectSize,
  onMinEffectSizeChange,
  overlayCoverage,
  dfFilterMode,
  onDfFilterModeChange,
  minFanoutRatio,
  onMinFanoutRatioChange,
  dfArcCount,
  onDfArcCountChange,
  maxGroupSize,
  dfCoverage,
}: {
  initialNodes: Node[];
  initialEdges: Edge[];
  colorMap: Record<string, string>;
  objectTypeDeviations: Record<string, ObjectTypeDeviations>;
  minEffectSize: number;
  onMinEffectSizeChange: (v: number) => void;
  overlayCoverage: Coverage;
  dfFilterMode: DfFilterMode;
  onDfFilterModeChange: (m: DfFilterMode) => void;
  minFanoutRatio: number;
  onMinFanoutRatioChange: (v: number) => void;
  dfArcCount: number;
  onDfArcCountChange: (v: number) => void;
  maxGroupSize: number;
  dfCoverage: Coverage;
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
            Min. frequency
          </Text>
          <SegmentedControl.Root
            value={dfFilterMode}
            onValueChange={(v) => onDfFilterModeChange(v as DfFilterMode)}
            size="1"
            style={{ width: "100%", marginBottom: 8 }}
          >
            <SegmentedControl.Item value="Ratio" title="Fraction of the source activity's outgoing flow">
              Ratio
            </SegmentedControl.Item>
            <SegmentedControl.Item value="Count" title="Raw occurrence count">
              Count
            </SegmentedControl.Item>
          </SegmentedControl.Root>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {dfFilterMode === "Ratio" ? (
              <Slider
                size="1"
                orientation="vertical"
                style={{ height: 96 }}
                min={0}
                max={1}
                step={0.01}
                value={[minFanoutRatio]}
                onValueChange={([v]) => onMinFanoutRatioChange(v)}
              />
            ) : (
              <Slider
                size="1"
                orientation="vertical"
                style={{ height: 96 }}
                min={0}
                max={maxGroupSize}
                step={1}
                value={[dfArcCount]}
                onValueChange={([v]) => onDfArcCountChange(v)}
              />
            )}
            <Text as="div" size="1" color="gray" style={{ textAlign: "center" }}>
              {dfCoverage.shown} / {dfCoverage.total} arcs
              <br />
              {dfFilterMode === "Ratio"
                ? `ratio ≥ ${minFanoutRatio.toFixed(2)}`
                : `${dfCoverage.total > 0 ? Math.round((dfCoverage.shown / dfCoverage.total) * 100) : 0}% of arcs`}
            </Text>
          </div>
          <div style={{ borderTop: "1px solid rgba(0,0,0,0.08)", margin: "10px 0" }} />
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
      <Legend colorMap={colorMap} objectTypeDeviations={objectTypeDeviations} />
    </ReactFlow>
  );
}
