import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { TERM_NODE_SIZE } from "./vendor/dfg/util/dfg-model";

export interface TerminalNodeData extends Record<string, unknown> {
  kind: "start" | "end";
  color: string;
}

type TerminalNode = Node<TerminalNodeData, "terminal">;

/** Synthetic per-object-type process start/end marker (analogous to DFG_START_ID/DFG_END_ID).
 *  Filled with the owning object type's color; a small CSS-drawn triangle/square (not a Unicode
 *  glyph, which renders as a full-color platform emoji and clashes with the fill) marks start vs
 *  end. */
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
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      {data.kind === "start" ? (
        <div
          style={{
            width: 0,
            height: 0,
            marginLeft: 2,
            borderTop: "6px solid transparent",
            borderBottom: "6px solid transparent",
            borderLeft: "9px solid #fff",
          }}
        />
      ) : (
        <div style={{ width: 10, height: 10, background: "#fff", borderRadius: 2 }} />
      )}
    </div>
  );
}
