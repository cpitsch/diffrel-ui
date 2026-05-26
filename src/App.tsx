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
  ComparisonOutput,
  DrilldownOutput,
  LogSummary,
  RelationMode,
} from "./types";
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
  const [mode, setMode] = useState<RelationMode>("E2O");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

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
      if (log2Summary) {
        const list2 = groupTypesForMode(log2Summary, mode);
        const both = groupTypesForMode(result.summary, mode).filter((t) =>
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
      if (log1Summary) {
        const list1 = groupTypesForMode(log1Summary, mode);
        const both = groupTypesForMode(result.summary, mode).filter((t) =>
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
      mode: RelationMode;
      numPermutations: number;
      alpha: number;
    }) =>
      runDrilldown(vars.groupKey, vars.mode, vars.numPermutations, vars.alpha),
    onSuccess: (result, vars) => {
      setDrilldownResults((prev) => ({ ...prev, [vars.groupKey]: result }));
    },
  });

  const bothLogsLoaded = log1Summary !== null && log2Summary !== null;

  function handleModeChange(m: RelationMode) {
    setMode(m);
    setComparison(null);
    setDrilldownResults({});
    if (log1Summary && log2Summary) {
      const list1 = groupTypesForMode(log1Summary, m);
      const list2 = groupTypesForMode(log2Summary, m);
      setSelectedTypes(new Set(list1.filter((t) => list2.includes(t))));
    }
  }

  // Derive group type sets for the selector
  const { bothLogTypes, onlyInLog1, onlyInLog2 } = useMemo(() => {
    if (!log1Summary || !log2Summary)
      return { bothLogTypes: [], onlyInLog1: [], onlyInLog2: [] };
    const list1 = groupTypesForMode(log1Summary, mode);
    const list2 = groupTypesForMode(log2Summary, mode);
    const s1 = new Set(list1);
    const s2 = new Set(list2);
    return {
      bothLogTypes: list1.filter((t) => s2.has(t)),
      onlyInLog1: list1.filter((t) => !s2.has(t)),
      onlyInLog2: list2.filter((t) => !s1.has(t)),
    };
  }, [log1Summary, log2Summary, mode]);

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
                  value={mode}
                  onValueChange={(v) => handleModeChange(v as RelationMode)}
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
                </SegmentedControl.Root>
              </section>

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
                    {mode === "O2O" || mode === "O2E"
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

              <section className="sidebar-section">
                <ComparisonSettings
                  onRun={(params) => runComp.mutate(params)}
                  disabled={!bothLogsLoaded || selectedTypes.size === 0}
                  isPending={runComp.isPending}
                  mode={mode}
                  selectedTypes={
                    selectedTypes.size > 0 ? [...selectedTypes] : null
                  }
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
          log1EventTypes={
            log1Summary ? groupTypesForMode(log1Summary, mode) : []
          }
          log2EventTypes={
            log2Summary ? groupTypesForMode(log2Summary, mode) : []
          }
          runId={runId}
          drilldownResults={drilldownResults}
          drilldownPendingEventType={
            drilldownMutation.isPending
              ? drilldownMutation.variables?.groupKey
              : undefined
          }
          onDrilldown={(groupKey) => {
            const params = runComp.variables;
            if (params)
              drilldownMutation.mutate({
                groupKey,
                mode,
                numPermutations: params.numPermutations,
                alpha: params.alpha,
              });
          }}
        />
      </main>
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
