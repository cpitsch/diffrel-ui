import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";

const elk = new ELK();

/**
 * Applies an ELK force-directed layout to the given nodes and edges.
 * Node dimensions are read from `node.measured` (set by React Flow after
 * the first render). Returns a new nodes array with updated positions.
 */
export async function applyElkLayout(nodes: Node[], edges: Edge[]): Promise<Node[]> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "force",
      "elk.force.iterations": "500",
      "elk.spacing.nodeNode": "40",
      "elk.force.repulsion": "5.0",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.measured?.width ?? 180,
      height: n.measured?.height ?? 60,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const laid = await elk.layout(graph);

  return nodes.map((node) => {
    const child = laid.children?.find((c) => c.id === node.id);
    if (!child || child.x == null || child.y == null) return node;
    return { ...node, position: { x: child.x, y: child.y } };
  });
}
