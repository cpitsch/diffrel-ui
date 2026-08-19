import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { TERM_NODE_SIZE } from "./vendor/dfg/util/dfg-model";

export interface TerminalNodeData extends Record<string, unknown> {
  kind: "start" | "end";
  color: string;
}

type TerminalNode = Node<TerminalNodeData, "terminal">;

/** Synthetic per-object-type process start/end marker (analogous to DFG_START_ID/DFG_END_ID). */
export function TerminalNode({ data }: NodeProps<TerminalNode>) {
  return (
    <div
      style={{
        width: TERM_NODE_SIZE,
        height: TERM_NODE_SIZE,
        borderRadius: "50%",
        background: data.color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontSize: 12,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      {data.kind === "start" ? "▶" : "■"}
    </div>
  );
}
