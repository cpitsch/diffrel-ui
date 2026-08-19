import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import styles from "./ActivityNode.module.css";

export interface ActivityNodeData extends Record<string, unknown> {
  activity: string;
  /** Occurrence count of this activity in the base (log 1) skeleton. */
  count: number;
  /** Object types whose E2O relation to this event type differs significantly (group-level result). */
  deviatingObjectTypes: { objectType: string; color: string }[];
  /** Whether this event type's E2E (directly-follows) profile differs significantly between logs. */
  e2eSignificant: boolean;
}

type ActivityNode = Node<ActivityNodeData, "activity">;

export function ActivityNode({ data }: NodeProps<ActivityNode>) {
  return (
    <div
      className={styles.node}
      style={
        data.e2eSignificant
          ? { borderColor: "#f59e0b", borderStyle: "dashed" }
          : undefined
      }
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <span className={styles.label}>{data.activity}</span>
      <span className={styles.subtitle}>{data.count.toLocaleString("en")}</span>
      {data.deviatingObjectTypes.length > 0 && (
        <div className={styles.dots} title="E2O relation differs significantly for these object types">
          {data.deviatingObjectTypes.map((d) => (
            <span
              key={d.objectType}
              className={styles.dot}
              style={{ background: d.color }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
