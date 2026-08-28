// Adapted from https://github.com/aarkue/propel (packages/components/src/dfg/util/styled-graph.ts)
// Copyright (c) 2026 aarkue, licensed MIT OR Apache-2.0.
/** Converts the DFG SVG model into a generic `StyledGraph`, drawn by `styledGraphToSvg`; geometry
 *  matches the on-screen model pixel-for-pixel. */

import type { LegendGroup, MarkingGroup, StyledGraph, StyledNode } from "../../graph-svg/styled-graph";
import { buildStyledGraph } from "../../graph-svg/build-styled-graph";
import { formatPVal, measureTextWidth, MONO_STACK, SANS_STACK } from "../../../../../nativeSvg";
import { exportBackgroundHex, flattenColor } from "./colors";
import { type FlowDirection, selfLoopBezier } from "./self-loop";
import {
  buildDfgSvgModel,
  type DfgSvgBuilderInputs,
  type DfgSvgEdge,
  type DfgSvgNode,
} from "./svg-export";

type Pt = { x: number; y: number };

/** Sample a cubic Bezier at `n` evenly-spaced parameter steps (inclusive of both ends). */
function sampleCubicBezier(p0: Pt, c1: Pt, c2: Pt, p3: Pt, n: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x;
    const y = u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y;
    pts.push({ x, y });
  }
  return pts;
}

/** Same self-loop geometry as `DfgEdge.tsx`'s on-screen renderer (via `selfLoopBezier`), sampled to a
 *  polyline. */
function selfLoopPoints(
  src: DfgSvgNode,
  parallelIndex: number,
  strokeWidth: number,
  direction: FlowDirection,
): [number, number][] {
  const { p0, c1, c2, p3 } = selfLoopBezier(src, parallelIndex, strokeWidth, direction);
  return sampleCubicBezier(p0, c1, c2, p3, 32).map((p) => [p.x, p.y]);
}

function edgePoints(
  src: DfgSvgNode,
  tgt: DfgSvgNode,
  edge: DfgSvgEdge,
  direction: FlowDirection,
): [number, number][] | null {
  // Matches DfgEdge.tsx's own fallback (its `sw` default when `style.strokeWidth` isn't a number)
  // — was `?? 2` here, silently rendering half as thick as the live default for any edge that
  // doesn't carry an explicit strokeWidth.
  const strokeWidth = edge.strokeWidth ?? 4;
  if (src.id === tgt.id) return selfLoopPoints(src, edge.parallelIndex ?? 0, strokeWidth, direction);

  if (edge.routing && edge.routing.points.length >= 2) {
    const pts: Pt[] = edge.routing.points.map((p) => ({ x: p.x, y: p.y }));
    const srcDx = src.x - edge.routing.srcPos.x;
    const srcDy = src.y - edge.routing.srcPos.y;
    const tgtDx = tgt.x - edge.routing.tgtPos.x;
    const tgtDy = tgt.y - edge.routing.tgtPos.y;
    if (srcDx !== 0 || srcDy !== 0) pts[0] = { x: pts[0].x + srcDx, y: pts[0].y + srcDy };
    if (tgtDx !== 0 || tgtDy !== 0) {
      const n = pts.length;
      pts[n - 1] = { x: pts[n - 1].x + tgtDx, y: pts[n - 1].y + tgtDy };
    }
    return pts.map((p) => [p.x, p.y]);
  }

  // Fallback: straight bottom-center -> top-center (no routing available).
  return [
    [src.x + src.width / 2, src.y + src.height],
    [tgt.x + tgt.width / 2, tgt.y],
  ];
}

/** diffrel addition, not upstream: the deviating-object-type dot row, one exact-mode `MarkingGroup`
 *  per dot (matches ActivityNode.module.css's `.dot` — 14px, 1px border). */
function deviatingDotsMarking(
  dots: { objectType: string; color: string; pValue?: number }[],
): MarkingGroup[] {
  // Plain color, not `rgba()` — the renderer (`nodeMarking` in styled-graph-svg.ts) applies the
  // 0.25 opacity itself via a separate `stroke-opacity` attribute, for Inkscape compatibility.
  return dots.map((d) => ({
    kind: "dot",
    color: d.color,
    count: 1,
    radius: 7,
    stroke: "#000000",
    title: `${d.objectType}${d.pValue !== undefined ? ` (p=${formatPVal(d.pValue)})` : ""}`,
  }));
}

function nodeToStyled(n: DfgSvgNode, bgHex: string): StyledNode {
  if (n.shape === "terminal") {
    return {
      cx: n.x + n.width / 2,
      cy: n.y + n.height / 2,
      w: n.width,
      h: n.height,
      shape: { kind: "circle" },
      fill: n.color,
      stroke: n.color,
      stroke_width: 0,
      icon: { kind: n.terminalKind === "start" ? "triangle" : "square", color: "#ffffff" },
    };
  }
  const fill = flattenColor(
    n.color.length === 7 && n.color.startsWith("#") ? `${n.color}26` : n.color,
    bgHex,
  );
  // diffrel addition, not upstream: upstream's own truncation heuristic (a fixed chars-per-width
  // ratio, `Math.max(8, Math.floor(n.width / 9))`) doesn't match how this app's live ActivityNode
  // actually behaves — `.node` has no `white-space: nowrap`/`text-overflow`, so a long name just
  // wraps in the live CSS flex box rather than getting cut off. Real multi-line wrapping in raw SVG
  // text is a bigger lift (line-breaking, growing box height, re-deriving every other row's `dy`);
  // widening the box to fit the label via real text measurement is a much smaller change and, more
  // importantly, never loses part of the name the way silent truncation did.
  const NODE_LABEL_H_PADDING = 28; // matches ActivityNode.module.css's `padding: 8px 14px` (14*2)
  const w = Math.max(n.width, measureTextWidth(n.label, 12, SANS_STACK) + NODE_LABEL_H_PADDING);
  const label = n.label;
  const hasDots = (n.deviatingDots?.length ?? 0) > 0;

  // diffrel addition, not upstream: stack label / sublabel / dot row with equal gaps between each
  // present element, centered as a block on the node — rather than fixed per-line offsets (which
  // produced uneven label-to-sublabel vs. sublabel-to-dots spacing once the dot row was involved).
  const GAP = 6;
  const LABEL_H = 12;
  const SUBLABEL_H = 12;
  const DOTS_H = 14;
  const contentH =
    LABEL_H + (n.sublabel ? GAP + SUBLABEL_H : 0) + (hasDots ? GAP + DOTS_H : 0);
  let cursor = -contentH / 2;
  const labelDy = cursor + LABEL_H / 2;
  cursor += LABEL_H;
  let sublabelDy = 0;
  if (n.sublabel) {
    cursor += GAP;
    sublabelDy = cursor + SUBLABEL_H / 2;
    cursor += SUBLABEL_H;
  }
  let dotsDy = 0;
  if (hasDots) {
    cursor += GAP;
    dotsDy = cursor + DOTS_H / 2;
  }

  return {
    cx: n.x + w / 2,
    cy: n.y + n.height / 2,
    w,
    h: n.height,
    shape: { kind: "box", radius: 10 },
    fill,
    // diffrel addition, not upstream: E2E significance overrides the identity stroke with a
    // thicker red border, mirroring ActivityNode.tsx.
    stroke: n.significant ? "#ef4444" : n.color,
    stroke_width: n.significant ? 3 : 2,
    // diffrel addition, not upstream: on-screen, the dot row lives *inside* the same bordered card
    // as the label/count (ActivityNode.module.css's `.node` is a centered flex column containing
    // all three; DEVIATING_DOTS_HEIGHT grows the card to fit it). Mirror that here rather than
    // treating `marking` as an external decoration below the box (propel's own OC-Declare use of
    // it).
    // diffrel addition, not upstream: fixed colors matching ActivityNode.module.css's `.label`
    // (solid dark gray) / `.subtitle` (translucent black) exactly, rather than upstream's
    // node-color-derived `foreground` shade — this app's label colors don't vary with node identity
    // color. Black + `fill_opacity` rather than an `rgba()` fill string — Inkscape and other strict
    // SVG 1.1 consumers don't reliably parse `rgba()` in a bare presentation attribute.
    labels: [
      { text: label, size: 12, weight: 700, color: "#111827", dy: labelDy },
      // Monospace, matching ActivityNode.module.css's `.subtitle` — this is a count, not prose.
      ...(n.sublabel
        ? [
            {
              text: n.sublabel,
              size: 10,
              weight: 400,
              color: "#000000",
              fill_opacity: 0.55,
              dy: sublabelDy,
              font_family: MONO_STACK,
            },
          ]
        : []),
    ],
    ...(hasDots ? { marking: deviatingDotsMarking(n.deviatingDots!), marking_dy: dotsDy } : {}),
  };
}

/** Convert an already-computed DFG SVG model into a `StyledGraph`. */
export function dfgModelToStyledGraph(
  nodes: DfgSvgNode[],
  edges: DfgSvgEdge[],
  legend: LegendGroup[] = [],
  direction: FlowDirection = "TB",
): StyledGraph {
  const bgHex = exportBackgroundHex();
  return buildStyledGraph(nodes, edges, {
    id: (n) => n.id,
    source: (e) => e.source,
    target: (e) => e.target,
    nodeToStyled: (n) => nodeToStyled(n, bgHex),
    edgeToStyled: (edge, src, tgt) => {
      const points = edgePoints(src, tgt, edge, direction);
      if (!points) return null;
      // Self-loops are already a sampled curve (rounding would fight the sampling); regular
      // polylines get the same corner radius the on-screen edge uses.
      const isLoop = src.id === tgt.id;
      // diffrel addition, not upstream: E2E significance dashes + thickens the stroke, mirroring
      // DfgEdge.tsx's on-screen `isDeviating` treatment exactly.
      const isDeviating = edge.deviation?.significant === true;
      const title =
        isDeviating && edge.deviation?.pValue !== undefined
          ? `(p=${formatPVal(edge.deviation.pValue)}${
              edge.deviation.effectSize !== undefined
                ? `, effect size=${edge.deviation.effectSize.toFixed(2)}`
                : ""
            })`
          : undefined;
      return {
        points,
        color: flattenColor(edge.color, bgHex),
        width: (edge.strokeWidth ?? 4) + (isDeviating ? 1.5 : 0),
        dash: isDeviating ? "6 4" : undefined,
        marker_end: "arrow",
        rounded: isLoop ? 0 : 18,
        title,
        labels: edge.label
          ? [
              {
                text: edge.label,
                at: 0.5,
                dx: edge.labelOffset?.dx ?? 0,
                dy: edge.labelOffset?.dy ?? 0,
                bg: flattenColor("#ffffff", bgHex),
                color: flattenColor("#111827", bgHex),
              },
            ]
          : [],
      };
    },
    padding: 40,
    background: bgHex,
    legend,
  });
}

/** Convert a live DFG panel's state directly into a `StyledGraph`. Unused by this app today — our
 *  OC-DFG has per-object-type terminal nodes (colored per object type), not `buildDfgSvgModel`'s
 *  assumed single global __START/__END pair, so we build our own `DfgSvgNode[]`/`DfgSvgEdge[]` via
 *  `to-dfg-svg-model.ts` instead and call `dfgModelToStyledGraph` directly. Kept for parity with
 *  upstream and as a reference for the single-DFG case. */
export function buildDfgStyledGraph(inputs: DfgSvgBuilderInputs): StyledGraph | null {
  const model = buildDfgSvgModel(inputs);
  return model
    ? dfgModelToStyledGraph(model.nodes, model.edges, model.legend, inputs.direction ?? "TB")
    : null;
}
