import { saveBlob } from "./components/GraphView";
import { importComparisonResult } from "./tauriCommands";
import type { EdgeRouting } from "./components/ocdfg/vendor/dfg/DfgEdge";
import type {
  ComparisonOutput,
  DistanceMode,
  DrilldownRelationResult,
  E2EQualifierMode,
  EventTypeResult,
  ExportedComparisonResult,
  FollowsMode,
  LogSummary,
  RelationMode,
} from "./types";
import type {
  DeviationsByObjectType,
  DrilldownByEventType,
  E2EDrilldownByEventType,
  ProcessModelData,
} from "./processModel";

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

/** Legacy path: re-exports an already-imported `ProcessModelExportV1` file (possibly with an
 *  updated `layout` if the user moved nodes since importing). Only used for that — a *live*
 *  comparison's result is exported via `saveComparisonResultExport` below instead, since a live
 *  comparison has real backend state (`AppState.last_result`) to build diffrel's own document
 *  shape from, which an imported file doesn't. */
export function exportProcessModel(
  bundle: ProcessModelExportV1,
): Promise<void> {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  return saveBlob(
    blob,
    "process-model-result.json",
    "JSON Result",
    "application/json",
    "json",
  );
}

/** Writes diffrel's own export document (see `tauriCommands.exportComparisonResult`) plus the
 *  current on-screen canvas layout to disk — the live-comparison counterpart to
 *  `exportProcessModel` above. `layout` is merged into `processModel` here, not inside the Rust
 *  command, since it's the one piece of this file the backend has no way to know. */
export function saveComparisonResultExport(
  exported: ExportedComparisonResult,
  layout: ProcessModelLayout,
): Promise<void> {
  const withLayout: ExportedComparisonResult = {
    ...exported,
    processModel: { ...exported.processModel, layout },
  };
  const blob = new Blob([JSON.stringify(withLayout, null, 2)], {
    type: "application/json",
  });
  return saveBlob(
    blob,
    "process-model-result.json",
    "JSON Result",
    "application/json",
    "json",
  );
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
    throw new Error(
      "Not a valid process model export: expected a JSON object.",
    );
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

// ── New-format (diffrel document) import ────────────────────────────────────────────────────
//
// A minimal, adapter-local view of diffrel's own document shape (see
// schema/orchestration-result.schema.json) — only the fields `adaptExportedComparisonResult`
// below actually reads. Deliberately not exported or reused elsewhere: see
// `ExportedComparisonResult`'s own doc comment in types.ts for why the document stays untyped
// field-by-field everywhere else. This is the one place that genuinely needs to interpret its
// internals, to reconstruct the older `ProcessModelExportV1` shape the rest of the app renders.

interface DiffrelInstance {
  mode: RelationMode;
  group_key: string;
}

interface DiffrelTestResult {
  pseudo_f: number | null;
  p_value: number;
  significant: boolean;
}

interface DiffrelDrilldownRelation {
  qualifier: string;
  target: string;
  test: DiffrelTestResult;
  effect_size: number;
}

interface DiffrelInstanceResult {
  instance: DiffrelInstance;
  n1: number;
  n2: number;
  test: DiffrelTestResult;
  drilldown: null | {
    relations: DiffrelDrilldownRelation[];
    error: unknown;
  };
}

interface DiffrelLogInfo {
  path: string | null;
  num_events: number;
  num_event_types: number;
  event_types: string[];
  num_object_types: number;
  object_types: string[];
}

interface DiffrelExportDocument {
  params: {
    permutations: number;
    alpha: number;
    seed: number | null;
    distance: "bray_curtis" | "euclidean";
    follows: "directly_follows" | "eventually_follows";
    e2e_object_types: string[] | null;
  };
  logs: { log_1: DiffrelLogInfo; log_2: DiffrelLogInfo };
  results: DiffrelInstanceResult[];
  skipped: { instance: DiffrelInstance; reason: unknown }[];
  seed_used: number;
}

function toLogSummary(info: DiffrelLogInfo): LogSummary {
  return {
    eventCount: info.num_events,
    eventTypeCount: info.num_event_types,
    eventTypes: info.event_types,
    objectTypeCount: info.num_object_types,
    objectTypes: info.object_types,
  };
}

/** A target can appear under multiple qualifiers (e.g. several E2E relations pointing at the
 *  same object type) — keep the most significant (lowest p-value) one per target. Mirrors
 *  `processModel.ts`'s own `dedupeByTarget`, applied here to the same kind of already-significant-
 *  filtered relation list, just sourced from the imported document instead of a live
 *  `runDrilldownBatch` call. */
function dedupeByTarget(
  relations: DiffrelDrilldownRelation[],
): { target: string; pValue: number; effectSize: number }[] {
  const byTarget = new Map<string, DiffrelDrilldownRelation>();
  for (const r of relations) {
    const existing = byTarget.get(r.target);
    if (!existing || r.test.p_value < existing.test.p_value)
      byTarget.set(r.target, r);
  }
  return [...byTarget.values()].map((r) => ({
    target: r.target,
    pValue: r.test.p_value,
    effectSize: r.effect_size,
  }));
}

/** Converts diffrel's own document shape (as returned by `tauriCommands.importComparisonResult`)
 *  into the `ProcessModelExportV1`-compatible value the existing import/render pipeline already
 *  expects, so `ProcessModelView` never has to know two different shapes exist. Real, lossy
 *  conversion in two places, both accepted trade-offs (see the design discussion this followed):
 *  - `objectTypeRelations` (per-relation median/mean/std) has no equivalent in the new document —
 *    it's a Tauri-only descriptive stat `diffrel` never computes — so it comes back empty for
 *    every entry. The DFG itself (activities/edges/significance coloring) is unaffected; only the
 *    O2O/O2E legend's mean/median/std tooltip detail is missing for an imported file.
 *  - A drilldown that failed (`DrilldownError`) has no analogous slot in the old per-mode maps
 *    (which are plain arrays of successful relation results), so it's silently dropped, same as
 *    "drilldown not attempted".
 *  `exportedAt` has no source in the new document at all (nothing stamps one on write) — left as
 *  `""`, which renders as "Exported Invalid Date" in the banner. Accepted as-is per the 2026-09-25
 *  decision not to add an export timestamp. */
function adaptExportedComparisonResult(
  exported: ExportedComparisonResult,
): ProcessModelExportV1 {
  const doc = exported as unknown as DiffrelExportDocument;

  const results: Record<string, EventTypeResult> = {};
  for (const r of doc.results) {
    const key = `pm-${r.instance.mode.toLowerCase()}-${r.instance.group_key}`;
    results[key] = {
      pValue: r.test.p_value,
      isSignificant: r.test.significant,
      // `pseudo_f` is `null` for the same reason it always has been on the live path too (NaN,
      // when every observation is identical) — EventTypeResult's own type has never accounted
      // for that nullability, so this matches existing (if slightly optimistic) typing.
      pseudoF: r.test.pseudo_f as number,
      n1: r.n1,
      n2: r.n2,
      objectTypeRelations: [],
      mode: r.instance.mode,
      groupKey: r.instance.group_key,
    };
  }

  const onlyInLog1: string[] = [];
  const onlyInLog2: string[] = [];
  for (const s of doc.skipped) {
    if (s.reason === "only_in_log_one") onlyInLog1.push(s.instance.group_key);
    else if (s.reason === "only_in_log_two")
      onlyInLog2.push(s.instance.group_key);
  }

  const comparison: ComparisonOutput = {
    results,
    onlyInLog1,
    onlyInLog2,
    seedUsed: doc.seed_used,
  };

  const drilldowns: DrilldownByEventType = {};
  const e2eDrilldowns: E2EDrilldownByEventType = {};
  const o2oDrilldowns: DeviationsByObjectType = {};
  const o2eDrilldowns: DeviationsByObjectType = {};

  for (const r of doc.results) {
    if (!r.drilldown || r.drilldown.error) continue; // not attempted, or failed - see doc comment
    const significant = r.drilldown.relations.filter(
      (rel) => rel.test.significant,
    );
    const groupKey = r.instance.group_key;

    switch (r.instance.mode) {
      case "E2O":
        drilldowns[groupKey] = dedupeByTarget(significant).map((d) => ({
          objectType: d.target,
          pValue: d.pValue,
          effectSize: d.effectSize,
        }));
        break;
      case "E2E":
        e2eDrilldowns[groupKey] = significant.map(
          (rel): DrilldownRelationResult => ({
            qualifier: rel.qualifier,
            objectType: rel.target,
            pValue: rel.test.p_value,
            isSignificant: rel.test.significant,
            pseudoF: rel.test.pseudo_f as number,
            effectSize: rel.effect_size,
          }),
        );
        break;
      case "O2O":
        o2oDrilldowns[groupKey] = dedupeByTarget(significant);
        break;
      case "O2E":
        o2eDrilldowns[groupKey] = dedupeByTarget(significant);
        break;
    }
  }

  const followsMode: FollowsMode =
    doc.params.follows === "directly_follows"
      ? "DirectlyFollows"
      : "EventuallyFollows";

  const result: ProcessModelData = {
    dfg: exported.processModel.dfg,
    comparison,
    drilldowns,
    e2eDrilldowns,
    o2oDrilldowns,
    o2eDrilldowns,
    followsMode,
  };

  return {
    schemaVersion: 1,
    exportedAt: "",
    log1: {
      path: doc.logs.log_1.path ?? "",
      summary: toLogSummary(doc.logs.log_1),
    },
    log2: {
      path: doc.logs.log_2.path ?? "",
      summary: toLogSummary(doc.logs.log_2),
    },
    // Write-only in this app (nothing ever reads `.query` back off `importedProcessModel` — only
    // `.log1`/`.log2`/`.statParams`/`.result`/`.layout`/`.exportedAt` are) - best-effort
    // reconstruction from what the new document actually has, not a faithful record of the
    // original query if it was ever narrower than "every shared type".
    query: {
      eventTypes: doc.logs.log_1.event_types,
      objectTypes: doc.logs.log_1.object_types,
      allowedObjectTypes: doc.params.e2e_object_types,
      followsMode,
      qualifierMode: "Single",
    },
    statParams: {
      numPermutations: doc.params.permutations,
      alpha: doc.params.alpha,
      seed: doc.params.seed,
      distanceMode:
        doc.params.distance === "bray_curtis" ? "BrayCurtis" : "Euclidean",
    },
    layout: exported.processModel.layout,
    result,
  };
}

/** Result of `importProcessModelResult`: the adapted value the existing render pipeline expects,
 *  plus — only when the imported file was diffrel's own new-format document — the untouched raw
 *  document. Keeping the raw bytes around lets a later re-export write the original new-format
 *  document back out (just with an updated `layout`) instead of always falling back to the lossy
 *  `ProcessModelExportV1` adapter output; see `rawExport`'s use in `App.tsx`'s
 *  `handleExportProcessModel`. `rawExport` is `null` for an old-format import, which has no new-
 *  format document to preserve. */
export interface ImportedProcessModelResult {
  processModel: ProcessModelExportV1;
  rawExport: ExportedComparisonResult | null;
}

/** Reads an export file of either format and returns the `ProcessModelExportV1`-compatible value
 *  the rest of the app already knows how to render — the two formats are self-identifying by
 *  which top-level version key is present (`schemaVersion`, old/camelCase vs. `schema_version`,
 *  new/snake_case from diffrel's own document), so there's no ambiguity to resolve. The new-format
 *  path routes the raw text through `importComparisonResult` (real Rust/serde deserialization,
 *  not shape-checking) before adapting it; the old-format path is unchanged, still pure frontend
 *  parsing via `parseProcessModelExport`. */
export async function importProcessModelResult(
  text: string,
): Promise<ImportedProcessModelResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      "Not a valid process model export: expected a JSON object.",
    );
  }
  const obj = parsed as Record<string, unknown>;

  if ("schema_version" in obj) {
    const exported = await importComparisonResult(text);
    return {
      processModel: adaptExportedComparisonResult(exported),
      rawExport: exported,
    };
  }
  if ("schemaVersion" in obj) {
    return { processModel: parseProcessModelExport(text), rawExport: null };
  }
  throw new Error(
    'Not a valid process model export: missing both "schemaVersion" and "schema_version".',
  );
}
