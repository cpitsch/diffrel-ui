export type RelationMode = "E2O" | "O2O" | "O2E" | "E2E";
export type DistanceMode = "Euclidean" | "BrayCurtis";
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

/** One object type's directly-follows graph, discovered from a single log. */
export interface DfgSkeleton {
  activities: Record<string, number>;
  /** [fromActivity, toActivity, count] triples. */
  directlyFollowsRelations: [string, string, number][];
  startActivities: string[];
  endActivities: string[];
}

/** Object-centric directly-follows graph skeleton for one log, keyed by object type. */
export interface ProcessModelSkeleton {
  objectTypeToDfg: Record<string, DfgSkeleton>;
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
