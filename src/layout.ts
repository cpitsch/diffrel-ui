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

/**
 * Applies an ELK layered (hierarchical) layout to the given nodes and edges.
 * Event type nodes appear on top; object type children fan out below.
 */
export async function applyHierarchicalLayout(nodes: Node[], edges: Edge[]): Promise<Node[]> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "30",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
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
  const laidNodes = nodes.map((node) => {
    const child = laid.children?.find((c) => c.id === node.id);
    if (!child || child.x == null || child.y == null) return node;
    return { ...node, position: { x: child.x, y: child.y } };
  });

  // Center each child group under its parent
  const parentToChildren = new Map<string, string[]>();
  for (const e of edges) {
    if (!parentToChildren.has(e.source)) parentToChildren.set(e.source, []);
    parentToChildren.get(e.source)!.push(e.target);
  }

  const nodeMap = new Map(laidNodes.map((n) => [n.id, n]));
  for (const [parentId, childIds] of parentToChildren) {
    const parent = nodeMap.get(parentId);
    if (!parent) continue;
    const parentW = parent.measured?.width ?? 180;
    const parentCx = parent.position.x + parentW / 2;

    const children = childIds.map((id) => nodeMap.get(id)).filter((n): n is Node => n != null);
    if (children.length === 0) continue;

    const groupLeft = Math.min(...children.map((c) => c.position.x));
    const groupRight = Math.max(...children.map((c) => c.position.x + (c.measured?.width ?? 180)));
    const shift = parentCx - (groupLeft + groupRight) / 2;
    if (Math.abs(shift) < 0.5) continue;

    for (const child of children) {
      const n = nodeMap.get(child.id)!;
      nodeMap.set(child.id, { ...n, position: { x: n.position.x + shift, y: n.position.y } });
    }
  }

  return laidNodes.map((n) => nodeMap.get(n.id) ?? n);
}
