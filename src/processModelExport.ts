import { saveBlob } from "./components/GraphView";
import type { EdgeRouting } from "./components/ocdfg/vendor/dfg/DfgEdge";
import type { DistanceMode, E2EQualifierMode, FollowsMode, LogSummary } from "./types";
import type { ProcessModelData } from "./processModel";

/** Exact on-screen canvas state at export time: every node's top-left position, and every
 *  non-self-loop edge's routing (self-loops are computed live from node position + parallel
 *  index, not stored). Both are keyed by react-flow id — deterministic from the data
 *  (`buildProcessModelGraph` names nodes/edges from qualifiers/activities, not randomly), so they
 *  still match up after a fresh import. Restoring both directly (see ProcessModelView.tsx) is a
 *  WYSIWYG replay: no layout engine call on import, so no risk of an engine-specific coordinate
 *  or pinning-semantics mismatch scrambling the result. */
export interface ProcessModelLayout {
  nodePositions: Record<string, { x: number; y: number }>;
  edgeRouting: Record<string, EdgeRouting>;
}

/** Static-replay export of a Process model (OCDFG) comparison: the fully computed result plus
 *  every parameter needed to describe how it was produced. Import re-renders this data as-is —
 *  it does not re-run the comparison, so the original OCEL files aren't needed to view it.
 *  The actually-used permutation seed isn't duplicated here — even a "no seed requested" run
 *  (`statParams.seed === null`) always has a resolved one at `result.comparison.seedUsed`. */
export interface ProcessModelExportV1 {
  schemaVersion: 1;
  exportedAt: string;
  log1: { path: string; summary: LogSummary };
  log2: { path: string; summary: LogSummary };
  query: {
    eventTypes: string[];
    objectTypes: string[];
    allowedObjectTypes: string[] | null;
    followsMode: FollowsMode;
    qualifierMode: E2EQualifierMode;
  };
  statParams: {
    numPermutations: number;
    alpha: number;
    seed: number | null;
    distanceMode: DistanceMode;
  };
  /** Optional so files exported before this field existed still import (falls back to a fresh
   *  auto-layout). */
  layout?: ProcessModelLayout;
  result: ProcessModelData;
}

export function exportProcessModel(bundle: ProcessModelExportV1): Promise<void> {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  return saveBlob(blob, "process-model-result.json", "JSON Result", "application/json", "json");
}

/** Parses and minimally shape-checks an imported export file — just enough to fail with a
 *  descriptive error rather than rendering with `undefined` holes on a mismatched/corrupt file. */
export function parseProcessModelExport(text: string): ProcessModelExportV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Not a valid process model export: expected a JSON object.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new Error(
      `Unsupported export schema version: ${JSON.stringify(obj.schemaVersion)} (expected 1).`,
    );
  }
  for (const key of ["log1", "log2", "query", "statParams", "result"]) {
    if (!(key in obj)) {
      throw new Error(`Not a valid process model export: missing "${key}".`);
    }
  }
  return obj as unknown as ProcessModelExportV1;
}
