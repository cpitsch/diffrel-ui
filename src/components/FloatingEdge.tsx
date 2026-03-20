import {
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
  useInternalNode,
  type EdgeProps,
} from "@xyflow/react";

/** Returns the point where the line from (cx,cy) through (px,py) exits the rectangle
 *  centered at (cx,cy) with half-dimensions (hw, hh). */
function rectIntersection(
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  px: number,
  py: number,
): { x: number; y: number } {
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  // Scale factors to hit each edge
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);

  return { x: cx + dx * t, y: cy + dy * t };
}

export function FloatingEdge({
  id,
  source,
  target,
  label,
  style,
  markerEnd,
}: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  if (!sourceNode || !targetNode) return null;

  const sw = sourceNode.measured?.width ?? 180;
  const sh = sourceNode.measured?.height ?? 60;
  const tw = targetNode.measured?.width ?? 180;
  const th = targetNode.measured?.height ?? 60;

  const scx = sourceNode.internals.positionAbsolute.x + sw / 2;
  const scy = sourceNode.internals.positionAbsolute.y + sh / 2;
  const tcx = targetNode.internals.positionAbsolute.x + tw / 2;
  const tcy = targetNode.internals.positionAbsolute.y + th / 2;

  const sourcePoint = rectIntersection(scx, scy, sw / 2, sh / 2, tcx, tcy);
  const targetPoint = rectIntersection(tcx, tcy, tw / 2, th / 2, scx, scy);

  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    targetX: targetPoint.x,
    targetY: targetPoint.y,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: "0.7rem",
              background: "rgba(255,255,255,0.85)",
              padding: "1px 4px",
              borderRadius: "3px",
              pointerEvents: "none",
            }}
            className="nodrag nopan"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
