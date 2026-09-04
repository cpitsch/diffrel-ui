import "@xyflow/react/dist/style.css";

import { toPng, toSvg } from "html-to-image";
import mermaid from "mermaid";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";

import { MagnifyingGlassIcon, PlusIcon, RulerSquareIcon } from "@radix-ui/react-icons";
import { Button, Link, SegmentedControl } from "@radix-ui/themes";
import { applyElkHierarchicalLayout, applyElkLayout } from "../layout";
import { buildMermaidSubgraph } from "../mermaid";
import { buildNativeSvgSubgraph } from "../nativeSvg";
import { buildColorMap } from "../objectTypeColors";
import type {
  ComparisonOutput,
  DrilldownOutput,
  EventTypeNodeData,
  MixedBlock,
  ObjectTypeNodeData,
  RelationMode,
} from "../types";
import { EventTypeNode } from "./EventTypeNode";
import { FloatingEdge } from "./FloatingEdge";
import { ObjectTypeNode } from "./ObjectTypeNode";

mermaid.initialize({ startOnLoad: false, theme: "neutral" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: Record<string, any> = {
  eventType: EventTypeNode,
  objectType: ObjectTypeNode,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const edgeTypes: Record<string, any> = {
  floating: FloatingEdge,
};

interface GraphViewProps {
  comparison: ComparisonOutput | null;
  runId: number;
  drilldownResults: Record<string, DrilldownOutput>;
  drilldownPendingEventType: string | undefined;
  onDrilldown: (blockId: string) => void;
  isMixedMode?: boolean;
  mixedBlocks?: MixedBlock[];
  onAddBlock?: () => void;
  onAddFullComparison?: (modes: RelationMode[]) => void;
  isAddingFullComparison?: boolean;
  onClearBlocks?: () => void;
  onRemoveBlock?: (blockId: string) => void;
  onImportClick?: () => void;
}

function buildGraph(
  comparison: ComparisonOutput | null,
  mixedBlocks: MixedBlock[] | undefined,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Build color map from all object types (results + pending block dimensions)
  const allObjectTypes = [
    ...(comparison
      ? Object.values(comparison.results).flatMap((r) =>
          r.objectTypeRelations.map((rel) => rel.objectType),
        )
      : []),
    ...(mixedBlocks ? mixedBlocks.flatMap((b) => b.dimensions.map(([, t]) => t)) : []),
  ];
  const colorMap = buildColorMap(allObjectTypes);

  if (mixedBlocks) {
    // Mixed mode: blocks are the authoritative source of nodes
    for (const block of mixedBlocks) {
      const result = comparison?.results[block.id] ?? null;
      const isPending = result === null;

      const data: EventTypeNodeData = {
        eventType: block.id,
        groupKey: block.groupKey,
        presence: "both",
        result,
        isPending,
        blockMode: block.mode,
      };
      nodes.push({
        id: `evt-${block.id}`,
        type: "eventType",
        position: { x: 0, y: 0 },
        data,
      });

      // Use result's objectTypeRelations if available; otherwise use pre-fetched dimensions
      const dims: Array<{
        qualifier: string;
        objectType: string;
        medianLog1: number;
        medianLog2: number;
        meanLog1: number;
        meanLog2: number;
        stdLog1: number;
        stdLog2: number;
      }> = result
        ? result.objectTypeRelations
        : block.dimensions.map(([q, t]) => ({
            qualifier: q,
            objectType: t,
            medianLog1: 0,
            medianLog2: 0,
            meanLog1: 0,
            meanLog2: 0,
            stdLog1: 0,
            stdLog2: 0,
          }));

      for (const rel of dims) {
        const objId = `obj-${block.id}|${rel.qualifier}|${rel.objectType}`;
        const objData: ObjectTypeNodeData = {
          objectType: rel.objectType,
          qualifier: rel.qualifier,
          medianLog1: rel.medianLog1,
          medianLog2: rel.medianLog2,
          meanLog1: rel.meanLog1,
          meanLog2: rel.meanLog2,
          stdLog1: rel.stdLog1,
          stdLog2: rel.stdLog2,
          color: colorMap[rel.objectType] ?? "#d1d5db",
        };
        nodes.push({
          id: objId,
          type: "objectType",
          position: { x: 0, y: 0 },
          data: objData,
        });
        edges.push({
          id: `e-${block.id}-${rel.qualifier}-${rel.objectType}`,
          source: `evt-${block.id}`,
          target: objId,
          label: rel.qualifier,
          type: "floating",
        });
      }
    }
  } else if (comparison) {
    // Homogeneous mode: results are the source of nodes
    for (const [blockId, result] of Object.entries(comparison.results)) {
      const data: EventTypeNodeData = {
        eventType: blockId,
        groupKey: result.groupKey,
        presence: "both",
        result,
      };
      nodes.push({
        id: `evt-${blockId}`,
        type: "eventType",
        position: { x: 0, y: 0 },
        data,
      });

      for (const rel of result.objectTypeRelations) {
        const objId = `obj-${blockId}|${rel.qualifier}|${rel.objectType}`;
        const objData: ObjectTypeNodeData = {
          objectType: rel.objectType,
          qualifier: rel.qualifier,
          medianLog1: rel.medianLog1,
          medianLog2: rel.medianLog2,
          meanLog1: rel.meanLog1,
          meanLog2: rel.meanLog2,
          stdLog1: rel.stdLog1,
          stdLog2: rel.stdLog2,
          color: colorMap[rel.objectType] ?? "#d1d5db",
        };
        nodes.push({
          id: objId,
          type: "objectType",
          position: { x: 0, y: 0 },
          data: objData,
        });
        edges.push({
          id: `e-${blockId}-${rel.qualifier}-${rel.objectType}`,
          source: `evt-${blockId}`,
          target: objId,
          label: rel.qualifier,
          type: "floating",
        });
      }
    }
  }

  return { nodes, edges };
}

/** Saves a blob via the File System Access API's save picker, falling back to a
 * synthetic anchor download if the picker is unavailable or the user cancels. Shared
 * by exportSubgraphNative; the older exportSubgraph/exportMermaidSubgraph functions
 * keep their own inline copies of this logic untouched. */
export async function saveBlob(
  blob: Blob,
  suggestedName: string,
  description: string,
  mimeType: string,
  ext: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picker = (window as any).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description, accept: { [mimeType]: [`.${ext}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") return;
    }
  }
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.download = suggestedName;
  a.href = objUrl;
  a.click();
  URL.revokeObjectURL(objUrl);
}

type LayoutMode = "force" | "elk-hierarchical";

function FlowCanvas({
  initialNodes,
  initialEdges,
  layoutMode,
  setLayoutMode,
  comparison,
  drilldownResults,
  drilldownPendingEventType,
  onDrilldown,
  isMixedMode,
  onAddBlock,
  onClearBlocks,
  onRemoveBlock,
}: {
  initialNodes: Node[];
  initialEdges: Edge[];
  layoutMode: LayoutMode;
  setLayoutMode: (m: LayoutMode) => void;
  comparison: ComparisonOutput | null;
  drilldownResults: Record<string, DrilldownOutput>;
  drilldownPendingEventType: string | undefined;
  onDrilldown: (blockId: string) => void;
  isMixedMode?: boolean;
  onAddBlock?: () => void;
  onClearBlocks?: () => void;
  onRemoveBlock?: (blockId: string) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const nodesRef = useRef<Node[]>(initialNodes);
  const nodesInitialized = useNodesInitialized();
  const { fitView, getNodesBounds } = useReactFlow();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
  } | null>(null);
  const [layoutKey, setLayoutKey] = useState(0);

  const childrenOf = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of initialEdges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      map.get(e.source)!.add(e.target);
    }
    return map;
  }, [initialEdges]);

  const animRef = useRef<number | null>(null);
  const dragParentPos = useRef<{ x: number; y: number } | null>(null);
  const dragParentSize = useRef<{ w: number; h: number }>({ w: 180, h: 60 });
  const childIds = useRef<Set<string>>(new Set());
  const childDist = useRef<Map<string, number>>(new Map());
  const childSize = useRef<Map<string, { w: number; h: number }>>(new Map());

  const displayEdges = useMemo(() => {
    if (layoutMode === "force") return initialEdges;
    return initialEdges.map((e) => ({
      ...e,
      type: undefined,
      sourceHandle: "bottom",
      targetHandle: "top",
    }));
  }, [initialEdges, layoutMode]);

  useEffect(() => {
    if (!nodesInitialized) return;
    const layoutFn =
      layoutMode === "force" ? applyElkLayout : applyElkHierarchicalLayout;
    layoutFn(nodesRef.current, initialEdges).then((laid) => {
      setNodes(laid);
      nodesRef.current = laid;
      setTimeout(() => fitView({ padding: 0.15 }), 50);
    });
  }, [nodesInitialized, layoutMode, layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Patch object type node data with drilldown results without re-triggering layout.
  useEffect(() => {
    setNodes((nds) => {
      const patched = nds.map((n) => {
        if (n.type !== "objectType") return n;
        // Node id format: "obj-{blockId}|{qualifier}|{objectType}"
        const rest = n.id.slice("obj-".length);
        const sepIdx = rest.indexOf("|");
        const blockId = rest.slice(0, sepIdx);
        const [qualifier, objectType] = rest.slice(sepIdx + 1).split("|");
        const rel = drilldownResults[blockId]?.results.find(
          (r) => r.qualifier === qualifier && r.objectType === objectType,
        );
        return {
          ...n,
          data: {
            ...n.data,
            drilldownPValue: rel?.pValue,
            drilldownIsSignificant: rel?.isSignificant,
            isDrilldownPending: drilldownPendingEventType === blockId,
          },
        };
      });
      nodesRef.current = patched;
      return patched;
    });
  }, [drilldownResults, drilldownPendingEventType]);

  const isDragging = useRef(false);
  const LERP = 0.06;

  const runSpring = useCallback(() => {
    let stillMoving = false;
    const parent = dragParentPos.current;
    if (!parent) {
      animRef.current = null;
      return;
    }

    const pcx = parent.x + dragParentSize.current.w / 2;
    const pcy = parent.y + dragParentSize.current.h / 2;

    setNodes((nds) => {
      let next = nds.map((n) => {
        if (!childIds.current.has(n.id)) return n;
        const sz = childSize.current.get(n.id) ?? { w: 180, h: 60 };
        const ccx = n.position.x + sz.w / 2;
        const ccy = n.position.y + sz.h / 2;
        const dx = ccx - pcx;
        const dy = ccy - pcy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetDist = childDist.current.get(n.id) ?? dist;
        const tx = pcx + (dx / dist) * targetDist - sz.w / 2;
        const ty = pcy + (dy / dist) * targetDist - sz.h / 2;
        const ex = tx - n.position.x;
        const ey = ty - n.position.y;
        if (Math.abs(ex) > 0.5 || Math.abs(ey) > 0.5) stillMoving = true;
        return {
          ...n,
          position: {
            x: n.position.x + ex * LERP,
            y: n.position.y + ey * LERP,
          },
        };
      });

      const childList = next.filter((n) => childIds.current.has(n.id));
      for (let i = 0; i < childList.length; i++) {
        for (let j = i + 1; j < childList.length; j++) {
          const a = childList[i];
          const b = childList[j];
          const asz = childSize.current.get(a.id) ?? { w: 180, h: 60 };
          const bsz = childSize.current.get(b.id) ?? { w: 180, h: 60 };
          const minD =
            (Math.max(asz.w, asz.h) + Math.max(bsz.w, bsz.h)) / 2 + 8;
          const dx = b.position.x + bsz.w / 2 - (a.position.x + asz.w / 2);
          const dy = b.position.y + bsz.h / 2 - (a.position.y + asz.h / 2);
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist < minD) {
            const push = (minD - dist) / (2 * dist);
            const ai = next.findIndex((n) => n.id === a.id);
            const bi = next.findIndex((n) => n.id === b.id);
            next[ai] = {
              ...next[ai],
              position: {
                x: next[ai].position.x - dx * push,
                y: next[ai].position.y - dy * push,
              },
            };
            next[bi] = {
              ...next[bi],
              position: {
                x: next[bi].position.x + dx * push,
                y: next[bi].position.y + dy * push,
              },
            };
            stillMoving = true;
          }
        }
      }

      nodesRef.current = next;
      return next;
    });

    animRef.current =
      isDragging.current || stillMoving
        ? requestAnimationFrame(runSpring)
        : null;
  }, []);

  useEffect(
    () => () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    },
    [],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => {
      const next = applyNodeChanges(changes, nds);
      nodesRef.current = next;
      return next;
    });
  }, []);

  const onNodeDragStart = useCallback(
    (_: React.MouseEvent, node: Node) => {
      isDragging.current = true;
      if (animRef.current) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }

      const children = childrenOf.get(node.id);
      if (!children || children.size === 0) return;

      const parentNode = nodesRef.current.find((n) => n.id === node.id);
      const pw = parentNode?.measured?.width ?? 180;
      const ph = parentNode?.measured?.height ?? 60;
      dragParentSize.current = { w: pw, h: ph };
      dragParentPos.current = { ...node.position };

      const pcx = node.position.x + pw / 2;
      const pcy = node.position.y + ph / 2;

      childIds.current = new Set(children);
      childDist.current.clear();
      childSize.current.clear();

      for (const n of nodesRef.current) {
        if (!children.has(n.id)) continue;
        const cw = n.measured?.width ?? 180;
        const ch = n.measured?.height ?? 60;
        const ccx = n.position.x + cw / 2;
        const ccy = n.position.y + ch / 2;
        childDist.current.set(
          n.id,
          Math.sqrt((ccx - pcx) ** 2 + (ccy - pcy) ** 2),
        );
        childSize.current.set(n.id, { w: cw, h: ch });
      }

      animRef.current = requestAnimationFrame(runSpring);
    },
    [childrenOf, runSpring],
  );

  const onNodeDrag = useCallback((_: React.MouseEvent, node: Node) => {
    dragParentPos.current = { ...node.position };
  }, []);

  const onNodeDragStop = useCallback(() => {
    isDragging.current = false;
  }, []);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    if (node.type !== "eventType") return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);

  const onPaneClick = useCallback(() => setContextMenu(null), []);

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      if (isMixedMode && onAddBlock) {
        e.preventDefault();
        onAddBlock();
      }
    },
    [isMixedMode, onAddBlock],
  );

  const exportSubgraph = useCallback(
    (eventNodeId: string, format: "svg" | "png") => {
      const blockId = eventNodeId.slice("evt-".length);
      const label = comparison?.results[blockId]?.groupKey ?? blockId;
      const childPrefix = `obj-${blockId}|`;

      const allNodes = nodesRef.current;
      const subNodes = allNodes.filter(
        (n) => n.id === eventNodeId || n.id.startsWith(childPrefix),
      );
      const subEdgeIds = new Set(
        initialEdges.filter((e) => e.source === eventNodeId).map((e) => e.id),
      );

      const PADDING = 20;
      const ZOOM = 6;
      const bounds = getNodesBounds(subNodes);
      const IMAGE_W = Math.round(bounds.width * ZOOM) + PADDING * 2;
      const IMAGE_H = Math.round(bounds.height * ZOOM) + PADDING * 2;
      const tx = PADDING - bounds.x * ZOOM;
      const ty = PADDING - bounds.y * ZOOM;

      const viewport = document.querySelector(
        ".react-flow__viewport",
      ) as HTMLElement;

      const options = {
        width: IMAGE_W,
        height: IMAGE_H,
        style: {
          width: String(IMAGE_W),
          height: String(IMAGE_H),
          transform: `translate(${tx}px, ${ty}px) scale(${ZOOM})`,
        },
        filter: (domNode: HTMLElement) => {
          if (!domNode.classList) return true;
          if (domNode.classList.contains("react-flow__minimap")) return false;
          if (domNode.classList.contains("react-flow__controls")) return false;
          if (domNode.classList.contains("react-flow__panel")) return false;
          if (domNode.classList.contains("react-flow__node"))
            return subNodes.some((n) => n.id === domNode.getAttribute("data-id"));
          if (domNode.classList.contains("react-flow__edge"))
            return subEdgeIds.has(domNode.getAttribute("data-id") ?? "");
          return true;
        },
      };

      const exportPromise =
        format === "svg"
          ? toSvg(viewport, options).then((dataUrl) => {
              const raw = decodeURIComponent(
                dataUrl.split(",").slice(1).join(","),
              );
              return new Blob(
                [
                  raw.replace(
                    /(<svg[^>]*>)/,
                    "$1<style>* { cursor: default !important; user-select: text !important; } foreignObject, foreignObject * { cursor: auto !important; }</style>",
                  ),
                ],
                { type: "image/svg+xml;charset=utf-8" },
              );
            })
          : toPng(viewport, options).then((dataUrl) => {
              return fetch(dataUrl).then((r) => r.blob());
            });

      exportPromise.then(async (blob) => {
        const ext = format;
        const mimeType = format === "svg" ? "image/svg+xml" : "image/png";
        const description = format === "svg" ? "SVG Image" : "PNG Image";

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const picker = (window as any).showSaveFilePicker;
        if (picker) {
          try {
            const handle = await picker({
              suggestedName: `${label}.${ext}`,
              types: [{ description, accept: { [mimeType]: [`.${ext}`] } }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
          } catch (err: unknown) {
            if ((err as { name?: string }).name !== "AbortError") {
              const objUrl = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.download = `${label}.${ext}`;
              a.href = objUrl;
              a.click();
              URL.revokeObjectURL(objUrl);
            }
          }
        } else {
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.download = `${label}.${ext}`;
          a.href = objUrl;
          a.click();
          URL.revokeObjectURL(objUrl);
        }
      });
      setContextMenu(null);
    },
    [initialEdges, getNodesBounds, comparison],
  );

  const exportMermaidSubgraph = useCallback(
    async (eventNodeId: string) => {
      if (!comparison) return;
      const blockId = eventNodeId.slice("evt-".length);
      const result = comparison.results[blockId];
      if (!result) return;

      const allObjectTypes = Object.values(comparison.results).flatMap((r) =>
        r.objectTypeRelations.map((rel) => rel.objectType),
      );
      const colorMap = buildColorMap(allObjectTypes);
      // Use groupKey as the display label in the Mermaid diagram
      const diagram = buildMermaidSubgraph(result.groupKey, result, colorMap);
      const label = result.groupKey;

      const { svg } = await mermaid.render("mermaid-offscreen-sub", diagram);
      const blob = new Blob([svg.replace(/<br>/gi, "<br/>")], {
        type: "image/svg+xml",
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const picker = (window as any).showSaveFilePicker;
      if (picker) {
        try {
          const handle = await picker({
            suggestedName: `${label}.svg`,
            types: [
              {
                description: "SVG Image",
                accept: { "image/svg+xml": [".svg"] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        } catch (err: unknown) {
          if ((err as { name?: string }).name !== "AbortError") {
            const objUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.download = `${label}.svg`;
            a.href = objUrl;
            a.click();
            URL.revokeObjectURL(objUrl);
          }
        }
      } else {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.download = `${label}.svg`;
        a.href = objUrl;
        a.click();
        URL.revokeObjectURL(objUrl);
      }
    },
    [comparison],
  );

  const exportSubgraphNative = useCallback(
    (eventNodeId: string) => {
      const blockId = eventNodeId.slice("evt-".length);
      const label = comparison?.results[blockId]?.groupKey ?? blockId;
      const childPrefix = `obj-${blockId}|`;

      const allNodes = nodesRef.current;
      const eventNode = allNodes.find((n) => n.id === eventNodeId) as
        | Node<EventTypeNodeData>
        | undefined;
      const objectNodes = allNodes.filter((n) =>
        n.id.startsWith(childPrefix),
      ) as Node<ObjectTypeNodeData>[];

      if (!eventNode) {
        setContextMenu(null);
        return;
      }

      const bounds = getNodesBounds([eventNode, ...objectNodes]);
      const edges = initialEdges
        .filter((e) => e.source === eventNodeId)
        .map((e) => ({
          qualifier: String(e.label ?? ""),
          sourceId: e.source,
          targetId: e.target,
        }));

      const svgString = buildNativeSvgSubgraph({
        eventNode,
        objectNodes,
        edges,
        bounds,
        // Mirrors displayEdges: layoutMode "force" keeps FloatingEdge's dynamic
        // straight-line routing; any other mode falls back to React Flow's default
        // (curved) BezierEdge with fixed bottom/top handles.
        edgeStyle: layoutMode === "force" ? "straight" : "bezier",
      });
      const blob = new Blob([svgString], {
        type: "image/svg+xml;charset=utf-8",
      });
      saveBlob(blob, `${label}.svg`, "SVG Image", "image/svg+xml", "svg");
      setContextMenu(null);
    },
    [initialEdges, getNodesBounds, comparison, layoutMode],
  );

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        fitView
      >
        <Background />
        <Controls />
        <Panel position="top-right">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              padding: "4px 8px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            }}
          >
            {isMixedMode && onAddBlock && (
              <Button size="1" variant="soft" onClick={onAddBlock}>
                <PlusIcon />
                Add block
              </Button>
            )}
            {isMixedMode && onClearBlocks && (
              <Button
                size="1"
                variant="soft"
                color="gray"
                onClick={onClearBlocks}
                title="Remove all blocks and start over"
              >
                Clear
              </Button>
            )}
            <span
              style={{ fontSize: 11, color: "#6b7280", userSelect: "none" }}
            >
              Layout
            </span>
            <button
              onClick={() => setLayoutKey((k) => k + 1)}
              title="Auto layout"
              style={{
                display: "flex",
                alignItems: "center",
                padding: "2px 4px",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#6b7280",
                borderRadius: 4,
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "#f3f4f6")
              }
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              <RulerSquareIcon style={{ transform: "rotate(-90deg)" }} />
            </button>
            <SegmentedControl.Root
              value={layoutMode}
              onValueChange={(v) => setLayoutMode(v as LayoutMode)}
              size="1"
            >
              <SegmentedControl.Item value="force">Force</SegmentedControl.Item>
              <SegmentedControl.Item value="elk-hierarchical">
                Hierarchical
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          </div>
        </Panel>
      </ReactFlow>
      {contextMenu && (
        <div
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
            zIndex: 1000,
            overflow: "hidden",
          }}
        >
          {(() => {
            const blockId = contextMenu.nodeId.slice("evt-".length);
            const result = comparison?.results[blockId];
            return (
              <>
                {result?.isSignificant && (
                  <>
                    <button
                      onClick={() => {
                        onDrilldown(blockId);
                        setContextMenu(null);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        width: "100%",
                        padding: "8px 16px",
                        background: "none",
                        border: "none",
                        textAlign: "left",
                        fontSize: "0.85rem",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = "#f3f4f6")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "none")
                      }
                    >
                      <MagnifyingGlassIcon />
                      Drill down
                    </button>
                    <div
                      style={{
                        height: 1,
                        background: "#e5e7eb",
                        margin: "2px 0",
                      }}
                    />
                  </>
                )}
                {(["svg", "png"] as const).map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => exportSubgraph(contextMenu.nodeId, fmt)}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "8px 16px",
                      background: "none",
                      border: "none",
                      textAlign: "left",
                      fontSize: "0.85rem",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = "#f3f4f6")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "none")
                    }
                  >
                    Export as {fmt.toUpperCase()}
                  </button>
                ))}
                <button
                  onClick={() => exportSubgraphNative(contextMenu.nodeId)}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 16px",
                    background: "none",
                    border: "none",
                    textAlign: "left",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "#f3f4f6")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "none")
                  }
                >
                  Export as SVG (Native)
                </button>
                {result && (
                  <>
                    <div
                      style={{
                        height: 1,
                        background: "#e5e7eb",
                        margin: "2px 0",
                      }}
                    />
                    <button
                      onClick={() => {
                        exportMermaidSubgraph(contextMenu.nodeId);
                        setContextMenu(null);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "8px 16px",
                        background: "none",
                        border: "none",
                        textAlign: "left",
                        fontSize: "0.85rem",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = "#f3f4f6")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "none")
                      }
                    >
                      Export as SVG (Mermaid)
                    </button>
                  </>
                )}
                {isMixedMode && onRemoveBlock && (
                  <>
                    <div
                      style={{
                        height: 1,
                        background: "#e5e7eb",
                        margin: "2px 0",
                      }}
                    />
                    <button
                      onClick={() => {
                        onRemoveBlock(blockId);
                        setContextMenu(null);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "8px 16px",
                        background: "none",
                        border: "none",
                        textAlign: "left",
                        fontSize: "0.85rem",
                        cursor: "pointer",
                        color: "#ef4444",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = "#fef2f2")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "none")
                      }
                    >
                      Remove block
                    </button>
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

const MODE_TILES: { modes: RelationMode[]; label: string; hint: string }[] = [
  { modes: ["E2O"], label: "Full E2O", hint: "Every E2O relationship" },
  { modes: ["O2O"], label: "Full O2O", hint: "Every O2O relationship" },
  { modes: ["O2E"], label: "Full O2E", hint: "Every O2E relationship" },
  { modes: ["E2E"], label: "Full E2E", hint: "Every E2E relationship" },
];

function MixedModeTilePicker({
  onAddFullComparison,
  onCreateBlock,
  isPending,
}: {
  onAddFullComparison: (modes: RelationMode[]) => void;
  onCreateBlock: () => void;
  isPending?: boolean;
}) {
  const tileStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: 4,
    width: 190,
    height: 92,
    padding: "12px 14px",
    borderRadius: 8,
    border: "1px solid #e5e7eb",
    background: "#fff",
    cursor: isPending ? "default" : "pointer",
    opacity: isPending ? 0.5 : 1,
    textAlign: "left",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 16,
      }}
    >
      <span style={{ fontSize: "0.95rem", color: "#6b7280" }}>
        Start a mixed comparison
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 190px)", gap: 12 }}>
        {MODE_TILES.map(({ modes, label, hint }) => (
          <button
            key={label}
            className="mixed-tile"
            style={tileStyle}
            disabled={isPending}
            onClick={() => onAddFullComparison(modes)}
          >
            <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{label}</span>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>{hint}</span>
          </button>
        ))}
        <button
          className="mixed-tile"
          style={tileStyle}
          disabled={isPending}
          onClick={() => onAddFullComparison(["E2O", "O2O", "O2E", "E2E"])}
        >
          <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Full comparison</span>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
            Every relationship, all modes
          </span>
        </button>
        <button
          className="mixed-tile"
          style={{ ...tileStyle, background: "#f9fafb" }}
          disabled={isPending}
          onClick={onCreateBlock}
        >
          <span
            style={{ fontWeight: 600, fontSize: "0.9rem", display: "flex", alignItems: "center", gap: 4 }}
          >
            <PlusIcon /> Custom comparison
          </span>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
            Pick a relation and group key
          </span>
        </button>
      </div>
      {isPending && (
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>Loading…</span>
      )}
    </div>
  );
}

export function GraphView({
  comparison,
  runId,
  drilldownResults,
  drilldownPendingEventType,
  onDrilldown,
  isMixedMode,
  mixedBlocks,
  onAddBlock,
  onAddFullComparison,
  isAddingFullComparison,
  onClearBlocks,
  onRemoveBlock,
  onImportClick,
}: GraphViewProps) {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("elk-hierarchical");

  const { nodes, edges } = useMemo(() => {
    if (isMixedMode && mixedBlocks) {
      return buildGraph(comparison, mixedBlocks);
    }
    if (comparison) {
      return buildGraph(comparison, undefined);
    }
    return { nodes: [], edges: [] };
  }, [comparison, mixedBlocks, isMixedMode]);

  // Remount FlowCanvas when comparison changes (homogeneous) or when
  // Mixed blocks are added/removed (so layout re-runs for new nodes).
  const flowKey = isMixedMode
    ? `mixed-${mixedBlocks?.length ?? 0}-${runId}`
    : comparison
      ? runId
      : "empty";

  const hasMixedBlocks = isMixedMode && (mixedBlocks?.length ?? 0) > 0;
  const showCanvas = comparison !== null || hasMixedBlocks;

  if (!showCanvas) {
    if (isMixedMode && onAddBlock && onAddFullComparison) {
      return (
        <MixedModeTilePicker
          onAddFullComparison={onAddFullComparison}
          onCreateBlock={onAddBlock}
          isPending={isAddingFullComparison}
        />
      );
    }
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: "0.5rem",
          color: "#9ca3af",
          fontSize: "1rem",
        }}
      >
        <div>Load both logs and run a comparison to see the graph.</div>
        {onImportClick && (
          <>
            <div>or</div>
            <Link asChild underline="hover">
              <button
                type="button"
                onClick={onImportClick}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  cursor: "pointer",
                }}
              >
                import a result
              </button>
            </Link>
          </>
        )}
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <FlowCanvas
        key={flowKey}
        initialNodes={nodes}
        initialEdges={edges}
        layoutMode={layoutMode}
        setLayoutMode={setLayoutMode}
        comparison={comparison}
        drilldownResults={drilldownResults}
        drilldownPendingEventType={drilldownPendingEventType}
        onDrilldown={onDrilldown}
        isMixedMode={isMixedMode}
        onAddBlock={onAddBlock}
        onClearBlocks={onClearBlocks}
        onRemoveBlock={onRemoveBlock}
      />
    </ReactFlowProvider>
  );
}
