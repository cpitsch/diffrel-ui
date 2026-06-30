import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { EventTypeNodeData } from "../types";
import styles from "./EventTypeNode.module.css";

type EventTypeNode = Node<EventTypeNodeData, "eventType">;

function backgroundFor(data: EventTypeNodeData): string {
  if (data.isPending) return "#e0e7ff"; // indigo-100 — distinct from gray
  if (data.presence !== "both" || data.result === null) return "#e5e7eb";
  return data.result.isSignificant ? "#fecaca" : "#bbf7d0";
}

function formatPVal(p: number): string {
  if (p > 0 && p < 0.00005) return "< 0.0001";
  return p.toFixed(4);
}

function subtitleFor(data: EventTypeNodeData): string {
  if (data.presence === "onlyInLog1") return "only in log 1";
  if (data.presence === "onlyInLog2") return "only in log 2";
  if (data.isPending) return "pending";
  if (data.result === null) return "not tested";
  return "";
}

export function EventTypeNode({ data }: NodeProps<EventTypeNode>) {
  const hasResult = data.presence === "both" && data.result !== null;
  return (
    <div className={styles.node} style={{ background: backgroundFor(data) }}>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0 }}
      />
      {data.blockMode && (
        <span
          style={{
            fontSize: "0.6rem",
            fontWeight: 600,
            color: "#6366f1",
            letterSpacing: "0.05em",
            display: "block",
            marginBottom: 1,
          }}
        >
          {data.blockMode}
        </span>
      )}
      <span className={styles.label}>{data.groupKey}</span>
      {hasResult ? (
        <div className={styles.stats}>
          <span>p</span>
          <span>=</span>
          <span>{formatPVal(data.result!.pValue)}</span>
          <span>n</span>
          <span>=</span>
          <span>
            {data.result!.n1} / {data.result!.n2}
          </span>
        </div>
      ) : (
        <span className={styles.subtitle}>{subtitleFor(data)}</span>
      )}
    </div>
  );
}
