import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ComparisonOutput,
  DistanceMode,
  DrilldownOutput,
  LogSummary,
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
        extensions: ["xml", "xml.gz", "json", "json.gz", "jsonocel", "jsonocel.gz"],
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
): Promise<[string, string][]> {
  return invoke<[string, string][]>("get_dimensions", { mode, groupKey });
}

export async function runDrilldown(
  groupKey: string,
  mode: RelationMode,
  numPermutations: number,
  alpha: number,
): Promise<DrilldownOutput> {
  return invoke<DrilldownOutput>("run_drilldown", {
    groupKey,
    mode,
    numPermutations,
    alpha,
  });
}
