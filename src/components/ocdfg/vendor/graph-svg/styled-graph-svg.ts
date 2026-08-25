// Adapted from https://github.com/aarkue/propel (packages/components/src/graph-svg/styled-graph-svg.ts)
// Copyright (c) 2026 aarkue, licensed MIT OR Apache-2.0.
/** Backend-free `StyledGraph` -> SVG string renderer. Upstream's own doc comment on this file
 *  scopes it to "the ELK route (no markings/icons/legends)" — that's propel's fallback for when its
 *  Rust `export_graph_svg` binding isn't available. We don't have that binding at all, so this app
 *  extends the fallback with icon, marking-dot, and legend rendering (diffrel additions, not
 *  upstream) rather than treating those as permanently out of scope. */

import { escapeXml, measureTextWidth, SANS_STACK } from "../../../../nativeSvg";
import { polylinePointAt } from "../graph-edit/routing";
import type { LegendGroup, LegendItem, StyledEdge, StyledGraph, StyledNode } from "./styled-graph";

// SANS_STACK's quoted font names (e.g. "Segoe UI Variable") contain literal `"`, which breaks a
// double-quoted XML attribute if inserted raw (`font-family=""Segoe UI Variable"..."`) — escape
// once here rather than at every call site.
const SANS_STACK_ATTR = escapeXml(SANS_STACK);

/** TerminalNode.tsx's glyphs are fixed pixel sizes (10px square; a 9x12 CSS border-triangle offset
 *  2px right) drawn inside a TERM_NODE_SIZE=36 circle — scaled proportionally to the node's actual
 *  diameter here rather than via a generic `icon.scale` fraction, which came out visibly smaller
 *  than the live glyphs (a scale of 0.35 landed the square at ~19% of the diameter vs. the live
 *  10/36 ≈ 28%). */
function nodeIcon(n: StyledNode): string {
  if (!n.icon) return "";
  const d = Math.min(n.w, n.h);
  const color = n.icon.color ?? "#ffffff";
  if (n.icon.kind === "square") {
    const side = d * (10 / 36);
    return `<rect x="${n.cx - side / 2}" y="${n.cy - side / 2}" width="${side}" height="${side}" rx="1.5" fill="${color}" />`;
  }
  const w = d * (9 / 36);
  const h = d * (12 / 36);
  const cx = n.cx + d * (2 / 36);
  return `<path d="M ${cx - w / 2},${n.cy - h / 2} L ${cx - w / 2},${n.cy + h / 2} L ${cx + w / 2},${n.cy} Z" fill="${color}" />`;
}

/** diffrel addition, not upstream: a centered row of `marking` dots below the node — used for the
 *  deviating-object-type highlight (see `dfg/util/styled-graph.ts`'s `deviatingDotsMarking`). Only
 *  the exact-mode ("radius" set) rendering is implemented; upstream's fit-to-node/numeral-collapse
 *  modes aren't needed here since this app always sets a fixed radius. */
function nodeMarking(n: StyledNode): string {
  if (!n.marking || n.marking.length === 0) return "";
  const cy = n.cy + (n.marking_dy ?? n.h / 2 + 12);
  const gap = 4;
  const dots = n.marking.filter((m) => m.radius != null);
  const totalWidth = dots.reduce((sum, m, i) => sum + m.radius! * 2 + (i > 0 ? gap : 0), 0);
  let cx = n.cx - totalWidth / 2;
  const parts: string[] = [];
  for (const m of dots) {
    cx += m.radius!;
    // `stroke-opacity` as a separate attribute rather than an `rgba()` stroke color: Inkscape (and
    // other strict SVG 1.1 consumers) don't reliably parse `rgba()` in a bare presentation
    // attribute, silently dropping the stroke — `stroke`/`stroke-opacity` is the portable spelling.
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${m.radius}" fill="${m.color ?? "#999"}"${m.stroke ? ` stroke="${m.stroke}" stroke-width="1" stroke-opacity="0.25"` : ""} />`,
    );
    cx += m.radius! + gap;
  }
  return parts.join("");
}

function nodeSvg(n: StyledNode): string {
  const x = n.cx - n.w / 2;
  const y = n.cy - n.h / 2;
  const radius = n.shape?.kind === "box" ? Math.min(n.shape.radius ?? 0, n.h / 2) : n.h / 2;
  const isEllipse = n.shape?.kind === "ellipse" || n.shape?.kind === "circle";
  const shape = isEllipse
    ? `<ellipse cx="${n.cx}" cy="${n.cy}" rx="${n.w / 2}" ry="${n.h / 2}" fill="${n.fill ?? "none"}" stroke="${n.stroke ?? "none"}" stroke-width="${n.stroke_width ?? 1}"${n.stroke_dash ? ` stroke-dasharray="${n.stroke_dash}"` : ""} />`
    : `<rect x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="${radius}" fill="${n.fill ?? "none"}" stroke="${n.stroke ?? "none"}" stroke-width="${n.stroke_width ?? 1}"${n.stroke_dash ? ` stroke-dasharray="${n.stroke_dash}"` : ""} />`;
  const labels = (n.labels ?? [])
    .map(
      (l) =>
        `<text x="${n.cx}" y="${n.cy + (l.dy ?? 0)}" text-anchor="middle" dominant-baseline="central" font-family="${l.font_family ? escapeXml(l.font_family) : SANS_STACK_ATTR}" font-size="${l.size ?? 12}" font-weight="${l.weight ?? 400}" fill="${l.color ?? "#000"}"${l.fill_opacity != null ? ` fill-opacity="${l.fill_opacity}"` : ""}>${escapeXml(l.text)}</text>`,
    )
    .join("");
  return shape + labels + nodeIcon(n) + nodeMarking(n);
}

/** Matches the marker box computed in `styledGraphToSvg`'s marker-defs loop — kept in one place so
 *  the line-shortening below (which needs to match the arrowhead's own size) can't drift from it. */
function markerSizeFor(e: StyledEdge): number {
  return Math.max(16, (e.width ?? 1.5) * (16 / 3));
}

/** Rounds interior corners with a quadratic-bezier `Q` at each bend (radius `r`, clamped so it
 *  never overshoots a segment), matching DfgEdge.tsx's on-screen `roundedPolylinePath` exactly —
 *  ported here since `StyledEdge.rounded` (already set to 18 for non-loop polylines in
 *  dfg/util/styled-graph.ts) was being computed but never actually applied by this renderer, which
 *  drew straight `M...L...L` segments through every bend regardless. */
function roundedPolylinePath(pts: [number, number][], r: number): string {
  if (pts.length === 0) return "";
  if (pts.length <= 2) {
    return pts.length === 1
      ? `M ${pts[0][0]},${pts[0][1]}`
      : `M ${pts[0][0]},${pts[0][1]} L ${pts[1][0]},${pts[1][1]}`;
  }
  const parts: string[] = [`M ${pts[0][0]},${pts[0][1]}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const [p0x, p0y] = pts[i - 1];
    const [p1x, p1y] = pts[i];
    const [p2x, p2y] = pts[i + 1];
    const v1x = p0x - p1x;
    const v1y = p0y - p1y;
    const v2x = p2x - p1x;
    const v2y = p2y - p1y;
    const l1 = Math.hypot(v1x, v1y) || 1;
    const l2 = Math.hypot(v2x, v2y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = p1x + (v1x / l1) * rr;
    const ay = p1y + (v1y / l1) * rr;
    const bx2 = p1x + (v2x / l2) * rr;
    const by2 = p1y + (v2y / l2) * rr;
    parts.push(`L ${ax},${ay} Q ${p1x},${p1y} ${bx2},${by2}`);
  }
  const last = pts[pts.length - 1];
  parts.push(`L ${last[0]},${last[1]}`);
  return parts.join(" ");
}

/** Trim the last segment by `by`, so the *line* stops short of the endpoint and only the arrowhead
 *  marker reaches it. */
function shortenPolylineEnd(pts: [number, number][], by: number): [number, number][] {
  if (pts.length < 2 || by <= 0) return pts;
  const out = pts.map((p) => [...p] as [number, number]);
  const n = out.length;
  const [ax, ay] = out[n - 2];
  const [bx, byy] = out[n - 1];
  const len = Math.hypot(bx - ax, byy - ay);
  if (len > by) out[n - 1] = [bx - ((bx - ax) / len) * by, byy - ((byy - ay) / len) * by];
  return out;
}

function edgeSvg(e: StyledEdge, markerId: string): string {
  if (e.points.length < 2) return "";
  // diffrel addition, not upstream: upstream draws the raw routed polyline straight through to its
  // endpoint, with no shortening — fine for its own thin, unmarked lines, but on our thicker,
  // arrow-marked edges the full-width stroke visibly pokes past the arrowhead into the target node.
  // DfgEdge.tsx's on-screen edge shortens the last segment by `0.35 * markerSize` before drawing for
  // exactly this reason; mirrored here. Self-loops (`rounded === 0`, a pre-sampled curve whose own
  // endpoint already has an inset baked in via `selfLoopBezier`'s `arrowInset`) are left alone.
  const isLoop = e.rounded === 0;
  const hasArrow = e.marker_end === "arrow" || e.marker_end === "arrow_ball";
  const pts = !isLoop && hasArrow ? shortenPolylineEnd(e.points, markerSizeFor(e) * 0.35) : e.points;
  const d =
    e.rounded && e.rounded > 0
      ? roundedPolylinePath(pts, e.rounded)
      : pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const color = e.color ?? "#888";
  const end = hasArrow ? ` marker-end="url(#${markerId})"` : "";
  const line = `<path d="${d}" fill="none" stroke="${color}" stroke-width="${e.width ?? 1.5}"${e.dash ? ` stroke-dasharray="${e.dash}"` : ""} stroke-linejoin="round"${end} />`;
  const EDGE_LABEL_FONT = "ui-monospace, monospace";
  const EDGE_LABEL_SIZE = 16;
  const labels = (e.labels ?? [])
    .map((l) => {
      const { x: lx, y: ly } = polylinePointAt(
        pts.map(([x, y]) => ({ x, y })),
        l.at ?? 0.5,
      );
      // diffrel addition, not upstream: sit directly on the arc's own point (`dominant-baseline:
      // central`, same vertical-centering approach node labels use) instead of upstream's
      // unconditional `-5` nudge, which read as floating near the line rather than on it. And
      // upstream's "halo" was a thick colored stroke behind the glyphs (`paint-order="stroke"`), not
      // an actual background — swapped for a real measured rect, matching the pattern
      // `nativeSvg.ts` already uses for GraphView's edge-qualifier labels, so the line disappears
      // cleanly behind the label instead of just bleeding through a stroke outline.
      const cx = lx + (l.dx ?? 0);
      const cy = ly + (l.dy ?? 0);
      // Semi-transparent and tightly padded rather than a solid opaque block: on short arcs (nodes
      // close together), an opaque chip at full padding can cover the entire visible line. SVG
      // supports `fill-opacity` directly, so the arc still shows through faintly instead of getting
      // fully hidden.
      const bg = l.bg
        ? (() => {
            const w = measureTextWidth(l.text, EDGE_LABEL_SIZE, EDGE_LABEL_FONT) + 5;
            const h = EDGE_LABEL_SIZE * 1.2 + 2;
            return `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="3" fill="${l.bg}" fill-opacity="0.8" />`;
          })()
        : "";
      const text = `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="${EDGE_LABEL_FONT}" font-size="${EDGE_LABEL_SIZE}" fill="${l.color ?? color}">${escapeXml(l.text)}</text>`;
      return bg + text;
    })
    .join("");
  return line + labels;
}

const LEGEND_TITLE_SIZE = 19;
const LEGEND_ITEM_SIZE = 18;
const LEGEND_ROW_GAP = 9;
const LEGEND_GROUP_GAP = 17;
const LEGEND_DOT_R = 8;
const LEGEND_TEXT_GAP = 9;
const LEGEND_PANEL_PAD = 17;
// Split color + opacity attributes, not an `rgba()` string — Inkscape and other strict SVG 1.1
// consumers don't reliably parse `rgba()` in a bare presentation attribute, silently dropping it
// (the panel border and divider were invisible on import for exactly this reason).
const LEGEND_BORDER_ATTRS = `stroke="#000000" stroke-opacity="0.1"`;
const LEGEND_BADGE_SIZE = 14;
const LEGEND_BADGE_DOT_R = 6;
const LEGEND_BADGE_GAP = 9;

function measureBadges(badges: LegendItem["badges"]): number {
  const list = badges ?? [];
  let w = 0;
  list.forEach((badge, bi) => {
    if (bi > 0) w += LEGEND_BADGE_GAP;
    w += measureTextWidth(badge.label, LEGEND_BADGE_SIZE, SANS_STACK) + 5;
    w += badge.dots.length * (LEGEND_BADGE_DOT_R * 2 + 5);
  });
  return w;
}

/** Total width a row needs: dot+label, plus its badge group if it has one (used only to find the
 *  shared content width in `legendSvg`'s measure pass — badges are drawn right-aligned to that
 *  width, not immediately after the label, so this isn't literally where the row's ink ends up). */
function measureItemRow(item: LegendItem): number {
  let leftWidth = item.color ? LEGEND_DOT_R * 2 + LEGEND_TEXT_GAP : 0;
  leftWidth += measureTextWidth(item.label, LEGEND_ITEM_SIZE, SANS_STACK);
  const badgesWidth = measureBadges(item.badges);
  return leftWidth + (badgesWidth > 0 ? LEGEND_BADGE_GAP + badgesWidth : 0);
}

/** Dot + label at `x0`; badge groups (e.g. O2O/O2E targets), if any, right-aligned to end at
 *  `rightEdgeX` — mirroring Legend.tsx's `margin-left: auto` on the badge wrapper, so every row's
 *  badges line up on a shared right edge rather than trailing right after that row's own label. */
function drawItemRow(item: LegendItem, x0: number, y: number, rightEdgeX: number): string {
  const cy = y - LEGEND_ITEM_SIZE * 0.3;
  const parts: string[] = [];
  let x = x0;
  if (item.color) {
    parts.push(
      item.shape === "box"
        ? `<rect x="${x}" y="${cy - LEGEND_DOT_R}" width="${LEGEND_DOT_R * 2}" height="${LEGEND_DOT_R * 2}" rx="2" fill="#ffffff" stroke="${item.color}" stroke-width="3" />`
        : `<circle cx="${x + LEGEND_DOT_R}" cy="${cy}" r="${LEGEND_DOT_R}" fill="${item.color}" stroke="#000000" stroke-opacity="0.25" stroke-width="1" />`,
    );
    x += LEGEND_DOT_R * 2 + LEGEND_TEXT_GAP;
  }
  parts.push(
    `<text x="${x}" y="${y}" font-family="${SANS_STACK_ATTR}" font-size="${LEGEND_ITEM_SIZE}" fill="#111827">${escapeXml(item.label)}</text>`,
  );
  const badges = item.badges ?? [];
  if (badges.length > 0) {
    let bx = rightEdgeX - measureBadges(badges);
    for (const badge of badges) {
      parts.push(
        `<text x="${bx}" y="${y}" font-family="${SANS_STACK_ATTR}" font-size="${LEGEND_BADGE_SIZE}" fill="#6b7280">${escapeXml(badge.label)}</text>`,
      );
      bx += measureTextWidth(badge.label, LEGEND_BADGE_SIZE, SANS_STACK) + 5;
      for (const dot of badge.dots) {
        parts.push(
          `<circle cx="${bx + LEGEND_BADGE_DOT_R}" cy="${cy}" r="${LEGEND_BADGE_DOT_R}" fill="${dot.color}" stroke="#000000" stroke-opacity="0.2" stroke-width="1"><title>${escapeXml(dot.title)}</title></circle>`,
        );
        bx += LEGEND_BADGE_DOT_R * 2 + 5;
      }
      bx += LEGEND_BADGE_GAP;
    }
  }
  return parts.join("");
}

/** diffrel addition, not upstream: lays out `StyledGraph.legend` as a bordered panel (dot+label
 *  rows, right-aligned per-item badge groups, and a divider between groups — mirroring
 *  Legend.tsx's own panel chrome), positioned below the graph so the exported figure never needs a
 *  manual "drag the legend near the graph" step the way the on-screen canvas export does. Two
 *  passes: the first measures every row (needed up front since badges right-align to the panel's
 *  final content width, not to their own row), the second draws using that now-known width. Sizing
 *  uses real canvas text measurement (`measureTextWidth`, shared with `nativeSvg.ts`) rather than a
 *  character-count guess. `boxX`/`boxY` is the panel's own top-left corner (not the first text row). */
function legendSvg(groups: LegendGroup[], boxX: number, boxY: number): { svg: string; width: number; height: number } {
  const x0 = boxX + LEGEND_PANEL_PAD;

  let maxWidth = 0;
  for (const g of groups) {
    if (g.title) maxWidth = Math.max(maxWidth, measureTextWidth(g.title, LEGEND_TITLE_SIZE, SANS_STACK));
    for (const item of g.items) maxWidth = Math.max(maxWidth, measureItemRow(item));
  }
  const rightEdgeX = x0 + maxWidth;

  let y = boxY + LEGEND_PANEL_PAD;
  const parts: string[] = [];
  const dividerYs: number[] = [];
  groups.forEach((g, gi) => {
    if (gi > 0) dividerYs.push(y - (LEGEND_GROUP_GAP - LEGEND_ROW_GAP) / 2);
    if (g.title || g.rightTitle) {
      y += LEGEND_TITLE_SIZE;
      if (g.title) {
        parts.push(
          `<text x="${x0}" y="${y}" font-family="${SANS_STACK_ATTR}" font-size="${LEGEND_TITLE_SIZE}" font-weight="700" fill="#374151">${escapeXml(g.title)}</text>`,
        );
      }
      if (g.rightTitle) {
        parts.push(
          `<text x="${rightEdgeX}" y="${y}" text-anchor="end" font-family="${SANS_STACK_ATTR}" font-size="${LEGEND_TITLE_SIZE}" font-weight="700" fill="#374151">${escapeXml(g.rightTitle)}</text>`,
        );
      }
      y += LEGEND_ROW_GAP;
    }
    for (const item of g.items) {
      y += LEGEND_ITEM_SIZE;
      parts.push(drawItemRow(item, x0, y, rightEdgeX));
      y += LEGEND_ROW_GAP;
    }
    y += LEGEND_GROUP_GAP - LEGEND_ROW_GAP;
  });
  const contentBottom = y - (LEGEND_GROUP_GAP - LEGEND_ROW_GAP);
  const width = maxWidth + LEGEND_PANEL_PAD * 2;
  const height = contentBottom - boxY + LEGEND_PANEL_PAD;
  const panel = `<rect x="${boxX}" y="${boxY}" width="${width}" height="${height}" rx="8" fill="#ffffff" ${LEGEND_BORDER_ATTRS} stroke-width="1" />`;
  const dividers = dividerYs
    .map(
      (dy) =>
        `<line x1="${x0}" y1="${dy}" x2="${boxX + width - LEGEND_PANEL_PAD}" y2="${dy}" ${LEGEND_BORDER_ATTRS} stroke-width="1" />`,
    )
    .join("");
  return { svg: panel + dividers + parts.join(""), width, height };
}

/** Render a `StyledGraph` to a standalone SVG document string. */
export function styledGraphToSvg(graph: StyledGraph): string {
  const pad = graph.padding ?? 24;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of graph.nodes) {
    xs.push(n.cx - n.w / 2, n.cx + n.w / 2);
    ys.push(n.cy - n.h / 2, n.cy + n.h / 2);
  }
  for (const e of graph.edges)
    for (const [x, y] of e.points) {
      xs.push(x);
      ys.push(y);
    }
  if (xs.length === 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>`;
  const graphMinX = Math.min(...xs);
  const graphMinY = Math.min(...ys);
  let maxX = Math.max(...xs);
  let maxY = Math.max(...ys);

  // diffrel addition, not upstream: place the legend below the graph, left-aligned to it, and fold
  // its footprint into the canvas bounds — this is what gives the export a tight crop instead of
  // the on-screen canvas's arbitrary empty space.
  const legendGroups = graph.legend ?? [];
  let legend: { svg: string; width: number; height: number } | null = null;
  if (legendGroups.some((g) => g.items.length > 0)) {
    const legendY0 = maxY + 20;
    legend = legendSvg(legendGroups, graphMinX, legendY0);
    maxX = Math.max(maxX, graphMinX + legend.width);
    maxY = legendY0 + legend.height;
  }

  const minX = graphMinX - pad;
  const minY = graphMinY - pad;
  const w = maxX - graphMinX + pad * 2;
  const h = maxY - graphMinY + pad * 2;

  // One arrow marker per edge (not deduped by color, unlike upstream) so its size can track that
  // edge's own stroke width. Diverges from upstream's own marker def here in two ways: (1) upstream
  // has no `markerUnits`, so its default ("strokeWidth") auto-scales the marker box by stroke
  // width — but that scaling compounds with a *fixed* markerWidth/Height, so on our frequency-
  // scaled DF arcs (uncapped, can exceed 6px) it blew up; `userSpaceOnUse` turns off that implicit
  // scaling, but then needs the size computed explicitly per edge instead (in a 20x20 marker
  // viewBox). The on-screen DfgEdge.tsx marker uses `Math.max(14, sw*4)` — ported that first, but it
  // read as barely-there once exported (a dense interactive canvas can afford a subtler arrowhead
  // than a static print figure), so this is deliberately bumped up further. (2) switched from an
  // open two-segment `fill:none` chevron (renders as ">") to a closed, filled triangle.
  const markerDefs: string[] = [];
  const edgeMarkerId = new Map<StyledEdge, string>();
  graph.edges.forEach((e, i) => {
    if (!e.marker_end?.includes("arrow")) return;
    const id = `sg-arrow-${i}`;
    edgeMarkerId.set(e, id);
    const size = markerSizeFor(e);
    markerDefs.push(
      `<marker id="${id}" markerWidth="${size}" markerHeight="${size}" viewBox="0 0 20 20" refX="7" refY="10" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,2 L14,10 L0,18 Z" fill="${e.color ?? "#888"}" /></marker>`,
    );
  });
  const markers = markerDefs.join("");

  const bg = `<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="${graph.background ?? "#ffffff"}" />`;
  const edges = graph.edges.map((e) => edgeSvg(e, edgeMarkerId.get(e) ?? "")).join("");
  const nodes = graph.nodes.map(nodeSvg).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX} ${minY} ${w} ${h}"><defs>${markers}</defs>${bg}${edges}${nodes}${legend?.svg ?? ""}</svg>`;
}
