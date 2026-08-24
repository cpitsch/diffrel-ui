/** Our own adapter (not a propel port) from this app's post-layout React Flow nodes/edges directly
 *  into `DfgSvgNode`/`DfgSvgEdge` — bypasses `buildDfgSvgModel`, which assumes propel's single
 *  global __START/__END terminal pair. This app's OC-DFG has one start/end pair *per object type*
 *  (colored per object type, see `TerminalNode.tsx`), so terminal identification/coloring has to
 *  come from the node's own `type`/`data` rather than a fixed id match. */

import type { Edge, Node } from "@xyflow/react";
import { DEVIATING_DOTS_HEIGHT, type ActivityNodeData } from "../../../ActivityNode";
import type { TerminalNodeData } from "../../../TerminalNode";
import type { DfgEdgeData } from "../DfgEdge";
import { activityColor } from "./activity-color";
import { DEFAULT_ARC_COLOR } from "./colors";
import { OCEL_NODE_HEIGHT, OCEL_NODE_WIDTH, TERM_NODE_SIZE } from "./dfg-model";
import type { DfgSvgEdge, DfgSvgNode } from "./svg-export";

export function toDfgSvgNodes(nodes: Node[]): DfgSvgNode[] {
  return nodes.map((n) => {
    if (n.type === "terminal") {
      const d = n.data as TerminalNodeData;
      return {
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        width: TERM_NODE_SIZE,
        height: TERM_NODE_SIZE,
        label: "",
        color: d.color,
        shape: "terminal",
        terminalKind: d.kind,
      };
    }
    const d = n.data as ActivityNodeData;
    const hasDeviatingDots = (d.deviatingObjectTypes?.length ?? 0) > 0;
    return {
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      // Deliberately not `n.measured` here: this canvas has no `onNodesChange`, so React Flow's
      // own DOM-measured size is never written back onto our external `nodes` state — it's always
      // undefined, which silently fell back to the fixed OCEL_NODE_HEIGHT for every activity node
      // regardless of whether it actually has the taller dot row. `nodeSize()` in
      // ProcessModelView.tsx (what the layout engines themselves size against) is the real source
      // of truth for a node's intended box size; mirrored here rather than imported to avoid a
      // ProcessModelView.tsx <-> to-dfg-svg-model.ts import cycle.
      width: OCEL_NODE_WIDTH,
      height: OCEL_NODE_HEIGHT + (hasDeviatingDots ? DEVIATING_DOTS_HEIGHT : 0),
      label: d.activity,
      sublabel: d.count.toLocaleString("en"),
      color: activityColor(d.activity),
      shape: "rect",
      significant: d.e2eSignificant,
      deviatingDots: d.deviatingObjectTypes,
    };
  });
}

export function toDfgSvgEdges(edges: Edge[]): DfgSvgEdge[] {
  return edges.map((e) => {
    const d = (e.data ?? {}) as Partial<DfgEdgeData>;
    const strokeWidth =
      typeof (e.style as { strokeWidth?: number } | undefined)?.strokeWidth === "number"
        ? (e.style as { strokeWidth: number }).strokeWidth
        : undefined;
    return {
      key: e.id,
      source: e.source,
      target: e.target,
      label: d.label ?? "",
      color: d.color ?? DEFAULT_ARC_COLOR,
      strokeWidth,
      routing:
        d.routing?.kind === "polyline"
          ? { points: d.routing.points, srcPos: d.routing.srcPos, tgtPos: d.routing.tgtPos }
          : undefined,
      parallelIndex: d.parallelIndex,
      parallelCount: d.parallelCount,
      labelOffset: d.labelOffset,
      deviation: d.deviation,
    };
  });
}
