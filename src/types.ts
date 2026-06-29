export type RelationMode = "E2O" | "O2O" | "O2E" | "E2E";
export type DistanceMode = "Euclidean" | "BrayCurtis";

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

/** PERMANOVA result for one event type present in both logs and selected for testing. */
export interface EventTypeResult {
  pValue: number;
  isSignificant: boolean;
  pseudoF: number;
  n1: number;
  n2: number;
  objectTypeRelations: ObjectTypeRelation[];
}

/** Complete output of comparing two OCEL logs. */
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
  eventType: string;
  presence: EventTypePresence;
  /** null if not selected for testing, or if presence !== "both" */
  result: EventTypeResult | null;
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
