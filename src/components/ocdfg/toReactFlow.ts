/** React Flow adapter for a `ProjectedModel` (see `projection.ts`): decides *how* the projected
 *  OC-DFG is drawn on our own canvas — object-type colors, frequency-scaled stroke widths and the
 *  node/edge data shapes our `ActivityNode`/`TerminalNode`/`DfgEdge` components expect. Everything
 *  about *what* is shown (filters, ids, significance marks) is already decided by the projection. */

import type { Edge, Node } from "@xyflow/react";

import type { ActivityNodeData } from "./ActivityNode";
import type { TerminalNodeData } from "./TerminalNode";
import type { DfgEdgeData } from "./vendor/dfg/DfgEdge";
import type { ProjectedModel } from "./projection";

const FALLBACK_COLOR = "#9ca3af";

export interface ReactFlowAdapterOptions {
  /** Scale DF backbone arc stroke width by occurrence frequency (see `FREQUENCY_SCALED_EDGE_WIDTH`
   *  in `ProcessModelView.tsx`). */
  frequencyScaledWidth: boolean;
}

export function projectedToReactFlow(
  model: ProjectedModel,
  colorMap: Record<string, string>,
  options: ReactFlowAdapterOptions,
): { nodes: Node[]; edges: Edge[] } {
  const colorOf = (objectType: string) =>
    colorMap[objectType] ?? FALLBACK_COLOR;

  const nodes: Node[] = model.nodes.map((n) =>
    n.kind === "activity"
      ? {
          id: n.id,
          type: "activity",
          position: { x: 0, y: 0 },
          data: {
            activity: n.activity,
            count: n.count,
            deviatingObjectTypes: n.deviatingObjectTypes.map((d) => ({
              objectType: d.objectType,
              color: colorOf(d.objectType),
              pValue: d.pValue,
            })),
            e2eSignificant: n.e2eSignificant,
          } satisfies ActivityNodeData,
        }
      : {
          id: n.id,
          type: "terminal",
          position: { x: 0, y: 0 },
          // The shared pair (no object type) is neutral gray; object-type colors stay on its arcs.
          data: {
            kind: n.terminal,
            color: n.objectType === null ? FALLBACK_COLOR : colorOf(n.objectType),
          } satisfies TerminalNodeData,
        },
  );

  // Max occurrence count over the *shown* DF arcs only, so the width scale stays meaningful as
  // the filter changes rather than being dragged down by arcs that got filtered out.
  let maxDfCount = 1;
  for (const a of model.arcs) {
    if (a.kind === "df")
      maxDfCount = Math.max(maxDfCount, a.countLog1 ?? 0, a.countLog2 ?? 0);
  }

  const edges: Edge[] = model.arcs.map((a) => {
    const color = colorOf(a.objectTypes[0]);
    const group = a.objectTypes.join(", ");
    if (a.kind === "terminal") {
      return {
        id: a.id,
        source: a.from,
        target: a.to,
        type: "default",
        // No text label: object type is already conveyed by arc color.
        data: { label: "", color, group } satisfies DfgEdgeData,
      };
    }
    if (a.kind === "df") {
      const count = Math.max(a.countLog1 ?? 0, a.countLog2 ?? 0);
      // Log-scaled by occurrence count (higher of the two logs — same "OR across logs" philosophy
      // as the projection's filter thresholds), ported from propel's own SVG-export width formula
      // (`vendor/dfg/util/svg-export.ts`, otherwise unused by the live canvas).
      const strokeWidth = options.frequencyScaledWidth
        ? 1 + Math.log2(1 + (6 * count) / maxDfCount)
        : undefined;
      return {
        id: a.id,
        source: a.from,
        target: a.to,
        type: "default",
        style: strokeWidth !== undefined ? { strokeWidth } : undefined,
        data: {
          label: "",
          color,
          group,
          count,
          ...(a.deviation ? { deviation: { ...a.deviation } } : {}),
        } satisfies DfgEdgeData,
      };
    }
    return {
      id: a.id,
      source: a.from,
      target: a.to,
      type: "default",
      data: {
        label: "",
        color,
        group,
        deviation: { ...a.deviation! },
      } satisfies DfgEdgeData,
    };
  });

  return { nodes, edges };
}
