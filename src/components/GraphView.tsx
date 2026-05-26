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

import { MagnifyingGlassIcon, RulerSquareIcon } from "@radix-ui/react-icons";
import { SegmentedControl } from "@radix-ui/themes";
import { applyElkHierarchicalLayout, applyElkLayout } from "../layout";
import { buildMermaidDiagram, buildMermaidSubgraph } from "../mermaid";
import { buildColorMap } from "../objectTypeColors";
import type {
  ComparisonOutput,
  DrilldownOutput,
  EventTypeNodeData,
  EventTypePresence,
  ObjectTypeNodeData,
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
  log1EventTypes: string[];
  log2EventTypes: string[];
  runId: number;
  drilldownResults: Record<string, DrilldownOutput>;
  drilldownPendingEventType: string | undefined;
  onDrilldown: (eventType: string) => void;
}

// Set to true to include event types that appear in only one of the two logs.
const SHOW_SINGLE_LOG_EVENT_TYPES = false;
// Set to true to include event types that were in both logs but not tested (no result).
const SHOW_NOT_TESTED_EVENT_TYPES = false;

function buildGraph(
  comparison: ComparisonOutput,
  log1EventTypes: string[],
  log2EventTypes: string[],
): { nodes: Node[]; edges: Edge[] } {
  const { results, onlyInLog1, onlyInLog2 } = comparison;

  const allObjectTypes = Object.values(results).flatMap((r) =>
    r.objectTypeRelations.map((rel) => rel.objectType),
  );
  const colorMap = buildColorMap(allObjectTypes);

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const allEventTypes = new Set([
    ...log1EventTypes,
    ...log2EventTypes,
    ...(SHOW_SINGLE_LOG_EVENT_TYPES ? onlyInLog1 : []),
    ...(SHOW_SINGLE_LOG_EVENT_TYPES ? onlyInLog2 : []),
  ]);

  for (const eventType of allEventTypes) {
    let presence: EventTypePresence;
    if (onlyInLog1.includes(eventType)) presence = "onlyInLog1";
    else if (onlyInLog2.includes(eventType)) presence = "onlyInLog2";
    else presence = "both";

    if (!SHOW_SINGLE_LOG_EVENT_TYPES && presence !== "both") continue;

    const result = results[eventType] ?? null;
    if (!SHOW_NOT_TESTED_EVENT_TYPES && presence === "both" && result === null)
      continue;
    const data: EventTypeNodeData = { eventType, presence, result };
    nodes.push({
      id: `evt-${eventType}`,
      type: "eventType",
      position: { x: 0, y: 0 },
      data,
    });

    if (result) {
      for (const rel of result.objectTypeRelations) {
        const objId = `obj-${eventType}|${rel.qualifier}|${rel.objectType}`;
        const data: ObjectTypeNodeData = {
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
          data,
        });
        edges.push({
          id: `e-${eventType}-${rel.qualifier}-${rel.objectType}`,
          source: `evt-${eventType}`,
          target: objId,
          label: rel.qualifier,
          type: "floating",
        });
      }
    }
  }

  return { nodes, edges };
}

type LayoutMode = "force" | "elk-hierarchical";

function FlowCanvas({
  initialNodes,
  initialEdges,
  layoutMode,
  setLayoutMode,
  comparison,
  log1EventTypes,
  log2EventTypes,
  drilldownResults,
  drilldownPendingEventType,
  onDrilldown,
}: {
  initialNodes: Node[];
  initialEdges: Edge[];
  layoutMode: LayoutMode;
  setLayoutMode: (m: LayoutMode) => void;
  comparison: ComparisonOutput;
  log1EventTypes: string[];
  log2EventTypes: string[];
  drilldownResults: Record<string, DrilldownOutput>;
  drilldownPendingEventType: string | undefined;
  onDrilldown: (eventType: string) => void;
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

  // Unidirectional: source → targets only (event nodes pull their object children)
  const childrenOf = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of initialEdges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      map.get(e.source)!.add(e.target);
    }
    return map;
  }, [initialEdges]);

  const animRef = useRef<number | null>(null);
  // Per-child data captured at drag start
  const dragParentPos = useRef<{ x: number; y: number } | null>(null);
  const dragParentSize = useRef<{ w: number; h: number }>({ w: 180, h: 60 });
  const childIds = useRef<Set<string>>(new Set());
  // original center-to-center distance from parent to each child
  const childDist = useRef<Map<string, number>>(new Map());
  // child node sizes for separation
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
        // Node id format: "obj-{eventType}|{qualifier}|{objectType}"
        const rest = n.id.slice("obj-".length);
        const sepIdx = rest.indexOf("|");
        const eventType = rest.slice(0, sepIdx);
        const [qualifier, objectType] = rest.slice(sepIdx + 1).split("|");
        const rel = drilldownResults[eventType]?.results.find(
          (r) => r.qualifier === qualifier && r.objectType === objectType,
        );
        return {
          ...n,
          data: {
            ...n.data,
            drilldownPValue: rel?.pValue,
            drilldownIsSignificant: rel?.isSignificant,
            isDrilldownPending: drilldownPendingEventType === eventType,
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
      // Pass 1: lerp each child toward its radial target
      // (parent center + current direction × original distance)
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

      // Pass 2: separate overlapping children from each other
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

  const exportSubgraph = useCallback(
    (eventNodeId: string, format: "svg" | "png") => {
      const eventType = eventNodeId.slice("evt-".length);
      const childPrefix = `obj-${eventType}|`;

      const allNodes = nodesRef.current;
      const subNodes = allNodes.filter(
        (n) => n.id === eventNodeId || n.id.startsWith(childPrefix),
      );
      const subEdgeIds = new Set(
        initialEdges.filter((e) => e.source === eventNodeId).map((e) => e.id),
      );

      const PADDING = 20;
      const ZOOM = 1.5;
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
        filter: (domNode: Node) => {
          const el = domNode as Element;
          if (!el.classList) return true;
          if (el.classList.contains("react-flow__minimap")) return false;
          if (el.classList.contains("react-flow__controls")) return false;
          if (el.classList.contains("react-flow__panel")) return false;
          if (el.classList.contains("react-flow__node"))
            return subNodes.some((n) => n.id === el.getAttribute("data-id"));
          if (el.classList.contains("react-flow__edge"))
            return subEdgeIds.has(el.getAttribute("data-id") ?? "");
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
              suggestedName: `${eventType}.${ext}`,
              types: [{ description, accept: { [mimeType]: [`.${ext}`] } }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
          } catch (err: unknown) {
            if ((err as { name?: string }).name !== "AbortError") {
              const objUrl = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.download = `${eventType}.${ext}`;
              a.href = objUrl;
              a.click();
              URL.revokeObjectURL(objUrl);
            }
          }
        } else {
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.download = `${eventType}.${ext}`;
          a.href = objUrl;
          a.click();
          URL.revokeObjectURL(objUrl);
        }
      });
      setContextMenu(null);
    },
    [initialEdges, getNodesBounds],
  );

  const exportMermaid = useCallback(
    async (format: "mmd" | "svg") => {
      const diagram = buildMermaidDiagram(
        comparison,
        log1EventTypes,
        log2EventTypes,
      );

      let blob: Blob;
      if (format === "mmd") {
        blob = new Blob([diagram], { type: "text/plain" });
      } else {
        const { svg } = await mermaid.render("mermaid-offscreen", diagram);
        blob = new Blob([svg.replace(/<br>/gi, "<br/>")], {
          type: "image/svg+xml",
        });
      }

      const ext = format === "mmd" ? "mmd" : "svg";
      const mimeType = format === "mmd" ? "text/plain" : "image/svg+xml";
      const description = format === "mmd" ? "Mermaid Diagram" : "SVG Image";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const picker = (window as any).showSaveFilePicker;
      if (picker) {
        try {
          const handle = await picker({
            suggestedName: `comparison.${ext}`,
            types: [{ description, accept: { [mimeType]: [`.${ext}`] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        } catch (err: unknown) {
          if ((err as { name?: string }).name !== "AbortError") {
            const objUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.download = `comparison.${ext}`;
            a.href = objUrl;
            a.click();
            URL.revokeObjectURL(objUrl);
          }
        }
      } else {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.download = `comparison.${ext}`;
        a.href = objUrl;
        a.click();
        URL.revokeObjectURL(objUrl);
      }
    },
    [comparison, log1EventTypes, log2EventTypes],
  );

  const exportMermaidSubgraph = useCallback(
    async (eventNodeId: string) => {
      const eventType = eventNodeId.slice("evt-".length);
      const result = comparison.results[eventType];
      if (!result) return;

      const allObjectTypes = Object.values(comparison.results).flatMap((r) =>
        r.objectTypeRelations.map((rel) => rel.objectType),
      );
      const colorMap = buildColorMap(allObjectTypes);
      const diagram = buildMermaidSubgraph(eventType, result, colorMap);

      const { svg } = await mermaid.render("mermaid-offscreen-sub", diagram);
      const blob = new Blob([svg.replace(/<br>/gi, "<br/>")], {
        type: "image/svg+xml",
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const picker = (window as any).showSaveFilePicker;
      if (picker) {
        try {
          const handle = await picker({
            suggestedName: `${eventType}.svg`,
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
            a.download = `${eventType}.svg`;
            a.href = objUrl;
            a.click();
            URL.revokeObjectURL(objUrl);
          }
        }
      } else {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.download = `${eventType}.svg`;
        a.href = objUrl;
        a.click();
        URL.revokeObjectURL(objUrl);
      }
    },
    [comparison],
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
            const eventType = contextMenu.nodeId.slice("evt-".length);
            const isSignificant = comparison.results[eventType]?.isSignificant;
            if (!isSignificant) return null;
            return (
              <>
                <button
                  onClick={() => {
                    onDrilldown(eventType);
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
                  style={{ height: 1, background: "#e5e7eb", margin: "2px 0" }}
                />
              </>
            );
          })()}
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
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              Export as {fmt.toUpperCase()}
            </button>
          ))}
          <div style={{ height: 1, background: "#e5e7eb", margin: "2px 0" }} />
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
            onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          >
            Export as SVG (Mermaid)
          </button>
        </div>
      )}
    </div>
  );
}

export function GraphView({
  comparison,
  log1EventTypes,
  log2EventTypes,
  runId,
  drilldownResults,
  drilldownPendingEventType,
  onDrilldown,
}: GraphViewProps) {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("elk-hierarchical");

  const { nodes, edges } = useMemo(
    () =>
      comparison
        ? buildGraph(comparison, log1EventTypes, log2EventTypes)
        : { nodes: [], edges: [] },
    [comparison, log1EventTypes, log2EventTypes],
  );

  const flowKey = comparison ? runId : "empty";

  if (!comparison) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#9ca3af",
          fontSize: "1rem",
        }}
      >
        Load both logs and run a comparison to see the graph.
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
        log1EventTypes={log1EventTypes}
        log2EventTypes={log2EventTypes}
        drilldownResults={drilldownResults}
        drilldownPendingEventType={drilldownPendingEventType}
        onDrilldown={onDrilldown}
      />
    </ReactFlowProvider>
  );
}
