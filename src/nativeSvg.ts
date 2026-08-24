import type { EventTypeNodeData, ObjectTypeNodeData } from "./types";

/** Minimal structural shape of a React Flow node — avoids importing `Node` from
 * @xyflow/react so this module stays decoupled, like mermaid.ts. */
interface LaidOutNode<T> {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  data: T;
}

export interface NativeSvgEdge {
  qualifier: string;
  sourceId: string;
  targetId: string;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PADDING = 20;
const DEFAULT_W = 180;
const DEFAULT_H = 60;

export const SANS_STACK =
  '"Segoe UI Variable","Segoe UI",-apple-system,"SF Pro Display",Ubuntu,Cantarell,sans-serif';
export const MONO_STACK =
  '"Cascadia Code","SF Mono","Ubuntu Mono",Consolas,monospace';

const LINE_HEIGHT_RATIO = 1.2;
/** Standard cap-height-ish offset for converting a line's vertical center into an SVG
 * text baseline y. dominant-baseline is deliberately avoided (inconsistent support in
 * some non-browser SVG viewers, which is the whole point of this export). */
const BASELINE_OFFSET_RATIO = 0.35;
/** Extra gap between stacked lines, matching the `gap: 2px` flex-column gap in both
 * EventTypeNode.module.css and ObjectTypeNode.module.css — line-height alone (the
 * lines' own font metrics) isn't the only spacing the live layout applies. */
const LINE_GAP = 2;
/** Matches ObjectTypeNode.module.css's `border-radius: 27.5px` and
 * EventTypeNode.module.css's `border-radius: 8px` exactly, rather than deriving a
 * "true" pill from the node's actual height — for taller pill nodes (more stat lines),
 * the live CSS component doesn't scale the radius up to match, so a computed full pill
 * ends up looking rounder than the real thing. */
const OBJ_NODE_RADIUS = 27.5;
const EVT_NODE_RADIUS = 8;
/** CSS `border: 2px solid` is fully inside the box (border-box sizing); SVG's stroke
 * is centered on the path by default, so half would bleed outside the rect and the
 * fill would show through the inner half less crisply. Draw the stroke as a separate,
 * 1px-inset outline so its 2px of ink lands entirely within the original box bounds,
 * matching the CSS look instead of looking thinner/blended. */
const BORDER_WIDTH = 2;

const EVT_BADGE_FS = 9.6;
const EVT_LABEL_FS = 13.6;
const EVT_STATS_FS = 11.52;
const EVT_SUBTITLE_FS = 12;
const OBJ_LABEL_FS = 12.8;
const OBJ_STAT_FS = 11.52;
const EDGE_LABEL_FS = 11.2;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatPVal(p: number): string {
  if (p > 0 && p < 0.00005) return "< 0.0001";
  return p.toFixed(4);
}

/** Returns the point where the line from (cx,cy) through (px,py) exits the rectangle
 * centered at (cx,cy) with half-dimensions (hw,hh). Duplicated from FloatingEdge.tsx
 * rather than shared — two call sites, trivial size. */
function rectIntersection(
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  px: number,
  py: number,
): { x: number; y: number } {
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

export type NativeSvgEdgeStyle = "straight" | "bezier";

/** Matches @xyflow/react's default BezierEdge curvature (used whenever an edge's
 * `type` is unset) exactly, so hierarchical-layout exports show the same curved
 * edges as the live canvas instead of straight rectIntersection lines. */
const BEZIER_CURVATURE = 0.25;

function calculateControlOffset(distance: number, curvature: number): number {
  if (distance >= 0) return 0.5 * distance;
  return curvature * 25 * Math.sqrt(-distance);
}

/** Cubic bezier from the source node's bottom-center to the target node's top-center —
 * the fixed handle positions GraphView.tsx's `displayEdges` assigns
 * (`sourceHandle:"bottom"`, `targetHandle:"top"`) whenever layoutMode isn't "force".
 * Mirrors @xyflow/react's getControlWithCurvature (Bottom/Top cases only, since those
 * are the only positions these edges ever use) and getBezierEdgeCenter for the label
 * midpoint. */
function bezierEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): { path: string; labelX: number; labelY: number } {
  const sourceControlY =
    sourceY + calculateControlOffset(targetY - sourceY, BEZIER_CURVATURE);
  const targetControlY =
    targetY - calculateControlOffset(sourceY - targetY, BEZIER_CURVATURE);
  const path = `M${sourceX},${sourceY} C${sourceX},${sourceControlY} ${targetX},${targetControlY} ${targetX},${targetY}`;
  const labelX =
    sourceX * 0.125 + sourceX * 0.375 + targetX * 0.375 + targetX * 0.125;
  const labelY =
    sourceY * 0.125 +
    sourceControlY * 0.375 +
    targetControlY * 0.375 +
    targetY * 0.125;
  return { path, labelX, labelY };
}

let measureCanvas: HTMLCanvasElement | null = null;
/** Real text measurement via an offscreen canvas — used only where an SVG <rect>
 * genuinely needs to know rendered text width (it can't auto-size to sibling text the
 * way a CSS padding box would). Not a character-count heuristic. */
export function measureTextWidth(
  text: string,
  fontSizePx: number,
  fontFamily: string,
): number {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return text.length * fontSizePx * 0.55;
  ctx.font = `${fontSizePx}px ${fontFamily}`;
  return ctx.measureText(text).width;
}

function computeColumnWidths(
  rows: string[][],
  fontSizePx: number,
  fontFamily: string,
): number[] {
  const numCols = rows[0]?.length ?? 0;
  const widths = new Array(numCols).fill(0);
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], measureTextWidth(cell, fontSizePx, fontFamily));
    });
  }
  return widths;
}

type Attrs = Record<string, string | number | undefined>;

function el(tag: string, attrs: Attrs, children?: string): string {
  const attrStr = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");
  if (children === undefined) return `<${tag}${attrStr}/>`;
  return `<${tag}${attrStr}>${children}</${tag}>`;
}

function textEl(
  cx: number,
  y: number,
  fontSizePx: number,
  fill: string,
  content: string,
  opts: { weight?: number; fontFamily?: string; letterSpacing?: string } = {},
): string {
  return el(
    "text",
    {
      x: cx,
      y,
      "text-anchor": "middle",
      "font-size": fontSizePx,
      "font-family": opts.fontFamily ?? SANS_STACK,
      "font-weight": opts.weight,
      fill,
      "letter-spacing": opts.letterSpacing,
    },
    escapeXml(content),
  );
}

/** A monospace stat line split into a full-opacity "main" run and a dimmer "tail" run
 * (mirrors ObjectTypeNode.module.css's .sd { opacity: 0.75 } on the "± std" portion). */
function statLineSplit(
  cx: number,
  y: number,
  fontSizePx: number,
  main: string,
  tail: string,
): string {
  const mainTspan = el("tspan", {}, escapeXml(main));
  const tailTspan = tail
    ? el("tspan", { "fill-opacity": 0.75 }, escapeXml(tail))
    : "";
  return el(
    "text",
    {
      x: cx,
      y,
      "text-anchor": "middle",
      "font-size": fontSizePx,
      "font-family": MONO_STACK,
      fill: "rgba(0,0,0,0.6)",
    },
    mainTspan + tailTspan,
  );
}

type Line =
  | {
      kind: "text";
      text: string;
      fontSizePx: number;
      fill: string;
      weight?: number;
      fontFamily?: string;
      letterSpacing?: string;
    }
  | {
      kind: "stat";
      main: string;
      tail: string;
      fontSizePx: number;
    }
  | {
      // A left-aligned grid row (e.g. "p", "=", value), sized against
      // pre-shared column widths so multiple rows line up like a table —
      // mirrors EventTypeNode.module.css's `.stats` CSS grid, which can't be
      // replicated by per-line centering since row contents differ in length.
      kind: "statsRow";
      cells: string[];
      columnWidths: number[];
      fontSizePx: number;
    };

function lineHeight(line: Line): number {
  return line.fontSizePx * LINE_HEIGHT_RATIO;
}

const STATS_GRID_COLUMN_GAP = 3; // matches EventTypeNode.module.css's column-gap: 3px

function statsRowSvg(
  cx: number,
  y: number,
  fontSizePx: number,
  cells: string[],
  columnWidths: number[],
): string {
  const totalWidth =
    columnWidths.reduce((s, w) => s + w, 0) +
    STATS_GRID_COLUMN_GAP * (columnWidths.length - 1);
  let colX = cx - totalWidth / 2;
  let svg = "";
  cells.forEach((cell, i) => {
    // text-align: center inherits from EventTypeNode.module.css's `.node`, so each
    // cell centers within its own column width rather than hugging its left edge.
    svg += el(
      "text",
      {
        x: colX + columnWidths[i] / 2,
        y,
        "text-anchor": "middle",
        "font-size": fontSizePx,
        "font-family": MONO_STACK,
        fill: "rgba(0,0,0,0.6)",
      },
      escapeXml(cell),
    );
    colX += columnWidths[i] + STATS_GRID_COLUMN_GAP;
  });
  return svg;
}

/** Vertically centers a stack of lines (of possibly-mixed font sizes) around
 * rectCenterY and returns both the rendered markup and each line's vertical center
 * (the latter needed separately to position the drilldown dot next to the label line). */
function renderTextBlock(
  lines: Line[],
  cx: number,
  rectCenterY: number,
): { svg: string; lineCenters: number[] } {
  const totalHeight =
    lines.reduce((sum, l) => sum + lineHeight(l), 0) +
    LINE_GAP * Math.max(0, lines.length - 1);
  let cursorY = rectCenterY - totalHeight / 2;
  const lineCenters: number[] = [];
  const parts: string[] = [];
  for (const line of lines) {
    const lh = lineHeight(line);
    const centerY = cursorY + lh / 2;
    lineCenters.push(centerY);
    const baselineY = centerY + line.fontSizePx * BASELINE_OFFSET_RATIO;
    if (line.kind === "stat") {
      parts.push(statLineSplit(cx, baselineY, line.fontSizePx, line.main, line.tail));
    } else if (line.kind === "statsRow") {
      parts.push(
        statsRowSvg(cx, baselineY, line.fontSizePx, line.cells, line.columnWidths),
      );
    } else {
      parts.push(
        textEl(cx, baselineY, line.fontSizePx, line.fill, line.text, {
          weight: line.weight,
          fontFamily: line.fontFamily,
          letterSpacing: line.letterSpacing,
        }),
      );
    }
    cursorY += lh + LINE_GAP;
  }
  return { svg: parts.join(""), lineCenters };
}

function eventNodeFill(data: EventTypeNodeData): string {
  if (data.isPending) return "#e0e7ff";
  if (data.presence !== "both" || data.result === null) return "#e5e7eb";
  return data.result.isSignificant ? "#fecaca" : "#bbf7d0";
}

function subtitleFor(data: EventTypeNodeData): string {
  if (data.presence === "onlyInLog1") return "only in log 1";
  if (data.presence === "onlyInLog2") return "only in log 2";
  if (data.isPending) return "pending";
  if (data.result === null) return "not tested";
  return "";
}

function eventNodeTextLines(data: EventTypeNodeData): Line[] {
  const lines: Line[] = [];
  if (data.blockMode) {
    lines.push({
      kind: "text",
      text: data.blockMode,
      fontSizePx: EVT_BADGE_FS,
      weight: 600,
      fill: "#6366f1",
      letterSpacing: "0.05em",
    });
  }
  lines.push({
    kind: "text",
    text: data.groupKey,
    fontSizePx: EVT_LABEL_FS,
    weight: 600,
    fill: "#111827",
  });

  const result = data.result;
  if (data.presence === "both" && result !== null) {
    const rows = [
      ["p", "=", formatPVal(result.pValue)],
      ["n", "=", `${result.n1} / ${result.n2}`],
    ];
    const columnWidths = computeColumnWidths(rows, EVT_STATS_FS, MONO_STACK);
    for (const cells of rows) {
      lines.push({ kind: "statsRow", cells, columnWidths, fontSizePx: EVT_STATS_FS });
    }
  } else {
    const subtitle = subtitleFor(data);
    if (subtitle) {
      lines.push({
        kind: "text",
        text: subtitle,
        fontSizePx: EVT_SUBTITLE_FS,
        fill: "#374151",
      });
    }
  }
  return lines;
}

function objectNodeBorder(data: ObjectTypeNodeData): {
  stroke: string;
  strokeOpacity?: number;
} {
  if (data.drilldownIsSignificant === undefined) {
    return { stroke: "#000000", strokeOpacity: 0.15 };
  }
  return { stroke: data.drilldownIsSignificant ? "#d5adad" : "#a3d1b1" };
}

function objectNodeTextLines(data: ObjectTypeNodeData): Line[] {
  const lines: Line[] = [
    {
      kind: "text",
      text: data.objectType,
      fontSizePx: OBJ_LABEL_FS,
      weight: 600,
      fill: "#111827",
    },
    {
      kind: "stat",
      main: `μ₁ = ${data.meanLog1.toFixed(2)}`,
      tail: ` ± ${data.stdLog1.toFixed(2)}`,
      fontSizePx: OBJ_STAT_FS,
    },
    {
      kind: "stat",
      main: `μ₂ = ${data.meanLog2.toFixed(2)}`,
      tail: ` ± ${data.stdLog2.toFixed(2)}`,
      fontSizePx: OBJ_STAT_FS,
    },
  ];
  if (!data.isDrilldownPending && data.drilldownPValue !== undefined) {
    lines.push({
      kind: "text",
      text: `p = ${formatPVal(data.drilldownPValue)}`,
      fontSizePx: OBJ_STAT_FS,
      fill: "rgba(0,0,0,0.6)",
      fontFamily: MONO_STACK,
    });
  }
  return lines;
}

/** Fill rect at full node dims (matches border-box content+padding area, unaffected by
 * border thickness) plus a separate, 1px-inset stroke-only outline (see BORDER_WIDTH
 * comment above) so the two together match the CSS look. */
function nodeShape(
  r: Rect,
  radius: number,
  fill: string,
  stroke: string,
  strokeOpacity?: number,
): string {
  const fillPart = el("rect", {
    x: r.x,
    y: r.y,
    width: r.w,
    height: r.h,
    rx: radius,
    ry: radius,
    fill,
  });
  const inset = BORDER_WIDTH / 2;
  const insetRadius = Math.max(0, radius - inset);
  const strokePart = el("rect", {
    x: r.x + inset,
    y: r.y + inset,
    width: Math.max(0, r.w - inset * 2),
    height: Math.max(0, r.h - inset * 2),
    rx: insetRadius,
    ry: insetRadius,
    fill: "none",
    stroke,
    "stroke-opacity": strokeOpacity,
    "stroke-width": BORDER_WIDTH,
  });
  return fillPart + strokePart;
}

function resolveRect(node: LaidOutNode<unknown>, ox: number, oy: number): Rect {
  return {
    x: node.position.x + ox,
    y: node.position.y + oy,
    w: node.measured?.width ?? DEFAULT_W,
    h: node.measured?.height ?? DEFAULT_H,
  };
}

export function buildNativeSvgSubgraph(args: {
  eventNode: LaidOutNode<EventTypeNodeData>;
  objectNodes: LaidOutNode<ObjectTypeNodeData>[];
  edges: NativeSvgEdge[];
  bounds: Bounds;
  edgeStyle: NativeSvgEdgeStyle;
}): string {
  const { eventNode, objectNodes, edges, bounds, edgeStyle } = args;
  const ox = PADDING - bounds.x;
  const oy = PADDING - bounds.y;
  const svgW = Math.ceil(bounds.width) + PADDING * 2;
  const svgH = Math.ceil(bounds.height) + PADDING * 2;

  const rects = new Map<string, Rect>();
  rects.set(eventNode.id, resolveRect(eventNode, ox, oy));
  for (const on of objectNodes) rects.set(on.id, resolveRect(on, ox, oy));

  const parts: string[] = [];

  // Edges first, so they're drawn behind nodes (matches React Flow's actual layering).
  for (const edge of edges) {
    const s = rects.get(edge.sourceId);
    const t = rects.get(edge.targetId);
    if (!s || !t) continue;

    let sp: { x: number; y: number };
    let tp: { x: number; y: number };
    let labelX: number;
    let labelY: number;
    let edgeShape: string;

    if (edgeStyle === "bezier") {
      // Matches GraphView.tsx's displayEdges, which fixes sourceHandle="bottom" /
      // targetHandle="top" whenever layoutMode isn't "force" — the live canvas falls
      // back to React Flow's default (curved) BezierEdge in that case, not FloatingEdge.
      sp = { x: s.x + s.w / 2, y: s.y + s.h };
      tp = { x: t.x + t.w / 2, y: t.y };
      const bezier = bezierEdgePath(sp.x, sp.y, tp.x, tp.y);
      edgeShape = el("path", {
        d: bezier.path,
        fill: "none",
        stroke: "#b1b1b7",
        "stroke-width": 1,
      });
      labelX = bezier.labelX;
      labelY = bezier.labelY;
    } else {
      const scx = s.x + s.w / 2;
      const scy = s.y + s.h / 2;
      const tcx = t.x + t.w / 2;
      const tcy = t.y + t.h / 2;
      sp = rectIntersection(scx, scy, s.w / 2, s.h / 2, tcx, tcy);
      tp = rectIntersection(tcx, tcy, t.w / 2, t.h / 2, scx, scy);
      edgeShape = el("line", {
        x1: sp.x,
        y1: sp.y,
        x2: tp.x,
        y2: tp.y,
        stroke: "#b1b1b7",
        "stroke-width": 1,
      });
      labelX = (sp.x + tp.x) / 2;
      labelY = (sp.y + tp.y) / 2;
    }

    parts.push(edgeShape);

    if (edge.qualifier) {
      const mx = labelX;
      const my = labelY;
      const textW = measureTextWidth(edge.qualifier, EDGE_LABEL_FS, SANS_STACK);
      const boxW = textW + 8;
      const boxH = EDGE_LABEL_FS * LINE_HEIGHT_RATIO + 2;
      parts.push(
        el("rect", {
          x: mx - boxW / 2,
          y: my - boxH / 2,
          width: boxW,
          height: boxH,
          rx: 3,
          ry: 3,
          fill: "#ffffff",
          "fill-opacity": 0.85,
        }),
      );
      parts.push(
        textEl(
          mx,
          my + EDGE_LABEL_FS * BASELINE_OFFSET_RATIO,
          EDGE_LABEL_FS,
          "#111827",
          edge.qualifier,
          { fontFamily: SANS_STACK },
        ),
      );
    }
  }

  // Event node.
  const er = rects.get(eventNode.id)!;
  parts.push(
    nodeShape(er, EVT_NODE_RADIUS, eventNodeFill(eventNode.data), "#000000", 0.15),
  );
  parts.push(
    renderTextBlock(
      eventNodeTextLines(eventNode.data),
      er.x + er.w / 2,
      er.y + er.h / 2,
    ).svg,
  );

  // Object-type nodes.
  for (const on of objectNodes) {
    const r = rects.get(on.id)!;
    const border = objectNodeBorder(on.data);
    parts.push(
      nodeShape(r, OBJ_NODE_RADIUS, on.data.color, border.stroke, border.strokeOpacity),
    );

    const { svg: textSvg, lineCenters } = renderTextBlock(
      objectNodeTextLines(on.data),
      r.x + r.w / 2,
      r.y + r.h / 2,
    );
    parts.push(textSvg);

    if (!on.data.isDrilldownPending && on.data.drilldownIsSignificant !== undefined) {
      const dotColor = on.data.drilldownIsSignificant ? "#d5adad" : "#a3d1b1";
      // Fixed inset from the node's right edge, matching the live component's own
      // `position:absolute; right:0` layout (ObjectTypeNode.tsx) for the typical case
      // where node width is content-driven rather than clamped by min-width.
      parts.push(
        el("circle", {
          cx: r.x + r.w - 18,
          cy: lineCenters[0],
          r: 5,
          fill: dotColor,
        }),
      );
    }
  }

  const body = parts.join("");
  return el(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: svgW,
      height: svgH,
      viewBox: `0 0 ${svgW} ${svgH}`,
      "font-family": SANS_STACK,
    },
    body,
  );
}
