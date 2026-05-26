import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ComparisonOutput,
  DrilldownOutput,
  LogSummary,
  RelationMode,
} from "./types";

export async function pickAndLoadLog(
  logIndex: 0 | 1,
): Promise<{ path: string; summary: LogSummary } | null> {
  const path = await open({
    multiple: false,
    filters: [{ name: "OCEL XML", extensions: ["xml"] }],
  });
  if (!path) return null;
  const summary = await invoke<LogSummary>("load_log", { path, logIndex });
  return { path, summary };
}

export interface RunComparisonParams {
  numPermutations: number;
  seed: number | null;
  alpha: number;
  mode: RelationMode;
  selectedTypes: string[] | null;
}

export async function runComparison(
  params: RunComparisonParams,
): Promise<ComparisonOutput> {
  return invoke<ComparisonOutput>("run_comparison", { ...params });
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
