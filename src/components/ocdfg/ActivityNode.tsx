import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import styles from "./ActivityNode.module.css";
import { activityFillColor, activityStrokeColor } from "./vendor/dfg/util/activity-color";

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

/** Extra height the `.dots` row (deviating-object-type badges) adds on top of the base card —
 *  14px dot + 1px margin-top + 3px flex gap (border included in the 14px: this app resets
 *  box-sizing to border-box globally, see App.css). Layout (`nodeSize` in ProcessModelView.tsx)
 *  needs this to size nodes correctly for ELK, since ELK routes edge endpoints against the box
 *  size it's told, not the actual rendered DOM size. */
export const DEVIATING_DOTS_HEIGHT = 18;

export function ActivityNode({ data }: NodeProps<ActivityNode>) {
  const fill = activityFillColor(data.activity);
  const stroke = activityStrokeColor(data.activity);
  return (
    <div
      className={styles.node}
      style={
        data.e2eSignificant
          ? { background: fill, borderColor: "#ef4444", borderWidth: 3 }
          : { background: fill, borderColor: stroke }
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
