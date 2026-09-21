import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ComparisonOutput,
  DistanceMode,
  DrilldownOutput,
  E2EQualifierMode,
  FollowsMode,
  LogSummary,
  ProcessModelSkeleton,
  RelationMode,
} from "./types";

export async function pickAndLoadLog(
  logIndex: 0 | 1,
): Promise<{ path: string; summary: LogSummary } | null> {
  const path = await open({
    multiple: false,
    filters: [
      {
        name: "OCEL",
        extensions: [
          "xml",
          "xml.gz",
          "json",
          "json.gz",
          "jsonocel",
          "jsonocel.gz",
          "sqlite",
          "db",
        ],
      },
    ],
  });
  if (!path) return null;
  const summary = await invoke<LogSummary>("load_log", { path, logIndex });
  return { path, summary };
}

export interface RunComparisonParams {
  blocks: Array<{
    id: string;
    mode: RelationMode;
    groupKey: string;
    targetTypes: string[] | null;
  }>;
  numPermutations: number;
  seed: number | null;
  alpha: number;
  distanceMode: DistanceMode;
  /** Object types allowed to mediate E2E pairing. null = no restriction (all allowed). */
  allowedObjectTypes: string[] | null;
  /** Only affects E2E blocks. */
  followsMode: FollowsMode;
  /** Only affects E2E blocks. */
  qualifierMode: E2EQualifierMode;
}

export async function runComparison(
  params: RunComparisonParams,
): Promise<ComparisonOutput> {
  return invoke<ComparisonOutput>("run_mixed_comparison", { ...params });
}

/** Returns all (qualifier, targetType) pairs observed across both logs for (mode, groupKey). */
export async function getDimensions(
  mode: RelationMode,
  groupKey: string,
  allowedObjectTypes: string[] | null,
  followsMode: FollowsMode,
  qualifierMode: E2EQualifierMode,
): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_dimensions", {
    mode,
    groupKey,
    allowedObjectTypes,
    followsMode,
    qualifierMode,
  });
}

/** Discovers a joint object-centric directly-follows graph skeleton from both logs. */
export async function discoverProcessModel(
  allowedObjectTypes: string[] | null,
): Promise<ProcessModelSkeleton> {
  return invoke<ProcessModelSkeleton>("discover_process_model", {
    allowedObjectTypes,
  });
}

export async function runDrilldown(
  groupKey: string,
  mode: RelationMode,
  numPermutations: number,
  seed: number,
  alpha: number,
  allowedObjectTypes: string[] | null,
  followsMode: FollowsMode,
  qualifierMode: E2EQualifierMode,
): Promise<DrilldownOutput> {
  return invoke<DrilldownOutput>("run_drilldown", {
    groupKey,
    mode,
    numPermutations,
    seed,
    alpha,
    allowedObjectTypes,
    followsMode,
    qualifierMode,
  });
}

/** Same as `runDrilldown`, but for many group keys at once, sharing a single relationship-count
 *  extraction pass per log instead of repeating it per key — extraction (not the permutation
 *  test) is the dominant cost for E2E once high-fan-out object types are included in the filter,
 *  since it's re-walked from scratch on every `runDrilldown` call. */
export async function runDrilldownBatch(
  groupKeys: string[],
  mode: RelationMode,
  numPermutations: number,
  seed: number,
  alpha: number,
  allowedObjectTypes: string[] | null,
  followsMode: FollowsMode,
  qualifierMode: E2EQualifierMode,
): Promise<Record<string, DrilldownOutput>> {
  return invoke<Record<string, DrilldownOutput>>("run_drilldown_batch", {
    groupKeys,
    mode,
    numPermutations,
    seed,
    alpha,
    allowedObjectTypes,
    followsMode,
    qualifierMode,
  });
}
