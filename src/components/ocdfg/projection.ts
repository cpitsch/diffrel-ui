/** Renderer-neutral projection of a two-log process-model comparison: decides *what* the OC-DFG
 *  canvas shows (which activities, terminals and arcs, with both logs' counts and significance
 *  marks), but not *how* it is drawn — no colors, stroke widths or React Flow types here. The
 *  React Flow adapter (`toReactFlow.ts`) turns a `ProjectedModel` into canvas nodes/edges; a
 *  future upstream-viewer adapter (`@r4pm/components` `DfgGraph` + look hooks) is meant to consume
 *  the same model, which is why this file must stay free of renderer imports.
 *
 *  Ids are generated here, not in the adapter: they are model identity, and saved canvas layouts
 *  (`ProcessModelLayout` in `processModelExport.ts`) are keyed by them, so they must stay stable
 *  across renderers and releases. */

import type { ProcessModelData } from "../../processModel";
import type { DfgEdgeSkeleton } from "../../types";
import { DFG_END_ID, DFG_START_ID } from "./vendor/dfg/util/dfg-model";

/** Which threshold gates a DF backbone arc's visibility: `Ratio` keeps an arc whose fan-out-
 *  relative frequency clears `minFanoutRatio` in at least one log; `Count` keeps, per object type,
 *  that type's top `dfArcCount` arcs by raw occurrence count, ranked independently per log and
 *  unioned. Mutually exclusive — only one is active at a time, toggled for direct comparison
 *  rather than combined. */
export type DfFilterMode = "Ratio" | "Count";

export const MAX_INITIAL_DF_ARCS = 25;

/** Feature flag: after the normal 25-arc-cap seed search below, keep growing the per-group N
 *  until every activity that has an incoming DF edge somewhere in the full edge set retains at
 *  least one incoming edge in the selection. Doesn't guarantee full graph connectivity (a node's
 *  outgoing edges, or edges deep in an otherwise-sparse neighborhood, aren't covered) — just
 *  removes the worst case, an activity with zero visible arcs (e.g. propel itself has no such
 *  guarantee and can produce this). Off switch here in case this grows the default view too
 *  aggressively on some datasets. */
const SEED_UNTIL_EVERY_NODE_HAS_INPUT = true;

export interface ProjectionFilters {
  /** Minimum |Cliff's delta| for a significant E2E relation to be shown in the overlay. */
  minEffectSize: number;
  dfFilterMode: DfFilterMode;
  minFanoutRatio: number;
  /** Per-object-type top-N for `Count` mode. */
  dfArcCount: number;
}

export interface ProjectionOptions {
  /** One shared start/end pair instead of one pair per object type. */
  singleTerminal: boolean;
}

export type Coverage = { shown: number; total: number };

export interface Deviation {
  significant: true;
  pValue: number;
  effectSize: number;
}

export type ProjectedNode =
  | {
      kind: "activity";
      id: string;
      activity: string;
      /** Max across object types (see `projectProcessModel`). */
      count: number;
      deviatingObjectTypes: { objectType: string; pValue: number }[];
      e2eSignificant: boolean;
    }
  | {
      kind: "terminal";
      id: string;
      terminal: "start" | "end";
      /** null for the shared pair under `singleTerminal`. */
      objectType: string | null;
    };

export interface ProjectedArc {
  id: string;
  /** `terminal`: start/end arc; `df`: directly-follows backbone arc; `overlay`: significant E2E
   *  relation with no matching backbone arc. */
  kind: "terminal" | "df" | "overlay";
  from: string;
  to: string;
  /** Mediating object type(s); the first one determines the arc's color. */
  objectTypes: string[];
  /** Present on `df` arcs only. */
  countLog1?: number;
  countLog2?: number;
  /** Set on `overlay` arcs, and on `df` arcs that a significant E2E relation highlights in place. */
  deviation?: Deviation;
}

export interface ProjectedModel {
  nodes: ProjectedNode[];
  arcs: ProjectedArc[];
  overlayCoverage: Coverage;
  dfCoverage: Coverage;
  maxGroupSize: number;
}

/** Per object type (`qualifier[0]`), that type's edge indices ranked by log 1 and by log 2 count.
 *  Deterministic tiebreak (matches propel's own `y.count - x.count || x.key.localeCompare(y.key)`):
 *  without it, ties at the cutoff resolve via Rust `HashMap`'s randomized iteration order, which
 *  isn't even stable across repeated loads of the same log. Map iteration order is first-seen
 *  order of each object type in `edges`. */
function rankPerGroup(
  edges: DfgEdgeSkeleton[],
): Map<string, { byLog1: number[]; byLog2: number[] }> {
  const groups = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const type = e.qualifier[0];
    const list = groups.get(type);
    if (list) list.push(i);
    else groups.set(type, [i]);
  });

  const arcKey = (i: number) => `${edges[i].from}->${edges[i].to}`;
  const ranked = new Map<string, { byLog1: number[]; byLog2: number[] }>();
  for (const [type, indices] of groups) {
    ranked.set(type, {
      byLog1: [...indices].sort(
        (a, b) =>
          edges[b].countLog1 - edges[a].countLog1 ||
          arcKey(a).localeCompare(arcKey(b)),
      ),
      byLog2: [...indices].sort(
        (a, b) =>
          edges[b].countLog2 - edges[a].countLog2 ||
          arcKey(a).localeCompare(arcKey(b)),
      ),
    });
  }
  return ranked;
}

/** Auto-seeds `dfArcCount` similarly to propel's own per-group top-N filter (its `useDfgPanel`
 *  `unionAt`/seed search in `DfgGraph.tsx`): search for the largest per-group N whose *union*
 *  across all object types stays within `MAX_INITIAL_DF_ARCS`, so the initial view stays readable
 *  regardless of how many object types are present. Adapted for two logs: propel ranks a single
 *  log per group, so its union has a closed-form size (groups partition the edge set); here each
 *  group is ranked independently per log and then unioned, so the two logs' top-N sets can
 *  overlap in ways that formula doesn't account for — so this recomputes the real selection at
 *  each N instead of a formula. Union size only grows with N, so the search can stop at the first
 *  N that exceeds the cap. */
export function computeDfArcCountSeed(edges: DfgEdgeSkeleton[]): number {
  if (edges.length === 0) return 1;

  const ranked = rankPerGroup(edges);
  let maxGroupSize = 1;
  for (const { byLog1 } of ranked.values())
    maxGroupSize = Math.max(maxGroupSize, byLog1.length);

  const unionSizeAt = (n: number): number => {
    const keep = new Set<number>();
    for (const { byLog1, byLog2 } of ranked.values()) {
      for (const i of byLog1.slice(0, n)) keep.add(i);
      for (const i of byLog2.slice(0, n)) keep.add(i);
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
  // in `projectProcessModel`, so it correctly isn't required to have one here.
  const targetsNeedingCoverage = new Set(edges.map((e) => e.to));
  const coveredAt = (n: number): boolean => {
    const covered = new Set<string>();
    for (const { byLog1, byLog2 } of ranked.values()) {
      for (const i of byLog1.slice(0, n)) covered.add(edges[i].to);
      for (const i of byLog2.slice(0, n)) covered.add(edges[i].to);
    }
    for (const t of targetsNeedingCoverage) if (!covered.has(t)) return false;
    return true;
  };
  while (seed < maxGroupSize && !coveredAt(seed)) seed++;
  return seed;
}

/** `from`'s total outgoing count for `qualifier`, per log — the denominator of that edge's
 *  fan-out ratio (`countLogN / total`). Always exactly the sum of `countLogN` across every edge
 *  sharing this `(from, qualifier)` — see `DfgEdgeSkeleton`'s doc comment for why the backend
 *  doesn't send this directly. Callers should memoize this separately from anything that also
 *  depends on the filter threshold — it only depends on the DFG, so recomputing it on every
 *  threshold change would be wasted work. */
export function computeFanoutTotals(
  edges: DfgEdgeSkeleton[],
): Map<string, [number, number]> {
  const totals = new Map<string, [number, number]>();
  for (const e of edges) {
    const key = `${e.from}::${e.qualifier.join(",")}`;
    const entry = totals.get(key) ?? [0, 0];
    entry[0] += e.countLog1;
    entry[1] += e.countLog2;
    totals.set(key, entry);
  }
  return totals;
}

export const EMPTY_PROJECTED_MODEL: ProjectedModel = {
  nodes: [],
  arcs: [],
  overlayCoverage: { shown: 0, total: 0 },
  dfCoverage: { shown: 0, total: 0 },
  maxGroupSize: 1,
};

export function projectProcessModel(
  data: ProcessModelData | null,
  filters: ProjectionFilters,
  fanoutTotals: Map<string, [number, number]>,
  options: ProjectionOptions,
): ProjectedModel {
  if (!data) return EMPTY_PROJECTED_MODEL;
  const { minEffectSize, dfFilterMode, minFanoutRatio, dfArcCount } = filters;
  const { singleTerminal } = options;
  // Aliased (not destructured as bare `dfg`) to avoid colliding with this function's several
  // `for (const dfg of ...)` loop variables below, each of which is one object type's DfgSkeleton
  // entry from `pmDfg.objectTypeToDfg` — a different, smaller thing than the whole DFG.
  const { dfg: pmDfg, comparison, drilldowns, e2eDrilldowns } = data;

  // An activity's occurrence count differs per object type (each object-type DFG only "sees" the
  // events touching objects of that type); take the max as a representative size, not the sum
  // (summing would multiply-count events that relate to several object types).
  const activityCounts = new Map<string, number>();
  for (const dfg of Object.values(pmDfg.objectTypeToDfg)) {
    for (const [activity, count] of Object.entries(dfg.activities)) {
      activityCounts.set(
        activity,
        Math.max(activityCounts.get(activity) ?? 0, count),
      );
    }
  }

  const e2eSignificant = new Set<string>();
  for (const result of Object.values(comparison.results)) {
    if (result.mode === "E2E" && result.isSignificant) {
      e2eSignificant.add(result.groupKey);
    }
  }

  const nodes: ProjectedNode[] = [];
  for (const [activity, count] of activityCounts) {
    nodes.push({
      kind: "activity",
      id: activity,
      activity,
      count,
      deviatingObjectTypes: (drilldowns[activity] ?? []).map((d) => ({
        objectType: d.objectType,
        pValue: d.pValue,
      })),
      e2eSignificant: e2eSignificant.has(activity),
    });
  }

  const arcs: ProjectedArc[] = [];

  // Terminal (start/end) nodes are one pair per object type by default (reserved as future O2O
  // anchor points, per the original design; not affected by combining directly-follows arcs
  // below); or one shared pair total under `singleTerminal`.
  if (singleTerminal) {
    const anyTerminals = Object.values(pmDfg.objectTypeToDfg).some(
      (dfg) => dfg.startActivities.length > 0 || dfg.endActivities.length > 0,
    );
    if (anyTerminals) {
      nodes.push({ kind: "terminal", id: DFG_START_ID, terminal: "start", objectType: null });
      nodes.push({ kind: "terminal", id: DFG_END_ID, terminal: "end", objectType: null });
    }
  }

  for (const [objectType, dfg] of Object.entries(pmDfg.objectTypeToDfg)) {
    const startId = singleTerminal
      ? DFG_START_ID
      : `${DFG_START_ID}::${objectType}`;
    const endId = singleTerminal ? DFG_END_ID : `${DFG_END_ID}::${objectType}`;
    const hasTerminals =
      dfg.startActivities.length > 0 || dfg.endActivities.length > 0;

    if (!singleTerminal && hasTerminals) {
      nodes.push({ kind: "terminal", id: startId, terminal: "start", objectType });
      nodes.push({ kind: "terminal", id: endId, terminal: "end", objectType });
    }

    for (const act of dfg.startActivities) {
      arcs.push({
        id: `dfg::${objectType}::START->${act}`,
        kind: "terminal",
        from: startId,
        to: act,
        objectTypes: [objectType],
      });
    }
    for (const act of dfg.endActivities) {
      arcs.push({
        id: `dfg::${objectType}::${act}->END`,
        kind: "terminal",
        from: act,
        to: endId,
        objectTypes: [objectType],
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
  // propel's own per-group top-N filter. Indexed by (from, to, mediating object type) so the
  // significant overlay below can find and highlight an existing arc instead of stacking a
  // duplicate on top of it.
  let keepByCount: Set<number> | null = null;
  let maxGroupSize = 1;
  if (dfFilterMode === "Count") {
    const keep = new Set<number>();
    for (const { byLog1, byLog2 } of rankPerGroup(pmDfg.arcs).values()) {
      maxGroupSize = Math.max(maxGroupSize, byLog1.length);
      for (const i of byLog1.slice(0, dfArcCount)) keep.add(i);
      for (const i of byLog2.slice(0, dfArcCount)) keep.add(i);
    }
    keepByCount = keep;
  }

  const dfBackboneByPairAndType = new Map<string, ProjectedArc>();
  let dfShown = 0;
  for (let i = 0; i < pmDfg.arcs.length; i++) {
    const { from, to, qualifier, countLog1, countLog2 } = pmDfg.arcs[i];
    let keep: boolean;
    if (dfFilterMode === "Ratio") {
      const [fanoutLog1, fanoutLog2] = fanoutTotals.get(
        `${from}::${qualifier.join(",")}`,
      ) ?? [0, 0];
      keep =
        (fanoutLog1 > 0 ? countLog1 / fanoutLog1 : 0) >= minFanoutRatio ||
        (fanoutLog2 > 0 ? countLog2 / fanoutLog2 : 0) >= minFanoutRatio;
    } else {
      keep = keepByCount!.has(i);
    }
    if (!keep) continue;
    dfShown++;

    const arc: ProjectedArc = {
      id: `dfg::${from}->${to}::${qualifier.join(", ")}`,
      kind: "df",
      from,
      to,
      objectTypes: qualifier,
      countLog1,
      countLog2,
    };
    arcs.push(arc);
    for (const t of qualifier) {
      dfBackboneByPairAndType.set(`${from}->${to}::${t}`, arc);
    }
  }
  const dfCoverage: Coverage = { shown: dfShown, total: pmDfg.arcs.length };

  // Significant overlay: one arc per significant relationship of `followsMode` (eventually- or
  // directly-follows, whichever the data was fetched with). Any directly-follows pair is by
  // definition also an eventually-follows pair, so a significant relation whose (from, to) is
  // already mediated by a DF backbone arc for (one of) the same object type(s) doesn't get a
  // second arc drawn on top — instead the existing backbone arc is marked with the deviation in
  // place. Only relations with no matching backbone arc (genuinely eventual, non-adjacent steps)
  // get their own new arc. Statistical significance alone is sensitive to sample size, not
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
      // co-occurring types.
      const types = r.qualifier.split(", ");
      const deviation: Deviation = {
        significant: true,
        pValue: r.pValue,
        effectSize: r.effectSize,
      };

      const matchedBackboneArcs = types
        .map((t) =>
          dfBackboneByPairAndType.get(`${from}->${r.objectType}::${t}`),
        )
        .filter((a): a is ProjectedArc => a !== undefined);

      if (matchedBackboneArcs.length > 0) {
        for (const arc of matchedBackboneArcs) arc.deviation = deviation;
        continue;
      }

      arcs.push({
        id: `e2e-overlay::${from}->${r.objectType}::${r.qualifier}`,
        kind: "overlay",
        from,
        to: r.objectType,
        objectTypes: types,
        deviation,
      });
    }
  }

  return {
    nodes,
    arcs,
    overlayCoverage: { shown: overlayShown, total: overlayTotal },
    dfCoverage,
    maxGroupSize,
  };
}
