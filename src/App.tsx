import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Button, Callout, Heading, Theme } from "@radix-ui/themes";

import { pickAndLoadLog, runComparison } from "./tauriCommands";
import type { ComparisonOutput, LogSummary } from "./types";
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
  const [selectedEventTypes, setSelectedEventTypes] = useState<Set<string>>(new Set());

  const loadLog1 = useMutation({
    mutationFn: () => pickAndLoadLog(0),
    onSuccess: (result) => {
      if (!result) return;
      setLog1Summary(result.summary);
      setLog1Path(result.path);
      setComparison(null);
      // Default-select event types present in both logs
      if (log2Summary) {
        const both = result.summary.eventTypes.filter((et) =>
          log2Summary.eventTypes.includes(et)
        );
        setSelectedEventTypes(new Set(both));
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
        const both = result.summary.eventTypes.filter((et) =>
          log1Summary.eventTypes.includes(et)
        );
        setSelectedEventTypes(new Set(both));
      }
    },
  });

  const runComp = useMutation({
    mutationFn: runComparison,
    onSuccess: (result) => {
      setComparison(result);
      setRunId((id) => id + 1);
    },
  });

  const bothLogsLoaded = log1Summary !== null && log2Summary !== null;

  // Derive event type sets for the selector
  const { bothLogTypes, onlyInLog1, onlyInLog2 } = useMemo(() => {
    if (!log1Summary || !log2Summary)
      return { bothLogTypes: [], onlyInLog1: [], onlyInLog2: [] };
    const s1 = new Set(log1Summary.eventTypes);
    const s2 = new Set(log2Summary.eventTypes);
    return {
      bothLogTypes: log1Summary.eventTypes.filter((et) => s2.has(et)),
      onlyInLog1: log1Summary.eventTypes.filter((et) => !s2.has(et)),
      onlyInLog2: log2Summary.eventTypes.filter((et) => !s1.has(et)),
    };
  }, [log1Summary, log2Summary]);

  const error =
    loadLog1.error?.toString() ??
    loadLog2.error?.toString() ??
    runComp.error?.toString() ??
    null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <Heading size="3" style={{ fontVariant: "small-caps" }}>DiffRel</Heading>
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
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                  <p className="sidebar-section-label" style={{ margin: 0 }}>Event types</p>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Button size="1" variant="soft" onClick={() => setSelectedEventTypes(new Set(bothLogTypes))}>Select All</Button>
                    <Button size="1" variant="soft" onClick={() => setSelectedEventTypes(new Set())}>Clear</Button>
                  </div>
                </div>
                <EventTypeSelector
                  bothLogTypes={bothLogTypes}
                  onlyInLog1={onlyInLog1}
                  onlyInLog2={onlyInLog2}
                  selected={selectedEventTypes}
                  onChange={setSelectedEventTypes}
                />
              </section>

              <section className="sidebar-section">
                <p className="sidebar-section-label">Parameters</p>
                <ComparisonSettings
                  onRun={(params) => runComp.mutate(params)}
                  disabled={!bothLogsLoaded || selectedEventTypes.size === 0}
                  isPending={runComp.isPending}
                  selectedEventTypes={
                    selectedEventTypes.size > 0
                      ? [...selectedEventTypes]
                      : null
                  }
                />
              </section>
            </>
          )}

          {error && (
            <Callout.Root color="red" size="1" mt="3">
              <Callout.Text style={{ wordBreak: "break-word" }}>{error}</Callout.Text>
            </Callout.Root>
          )}
        </div>
      </aside>

      <main className="graph-area">
        <GraphView
          comparison={comparison}
          log1EventTypes={log1Summary?.eventTypes ?? []}
          log2EventTypes={log2Summary?.eventTypes ?? []}
          runId={runId}
        />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Theme accentColor="indigo" grayColor="slate" radius="medium" scaling="95%">
        <AppInner />
      </Theme>
    </QueryClientProvider>
  );
}
