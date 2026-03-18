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
 * ELK layered layout with no post-processing — for comparison/testing.
 */
export async function applyElkHierarchicalLayout(nodes: Node[], edges: Edge[]): Promise<Node[]> {
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

  // Center each parent over its children
  const parentToChildren = new Map<string, string[]>();
  for (const e of edges) {
    if (!parentToChildren.has(e.source)) parentToChildren.set(e.source, []);
    parentToChildren.get(e.source)!.push(e.target);
  }
  const nodeMap = new Map(laidNodes.map((n) => [n.id, n]));
  for (const [parentId, childIds] of parentToChildren) {
    const parent = nodeMap.get(parentId);
    if (!parent) continue;
    const children = childIds.map((id) => nodeMap.get(id)).filter((n): n is Node => n != null);
    if (children.length === 0) continue;
    const childLeft = Math.min(...children.map((c) => c.position.x));
    const childRight = Math.max(...children.map((c) => c.position.x + (c.measured?.width ?? 180)));
    const parentW = parent.measured?.width ?? 180;
    nodeMap.set(parentId, { ...parent, position: { x: (childLeft + childRight) / 2 - parentW / 2, y: parent.position.y } });
  }
  return laidNodes.map((n) => nodeMap.get(n.id) ?? n);
}

/**
 * Manual hierarchical layout: each event-type node and its object-type children
 * form an independent group. Groups are packed left-to-right with row-wrapping.
 * This avoids ELK's global layering which puts all children in one wide row.
 */
export async function applyHierarchicalLayout(nodes: Node[], edges: Edge[]): Promise<Node[]> {
  const CHILD_GAP = 16;
  const PARENT_TO_CHILD_Y = 80;
  const GROUP_GAP_X = 48;
  const GROUP_GAP_Y = 80;
  const MAX_ROW_WIDTH = 2000;

  const parentToChildren = new Map<string, string[]>();
  const childIdSet = new Set<string>();
  for (const e of edges) {
    if (!parentToChildren.has(e.source)) parentToChildren.set(e.source, []);
    parentToChildren.get(e.source)!.push(e.target);
    childIdSet.add(e.target);
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map<string, Node>();

  // Event nodes are any node that is not a child
  const eventNodes = nodes.filter((n) => !childIdSet.has(n.id));

  // Compute bounding width of each group
  const groupWidths = eventNodes.map((parent) => {
    const parentW = parent.measured?.width ?? 180;
    const children = (parentToChildren.get(parent.id) ?? [])
      .map((id) => nodeMap.get(id))
      .filter((n): n is Node => n != null);
    if (children.length === 0) return parentW;
    const childRowW =
      children.reduce((sum, c) => sum + (c.measured?.width ?? 180), 0) +
      CHILD_GAP * (children.length - 1);
    return Math.max(parentW, childRowW);
  });

  // Pack groups into rows
  let rowX = 0;
  let rowY = 0;
  let rowMaxH = 0;
  const groupOrigins: { x: number; y: number }[] = [];

  for (let i = 0; i < eventNodes.length; i++) {
    const parent = eventNodes[i];
    const gw = groupWidths[i];
    const parentH = parent.measured?.height ?? 60;
    const children = (parentToChildren.get(parent.id) ?? [])
      .map((id) => nodeMap.get(id))
      .filter((n): n is Node => n != null);
    const maxChildH = children.length > 0 ? Math.max(...children.map((c) => c.measured?.height ?? 60)) : 0;
    const gh = children.length > 0 ? parentH + PARENT_TO_CHILD_Y + maxChildH : parentH;

    if (i > 0 && rowX + gw > MAX_ROW_WIDTH) {
      rowY += rowMaxH + GROUP_GAP_Y;
      rowX = 0;
      rowMaxH = 0;
    }

    groupOrigins.push({ x: rowX, y: rowY });
    rowX += gw + GROUP_GAP_X;
    rowMaxH = Math.max(rowMaxH, gh);
  }

  // Apply positions
  for (let i = 0; i < eventNodes.length; i++) {
    const parent = eventNodes[i];
    const origin = groupOrigins[i];
    const gw = groupWidths[i];
    const parentW = parent.measured?.width ?? 180;
    const parentH = parent.measured?.height ?? 60;

    result.set(parent.id, {
      ...parent,
      position: { x: origin.x + (gw - parentW) / 2, y: origin.y },
    });

    const children = (parentToChildren.get(parent.id) ?? [])
      .map((id) => nodeMap.get(id))
      .filter((n): n is Node => n != null);
    if (children.length === 0) continue;

    const childRowW =
      children.reduce((sum, c) => sum + (c.measured?.width ?? 180), 0) +
      CHILD_GAP * (children.length - 1);
    let cx = origin.x + (gw - childRowW) / 2;
    const cy = origin.y + parentH + PARENT_TO_CHILD_Y;

    for (const child of children) {
      const cw = child.measured?.width ?? 180;
      result.set(child.id, { ...child, position: { x: cx, y: cy } });
      cx += cw + CHILD_GAP;
    }
  }

  return nodes.map((n) => result.get(n.id) ?? n);
}
