import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { EventTypeNodeData } from "../types";
import styles from "./EventTypeNode.module.css";

type EventTypeNode = Node<EventTypeNodeData, "eventType">;

function backgroundFor(data: EventTypeNodeData): string {
  if (data.presence !== "both" || data.result === null) return "#e5e7eb";
  return data.result.isSignificant ? "#fecaca" : "#bbf7d0";
}

function subtitleFor(data: EventTypeNodeData): string {
  if (data.presence === "onlyInLog1") return "only in log 1";
  if (data.presence === "onlyInLog2") return "only in log 2";
  if (data.result === null) return "not tested";
  return `p = ${data.result.pValue.toPrecision(3)}`;
}

export function EventTypeNode({ data }: NodeProps<EventTypeNode>) {
  return (
    <div className={styles.node} style={{ background: backgroundFor(data) }}>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle id="bottom" type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <span className={styles.label}>{data.eventType}</span>
      <span className={styles.subtitle}>{subtitleFor(data)}</span>
    </div>
  );
}
