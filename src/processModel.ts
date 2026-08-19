import { discoverProcessModel, runComparison, runDrilldown } from "./tauriCommands";
import type { ComparisonOutput, ProcessModelSkeleton } from "./types";
import type { StatParams } from "./components/ComparisonSettings";

export interface DrilldownByEventType {
  [eventType: string]: { objectType: string }[];
}

export interface ProcessModelData {
  skeleton: ProcessModelSkeleton;
  comparison: ComparisonOutput;
  drilldowns: DrilldownByEventType;
}

/** Process model comparisons always run with these fixed defaults (E2O + E2E, all shared
 *  event types) — it's not a user-tunable research query like the Relations view, so there's
 *  no settings UI for it yet; this can grow one later. */
export const DEFAULT_PROCESS_MODEL_STAT_PARAMS: StatParams = {
  numPermutations: 1000,
  alpha: 0.05,
  seed: null,
  distanceMode: "BrayCurtis",
};

/** Discovers the OC-DFG skeleton from log 1 and computes the E2O/E2E deviation overlays for
 *  every event type present in both logs, drilling down into significant E2O results to find
 *  which specific object types drive the difference. */
export async function fetchProcessModel(
  eventTypes: string[],
  params: StatParams = DEFAULT_PROCESS_MODEL_STAT_PARAMS,
): Promise<ProcessModelData> {
  const [skeleton, comparison] = await Promise.all([
    discoverProcessModel(0),
    runComparison({
      ...params,
      blocks: eventTypes.flatMap((et) => [
        { id: `pm-e2o-${et}`, mode: "E2O", groupKey: et, targetTypes: null },
        { id: `pm-e2e-${et}`, mode: "E2E", groupKey: et, targetTypes: null },
      ]),
    }),
  ]);

  const significantE2OTypes = eventTypes.filter(
    (et) => comparison.results[`pm-e2o-${et}`]?.isSignificant,
  );
  const drilldownEntries = await Promise.all(
    significantE2OTypes.map(async (et) => {
      const d = await runDrilldown(et, "E2O", params.numPermutations, params.alpha);
      const objectTypes = [
        ...new Set(d.results.filter((r) => r.isSignificant).map((r) => r.objectType)),
      ];
      return [et, objectTypes.map((objectType) => ({ objectType }))] as const;
    }),
  );

  return {
    skeleton,
    comparison,
    drilldowns: Object.fromEntries(drilldownEntries) as DrilldownByEventType,
  };
}
