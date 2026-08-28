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
  [eventType: string]: { objectType: string; pValue: number; effectSize: number }[];
}

/** Per-source-activity list of the specific (qualifier, target activity) E2E relationships found
 *  significant — rendered as their own dashed arcs, separate from the DF backbone. */
export interface E2EDrilldownByEventType {
  [eventType: string]: DrilldownRelationResult[];
}

/** One target (object type for O2O, event type for O2E) whose relationship-count distribution
 *  was found to differ significantly, carrying the stats behind that finding for a hover tooltip. */
export interface TargetDeviation {
  target: string;
  pValue: number;
  effectSize: number;
}

/** Per-object-type list of the specific targets (object types for O2O, event types for O2E)
 *  whose relationship-count distribution was found to differ significantly — surfaced as a small
 *  count badge in the Legend, not drawn on canvas (see ProcessModelView.tsx's Legend usage). */
export interface DeviationsByObjectType {
  [objectType: string]: TargetDeviation[];
}

export interface ProcessModelData {
  skeleton: ProcessModelSkeleton;
  comparison: ComparisonOutput;
  drilldowns: DrilldownByEventType;
  e2eDrilldowns: E2EDrilldownByEventType;
  o2oDrilldowns: DeviationsByObjectType;
  o2eDrilldowns: DeviationsByObjectType;
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
 *  multi-object-type arc can only be colored by one of its constituent types). `objectTypes`
 *  (shared between both logs, same convention as `eventTypes`) drives O2O/O2E blocks — these are
 *  never drawn on canvas, only surfaced as count badges in the Legend, since they describe object
 *  structure rather than anything with a natural position in the process flow. */
export async function fetchProcessModel(
  eventTypes: string[],
  objectTypes: string[],
  allowedObjectTypes: string[] | null,
  followsMode: FollowsMode = "EventuallyFollows",
  qualifierMode: E2EQualifierMode = "Grouped",
  params: StatParams = DEFAULT_PROCESS_MODEL_STAT_PARAMS,
): Promise<ProcessModelData> {
  params = { ...params, followsMode, qualifierMode };
  const blockObjectTypes = allowedObjectTypes
    ? objectTypes.filter((t) => allowedObjectTypes.includes(t))
    : objectTypes;
  const [skeleton, comparison] = await Promise.all([
    discoverProcessModel(allowedObjectTypes),
    runComparison({
      ...params,
      blocks: [
        ...eventTypes.flatMap((et) => [
          { id: `pm-e2o-${et}`, mode: "E2O" as const, groupKey: et, targetTypes: null },
          { id: `pm-e2e-${et}`, mode: "E2E" as const, groupKey: et, targetTypes: null },
        ]),
        ...blockObjectTypes.flatMap((ot) => [
          { id: `pm-o2o-${ot}`, mode: "O2O" as const, groupKey: ot, targetTypes: null },
          { id: `pm-o2e-${ot}`, mode: "O2E" as const, groupKey: ot, targetTypes: null },
        ]),
      ],
      allowedObjectTypes,
    }),
  ]);

  const significantE2OTypes = eventTypes.filter(
    (et) => comparison.results[`pm-e2o-${et}`]?.isSignificant,
  );
  const significantE2ETypes = eventTypes.filter(
    (et) => comparison.results[`pm-e2e-${et}`]?.isSignificant,
  );
  const significantO2OTypes = blockObjectTypes.filter(
    (ot) => comparison.results[`pm-o2o-${ot}`]?.isSignificant,
  );
  const significantO2ETypes = blockObjectTypes.filter(
    (ot) => comparison.results[`pm-o2e-${ot}`]?.isSignificant,
  );

  // One extraction pass per mode (not one per event type): `runDrilldownBatch` re-extracts
  // relationship counts only once per log, shared across all requested group keys. E2E
  // extraction in particular walks every allowed object's full event trace pairing it with
  // every later shared-object event — repeating that per significant event type (as looping
  // `runDrilldown` calls would) is the dominant cost once high-fan-out object types are
  // included in the filter.
  const [e2oDrilldowns, e2eDrilldowns, o2oDrilldownResults, o2eDrilldownResults] =
    await Promise.all([
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
      significantO2OTypes.length > 0
        ? runDrilldownBatch(
            significantO2OTypes,
            "O2O",
            params.numPermutations,
            params.alpha,
            allowedObjectTypes,
            params.followsMode,
            params.qualifierMode,
          )
        : Promise.resolve({} as Record<string, DrilldownOutput>),
      significantO2ETypes.length > 0
        ? runDrilldownBatch(
            significantO2ETypes,
            "O2E",
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
    return [
      et,
      dedupeByTarget(d.results).map((t) => ({
        objectType: t.target,
        pValue: t.pValue,
        effectSize: t.effectSize,
      })),
    ] as const;
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

  // A target can appear under multiple qualifiers; keep the most significant (lowest p-value)
  // one per target for the badge tooltip, same target set as before's Set-based dedup.
  function dedupeByTarget(results: DrilldownRelationResult[]): TargetDeviation[] {
    const byTarget = new Map<string, DrilldownRelationResult>();
    for (const r of results.filter((r) => r.isSignificant)) {
      const existing = byTarget.get(r.objectType);
      if (!existing || r.pValue < existing.pValue) byTarget.set(r.objectType, r);
    }
    return [...byTarget.values()].map((r) => ({
      target: r.objectType,
      pValue: r.pValue,
      effectSize: r.effectSize,
    }));
  }

  const o2oEntries = significantO2OTypes.map((ot) => {
    return [ot, dedupeByTarget(o2oDrilldownResults[ot].results)] as const;
  });

  const o2eEntries = significantO2ETypes.map((ot) => {
    return [ot, dedupeByTarget(o2eDrilldownResults[ot].results)] as const;
  });

  return {
    skeleton,
    comparison,
    drilldowns: Object.fromEntries(drilldownEntries) as DrilldownByEventType,
    e2eDrilldowns: Object.fromEntries(e2eDrilldownEntries) as E2EDrilldownByEventType,
    o2oDrilldowns: Object.fromEntries(o2oEntries) as DeviationsByObjectType,
    o2eDrilldowns: Object.fromEntries(o2eEntries) as DeviationsByObjectType,
    followsMode,
  };
}
