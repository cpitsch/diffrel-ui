// Originally adapted from https://github.com/aarkue/propel (packages/components/src/rust-layout/index.ts)
// Copyright (c) 2026 aarkue, licensed MIT OR Apache-2.0.
//
// Diffrel adaptation: upstream has since replaced its own `viz-layout` engine with rust4pm's
// `process_mining::visualization` (graphlay underneath), and so have we. This file now builds a
// graphlay `LayoutRequest` for our React Flow OC-DFG canvas and calls `layout_graph` /
// `reroute_graph` through a `VizTransport` (`./tauri-transport.ts`) — the same functions, names
// and JSON that `@r4pm/components`' `layoutGraph`/`rerouteGraph` helpers use. Field names inside
// the request (`label_size`, `cross_pos`, ...) are graphlay's own snake_case JSON.
import type { Edge, Node } from "@xyflow/react";
import { writeEdgeRouting } from "../dfg/util/edge-routing";
import type { VizTransport } from "./tauri-transport";

export type DfgLayoutNode = Node<{ kind?: "start" | "end" } & Record<string, unknown>>;
export type DfgLayoutEdge = Edge<Record<string, unknown>>;

/** Mutates `nodes`/`edges` in place: sets each node's `position` and (for non-self-loop edges)
 *  writes routed polyline points onto each edge's `data.routing` via `writeEdgeRouting`. */
export type DfgLayoutFn = (
  nodes: DfgLayoutNode[],
  edges: DfgLayoutEdge[],
  nodeSize: (n: DfgLayoutNode) => { width: number; height: number },
  options?: {
    direction?: "TB" | "LR";
    /** Per-node centre to keep (warm start), e.g. every node's current centre on drag-stop.
     *  `pinned` holds that node exactly where it is; the others may make room. */
    seed?: (n: DfgLayoutNode) => { x: number; y: number; pinned?: boolean } | undefined;
    /** Keep every node at its seed and only route the edges again (`reroute_graph`). Requires a
     *  seed for every node. */
    reroute?: boolean;
  },
) => Promise<void>;

type XY = { x: number; y: number };
/** The parts of graphlay's `Layout` JSON this adapter reads. */
type GraphlayLayout = {
  nodes: { center: XY }[];
  edges: { points: XY[] }[];
};

/** graphlay edge routing style: right-angle segments through gutters, or diagonal segments. */
export type RoutingStyle = "orthogonal" | "diagonal";

/** A `DfgLayoutFn` for the object-centric DFG, laid out by graphlay's `process_map` preset (the
 *  same preset rust4pm uses for its own DFG/OC-DFG drawings). */
export function createRustOcdfgLayout(
  transport: VizTransport,
  routing: RoutingStyle = "orthogonal",
): DfgLayoutFn {
  return async (nodes, edges, nodeSize, options) => {
    // Self-loops are drawn by our own `DfgEdge` (a bump on the free cross-axis side), not routed
    // by the engine, so they are left out of the request; their node instead reserves room for
    // the bump and its labels via a cross-axis margin.
    type Arc = { ot: string; from: string; to: string; count: number; edge: DfgLayoutEdge };
    const arcs: Arc[] = [];
    const loopLabels = new Map<string, string[]>();
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    for (const e of edges) {
      // An arc to a node that isn't on the canvas can't be drawn by React Flow either.
      if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
      if (e.source === e.target) {
        const labels = loopLabels.get(e.source) ?? [];
        labels.push((e.data as { label?: string }).label ?? "");
        loopLabels.set(e.source, labels);
        continue;
      }
      arcs.push({
        ot: (e.data as { group?: string }).group ?? "",
        from: e.source,
        to: e.target,
        count: (e.data as { count?: number }).count ?? 0,
        edge: e,
      });
    }
    const loopClearance = (labels: string[]) =>
      labels.reduce((m, text, i) => Math.max(m, 27 + 18 * i + (text.length * 6.2 + 6) / 2 + 8), 0);

    // Canonical node order (terminals first, then the rest by id) and canonical edge order (per
    // sorted object type: starts, ends, then relations by source/target), so the same graph
    // always yields the same request regardless of React Flow array order. Every node also
    // carries its id as graphlay `key`, which breaks ties by name instead of input position.
    const kindOf = (n: DfgLayoutNode) => (n.type === "terminal" ? n.data.kind : undefined);
    // Every node is laid out, including one with no arcs left after filtering (or only a
    // self-loop), so it gets its own spot instead of keeping a stale or (0, 0) position.
    const laidOut = [...nodes].sort(
        (a, b) =>
          Number(kindOf(b) !== undefined) - Number(kindOf(a) !== undefined) ||
          a.id.localeCompare(b.id),
      );
    const indexOf = new Map(laidOut.map((n, i) => [n.id, i]));

    const isStart = (id: string) => kindOf(nodeById.get(id)!) === "start";
    const isEnd = (id: string) => kindOf(nodeById.get(id)!) === "end";
    const types = [...new Set(arcs.map((a) => a.ot))].sort();
    const typeIndex = new Map(types.map((t, i) => [t, i]));
    const ordered: Arc[] = [];
    for (const ot of types) {
      const mine = arcs.filter((a) => a.ot === ot);
      ordered.push(
        ...mine.filter((a) => isStart(a.from)).sort((x, y) => x.to.localeCompare(y.to)),
        ...mine.filter((a) => isEnd(a.to)).sort((x, y) => x.from.localeCompare(y.from)),
        ...mine
          .filter((a) => !isStart(a.from) && !isEnd(a.to))
          .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to)),
      );
    }

    const graphNodes = laidOut.map((n) => {
      const kind = kindOf(n);
      const size = nodeSize(n);
      const seed = options?.seed?.(n);
      const labels = loopLabels.get(n.id);
      return {
        size: { width: size.width, height: size.height },
        shape: kind ? "ellipse" : "box",
        rank: kind === "start" ? "first" : kind === "end" ? "last" : "free",
        ...(seed ? { position: { x: seed.x, y: seed.y }, pinned: seed.pinned ?? false } : {}),
        // `cross_pos` is the free cross-axis side (right in TB, bottom in LR) — where `DfgEdge`
        // draws its self-loop bumps.
        ...(labels ? { margin: { cross_pos: loopClearance(labels) } } : {}),
        key: n.id,
      };
    });
    const graphEdges = ordered.map((a) => {
      const sw = (a.edge.style as React.CSSProperties | undefined)?.strokeWidth;
      return {
        source: indexOf.get(a.from)!,
        target: indexOf.get(a.to)!,
        // Same weighting rust4pm uses for DFG arcs (`weight_from_count`): heavier = shorter and
        // straighter.
        weight: 1 + Math.log(Math.max(1, a.count)),
        thickness: typeof sw === "number" ? sw : 2,
        group: typeIndex.get(a.ot),
      };
    });

    const request = {
      graph: { nodes: graphNodes, edges: graphEdges },
      preset: "process_map",
      options: {
        direction: (options?.direction ?? "TB") === "TB" ? "topbottom" : "leftright",
        routing: { style: routing },
      },
    };
    const layout = (await (options?.reroute
      ? transport.call("reroute_graph", { request, positions: [] })
      : transport.call("layout_graph", { request }))) as GraphlayLayout;

    const topLeft = (n: DfgLayoutNode) => {
      const i = indexOf.get(n.id);
      const c = i === undefined ? undefined : layout.nodes[i]?.center;
      const { width, height } = nodeSize(n);
      return c ? { x: c.x - width / 2, y: c.y - height / 2 } : n.position;
    };
    for (const n of laidOut) n.position = topLeft(n);
    ordered.forEach((a, i) => {
      const src = nodeById.get(a.from)!;
      const tgt = nodeById.get(a.to)!;
      writeEdgeRouting(a.edge, layout.edges[i]?.points ?? [], src.position, tgt.position);
    });
  };
}
