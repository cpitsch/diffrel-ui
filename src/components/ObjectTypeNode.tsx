import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ObjectTypeNodeData } from "../types";
import styles from "./ObjectTypeNode.module.css";

type ObjectTypeNode = Node<ObjectTypeNodeData, "objectType">;

function formatMedian(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

export function ObjectTypeNode({ data }: NodeProps<ObjectTypeNode>) {
  return (
    <div className={styles.node} style={{ background: data.color }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle id="top" type="target" position={Position.Top} style={{ opacity: 0 }} />
      <span className={styles.label}>{data.objectType}</span>
      <span className={styles.median}>
        Median: {formatMedian(data.medianLog1)} / {formatMedian(data.medianLog2)}
      </span>
    </div>
  );
}
