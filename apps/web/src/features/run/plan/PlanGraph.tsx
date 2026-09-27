import { selectDagGraph, type DagView, type Task, type TaskBoardView, type TaskCard } from "@analytax/contracts";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "../../../components/ui/Button";
import { IconFit, IconZoomIn, IconZoomOut } from "../../../components/ui/icons";
import { Tooltip } from "../../../components/ui/Overlay";
import { OriginMark, StatusIcon } from "../../../components/ui/Status";
import { cx } from "../../../lib/cx";
import { EDGE_STATE_TONE, TIER_LABEL, type Tone } from "../../../lib/status";
import { useTheme } from "../../../lib/theme";
import type { RunStatus } from "../../../view-models/run-status";
import { CHANGE_LABEL, type ChangeKind } from "../../../view-models/plan";
import { cardTone, isSuperseded } from "../../../view-models/tasks";

const NODE_WIDTH = 256;
const NODE_HEIGHT = 84;

const elk = new ELK();

const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.spacing.nodeNode": "28",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.separateConnectedComponents": "true",
  "elk.spacing.componentComponent": "40",
};

type TaskNodeData = {
  card: TaskCard;
  tone: Tone;
  agentName: string;
  muted: boolean;
  selected: boolean;
  change: ChangeKind | null;
};

type TaskFlowNode = Node<TaskNodeData, "task">;

const prefersReducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const TaskNode = memo(function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { card, tone, agentName, muted, selected, change } = data;
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div
        className={cx(
          "flex h-full w-full flex-col justify-between rounded-lg border bg-surface px-3 py-2.5 text-left transition-shadow duration-150",
          muted ? "border-dashed border-line-strong" : "border-line-strong",
          selected ? "shadow-[0_0_0_2px_var(--ax-fg)]" : "hover:shadow-[0_0_0_1px_var(--ax-line-strong)]",
          change && !selected && "shadow-[0_0_0_2px_color-mix(in_oklab,var(--ax-fg)_35%,transparent)]",
        )}
      >
        <div className="flex items-start gap-2">
          <p className={cx("line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium", muted ? "text-fg-3 line-through decoration-fg-3" : "text-fg")} title={card.title}>
            {card.title}
          </p>
          {change ? (
            <span className="shrink-0 rounded-full bg-sunken px-1.5 text-[11px] leading-5 font-medium text-fg-2">{CHANGE_LABEL[change]}</span>
          ) : (
            <OriginMark origin={card.originKind} size={13} />
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-2">
          <StatusIcon tone={tone} size={13} />
          <span className="shrink-0 font-medium">{tone.label}</span>
          <span className="min-w-0 truncate text-fg-3">
            {agentName}
            {card.tier ? `, ${TIER_LABEL[card.tier]}` : ""}
            {card.attempt > 1 ? `, attempt ${card.attempt}` : ""}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
});

const NODE_TYPES = { task: TaskNode };

/**
 * Fits when the layout changes (animated) and when the pane is resized or shown again (instant). A hidden tab measures
 * 0x0, so fitting waits until the pane has a size.
 */
function FitOnLayout({ layoutKey }: { layoutKey: string | null }) {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const fitted = useRef<{ layout: string; size: string } | null>(null);
  useEffect(() => {
    if (!layoutKey || width === 0 || height === 0) return;
    const size = `${Math.round(width)}x${Math.round(height)}`;
    const previous = fitted.current;
    if (previous?.layout === layoutKey && previous.size === size) return;
    const handle = requestAnimationFrame(() => {
      fitted.current = { layout: layoutKey, size };
      const animate = previous?.layout !== layoutKey && !prefersReducedMotion();
      void fitView({ padding: 0.16, maxZoom: 1, duration: animate ? 220 : 0 });
    });
    return () => cancelAnimationFrame(handle);
  }, [layoutKey, width, height, fitView]);
  return null;
}

function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const instant = prefersReducedMotion() ? 0 : 160;
  return (
    <Panel position="bottom-left" className="!m-3 flex gap-0.5 rounded-md border border-line bg-raised p-0.5 shadow-overlay">
      <Tooltip content="Zoom in">
        <IconButton size="sm" label="Zoom in" icon={<IconZoomIn size={15} aria-hidden="true" />} onClick={() => void zoomIn({ duration: instant })} />
      </Tooltip>
      <Tooltip content="Zoom out">
        <IconButton size="sm" label="Zoom out" icon={<IconZoomOut size={15} aria-hidden="true" />} onClick={() => void zoomOut({ duration: instant })} />
      </Tooltip>
      <Tooltip content="Fit to screen">
        <IconButton size="sm" label="Fit to screen" icon={<IconFit size={15} aria-hidden="true" />} onClick={() => void fitView({ padding: 0.16, maxZoom: 1, duration: instant })} />
      </Tooltip>
    </Panel>
  );
}

export type PlanGraphProps = {
  board: TaskBoardView;
  dag: DagView;
  tasks: Record<string, Task> | undefined;
  run: RunStatus;
  changes: ReadonlyMap<string, ChangeKind>;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  agentName: (agentId: string) => string;
};

function PlanGraphInner({ board, dag, tasks, run, changes, selectedTaskId, onSelectTask, agentName }: PlanGraphProps) {
  const { resolved } = useTheme();
  const graph = useMemo(() => selectDagGraph(board, dag), [board, dag]);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const structureKey = useMemo(() => `${graph.nodes.map((node) => node.id).join(",")}|${graph.edges.map((edge) => edge.id).join(",")}`, [graph]);
  const [layout, setLayout] = useState<{ key: string; positions: ReadonlyMap<string, { x: number; y: number }> } | null>(null);

  // Re-layout only when the structure changes, not on every status update.
  useEffect(() => {
    const { nodes, edges } = graphRef.current;
    if (nodes.length === 0) {
      setLayout(null);
      return;
    }
    let cancelled = false;
    const ids = new Set(nodes.map((node) => node.id));
    elk
      .layout({
        id: "plan",
        layoutOptions: LAYOUT_OPTIONS,
        children: nodes.map((node) => ({ id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
        edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
      })
      .then((result) => {
        if (cancelled) return;
        const positions = new Map<string, { x: number; y: number }>();
        for (const child of result.children ?? []) positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
        setLayout({ key: structureKey, positions });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("[analytax] ELK layout failed; falling back to a grid", error);
        const positions = new Map(nodes.map((node, index) => [node.id, { x: (index % 4) * (NODE_WIDTH + 64), y: Math.floor(index / 4) * (NODE_HEIGHT + 40) }]));
        setLayout({ key: structureKey, positions });
      });
    return () => {
      cancelled = true;
    };
  }, [structureKey]);

  const nodes = useMemo<TaskFlowNode[]>(
    () =>
      graph.nodes.map((card, index) => {
        const task = tasks?.[card.id];
        const withTier = task?.currentTier && !card.tier ? { ...card, tier: task.currentTier } : card;
        const tone = cardTone(board, card, task, run);
        return {
          id: card.id,
          type: "task" as const,
          position: layout?.positions.get(card.id) ?? { x: index * (NODE_WIDTH + 80), y: 0 },
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          draggable: false,
          connectable: false,
          selectable: false,
          ariaLabel: `${card.title}: ${tone.label}`,
          data: {
            card: withTier,
            tone,
            agentName: agentName(card.agentId),
            muted: isSuperseded(card, task) || card.status === "canceled",
            selected: card.id === selectedTaskId,
            change: changes.get(card.id) ?? null,
          },
        };
      }),
    [graph.nodes, layout, tasks, board, run, agentName, selectedTaskId, changes],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const state = EDGE_STATE_TONE[edge.state];
        const highlighted = changes.get(edge.target) === "rewired" || changes.get(edge.target) === "added";
        const stroke = highlighted && edge.state !== "broken" ? "var(--ax-fg-2)" : state.stroke;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "smoothstep",
          animated: edge.state === "pending" && board.cards[edge.source]?.status === "working",
          focusable: false,
          selectable: false,
          style: { stroke, strokeWidth: highlighted ? 2 : 1.5, strokeDasharray: state.dash },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
          ariaLabel: `${board.cards[edge.source]?.title ?? edge.source} before ${board.cards[edge.target]?.title ?? edge.target}: ${state.label}`,
        };
      }),
    [graph.edges, changes, board.cards],
  );

  return (
    <ReactFlow<TaskFlowNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={(_, node) => onSelectTask(node.id)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      colorMode={resolved}
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: false }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <ZoomControls />
      <FitOnLayout layoutKey={layout?.key ?? null} />
    </ReactFlow>
  );
}

export function PlanGraph(props: PlanGraphProps) {
  return (
    <ReactFlowProvider>
      <PlanGraphInner {...props} />
    </ReactFlowProvider>
  );
}

