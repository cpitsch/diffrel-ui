import { useMemo, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import {
  Button,
  Callout,
  Heading,
  SegmentedControl,
  Theme,
} from "@radix-ui/themes";

import { pickAndLoadLog, runComparison, runDrilldown } from "./tauriCommands";
import type {
  AppMode,
  ComparisonOutput,
  DistanceMode,
  DrilldownOutput,
  LogSummary,
  MixedBlock,
  RelationMode,
} from "./types";
import { AddBlockDialog } from "./components/AddBlockDialog";
import { ComparisonSettings } from "./components/ComparisonSettings";
import { EventTypeSelector } from "./components/EventTypeSelector";
import { GraphView } from "./components/GraphView";
import { LogLoader } from "./components/LogLoader";
import "./App.css";

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
  const [distanceMode, setDistanceMode] = useState<DistanceMode>("BrayCurtis");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [mixedBlocks, setMixedBlocks] = useState<MixedBlock[]>([]);
  const [addBlockDialogOpen, setAddBlockDialogOpen] = useState(false);

  function groupTypesForMode(summary: LogSummary, m: RelationMode): string[] {
    return m === "O2O" || m === "O2E"
      ? summary.objectTypes
      : summary.eventTypes;
  }

  const loadLog1 = useMutation({
    mutationFn: () => pickAndLoadLog(0),
    onSuccess: (result) => {
      if (!result) return;
      setLog1Summary(result.summary);
      setLog1Path(result.path);
      setComparison(null);
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
      alpha: number;
    }) =>
      runDrilldown(vars.groupKey, vars.mode, vars.numPermutations, vars.alpha),
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

          {bothLogsLoaded && (
            <>
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

              {!isMixedMode && (
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
                    runComp.mutate({ ...statParams, blocks });
                  }}
                  disabled={
                    !bothLogsLoaded ||
                    (isMixedMode ? mixedBlocks.length === 0 : selectedTypes.size === 0)
                  }
                  isPending={runComp.isPending}
                  distanceMode={distanceMode}
                  onDistanceModeChange={setDistanceMode}
                />
              </section>
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
            if (res && params) {
              drilldownMutation.mutate({
                groupKey: res.groupKey,
                resultKey: blockId,
                mode: res.mode,
                numPermutations: params.numPermutations,
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
          onRemoveBlock={isMixedMode ? handleRemoveBlock : undefined}
        />
      </main>

      {bothLogsLoaded && log1Summary && log2Summary && (
        <AddBlockDialog
          open={addBlockDialogOpen}
          onOpenChange={setAddBlockDialogOpen}
          log1Summary={log1Summary}
          log2Summary={log2Summary}
          existingBlocks={mixedBlocks}
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
