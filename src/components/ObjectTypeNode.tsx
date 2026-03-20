import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ObjectTypeNodeData } from "../types";
import styles from "./ObjectTypeNode.module.css";

type ObjectTypeNode = Node<ObjectTypeNodeData, "objectType">;

function fmtMd(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

function fmtN(value: number): string {
  return value.toFixed(2);
}

export function ObjectTypeNode({ data }: NodeProps<ObjectTypeNode>) {
  return (
    <div className={styles.node} style={{ background: data.color }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle id="top" type="target" position={Position.Top} style={{ opacity: 0 }} />
      <span className={styles.label}>{data.objectType}</span>
      {/* <span className={styles.stat}>
        Md: {fmtMd(data.medianLog1)} / {fmtMd(data.medianLog2)}
      </span> */}
      <span className={styles.stat}>μ₁ = {fmtN(data.meanLog1)}<span className={styles.sd}>±{fmtN(data.stdLog1)}</span></span>
      <span className={styles.stat}>μ₂ = {fmtN(data.meanLog2)}<span className={styles.sd}>±{fmtN(data.stdLog2)}</span></span>
    </div>
  );
}
