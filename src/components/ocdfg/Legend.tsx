import { Panel } from "@xyflow/react";
import { formatPVal } from "../../nativeSvg";
import type { TargetDeviation } from "../../processModel";
import { activityStrokeColor } from "./vendor/dfg/util/activity-color";

/** Per-object-type list of the specific targets (object types for O2O, event types for O2E) whose
 *  relationship-count distribution was found to differ significantly — see ProcessModelView.tsx's
 *  comment on why these are a Legend indicator rather than something drawn on canvas: they're
 *  object-structure comparisons with no natural position in the process flow, unlike E2O/E2E.
 *  Rendered without relying on hover: this view needs to be legible in a static screenshot/figure
 *  (e.g. for a paper), not just interactively. Both O2O and O2E targets are shown as colored dots:
 *  O2O uses the same `colorMap` already spelled out in the "Object types" list right above, while
 *  O2E uses each event type's own identity color (see `ActivityNode.tsx` /
 *  `vendor/dfg/util/activity-color.ts`) — so a dot's color never needs a hover to decode, it just
 *  resolves against a different reference: O2O against the list above, O2E against the matching
 *  activity node printed on canvas. */
export interface ObjectTypeDeviations {
  o2o: TargetDeviation[];
  o2e: TargetDeviation[];
}

export function Legend({
  colorMap,
  objectTypeDeviations,
}: {
  colorMap: Record<string, string>;
  objectTypeDeviations?: Record<string, ObjectTypeDeviations>;
}) {
  const entries = Object.entries(colorMap);
  if (entries.length === 0) return null;
  const showDeviationsColumn = objectTypeDeviations !== undefined;
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
          minWidth: 200,
          maxHeight: 320,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <span style={{ fontWeight: 600, color: "#374151" }}>
            Object types
          </span>
          {showDeviationsColumn && (
            <span style={{ fontWeight: 600, color: "#374151" }}>
              Differences
            </span>
          )}
        </div>
        {entries.map(([ot, color]) => {
          const dev = objectTypeDeviations?.[ot];
          const hasO2o = (dev?.o2o.length ?? 0) > 0;
          const hasO2e = (dev?.o2e.length ?? 0) > 0;
          return (
            <div
              key={ot}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
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
              {(hasO2o || hasO2e) && (
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginLeft: "auto",
                  }}
                >
                  {hasO2o && (
                    <span
                      style={{ display: "flex", alignItems: "center", gap: 3 }}
                    >
                      <span style={{ fontSize: "0.65rem", color: "#6b7280" }}>
                        O2O:
                      </span>
                      {dev!.o2o.map((d) => (
                        <span
                          key={d.target}
                          title={`${d.target} (p=${formatPVal(d.pValue)})`}
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: colorMap[d.target] ?? "#9ca3af",
                            border: "1px solid rgba(0,0,0,0.2)",
                            flexShrink: 0,
                          }}
                        />
                      ))}
                    </span>
                  )}
                  {hasO2e && (
                    <span
                      style={{ display: "flex", alignItems: "center", gap: 3 }}
                    >
                      <span style={{ fontSize: "0.65rem", color: "#6b7280" }}>
                        O2E:
                      </span>
                      {dev!.o2e.map((d) => (
                        <span
                          key={d.target}
                          title={`${d.target} (p=${formatPVal(d.pValue)})`}
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: activityStrokeColor(d.target),
                            border: "1px solid rgba(0,0,0,0.2)",
                            flexShrink: 0,
                          }}
                        />
                      ))}
                    </span>
                  )}
                </span>
              )}
            </div>
          );
        })}
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
            <span
              style={{
                width: 12,
                display: "flex",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  border: "3px solid #ef4444",
                  background: "#fff",
                  boxSizing: "border-box",
                }}
              />
            </span>
            <span>E2E differs</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 12,
                display: "flex",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "#999",
                  border: "1px solid rgba(0,0,0,0.25)",
                }}
              />
            </span>
            <span>E2O differs</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
