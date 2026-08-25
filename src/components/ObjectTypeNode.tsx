import { Ping } from "ldrs/react";
import "ldrs/react/Ping.css";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ObjectTypeNodeData } from "../types";
import styles from "./ObjectTypeNode.module.css";

type ObjectTypeNode = Node<ObjectTypeNodeData, "objectType">;

function fmtN(value: number): string {
  return value.toFixed(2);
}

function fmtPVal(p: number): string {
  if (p > 0 && p < 0.00005) return "< 0.0001";
  return p.toFixed(4);
}

function borderFor(data: ObjectTypeNodeData): string {
  if (data.drilldownIsSignificant === undefined)
    return "2px solid rgba(0, 0, 0, 0.15)";
  return data.drilldownIsSignificant
    ? "2px solid #d5adad"
    : "2px solid #a3d1b1";
}

export function ObjectTypeNode({ data }: NodeProps<ObjectTypeNode>) {
  return (
    <div
      className={styles.node}
      style={{ background: data.color, border: borderFor(data) }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        style={{ opacity: 0 }}
      />
      <span
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span className={styles.label} style={{ marginInline: 26 }}>
          {data.objectType}
        </span>
        {(data.isDrilldownPending ||
          data.drilldownIsSignificant !== undefined) && (
          <span
            style={{
              position: "absolute",
              right: 0,
              lineHeight: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
            }}
          >
            {data.isDrilldownPending ? (
              <Ping size="20" speed="3" color="rgba(0,0,0,0.4)" />
            ) : (
              <span
                style={{
                  position: "absolute",
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: data.drilldownIsSignificant
                    ? "#d5adad"
                    : "#a3d1b1",
                }}
              />
            )}
          </span>
        )}
      </span>
      {/* <span className={styles.stat}>
        Md: {fmtMd(data.medianLog1)} / {fmtMd(data.medianLog2)}
      </span> */}
      <span className={styles.stat}>
        μ₁ = {fmtN(data.meanLog1)}
        <span className={styles.sd}> ± {fmtN(data.stdLog1)}</span>
      </span>
      <span className={styles.stat}>
        μ₂ = {fmtN(data.meanLog2)}
        <span className={styles.sd}> ± {fmtN(data.stdLog2)}</span>
      </span>
      {!data.isDrilldownPending && data.drilldownPValue !== undefined && (
        <span className={styles.stat}>
          p = {fmtPVal(data.drilldownPValue as number)}
        </span>
      )}
    </div>
  );
}
