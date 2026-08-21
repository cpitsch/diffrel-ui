import { discoverProcessModel, runComparison, runDrilldownBatch } from "./tauriCommands";
import type {
  ComparisonOutput,
  DrilldownOutput,
  DrilldownRelationResult,
  E2EQualifierMode,
  FollowsMode,
  ProcessModelSkeleton,
} from "./types";
import type { StatParams } from "./components/ComparisonSettings";

export interface DrilldownByEventType {
  [eventType: string]: { objectType: string }[];
}

/** Per-source-activity list of the specific (qualifier, target activity) E2E relationships found
 *  significant — rendered as their own dashed arcs, separate from the DF backbone. */
export interface E2EDrilldownByEventType {
  [eventType: string]: DrilldownRelationResult[];
}

export interface ProcessModelData {
  skeleton: ProcessModelSkeleton;
  comparison: ComparisonOutput;
  drilldowns: DrilldownByEventType;
  e2eDrilldowns: E2EDrilldownByEventType;
  /** The follows mode this data was actually fetched with — lets the view label the overlay
   *  correctly even if the sidebar's selector has since moved on to a different value. */
  followsMode: FollowsMode;
}

/** Process model comparisons always run with these fixed statistical defaults (E2O + E2E, all
 *  shared event types) — only the object-type restriction is user-configurable via
 *  `allowedObjectTypes`; the rest isn't a user-tunable research query like the Relations view,
 *  so there's no settings UI for it yet; this can grow one later. */
export const DEFAULT_PROCESS_MODEL_STAT_PARAMS: StatParams = {
  numPermutations: 1000,
  alpha: 0.05,
  seed: null,
  distanceMode: "BrayCurtis",
  // Overridden per-call by fetchProcessModel's own `followsMode`/`qualifierMode` arguments below
  // — these defaults only matter if fetchProcessModel is ever called without them.
  followsMode: "EventuallyFollows",
  qualifierMode: "Grouped",
};

/** Discovers the joint OC-DFG skeleton (both logs) and computes the E2O/E2E deviation overlays
 *  for every event type present in both logs, drilling down into significant results to find
 *  which specific relationships drive the difference. `allowedObjectTypes` restricts both the
 *  discovered DFG edges and the comparison/drilldown to those object types (null = all).
 *  `followsMode` controls whether the E2E overlay highlights significant eventually-follows or
 *  directly-follows deviations — independent of the Relations view's own followsMode control.
 *  `qualifierMode` controls whether an E2E relation mediated by several object types is one
 *  relation per object type ("Single") or one combined relation ("Grouped", fewer arcs but a
 *  multi-object-type arc can only be colored by one of its constituent types). */
export async function fetchProcessModel(
  eventTypes: string[],
  allowedObjectTypes: string[] | null,
  followsMode: FollowsMode = "EventuallyFollows",
  qualifierMode: E2EQualifierMode = "Grouped",
  params: StatParams = DEFAULT_PROCESS_MODEL_STAT_PARAMS,
): Promise<ProcessModelData> {
  params = { ...params, followsMode, qualifierMode };
  const [skeleton, comparison] = await Promise.all([
    discoverProcessModel(allowedObjectTypes),
    runComparison({
      ...params,
      blocks: eventTypes.flatMap((et) => [
        { id: `pm-e2o-${et}`, mode: "E2O", groupKey: et, targetTypes: null },
        { id: `pm-e2e-${et}`, mode: "E2E", groupKey: et, targetTypes: null },
      ]),
      allowedObjectTypes,
    }),
  ]);

  const significantE2OTypes = eventTypes.filter(
    (et) => comparison.results[`pm-e2o-${et}`]?.isSignificant,
  );
  const significantE2ETypes = eventTypes.filter(
    (et) => comparison.results[`pm-e2e-${et}`]?.isSignificant,
  );

  // One extraction pass per mode (not one per event type): `runDrilldownBatch` re-extracts
  // relationship counts only once per log, shared across all requested group keys. E2E
  // extraction in particular walks every allowed object's full event trace pairing it with
  // every later shared-object event — repeating that per significant event type (as looping
  // `runDrilldown` calls would) is the dominant cost once high-fan-out object types are
  // included in the filter.
  const [e2oDrilldowns, e2eDrilldowns] = await Promise.all([
    significantE2OTypes.length > 0
      ? runDrilldownBatch(
          significantE2OTypes,
          "E2O",
          params.numPermutations,
          params.alpha,
          allowedObjectTypes,
          params.followsMode,
          params.qualifierMode,
        )
      : Promise.resolve({} as Record<string, DrilldownOutput>),
    significantE2ETypes.length > 0
      ? runDrilldownBatch(
          significantE2ETypes,
          "E2E",
          params.numPermutations,
          params.alpha,
          allowedObjectTypes,
          params.followsMode,
          params.qualifierMode,
        )
      : Promise.resolve({} as Record<string, DrilldownOutput>),
  ]);

  const drilldownEntries = significantE2OTypes.map((et) => {
    const d = e2oDrilldowns[et];
    const objectTypes = [
      ...new Set(d.results.filter((r) => r.isSignificant).map((r) => r.objectType)),
    ];
    return [et, objectTypes.map((objectType) => ({ objectType }))] as const;
  });

  const e2eDrilldownEntries = significantE2ETypes.map((et) => {
    const d = e2eDrilldowns[et];
    const multiType = d.results.filter((r) => r.qualifier.includes(", "));
    if (multiType.length > 0) {
      console.log(
        `[ProcessModel] ${et}: ${multiType.length}/${d.results.length} E2E relations have a multi-object-type qualifier (${multiType.filter((r) => r.isSignificant).length} significant)`,
        multiType,
      );
    }
    return [et, d.results.filter((r) => r.isSignificant)] as const;
  });

  return {
    skeleton,
    comparison,
    drilldowns: Object.fromEntries(drilldownEntries) as DrilldownByEventType,
    e2eDrilldowns: Object.fromEntries(e2eDrilldownEntries) as E2EDrilldownByEventType,
    followsMode,
  };
}
