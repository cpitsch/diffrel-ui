import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";

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
        <h2 style={{ margin: "0 0 1rem", fontSize: "1.1rem" }}>diffrel</h2>

        <section>
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
            <hr style={{ margin: "0.75rem 0" }} />
            <EventTypeSelector
              bothLogTypes={bothLogTypes}
              onlyInLog1={onlyInLog1}
              onlyInLog2={onlyInLog2}
              selected={selectedEventTypes}
              onChange={setSelectedEventTypes}
            />
            <ComparisonSettings
              onRun={(params) => runComp.mutate(params)}
              disabled={!bothLogsLoaded}
              isPending={runComp.isPending}
              selectedEventTypes={
                selectedEventTypes.size > 0
                  ? [...selectedEventTypes]
                  : null
              }
            />
          </>
        )}

        {error && (
          <div
            style={{
              marginTop: "1rem",
              padding: "0.5rem",
              background: "#fee2e2",
              color: "#991b1b",
              borderRadius: "6px",
              fontSize: "0.8rem",
              wordBreak: "break-word",
            }}
          >
            {error}
          </div>
        )}
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
      <AppInner />
    </QueryClientProvider>
  );
}
