import type { ProcessModelLayout } from "./processModelExport";

export type RelationMode = "E2O" | "O2O" | "O2E" | "E2E";
export type DistanceMode = "Euclidean" | "BrayCurtis";
/** Only meaningful for E2E: pair an event with every later shared-object event
 *  (eventually-follows, the long-standing default) or only the immediately next one
 *  (directly-follows). Ignored by other modes. */
export type FollowsMode = "DirectlyFollows" | "EventuallyFollows";
/** Only meaningful for E2E: whether a shared event pair mediated by several object types
 *  produces one relation per object type ("Single") or one combined relation per event pair
 *  ("Grouped", the long-standing default — fewer arcs, at the cost of a multi-object-type arc
 *  only being representable by one color). Ignored by other modes. */
export type E2EQualifierMode = "Single" | "Grouped";
export type AppMode = RelationMode | "Mixed";

/** A single comparison block in Mixed mode. */
export interface MixedBlock {
  id: string;
  mode: RelationMode;
  groupKey: string;
  /** null = include all target types as feature dimensions */
  targetTypes: string[] | null;
  /** Pre-fetched (qualifier, targetType) pairs for rendering pre-run child nodes. */
  dimensions: [string, string][];
}

/** Summary returned after loading an OCEL file. */
export interface LogSummary {
  /** The number of events in this log. */
  eventCount: number;
  /** The number of distinct event types in this log. */
  eventTypeCount: number;
  /** All event type names present in this log. */
  eventTypes: string[];
  /** Number of distinct object types in this log */
  objectTypeCount: number;
  /** All object type names present in this log. */
  objectTypes: string[];
}

/** Median count of a specific (qualifier, object_type) relationship per log. */
export interface ObjectTypeRelation {
  qualifier: string;
  objectType: string;
  medianLog1: number;
  medianLog2: number;
  meanLog1: number;
  meanLog2: number;
  stdLog1: number;
  stdLog2: number;
}

/** PERMANOVA result for one block, keyed by block ID in ComparisonOutput.results. */
export interface EventTypeResult {
  pValue: number;
  isSignificant: boolean;
  pseudoF: number;
  n1: number;
  n2: number;
  objectTypeRelations: ObjectTypeRelation[];
  /** Relation mode for this block (e.g. "E2O"). */
  mode: RelationMode;
  /** Group key for this block (event type or object type name). */
  groupKey: string;
}

/** Complete output of comparing two OCEL logs. Keys are block IDs. */
export interface ComparisonOutput {
  results: Record<string, EventTypeResult>;
  onlyInLog1: string[];
  onlyInLog2: string[];
  /** The permutation seed actually used — the caller's seed if one was given, otherwise the
   *  value the backend generated in its place. Lets a "no seed" run still be reproduced later,
   *  and lets a triggered drilldown reuse the same seed as its comparison. */
  seedUsed: number;
}

/** Whether an event type is present in one or both logs. */
export type EventTypePresence = "both" | "onlyInLog1" | "onlyInLog2";

/** Westfall-Young drilldown result for one (qualifier, object_type) relation. */
export interface DrilldownRelationResult {
  qualifier: string;
  objectType: string;
  pValue: number;
  isSignificant: boolean;
  pseudoF: number;
  /** Cliff's delta effect size (-1..1), independent of statistical significance. */
  effectSize: number;
}

/** Output of drilling down into a significant event type. */
export interface DrilldownOutput {
  results: DrilldownRelationResult[];
}

/** Data passed to an EventTypeNode in React Flow. */
export interface EventTypeNodeData extends Record<string, unknown> {
  /** The block ID (record key in ComparisonOutput.results). */
  eventType: string;
  /** Display label (group key name). Equals eventType for homogeneous modes. */
  groupKey: string;
  presence: EventTypePresence;
  /** null if not yet run (Mixed mode pending block). */
  result: EventTypeResult | null;
  /** When true, block exists but comparison hasn't been run yet. */
  isPending?: boolean;
  /** Relation mode badge shown in Mixed mode. */
  blockMode?: RelationMode;
}

/** One object type's activities and start/end terminals, discovered jointly from both logs
 *  (merged: activity counts take the max across logs, start/end sets are unioned). Mirrors
 *  `diffrel::joint_ocdfg::ObjectTypeNodes`. Directly-follows arcs don't live here — see
 *  `ProcessModelDfg.arcs`. */
export interface DfgSkeleton {
  activities: Record<string, number>;
  startActivities: string[];
  endActivities: string[];
}

/** One directly-follows arc of one object type, discovered jointly from both logs. Mirrors
 *  `diffrel::joint_ocdfg::JointDfArc`. `qualifier` is the arc's object type as a one-element
 *  list (a list only for backwards compatibility of the file format). Unfiltered — every arc
 *  found in either log is included, with 0 for a log it doesn't occur in. Counts are kept
 *  separate per log rather than summed/averaged, so the arc's label can show the comparison
 *  directly.
 *
 *  No `fanoutLog1`/`fanoutLog2` here (a from-activity's total outgoing count for this qualifier,
 *  used as a fan-out ratio's denominator) — the backend used to send it, but it was always
 *  exactly the sum of `countLog1`/`countLog2` across every edge sharing this `(from, qualifier)`,
 *  so identical values were duplicated across every edge from the same source. Compute it here
 *  instead — see `useFanoutTotals` in `ProcessModelView.tsx`, memoized separately from the
 *  filter-threshold-dependent render so it's still only computed once per DFG. */
export interface DfgEdgeSkeleton {
  from: string;
  to: string;
  qualifier: string[];
  countLog1: number;
  countLog2: number;
}

/** The joint OC-DFG of both logs (`diffrel::joint_ocdfg::JointOcdfg`): activities/terminals
 *  keyed by object type, plus one flat arc list sorted by (qualifier, from, to). Files written
 *  before the rename call `arcs` `edges`; both importers map that (Rust: serde alias, old format:
 *  `parseProcessModelExport`). */
export interface ProcessModelDfg {
  objectTypeToDfg: Record<string, DfgSkeleton>;
  arcs: DfgEdgeSkeleton[];
}

/** diffrel's own export document (`diffrel::execution::export::ComparisonResultExport`, see
 *  `schema/orchestration-result.schema.json`), the same type `diffrel-cli` writes. Top-level
 *  field names are snake_case (unlike everything else in this file), except `processModel`.
 *  Deliberately left untyped field-by-field: there's one source of truth for the shape (Rust),
 *  and the frontend only needs to pass this through, not interpret its internals.
 *
 *  `processModel` holds the joint OC-DFG (`dfg`) and the app's canvas `layout`, which diffrel
 *  treats as opaque. It's absent from documents written before diffrel embedded the graph (e.g.
 *  older CLI output). `layout` is absent from a freshly-built export (`export_comparison_result`
 *  has no way to know the live canvas state — the frontend merges it in itself just before writing
 *  the file, see `saveComparisonResultExport`), but present when this same type comes back from
 *  `import_comparison_result` reading an already-written file, which genuinely has it. */
export interface ExportedComparisonResult {
  [key: string]: unknown;
  processModel?: {
    dfg: ProcessModelDfg;
    layout?: ProcessModelLayout;
  };
}

/** Data passed to an ObjectTypeNode in React Flow. */
export interface ObjectTypeNodeData extends Record<string, unknown> {
  objectType: string;
  qualifier: string;
  medianLog1: number;
  medianLog2: number;
  meanLog1: number;
  meanLog2: number;
  stdLog1: number;
  stdLog2: number;
  color: string;
  drilldownPValue?: number;
  drilldownIsSignificant?: boolean;
  isDrilldownPending?: boolean;
}
