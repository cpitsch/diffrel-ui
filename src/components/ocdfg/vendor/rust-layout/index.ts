// Adapted from https://github.com/aarkue/propel (packages/components/src/rust-layout/index.ts)
// Copyright (c) 2026 aarkue, licensed MIT OR Apache-2.0.
//
// Diffrel adaptation: `DfgLayoutFn`/`DfgLayoutNode`/`DfgLayoutEdge` come from our own
// `../elk-layout/dfg` (see that file's own header for why upstream's `dfg/DfgGraph` app-layer
// type isn't vendored). `LayoutTransport` is engine-agnostic upstream (its two methods are meant
// to be backed by whatever loads the wasm); ours is instead backed by Tauri IPC — see
// `./tauri-transport.ts`, our own glue, not vendored. Only `createRustOcdfgLayout`/
// `createRustDfgLayout` are vendored here — the only two of upstream's exports we actually use.
// Skipped: `noopDfgLayout` (a no-engine-wired fallback, never applicable here), the generic
// `layoutGraph<N,E>` driver and `LaidOutGraph` (used by upstream's *other* graph surfaces —
// Petri nets, OCEL type graph, etc. — not the OC-DFG path `createRustOcdfgLayout` builds itself).
//
// Field names inside the spec objects below (`flow_edges`, `clear_after`, etc.) deliberately stay
// snake_case, unlike every other Tauri command boundary in this app — see the comment on
// `layout_graph`/`reroute_graph` in `src-tauri/src/lib.rs` for why.
import type { DfgLayoutFn } from "../elk-layout/dfg";
import { DFG_END_ID, DFG_START_ID } from "../dfg/util/dfg-model";
import { writeEdgeRouting } from "../dfg/util/edge-routing";

export type GraphLayout = { centers: [number, number][]; routes: [number, number][][] };

/** Pluggable layout transport: lays out (or re-routes) a `GraphSpec`, returning node centres + edge routes; passed explicitly, no global engine. */
export interface LayoutTransport {
  layoutGraph(spec: unknown): Promise<GraphLayout>;
  rerouteGraph(spec: unknown): Promise<GraphLayout>;
}

export type GraphNodeSpec = {
  width: number;
  height: number;
  ellipse?: boolean;
  pin?: "first" | "last";
  /** Minimum clearance (px) to keep free right of the node (TB) for caller-drawn decorations, e.g. DFG self-loops. */
  clear_after?: number;
  /** Optional grouping id; same-category nodes stay in a consistent lane across layers as a tiebreak. */
  category?: number;
  /** Optional seed centre `[x, y]`; when set, layout keeps structural layer/order but places the cross-axis at the seed. */
  seed?: [number, number];
  /** Hard-pin this node's seed cross-coordinate so it lands exactly where dropped. Only meaningful with `seed`. */
  pinned?: boolean;
};

/** A `DfgLayoutFn` for the object-centric DFG, backed by generic Rust `layout_graph`. Builds the spec in the same canonical node/edge order as the SVG export, so screen and export stay consistent. */
export function createRustOcdfgLayout(transport: LayoutTransport, flowDiagonal = true): DfgLayoutFn {
  const START = "__START__";
  const END = "__END__";
  const geoId = (id: string) => (id === DFG_START_ID ? START : id === DFG_END_ID ? END : id);
  const rfId = (geo: string) => (geo === START ? DFG_START_ID : geo === END ? DFG_END_ID : geo);
  return async (nodes, edges, nodeSize, options) => {
    type Arc = { ot: string; from: string; to: string; count: number; edge: (typeof edges)[number] };
    const arcs: Arc[] = [];
    // reserve clearance for the host-drawn self-loop bump + label
    const loopLabels = new Map<string, string[]>();
    for (const e of edges) {
      if (e.source === e.target) {
        const id = geoId(e.source);
        const labels = loopLabels.get(id) ?? [];
        labels.push((e.data as { label?: string }).label ?? "");
        loopLabels.set(id, labels);
        continue;
      }
      arcs.push({
        ot: (e.data as { group?: string }).group ?? "",
        from: geoId(e.source),
        to: geoId(e.target),
        count: (e.data as { count?: number }).count ?? 0,
        edge: e,
      });
    }
    const loopClearance = (labels: string[]) =>
      labels.reduce((m, text, i) => Math.max(m, 27 + 18 * i + (text.length * 6.2 + 6) / 2 + 8), 0);

    // Canonical node order: START, END, then activities (union of arc endpoints) sorted by name.
    const actSet = new Set<string>();
    for (const a of arcs) for (const id of [a.from, a.to]) if (id !== START && id !== END) actSet.add(id);
    const nodeIds = [START, END, ...[...actSet].sort()];
    const indexOf = new Map(nodeIds.map((id, i) => [id, i]));

    // canonical edge order: per sorted object type, sorted starts/ends, then relations by source
    const types = [...new Set(arcs.map((a) => a.ot))].sort();
    const ordered: Arc[] = [];
    for (const ot of types) {
      const mine = arcs.filter((a) => a.ot === ot);
      ordered.push(
        ...mine.filter((a) => a.from === START).sort((x, y) => x.to.localeCompare(y.to)),
        ...mine.filter((a) => a.to === END).sort((x, y) => x.from.localeCompare(y.from)),
        ...mine
          .filter((a) => a.from !== START && a.to !== END)
          .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to)),
      );
    }

    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const seedOf = new Map<string, { x: number; y: number; pinned?: boolean }>();
    if (options?.seed)
      for (const n of nodes) {
        const s = options.seed(n);
        if (s) seedOf.set(geoId(n.id), s);
      }
    const pinOf = new Map<string, "first" | "last">();
    const specNodes: GraphNodeSpec[] = nodeIds.map((id) => {
      const rf = nodeById.get(rfId(id));
      // `geoId`/`START`/`END` only ever fire for the case-centric DFG, whose node ids really are
      // the bare `DFG_START_ID`/`DFG_END_ID` sentinels. The OC-DFG instead has one start/end pair
      // *per object type* (`${DFG_START_ID}::${objectType}`, see ProcessModelView.tsx), which never
      // equals those sentinels — so `id === START || id === END` alone silently missed every
      // OC-DFG terminal, sending them through as plain unpinned, non-elliptical "activity" nodes:
      // no `pin: "first"/"last"` (free to land in any layer) and no `ellipse` (route endpoints
      // computed against a box, not a circle). Recognizing the real React Flow node's own
      // `type`/`data.kind` (independent of id format) covers both cases.
      const rfKind = rf?.type === "terminal" ? rf.data.kind : undefined;
      const isStart = id === START || rfKind === "start";
      const isEnd = id === END || rfKind === "end";
      const term = isStart || isEnd;
      if (isStart) pinOf.set(id, "first");
      else if (isEnd) pinOf.set(id, "last");
      const size = rf ? nodeSize(rf) : { width: term ? 36 : 150, height: term ? 36 : 58 };
      const s = seedOf.get(id);
      const labels = loopLabels.get(id);
      return {
        width: size.width,
        height: size.height,
        ellipse: term,
        pin: isStart ? "first" : isEnd ? "last" : undefined,
        seed: s ? ([s.x, s.y] as [number, number]) : undefined,
        pinned: s?.pinned,
        clear_after: labels ? loopClearance(labels) : undefined,
      };
    });
    const specEdges = ordered.map(
      (a) => [indexOf.get(a.from) ?? 0, indexOf.get(a.to) ?? 0] as [number, number],
    );
    const weights = ordered.map((a) => (a.count <= 0 ? 0.5 : 1 + Math.log(a.count)));
    const thickness = ordered.map((a) => {
      const sw = (a.edge.style as React.CSSProperties | undefined)?.strokeWidth;
      return typeof sw === "number" ? sw : 2;
    });

    // on drop, every node is seeded at its current centre, so reroute only re-derives routes
    const spec = {
      nodes: specNodes,
      edges: specEdges,
      weights,
      thickness,
      direction: options?.direction ?? "TB",
      flow_edges: true,
      flow_diagonal: flowDiagonal,
    };
    const g = await (options?.reroute ? transport.rerouteGraph(spec) : transport.layoutGraph(spec));

    // The engine's own terminal-centering pass (viz-layout's `layout.rs`: "Centre the START/END
    // terminals on the median cross-position of their neighbours") re-centers every pinned
    // first/last terminal onto the weighted median of its neighbours' cross-axis position, with
    // nothing downstream re-separating same-layer terminals afterward — fine for upstream's own
    // single global start/end pair (never more than one first-pinned node to begin with), but
    // this OC-DFG pins one start/end terminal *per object type*: two object types sharing the
    // exact same (single) start/end activity compute the identical median and land on literally
    // the same spot. Cheaper to de-overlap client-side — ordered by that same median, which is
    // still a meaningful signal for which flow each terminal belongs to — than to fork/patch the
    // vendored Rust engine for a case upstream itself never hits.
    const crossAxis = (options?.direction ?? "TB") === "TB" ? 0 : 1;
    // Per-id cross-axis nudge applied below, so the route-endpoint fix after it can shift each
    // affected arc by the exact same amount the node itself moved.
    const centerDelta = new Map<string, number>();
    const dedupePinned = (pin: "first" | "last") => {
      const idxs = [...pinOf.entries()]
        .filter(([, p]) => p === pin)
        .map(([id]) => ({ id, i: indexOf.get(id) }))
        .filter((e): e is { id: string; i: number } => e.i != null)
        .sort((a, b) => g.centers[a.i][crossAxis] - g.centers[b.i][crossAxis]);
      const GAP = 44;
      for (let k = 1; k < idxs.length; k++) {
        const prev = g.centers[idxs[k - 1].i];
        const cur = g.centers[idxs[k].i];
        const min = prev[crossAxis] + GAP;
        if (cur[crossAxis] < min) {
          const delta = min - cur[crossAxis];
          g.centers[idxs[k].i] = crossAxis === 0 ? [min, cur[1]] : [cur[0], min];
          centerDelta.set(idxs[k].id, (centerDelta.get(idxs[k].id) ?? 0) + delta);
        }
      }
    };
    dedupePinned("first");
    dedupePinned("last");

    // `g.routes[i]` was computed by the engine against the pre-de-overlap centers above, so any
    // route touching a terminal just nudged still points at its old (overlapping) spot — the node
    // circle moved, but the arc still visually converges on where it used to be. Terminals are
    // always a route's first or last point (never an interior waypoint, since they're start/end
    // of the flow), so shift just that one endpoint by the same delta.
    if (centerDelta.size > 0) {
      ordered.forEach((a, i) => {
        const pts = g.routes[i];
        if (!pts || pts.length === 0) return;
        const srcDelta = centerDelta.get(a.from);
        if (srcDelta) {
          pts[0] = crossAxis === 0 ? [pts[0][0] + srcDelta, pts[0][1]] : [pts[0][0], pts[0][1] + srcDelta];
        }
        const tgtDelta = centerDelta.get(a.to);
        if (tgtDelta) {
          const last = pts.length - 1;
          pts[last] =
            crossAxis === 0 ? [pts[last][0] + tgtDelta, pts[last][1]] : [pts[last][0], pts[last][1] + tgtDelta];
        }
      });
    }

    const centerOf = (geo: string) => {
      const i = indexOf.get(geo);
      return i == null ? undefined : g.centers[i];
    };
    const topLeft = (n: (typeof nodes)[number]) => {
      const c = centerOf(geoId(n.id));
      const { width, height } = nodeSize(n);
      return { x: (c?.[0] ?? 0) - width / 2, y: (c?.[1] ?? 0) - height / 2 };
    };
    for (const n of nodes) if (centerOf(geoId(n.id))) n.position = topLeft(n);
    ordered.forEach((a, i) => {
      const pts = (g.routes[i] ?? []).map(([x, y]) => ({ x, y }));
      const src = nodeById.get(a.edge.source);
      const tgt = nodeById.get(a.edge.target);
      writeEdgeRouting(a.edge, pts, src ? topLeft(src) : { x: 0, y: 0 }, tgt ? topLeft(tgt) : { x: 0, y: 0 });
    });
  };
}

/** A `DfgLayoutFn` for the case-centric DFG: a plain DFG is an OC-DFG with one implicit object type, so this is just {@link createRustOcdfgLayout}. */
export const createRustDfgLayout = createRustOcdfgLayout;
