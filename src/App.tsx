import { useEffect, useMemo, useRef, useState } from "react";
import { Ring } from "ldrs/react";
import "ldrs/react/Ring.css";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import {
  Box,
  Button,
  Callout,
  Checkbox,
  Flex,
  Heading,
  ScrollArea,
  SegmentedControl,
  Text,
  Theme,
} from "@radix-ui/themes";

import { getDimensions, pickAndLoadLog, runComparison, runDrilldown } from "./tauriCommands";
import { fetchProcessModel } from "./processModel";
import {
  exportProcessModel,
  parseProcessModelExport,
  type ProcessModelExportV1,
  type ProcessModelLayout,
} from "./processModelExport";
import type {
  AppMode,
  ComparisonOutput,
  DistanceMode,
  DrilldownOutput,
  E2EQualifierMode,
  FollowsMode,
  LogSummary,
  MixedBlock,
  RelationMode,
} from "./types";
import { AddBlockDialog } from "./components/AddBlockDialog";
import { ComparisonSettings, type StatParams } from "./components/ComparisonSettings";
import { STAT_PARAMS_DEFAULTS, StatParamsFields } from "./components/StatParamsFields";
import {
  DEFAULT_DISTANCE_MODE,
  DEFAULT_FOLLOWS_MODE,
  DEFAULT_QUALIFIER_MODE,
  DEFAULT_SEED_TEXT,
} from "./constants";
import { EventTypeSelector } from "./components/EventTypeSelector";
import { GraphView } from "./components/GraphView";
import { LogLoader } from "./components/LogLoader";
import { ProcessModelView } from "./components/ocdfg/ProcessModelView";
import "./App.css";

type ViewMode = "relations" | "processModel";

const queryClient = new QueryClient();

function AppInner() {
  const [log1Summary, setLog1Summary] = useState<LogSummary | null>(null);
  const [log1Path, setLog1Path] = useState<string | null>(null);
  const [log2Summary, setLog2Summary] = useState<LogSummary | null>(null);
  const [log2Path, setLog2Path] = useState<string | null>(null);
  const [comparison, setComparison] = useState<ComparisonOutput | null>(null);
  const [runId, setRunId] = useState(0);
  const [drilldownResults, setDrilldownResults] = useState<
    Record<string, DrilldownOutput>
  >({});
  const [appMode, setAppMode] = useState<AppMode>("E2O");
  const [distanceMode, setDistanceMode] = useState<DistanceMode>(DEFAULT_DISTANCE_MODE);
  // Lifted out of ComparisonSettings.tsx so the Relations view and the Process model view share
  // one "Parameters" config (StatParamsFields.tsx) instead of each keeping an independent copy —
  // the Process model previously had no UI for these at all, always running with fixed defaults.
  const [numPermutations, setNumPermutations] = useState(STAT_PARAMS_DEFAULTS.numPermutations);
  const [alpha, setAlpha] = useState(STAT_PARAMS_DEFAULTS.alpha);
  const [useSeed, setUseSeed] = useState(STAT_PARAMS_DEFAULTS.useSeed);
  const [seed, setSeed] = useState(DEFAULT_SEED_TEXT);
  // Was a user-toggleable SegmentedControl in ComparisonSettings ("E2E follows relation");
  // removed once it became clear it wasn't earning its keep as a real user choice, same
  // reasoning as the Process model's now-removed "Overlay relation"/"Qualifier grouping"
  // controls. Kept as a shared constant (not per-view-duplicated) since it still feeds
  // drilldownMutation and AddBlockDialog below, not just ComparisonSettings.
  const followsMode: FollowsMode = DEFAULT_FOLLOWS_MODE;
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [mixedBlocks, setMixedBlocks] = useState<MixedBlock[]>([]);
  const [addBlockDialogOpen, setAddBlockDialogOpen] = useState(false);
  const [allowedObjectTypes, setAllowedObjectTypes] = useState<Set<string>>(
    new Set(),
  );
  const [viewMode, setViewMode] = useState<ViewMode>("relations");
  // A statically-imported Process model result (see processModelExport.ts) — takes over
  // rendering from `pmMutation.data` when set. Cleared whenever the user does something that
  // would make it stale: loads a real log, or starts a new live "Discover process model" run.
  const [importedProcessModel, setImportedProcessModel] = useState<ProcessModelExportV1 | null>(
    null,
  );
  const [importError, setImportError] = useState<string | null>(null);

  const availableObjectTypes = useMemo(() => {
    if (!log1Summary || !log2Summary) return [];
    return [
      ...new Set([...log1Summary.objectTypes, ...log2Summary.objectTypes]),
    ].sort();
  }, [log1Summary, log2Summary]);

  // Default to "everything allowed" whenever the available object types change
  // (new logs loaded). Opt-in state, but the default is unrestricted.
  useEffect(() => {
    setAllowedObjectTypes(new Set(availableObjectTypes));
  }, [availableObjectTypes]);

  // null = no restriction (send to backend as Option::None)
  const allowedObjectTypesParam: string[] | null =
    allowedObjectTypes.size === availableObjectTypes.length
      ? null
      : [...allowedObjectTypes];

  function groupTypesForMode(summary: LogSummary, m: RelationMode): string[] {
    return m === "O2O" || m === "O2E"
      ? summary.objectTypes
      : summary.eventTypes;
  }

  // The process model is a different VIEW of the same underlying comparisons, but — unlike
  // the Relations view's runComp — it's only kicked off by an explicit "Discover process
  // model" click once the user has configured which object types to include; see the
  // mutate() call site in the sidebar.
  const pmMutation = useMutation({
    mutationFn: (vars: {
      eventTypes: string[];
      objectTypes: string[];
      allowedObjectTypes: string[] | null;
      followsMode: FollowsMode;
      qualifierMode: E2EQualifierMode;
      params: StatParams;
    }) =>
      fetchProcessModel(
        vars.eventTypes,
        vars.objectTypes,
        vars.allowedObjectTypes,
        vars.followsMode,
        vars.qualifierMode,
        vars.params,
      ),
  });

  const loadLog1 = useMutation({
    mutationFn: () => pickAndLoadLog(0),
    onSuccess: (result) => {
      if (!result) return;
      setLog1Summary(result.summary);
      setLog1Path(result.path);
      setComparison(null);
      pmMutation.reset();
      setImportedProcessModel(null);
      if (log2Summary && appMode !== "Mixed") {
        const m = appMode as RelationMode;
        const list2 = groupTypesForMode(log2Summary, m);
        const both = groupTypesForMode(result.summary, m).filter((t) =>
          list2.includes(t),
        );
        setSelectedTypes(new Set(both));
      }
    },
  });

  const loadLog2 = useMutation({
    mutationFn: () => pickAndLoadLog(1),
    onSuccess: (result) => {
      if (!result) return;
      setLog2Summary(result.summary);
      setLog2Path(result.path);
      setComparison(null);
      pmMutation.reset();
      setImportedProcessModel(null);
      if (log1Summary && appMode !== "Mixed") {
        const m = appMode as RelationMode;
        const list1 = groupTypesForMode(log1Summary, m);
        const both = groupTypesForMode(result.summary, m).filter((t) =>
          list1.includes(t),
        );
        setSelectedTypes(new Set(both));
      }
    },
  });

  const runComp = useMutation({
    mutationFn: runComparison,
    onSuccess: (result) => {
      setComparison(result);
      setRunId((id) => id + 1);
      setDrilldownResults({});
    },
  });

  const drilldownMutation = useMutation({
    mutationFn: (vars: {
      groupKey: string;
      resultKey: string;
      mode: RelationMode;
      numPermutations: number;
      seed: number;
      alpha: number;
    }) =>
      runDrilldown(
        vars.groupKey,
        vars.mode,
        vars.numPermutations,
        vars.seed,
        vars.alpha,
        allowedObjectTypesParam,
        followsMode,
        // No UI control for this in the Relations view — must match whatever qualifierMode the
        // comparison/block being drilled into was itself run with (ComparisonSettings.tsx,
        // AddBlockDialog.tsx).
        "Single",
      ),
    onSuccess: (result, vars) => {
      setDrilldownResults((prev) => ({ ...prev, [vars.resultKey]: result }));
    },
  });

  const bothLogsLoaded = log1Summary !== null && log2Summary !== null;

  function handleModeChange(m: AppMode) {
    setAppMode(m);
    setComparison(null);
    setDrilldownResults({});
    if (m === "Mixed") {
      setSelectedTypes(new Set());
    } else {
      setMixedBlocks([]);
      if (log1Summary && log2Summary) {
        const rm = m as RelationMode;
        const list1 = groupTypesForMode(log1Summary, rm);
        const list2 = groupTypesForMode(log2Summary, rm);
        setSelectedTypes(new Set(list1.filter((t) => list2.includes(t))));
      }
    }
  }

  // Derive group type sets for the selector (homogeneous modes only)
  const { bothLogTypes, onlyInLog1, onlyInLog2 } = useMemo(() => {
    if (!log1Summary || !log2Summary || appMode === "Mixed")
      return { bothLogTypes: [], onlyInLog1: [], onlyInLog2: [] };
    const m = appMode as RelationMode;
    const list1 = groupTypesForMode(log1Summary, m);
    const list2 = groupTypesForMode(log2Summary, m);
    const s1 = new Set(list1);
    const s2 = new Set(list2);
    return {
      bothLogTypes: list1.filter((t) => s2.has(t)),
      onlyInLog1: list1.filter((t) => !s2.has(t)),
      onlyInLog2: list2.filter((t) => !s1.has(t)),
    };
  }, [log1Summary, log2Summary, appMode]);

  function handleAddBlock(
    mode: RelationMode,
    groupKey: string,
    targetTypes: string[] | null,
    dimensions: [string, string][],
  ) {
    const id = crypto.randomUUID();
    const block: MixedBlock = { id, mode, groupKey, targetTypes, dimensions };
    setMixedBlocks((prev) => [...prev, block]);
  }

  function handleRemoveBlock(blockId: string) {
    setMixedBlocks((prev) => prev.filter((b) => b.id !== blockId));
    setDrilldownResults((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
  }

  function handleClearBlocks() {
    setMixedBlocks([]);
    setDrilldownResults({});
    setComparison(null);
  }

  const importFileInputRef = useRef<HTMLInputElement>(null);

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file path consecutively
    if (!file) return;
    setImportError(null);
    file
      .text()
      .then((text) => {
        const parsed = parseProcessModelExport(text);
        setImportedProcessModel(parsed);
        setViewMode("processModel");
      })
      .catch((err: unknown) => {
        setImportError(err instanceof Error ? err.message : String(err));
      });
  }

  function handleExportProcessModel(layout: ProcessModelLayout) {
    // Always the current on-screen positions, live or imported — if the user dragged nodes after
    // importing, re-exporting should save that new arrangement, not the stale imported one.
    if (importedProcessModel) {
      exportProcessModel({ ...importedProcessModel, layout });
      return;
    }
    const vars = pmMutation.variables;
    const data = pmMutation.data;
    if (!vars || !data || !log1Path || !log1Summary || !log2Path || !log2Summary) return;
    exportProcessModel({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      log1: { path: log1Path, summary: log1Summary },
      log2: { path: log2Path, summary: log2Summary },
      query: {
        eventTypes: vars.eventTypes,
        objectTypes: vars.objectTypes,
        allowedObjectTypes: vars.allowedObjectTypes,
        followsMode: vars.followsMode,
        qualifierMode: vars.qualifierMode,
      },
      statParams: {
        numPermutations: vars.params.numPermutations,
        alpha: vars.params.alpha,
        seed: vars.params.seed,
        distanceMode: vars.params.distanceMode,
      },
      layout,
      result: data,
    });
  }

  // "Full <mode>" / "Full comparison" tiles in Mixed mode's empty state: adds one block per
  // (mode, groupKey) pair shared between both logs, across the given relation modes — skipping
  // pairs already present as a block and pairs with no observed dimensions (nothing to compare).
  const addFullComparisonMutation = useMutation({
    mutationFn: async (modes: RelationMode[]) => {
      if (!log1Summary || !log2Summary) return [];
      const usedByMode = new Map<RelationMode, Set<string>>();
      for (const b of mixedBlocks) {
        if (!usedByMode.has(b.mode)) usedByMode.set(b.mode, new Set());
        usedByMode.get(b.mode)!.add(b.groupKey);
      }
      const pairs: { mode: RelationMode; groupKey: string }[] = [];
      for (const m of modes) {
        const list1 = groupTypesForMode(log1Summary, m);
        const list2 = new Set(groupTypesForMode(log2Summary, m));
        const used = usedByMode.get(m) ?? new Set();
        for (const t of list1) {
          if (list2.has(t) && !used.has(t)) pairs.push({ mode: m, groupKey: t });
        }
      }
      const results = await Promise.all(
        pairs.map(async ({ mode, groupKey }) => ({
          mode,
          groupKey,
          dimensions: await getDimensions(
            mode,
            groupKey,
            allowedObjectTypesParam,
            followsMode,
            "Single",
          ),
        })),
      );
      return results.filter((r) => r.dimensions.length > 0);
    },
    onSuccess: (results) => {
      if (results.length === 0) return;
      setMixedBlocks((prev) => [
        ...prev,
        ...results.map((r) => ({
          id: crypto.randomUUID(),
          mode: r.mode,
          groupKey: r.groupKey,
          targetTypes: null,
          dimensions: r.dimensions,
        })),
      ]);
    },
  });

  const isMixedMode = appMode === "Mixed";

  const error =
    loadLog1.error?.toString() ??
    loadLog2.error?.toString() ??
    runComp.error?.toString() ??
    null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <Heading size="3" style={{ fontVariant: "small-caps" }}>
            DiffRel
          </Heading>
        </div>
        <div className="sidebar-content">
          <section className="sidebar-section">
            <p className="sidebar-section-label">Logs</p>
            <LogLoader
              logNumber={1}
              summary={log1Summary}
              filePath={log1Path}
              isPending={loadLog1.isPending}
              onLoad={() => loadLog1.mutate()}
              disabled={runComp.isPending}
            />
            <LogLoader
              logNumber={2}
              summary={log2Summary}
              filePath={log2Path}
              isPending={loadLog2.isPending}
              onLoad={() => loadLog2.mutate()}
              disabled={runComp.isPending}
            />
          </section>

          <section className="sidebar-section">
            <input
              ref={importFileInputRef}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={handleImportFile}
            />
            <Button
              size="1"
              variant="soft"
              style={{ width: "100%" }}
              onClick={() => importFileInputRef.current?.click()}
            >
              Import result…
            </Button>
            {importError && (
              <Callout.Root color="red" size="1" mt="2">
                <Callout.Text style={{ wordBreak: "break-word" }}>{importError}</Callout.Text>
              </Callout.Root>
            )}
          </section>

          {bothLogsLoaded && (
            <>
              <section className="sidebar-section">
                <p className="sidebar-section-label">View</p>
                <SegmentedControl.Root
                  value={viewMode}
                  onValueChange={(v) => setViewMode(v as ViewMode)}
                  size="1"
                  style={{ width: "100%" }}
                >
                  <SegmentedControl.Item
                    value="relations"
                    title="Relation cardinality comparison"
                  >
                    Relations
                  </SegmentedControl.Item>
                  <SegmentedControl.Item
                    value="processModel"
                    title="Discovered process model with highlighted deviations"
                  >
                    Process model
                  </SegmentedControl.Item>
                </SegmentedControl.Root>
              </section>

              {viewMode === "relations" && (
                <section className="sidebar-section">
                  <p className="sidebar-section-label">Comparison Mode</p>
                  <SegmentedControl.Root
                    value={appMode}
                    onValueChange={(v) => handleModeChange(v as AppMode)}
                    size="1"
                    style={{ width: "100%" }}
                  >
                    <SegmentedControl.Item value="E2O" title="Event to Object">
                      E2O
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="O2O" title="Object to Object">
                      O2O
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="O2E" title="Object to Event">
                      O2E
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="E2E" title="Event to Event">
                      E2E
                    </SegmentedControl.Item>
                    <SegmentedControl.Item value="Mixed" title="Mixed">
                      Mixed
                    </SegmentedControl.Item>
                  </SegmentedControl.Root>
                </section>
              )}

              {viewMode === "relations" && !isMixedMode && (
                <section className="sidebar-section">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <p className="sidebar-section-label" style={{ margin: 0 }}>
                      {appMode === "O2O" || appMode === "O2E"
                        ? "Object types"
                        : "Event types"}
                    </p>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Button
                        size="1"
                        variant="soft"
                        onClick={() => setSelectedTypes(new Set(bothLogTypes))}
                      >
                        Select All
                      </Button>
                      <Button
                        size="1"
                        variant="soft"
                        onClick={() => setSelectedTypes(new Set())}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                  <EventTypeSelector
                    bothLogTypes={bothLogTypes}
                    onlyInLog1={onlyInLog1}
                    onlyInLog2={onlyInLog2}
                    selected={selectedTypes}
                    onChange={setSelectedTypes}
                  />
                </section>
              )}

              {(appMode === "E2E" || viewMode === "processModel") && (
              <section className="sidebar-section">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.5rem",
                  }}
                >
                  <p className="sidebar-section-label" style={{ margin: 0 }}>
                    E2E Object Types
                  </p>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Button
                      size="1"
                      variant="soft"
                      onClick={() =>
                        setAllowedObjectTypes(new Set(availableObjectTypes))
                      }
                    >
                      Select All
                    </Button>
                    <Button
                      size="1"
                      variant="soft"
                      onClick={() => setAllowedObjectTypes(new Set())}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                <Box mb="3">
                  <ScrollArea style={{ maxHeight: "min(180px, 30vh)" }}>
                    <Flex direction="column" gap="1" pr="2">
                      {availableObjectTypes.map((t) => (
                        <Text
                          as="label"
                          key={t}
                          size="2"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            cursor: "pointer",
                          }}
                        >
                          <Checkbox
                            checked={allowedObjectTypes.has(t)}
                            onCheckedChange={() => {
                              const next = new Set(allowedObjectTypes);
                              if (next.has(t)) next.delete(t);
                              else next.add(t);
                              setAllowedObjectTypes(next);
                            }}
                          />
                          {t}
                        </Text>
                      ))}
                    </Flex>
                  </ScrollArea>
                </Box>
              </section>
              )}

              {viewMode === "relations" && (
                <section className="sidebar-section">
                  <ComparisonSettings
                    onRun={(statParams) => {
                      const blocks = isMixedMode
                        ? mixedBlocks.map((b) => ({
                            id: b.id,
                            mode: b.mode,
                            groupKey: b.groupKey,
                            targetTypes: b.targetTypes,
                          }))
                        : [...selectedTypes].map((gk) => ({
                            id: crypto.randomUUID(),
                            mode: appMode as RelationMode,
                            groupKey: gk,
                            targetTypes: null,
                          }));
                      runComp.mutate({
                        ...statParams,
                        blocks,
                        allowedObjectTypes: allowedObjectTypesParam,
                      });
                    }}
                    disabled={
                      !bothLogsLoaded ||
                      (isMixedMode
                        ? mixedBlocks.length === 0
                        : selectedTypes.size === 0)
                    }
                    isPending={runComp.isPending}
                    distanceMode={distanceMode}
                    onDistanceModeChange={setDistanceMode}
                    numPermutations={numPermutations}
                    onNumPermutationsChange={setNumPermutations}
                    alpha={alpha}
                    onAlphaChange={setAlpha}
                    useSeed={useSeed}
                    onUseSeedChange={setUseSeed}
                    seed={seed}
                    onSeedChange={setSeed}
                  />
                </section>
              )}

              {viewMode === "processModel" && (
                <section className="sidebar-section">
                  <Flex direction="column" gap="3">
                    <StatParamsFields
                      numPermutations={numPermutations}
                      onNumPermutationsChange={setNumPermutations}
                      alpha={alpha}
                      onAlphaChange={setAlpha}
                      useSeed={useSeed}
                      onUseSeedChange={setUseSeed}
                      seed={seed}
                      onSeedChange={setSeed}
                      distanceMode={distanceMode}
                      onDistanceModeChange={setDistanceMode}
                      disabled={pmMutation.isPending}
                    />
                    <Button
                      size="2"
                      style={{ width: "100%" }}
                      disabled={
                        !bothLogsLoaded ||
                        pmMutation.isPending ||
                        allowedObjectTypes.size === 0
                      }
                      onClick={() => {
                        if (!log1Summary || !log2Summary) return;
                        setImportedProcessModel(null);
                        const eventTypes = log1Summary.eventTypes.filter((t) =>
                          log2Summary.eventTypes.includes(t),
                        );
                        const objectTypes = log1Summary.objectTypes.filter((t) =>
                          log2Summary.objectTypes.includes(t),
                        );
                        const parsedSeed = parseInt(seed, 10);
                        pmMutation.mutate({
                          eventTypes,
                          objectTypes,
                          allowedObjectTypes: allowedObjectTypesParam,
                          // Overlay relation / qualifier grouping used to be user-toggleable here —
                          // dropped once the Effect Size filter in the Process model header took
                          // over as the actual view-simplification control; "Eventually" + "Single"
                          // (richest relation, one arc per object type) is the only combination now
                          // in use, so it's just fixed rather than exposed as a choice.
                          followsMode: DEFAULT_FOLLOWS_MODE,
                          qualifierMode: DEFAULT_QUALIFIER_MODE,
                          params: {
                            numPermutations,
                            alpha,
                            seed: useSeed && !isNaN(parsedSeed) ? parsedSeed : null,
                            distanceMode,
                            followsMode: DEFAULT_FOLLOWS_MODE,
                            qualifierMode: DEFAULT_QUALIFIER_MODE,
                          },
                        });
                      }}
                    >
                      {pmMutation.isPending && (
                        <Ring size="16" stroke="2" speed="2" color="currentColor" />
                      )}
                      {pmMutation.isPending
                        ? "Discovering…"
                        : "Discover process model"}
                    </Button>
                    {importedProcessModel && (
                      <div
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: 6,
                          padding: "8px 10px",
                          fontSize: 12,
                          color: "#374151",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <Text weight="bold" size="1">
                          Viewing imported result
                        </Text>
                        <Text size="1" color="gray" style={{ wordBreak: "break-all" }}>
                          Log 1: {importedProcessModel.log1.path.split(/[\\/]/).pop()}
                        </Text>
                        <Text size="1" color="gray" style={{ wordBreak: "break-all" }}>
                          Log 2: {importedProcessModel.log2.path.split(/[\\/]/).pop()}
                        </Text>
                        <Text size="1" color="gray">
                          {importedProcessModel.statParams.numPermutations} permutations · α ={" "}
                          {importedProcessModel.statParams.alpha} · seed{" "}
                          {importedProcessModel.result.comparison.seedUsed} ·{" "}
                          {importedProcessModel.statParams.distanceMode}
                        </Text>
                        <Text size="1" color="gray">
                          Exported {new Date(importedProcessModel.exportedAt).toLocaleString()}
                        </Text>
                        <Button
                          size="1"
                          variant="soft"
                          color="gray"
                          onClick={() => setImportedProcessModel(null)}
                        >
                          Close imported result
                        </Button>
                      </div>
                    )}
                  </Flex>
                </section>
              )}
            </>
          )}

          {error && (
            <Callout.Root color="red" size="1" mt="3">
              <Callout.Text style={{ wordBreak: "break-word" }}>
                {error}
              </Callout.Text>
            </Callout.Root>
          )}
        </div>
      </aside>

      <main className="graph-area">
        {viewMode === "relations" ? (
          <GraphView
            comparison={comparison}
            runId={runId}
            drilldownResults={drilldownResults}
            drilldownPendingEventType={
              drilldownMutation.isPending
                ? drilldownMutation.variables?.resultKey
                : undefined
            }
            onDrilldown={(blockId) => {
              const res = comparison?.results[blockId];
              const params = runComp.variables;
              if (comparison && res && params) {
                drilldownMutation.mutate({
                  groupKey: res.groupKey,
                  resultKey: blockId,
                  mode: res.mode,
                  numPermutations: params.numPermutations,
                  seed: comparison.seedUsed,
                  alpha: params.alpha,
                });
              }
            }}
            isMixedMode={isMixedMode}
            mixedBlocks={isMixedMode ? mixedBlocks : undefined}
            onAddBlock={
              bothLogsLoaded && isMixedMode
                ? () => setAddBlockDialogOpen(true)
                : undefined
            }
            onAddFullComparison={
              bothLogsLoaded && isMixedMode
                ? (modes) => addFullComparisonMutation.mutate(modes)
                : undefined
            }
            isAddingFullComparison={addFullComparisonMutation.isPending}
            onClearBlocks={isMixedMode ? handleClearBlocks : undefined}
            onRemoveBlock={isMixedMode ? handleRemoveBlock : undefined}
          />
        ) : (
          <ProcessModelView
            log1Summary={importedProcessModel?.log1.summary ?? log1Summary}
            log2Summary={importedProcessModel?.log2.summary ?? log2Summary}
            data={importedProcessModel?.result ?? pmMutation.data ?? null}
            isPending={pmMutation.isPending}
            error={pmMutation.error ? String(pmMutation.error) : null}
            initialLayout={importedProcessModel?.layout}
            onExportResult={handleExportProcessModel}
          />
        )}
      </main>

      {bothLogsLoaded && log1Summary && log2Summary && (
        <AddBlockDialog
          open={addBlockDialogOpen}
          onOpenChange={setAddBlockDialogOpen}
          log1Summary={log1Summary}
          log2Summary={log2Summary}
          existingBlocks={mixedBlocks}
          availableObjectTypes={availableObjectTypes}
          allowedObjectTypes={allowedObjectTypes}
          onAllowedObjectTypesChange={setAllowedObjectTypes}
          followsMode={followsMode}
          onAdd={handleAddBlock}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Theme
        accentColor="indigo"
        grayColor="slate"
        radius="medium"
        scaling="95%"
      >
        <AppInner />
      </Theme>
    </QueryClientProvider>
  );
}
