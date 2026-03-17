import type { LogSummary } from "../types";

interface LogLoaderProps {
  logNumber: 1 | 2;
  summary: LogSummary | null;
  filePath: string | null;
  isPending: boolean;
  onLoad: () => void;
  disabled: boolean;
}

export function LogLoader({
  logNumber,
  summary,
  filePath,
  isPending,
  onLoad,
  disabled,
}: LogLoaderProps) {
  const fileName = filePath ? filePath.split(/[\\/]/).pop() : null;

  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <button onClick={onLoad} disabled={disabled || isPending} style={{ width: "100%" }}>
        {isPending ? "Loading…" : `Load Log ${logNumber}`}
      </button>
      {summary && fileName && (
        <div style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "#6b7280" }}>
          <div style={{ fontWeight: 500, color: "#374151", wordBreak: "break-all" }}>
            {fileName}
          </div>
          <div>
            {summary.eventCount.toLocaleString()} events ·{" "}
            {summary.eventTypeCount} event types
          </div>
        </div>
      )}
    </div>
  );
}
