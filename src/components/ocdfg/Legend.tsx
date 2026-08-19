import { Panel } from "@xyflow/react";

export function Legend({ colorMap }: { colorMap: Record<string, string> }) {
  const entries = Object.entries(colorMap);
  if (entries.length === 0) return null;
  return (
    <Panel position="bottom-left">
      <div
        style={{
          background: "#fff",
          border: "1px solid rgba(0,0,0,0.1)",
          borderRadius: 8,
          padding: "8px 10px",
          fontSize: "0.75rem",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          maxHeight: 260,
          overflowY: "auto",
        }}
      >
        <span style={{ fontWeight: 600, color: "#374151" }}>Object types</span>
        {entries.map(([ot, color]) => (
          <div key={ot} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: color,
                border: "1px solid rgba(0,0,0,0.2)",
                flexShrink: 0,
              }}
            />
            <span>{ot}</span>
          </div>
        ))}
        <div
          style={{
            borderTop: "1px solid rgba(0,0,0,0.1)",
            marginTop: 2,
            paddingTop: 4,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 14, height: 0, borderTop: "2px dashed #f59e0b" }} />
            <span>E2E differs</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "#999",
                border: "1px solid rgba(0,0,0,0.25)",
              }}
            />
            <span>E2O differs (dot = object type)</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
