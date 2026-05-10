/**
 * AdvancedWorkflowCanvasEditor — v1a visual graph editor for P2P workflow drafts.
 *
 * Replaces the earlier list-based `AdvancedWorkflowDraftEditor` (folded back
 * into v1a per the 87fd4db8-ff5 R3 plan). This is a single editor surface;
 * there is NO toggle and no second list view to maintain.
 *
 * Design constraints:
 * - Pure preact + inline SVG, NO external graph libs (`react-flow`, `d3`,
 *   `cytoscape`, `dagre` not in `web/package.json`).
 * - Node positions are AUTHORING-ONLY metadata: stored in component state and
 *   never serialised into `P2pWorkflowDraft` (compile/bind don't need them).
 *   Positions auto-layout when missing (deterministic by node order so test
 *   snapshots stay stable).
 * - All edits round-trip through `validateP2pWorkflowDraft` so diagnostics
 *   render inline before Save (preserves the v1a contract that the editor
 *   mirrors validator output).
 * - `readOnly` mode disables all mutations (drag, edge-create, inspector
 *   inputs, delete) so future-schema drafts render safely.
 * - Edge creation by drag: pointer-down on a node's right anchor, drag to
 *   another node, pointer-up creates a new DEFAULT edge (user toggles to
 *   conditional + sets condition in inspector).
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  P2P_EDGE_CONDITION_KINDS,
  P2P_EDGE_KINDS,
  P2P_NODE_DISPATCH_STYLES,
  P2P_NODE_KINDS,
  P2P_PERMISSION_SCOPES,
  P2P_PRESET_DEFAULT_DISPATCH_STYLE,
  P2P_PRESET_DEFAULT_PERMISSION_SCOPE,
  P2P_PRESET_DEFAULT_PROMPT,
  P2P_PRESET_DEFAULT_SUMMARY_PROMPT,
  P2P_PRESET_KEYS,
  type P2pEdgeConditionKind,
  type P2pEdgeKind,
  type P2pNodeDispatchStyle,
  type P2pNodeKind,
  type P2pPermissionScope,
  type P2pPresetKey,
} from '@shared/p2p-workflow-constants.js';
import type {
  P2pWorkflowDraft,
  P2pWorkflowEdgeDraft,
  P2pWorkflowNodeDraft,
} from '@shared/p2p-workflow-types.js';
import { validateP2pWorkflowDraft } from '@shared/p2p-workflow-validators.js';

// ── Layout constants ────────────────────────────────────────────────────────
// Kept as module-level constants so unit tests can import + assert layout.
export const CANVAS_NODE_WIDTH = 168;
export const CANVAS_NODE_HEIGHT = 78;
export const CANVAS_GRID_X = 220;
export const CANVAS_GRID_Y = 120;
export const CANVAS_VIEW_WIDTH = 720;
export const CANVAS_VIEW_HEIGHT = 420;
export const CANVAS_NODES_PER_ROW = 3;

interface NodePosition {
  x: number;
  y: number;
}

export interface AdvancedWorkflowCanvasEditorProps {
  value: P2pWorkflowDraft;
  onChange: (next: P2pWorkflowDraft) => void;
  readOnly: boolean;
}

interface PointerDragState {
  kind: 'node' | 'edge_create';
  nodeId: string;
  // For 'node' drag: pointer offset from node origin so cursor stays anchored.
  offsetX?: number;
  offsetY?: number;
  // For 'edge_create': current pointer position in canvas coords.
  cursorX?: number;
  cursorY?: number;
}

/**
 * Sequential, deterministic local id within editor scope. Mirrors the helper
 * the previous list editor exposed so existing draft fixtures keep producing
 * the same `node_1` / `edge_1` collisions.
 */
export function nextLocalId(prefix: string, existing: ReadonlySet<string>): string {
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${prefix}_${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${prefix}_${existing.size + 1}`;
}

/**
 * Deterministic auto-layout — places nodes on a grid in declaration order so
 * tests can assert position math without snapshotting RNG.
 */
export function autoLayoutPositions(nodes: ReadonlyArray<{ id: string }>): Record<string, NodePosition> {
  const positions: Record<string, NodePosition> = {};
  nodes.forEach((node, index) => {
    const col = index % CANVAS_NODES_PER_ROW;
    const row = Math.floor(index / CANVAS_NODES_PER_ROW);
    positions[node.id] = {
      x: 30 + col * CANVAS_GRID_X,
      y: 30 + row * CANVAS_GRID_Y,
    };
  });
  return positions;
}

// ── Inline styles (consistent with surrounding panel theme) ─────────────────
const cardStyle = {
  marginTop: 12,
  background: '#0b1220',
  border: '1px solid #334155',
  borderRadius: 8,
  padding: 10,
  display: 'grid',
  gap: 10,
} as const;
const headerRowStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
} as const;
const sectionLabelStyle = { fontSize: 12, color: '#94a3b8', fontWeight: 600 } as const;
const btnStyle = {
  padding: '4px 10px', borderRadius: 5, border: '1px solid #475569', background: '#1e293b',
  color: '#cbd5e1', fontSize: 11, cursor: 'pointer',
} as const;
const inputStyle = {
  width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 5,
  color: '#e2e8f0', fontSize: 12, padding: '5px 7px', outline: 'none',
  fontFamily: 'inherit',
} as const;
const labelStyle = { fontSize: 11, color: '#94a3b8', display: 'grid', gap: 3 } as const;
const inspectorCardStyle = {
  background: '#0f172a', border: '1px solid #334155', borderRadius: 6, padding: 8, display: 'grid', gap: 6,
} as const;

export function AdvancedWorkflowCanvasEditor({ value, onChange, readOnly }: AdvancedWorkflowCanvasEditorProps) {
  const { t } = useTranslation();
  const diagnostics = useMemo(() => validateP2pWorkflowDraft(value).diagnostics, [value]);
  const nodeIds = useMemo(() => new Set(value.nodes.map((node) => node.id)), [value.nodes]);
  const edgeIds = useMemo(() => new Set(value.edges.map((edge) => edge.id)), [value.edges]);
  const nodesById = useMemo(() => {
    const map = new Map<string, P2pWorkflowNodeDraft>();
    for (const node of value.nodes) map.set(node.id, node);
    return map;
  }, [value.nodes]);

  // Position state — visual-only, NEVER serialised into the draft. Initialised
  // via deterministic auto-layout; backfilled when nodes are added.
  const [positions, setPositions] = useState<Record<string, NodePosition>>(() => autoLayoutPositions(value.nodes));
  useEffect(() => {
    setPositions((prev) => {
      let mutated = false;
      const next = { ...prev };
      const layout = autoLayoutPositions(value.nodes);
      for (const node of value.nodes) {
        if (!next[node.id]) { next[node.id] = layout[node.id]; mutated = true; }
      }
      // Drop stale positions for removed nodes so the map doesn't grow.
      for (const id of Object.keys(next)) {
        if (!nodeIds.has(id)) { delete next[id]; mutated = true; }
      }
      return mutated ? next : prev;
    });
  }, [value.nodes, nodeIds]);

  const [selection, setSelection] = useState<
    | { kind: 'node'; id: string }
    | { kind: 'edge'; id: string }
    | null
  >(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<PointerDragState | null>(null);
  // Force re-render during drag without storing transient state in React.
  const [, forceTick] = useState(0);

  // Drop selection if the selected entity disappears (e.g., user removes node).
  useEffect(() => {
    if (!selection) return;
    if (selection.kind === 'node' && !nodeIds.has(selection.id)) setSelection(null);
    if (selection.kind === 'edge' && !edgeIds.has(selection.id)) setSelection(null);
  }, [selection, nodeIds, edgeIds]);

  const screenToCanvas = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: clientX, y: clientY };
    const rect = svg.getBoundingClientRect();
    const scaleX = CANVAS_VIEW_WIDTH / rect.width;
    const scaleY = CANVAS_VIEW_HEIGHT / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  // ── Mutators ──────────────────────────────────────────────────────────────
  const updateNode = (id: string, fn: (n: P2pWorkflowNodeDraft) => P2pWorkflowNodeDraft) => {
    if (readOnly) return;
    onChange({ ...value, nodes: value.nodes.map((node) => (node.id === id ? fn(node) : node)) });
  };
  const updateEdge = (id: string, fn: (e: P2pWorkflowEdgeDraft) => P2pWorkflowEdgeDraft) => {
    if (readOnly) return;
    onChange({ ...value, edges: value.edges.map((edge) => (edge.id === id ? fn(edge) : edge)) });
  };
  const addNode = () => {
    if (readOnly) return;
    const id = nextLocalId('node', nodeIds);
    onChange({
      ...value,
      nodes: [
        ...value.nodes,
        { id, title: id, nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' },
      ],
    });
    setSelection({ kind: 'node', id });
  };
  const removeNode = (id: string) => {
    if (readOnly) return;
    onChange({
      ...value,
      nodes: value.nodes.filter((node) => node.id !== id),
      edges: value.edges.filter((edge) => edge.fromNodeId !== id && edge.toNodeId !== id),
    });
    if (selection?.kind === 'node' && selection.id === id) setSelection(null);
  };
  const removeEdge = (id: string) => {
    if (readOnly) return;
    onChange({ ...value, edges: value.edges.filter((edge) => edge.id !== id) });
    if (selection?.kind === 'edge' && selection.id === id) setSelection(null);
  };
  const setEdgeKind = (id: string, edgeKind: P2pEdgeKind) => {
    updateEdge(id, (edge) => {
      if (edgeKind === 'default') {
        const { condition: _drop, ...rest } = edge;
        void _drop;
        return { ...rest, edgeKind };
      }
      return { ...edge, edgeKind, condition: edge.condition ?? { kind: 'routing_key_equals', equals: '' } };
    });
  };
  const createEdgeBetween = (fromId: string, toId: string): string | null => {
    if (readOnly) return null;
    if (!nodeIds.has(fromId) || !nodeIds.has(toId)) return null;
    const id = nextLocalId('edge', edgeIds);
    onChange({
      ...value,
      edges: [...value.edges, { id, fromNodeId: fromId, toNodeId: toId, edgeKind: 'default' }],
    });
    return id;
  };

  // ── Pointer handlers ──────────────────────────────────────────────────────
  const onSvgPointerMove = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = screenToCanvas(event.clientX, event.clientY);
    if (drag.kind === 'node') {
      const offX = drag.offsetX ?? 0;
      const offY = drag.offsetY ?? 0;
      setPositions((prev) => ({
        ...prev,
        [drag.nodeId]: {
          x: Math.max(0, Math.min(CANVAS_VIEW_WIDTH - CANVAS_NODE_WIDTH, point.x - offX)),
          y: Math.max(0, Math.min(CANVAS_VIEW_HEIGHT - CANVAS_NODE_HEIGHT, point.y - offY)),
        },
      }));
    } else if (drag.kind === 'edge_create') {
      drag.cursorX = point.x;
      drag.cursorY = point.y;
      forceTick((tick) => tick + 1);
    }
  };
  const onSvgPointerUp = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === 'edge_create') {
      // Hit-test against node bounding boxes to find the drop target.
      const point = screenToCanvas(event.clientX, event.clientY);
      const target = value.nodes.find((node) => {
        const pos = positions[node.id];
        if (!pos) return false;
        return point.x >= pos.x && point.x <= pos.x + CANVAS_NODE_WIDTH
          && point.y >= pos.y && point.y <= pos.y + CANVAS_NODE_HEIGHT;
      });
      if (target && target.id !== drag.nodeId) {
        const newEdgeId = createEdgeBetween(drag.nodeId, target.id);
        if (newEdgeId) setSelection({ kind: 'edge', id: newEdgeId });
      }
    }
    dragRef.current = null;
    forceTick((tick) => tick + 1);
  };

  const beginNodeDrag = (event: PointerEvent, nodeId: string) => {
    if (readOnly) return;
    event.stopPropagation();
    const point = screenToCanvas(event.clientX, event.clientY);
    const pos = positions[nodeId] ?? { x: 0, y: 0 };
    dragRef.current = {
      kind: 'node',
      nodeId,
      offsetX: point.x - pos.x,
      offsetY: point.y - pos.y,
    };
    setSelection({ kind: 'node', id: nodeId });
    (event.currentTarget as Element)?.setPointerCapture?.(event.pointerId);
  };
  const beginEdgeCreate = (event: PointerEvent, nodeId: string) => {
    if (readOnly) return;
    event.stopPropagation();
    const point = screenToCanvas(event.clientX, event.clientY);
    dragRef.current = {
      kind: 'edge_create',
      nodeId,
      cursorX: point.x,
      cursorY: point.y,
    };
    (event.currentTarget as Element)?.setPointerCapture?.(event.pointerId);
    forceTick((tick) => tick + 1);
  };

  const select = <T extends string>(
    ariaLabel: string, current: T, options: readonly T[],
    onSelect: (next: T) => void,
  ) => (
    <select
      value={current}
      disabled={readOnly}
      onInput={(event) => onSelect((event.target as HTMLSelectElement).value as T)}
      style={inputStyle}
      aria-label={ariaLabel}
    >
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  const dragState = dragRef.current;

  const inspectorBody = (() => {
    if (!selection) {
      return (
        <div
          style={{ ...inspectorCardStyle, color: '#64748b', fontSize: 12 }}
          data-testid="p2p-editor-inspector-empty"
        >
          {t('p2p.workflow.editor.inspector_empty', 'Select a node or edge to edit its properties.')}
        </div>
      );
    }
    if (selection.kind === 'node') {
      const node = nodesById.get(selection.id);
      if (!node) return null;
      return (
        <div
          style={inspectorCardStyle}
          data-testid={`p2p-editor-node-${node.id}`}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={sectionLabelStyle}>{t('p2p.workflow.editor.node.section_label', 'Node')}</div>
            {!readOnly && (
              <button
                type="button" style={btnStyle} onClick={() => removeNode(node.id)}
                data-testid={`p2p-editor-remove-node-${node.id}`}
                aria-label={t('p2p.workflow.editor.remove_node', 'Remove node')}
              >×</button>
            )}
          </div>
          <input
            type="text" value={node.title ?? ''} disabled={readOnly}
            onInput={(event) => updateNode(node.id, (current) => ({ ...current, title: (event.target as HTMLInputElement).value }))}
            style={{ ...inputStyle, fontWeight: 600 }}
            aria-label={`node-${node.id}-title`}
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
            <label style={labelStyle}>
              <span>{t('p2p.workflow.editor.node.preset_label', 'Preset')}</span>
              {select(`node-${node.id}-preset`, node.preset, P2P_PRESET_KEYS,
                (preset) => updateNode(node.id, (current) => {
                  /*
                   * R3 v2 PR-λ — Auto-align permissionScope + dispatchStyle to
                   * the picked preset. Without this, picking `implementation`
                   * left `permissionScope='analysis_only'` and the validator
                   * rejected the workflow with a cryptic
                   * `invalid_workflow_graph (nodes[N])` error.
                   *
                   * We only overwrite scope/dispatchStyle when they are still
                   * at the OLD preset's defaults — if the user has manually
                   * customised either, we preserve their choice. This keeps
                   * power-users in control while saving brand-new users from
                   * tripping over the validator.
                   */
                  const next = preset as P2pPresetKey;
                  const previousPresetDefaultScope = P2P_PRESET_DEFAULT_PERMISSION_SCOPE[current.preset];
                  const previousPresetDefaultDispatch = P2P_PRESET_DEFAULT_DISPATCH_STYLE[current.preset];
                  const scopeIsDefault = (current.permissionScope ?? 'analysis_only') === previousPresetDefaultScope;
                  const dispatchIsDefault = (current.dispatchStyle ?? previousPresetDefaultDispatch) === previousPresetDefaultDispatch;
                  return {
                    ...current,
                    preset: next,
                    permissionScope: scopeIsDefault ? P2P_PRESET_DEFAULT_PERMISSION_SCOPE[next] : current.permissionScope,
                    dispatchStyle: dispatchIsDefault ? P2P_PRESET_DEFAULT_DISPATCH_STYLE[next] : current.dispatchStyle,
                  };
                }))}
            </label>
            <label style={labelStyle}>
              <span>nodeKind</span>
              {select(`node-${node.id}-kind`, node.nodeKind, P2P_NODE_KINDS,
                (kind) => updateNode(node.id, (current) => ({ ...current, nodeKind: kind as P2pNodeKind })))}
            </label>
            <label style={labelStyle}>
              <span>{t('p2p.workflow.editor.node.permission_scope_label', 'Permission scope')}</span>
              {select(`node-${node.id}-scope`, node.permissionScope ?? P2P_PRESET_DEFAULT_PERMISSION_SCOPE[node.preset], P2P_PERMISSION_SCOPES,
                (scope) => updateNode(node.id, (current) => ({ ...current, permissionScope: scope as P2pPermissionScope })))}
            </label>
            <label style={labelStyle}>
              {/*
               * R3 v2 PR-λ — User feedback: "我安排了单节点的node, 比如实施这种节点
               * 肯定是单节点node, 默认是发起节点(可以选其它的), 讨论那些是多节点讨论
               * node, 这里面完全没有做区分". The data model carries
               * `dispatchStyle` already; surface it in the inspector so users
               * can flip between single_main (one authoritative agent) and
               * multi_dispatch (fan-out to all participants).
               */}
              <span>{t('p2p.workflow.editor.node.dispatch_style_label', 'Dispatch style')}</span>
              {select(`node-${node.id}-dispatch-style`, node.dispatchStyle ?? P2P_PRESET_DEFAULT_DISPATCH_STYLE[node.preset], P2P_NODE_DISPATCH_STYLES,
                (style) => updateNode(node.id, (current) => ({ ...current, dispatchStyle: style as P2pNodeDispatchStyle })))}
            </label>
          </div>
          <textarea
            value={node.promptAppend ?? ''}
            disabled={readOnly}
            rows={3}
            placeholder={P2P_PRESET_DEFAULT_PROMPT[node.preset]}
            onInput={(event) => updateNode(node.id, (current) => ({ ...current, promptAppend: (event.target as HTMLTextAreaElement).value }))}
            style={{ ...inputStyle, resize: 'vertical' }}
            aria-label={`node-${node.id}-prompt-append`}
          />
          {/*
           * R3 v2 PR-μ — Per-node summary prompt override. Surfaces the
           * default per-preset summary prompt as the placeholder so users
           * see what the auto-summary will say. Leaving the field blank
           * means "use the default"; typing anything overrides it AND
           * forces a summary phase to run even on `single_main` nodes
           * (where previously `synthesisStyle='none'` skipped summary).
           */}
          <label style={{ ...labelStyle, marginTop: 4 }}>
            <span>{t('p2p.workflow.editor.node.summary_prompt_label', 'Round summary prompt (auto-runs after this node)')}</span>
            <textarea
              value={node.summaryPromptOverride ?? ''}
              disabled={readOnly}
              rows={4}
              placeholder={P2P_PRESET_DEFAULT_SUMMARY_PROMPT[node.preset]}
              onInput={(event) => updateNode(node.id, (current) => ({ ...current, summaryPromptOverride: (event.target as HTMLTextAreaElement).value }))}
              style={{ ...inputStyle, resize: 'vertical' }}
              aria-label={`node-${node.id}-summary-prompt`}
              data-testid={`p2p-editor-node-${node.id}-summary-prompt`}
            />
          </label>
        </div>
      );
    }
    const edge = value.edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    return (
      <div
        style={inspectorCardStyle}
        data-testid={`p2p-editor-edge-${edge.id}`}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={sectionLabelStyle}>{t('p2p.workflow.editor.edge.section_label', 'Edge')}</div>
          {!readOnly && (
            <button
              type="button" style={btnStyle} onClick={() => removeEdge(edge.id)}
              data-testid={`p2p-editor-remove-edge-${edge.id}`}
              aria-label={t('p2p.workflow.editor.remove_edge', 'Remove edge')}
            >×</button>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
          <label style={labelStyle}>
            <span>{t('p2p.workflow.editor.edge.from_label', 'From')}</span>
            {select(`edge-${edge.id}-from`, edge.fromNodeId, value.nodes.map((node) => node.id),
              (from) => updateEdge(edge.id, (current) => ({ ...current, fromNodeId: from })))}
          </label>
          <label style={labelStyle}>
            <span>{t('p2p.workflow.editor.edge.to_label', 'To')}</span>
            {select(`edge-${edge.id}-to`, edge.toNodeId, value.nodes.map((node) => node.id),
              (to) => updateEdge(edge.id, (current) => ({ ...current, toNodeId: to })))}
          </label>
          <label style={labelStyle}>
            <span>edgeKind</span>
            {select(`edge-${edge.id}-kind`, edge.edgeKind, P2P_EDGE_KINDS,
              (kind) => setEdgeKind(edge.id, kind as P2pEdgeKind))}
          </label>
        </div>
        {edge.edgeKind === 'conditional' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 200px) minmax(0, 1fr)', gap: 6 }}>
            {select(`edge-${edge.id}-condition-kind`, edge.condition?.kind ?? 'routing_key_equals', P2P_EDGE_CONDITION_KINDS,
              (kind) => updateEdge(edge.id, (current) => ({
                ...current,
                condition: { kind: kind as P2pEdgeConditionKind, equals: current.condition?.equals ?? '' },
              })))}
            <input
              type="text" value={edge.condition?.equals ?? ''} disabled={readOnly}
              placeholder={t('p2p.workflow.editor.edge.condition_label', 'Condition value')}
              onInput={(event) => updateEdge(edge.id, (current) => ({
                ...current,
                condition: {
                  kind: current.condition?.kind ?? 'routing_key_equals',
                  equals: (event.target as HTMLInputElement).value,
                },
              }))}
              style={inputStyle}
              aria-label={`edge-${edge.id}-condition-equals`}
            />
          </div>
        )}
      </div>
    );
  })();

  return (
    <div
      style={cardStyle}
      data-testid="p2p-advanced-workflow-editor"
      data-readonly={readOnly ? 'true' : 'false'}
      data-editor-variant="canvas"
    >
      <div style={headerRowStyle}>
        <div style={sectionLabelStyle}>
          {t('p2p.workflow.editor.title', 'Advanced workflow draft')}
        </div>
        {!readOnly && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={btnStyle} onClick={addNode} data-testid="p2p-editor-add-node">
              {t('p2p.workflow.editor.add_node', 'Add node')}
            </button>
          </div>
        )}
      </div>

      {readOnly && (
        <div
          style={{ fontSize: 12, color: '#fcd34d', lineHeight: 1.4 }}
          data-testid="p2p-editor-readonly-notice"
        >
          {t('p2p.workflow.editor.read_only_notice', 'This workflow uses a future schema and is read-only here.')}
        </div>
      )}

      <div style={{ fontSize: 11, color: '#64748b' }} data-testid="p2p-editor-canvas-hint">
        {t('p2p.workflow.editor.canvas_hint', 'Drag nodes to position. Drag from the right anchor (●) to another node to create an edge.')}
      </div>

      <svg
        ref={(element) => { svgRef.current = element ?? null; }}
        viewBox={`0 0 ${CANVAS_VIEW_WIDTH} ${CANVAS_VIEW_HEIGHT}`}
        width="100%"
        style={{
          display: 'block', background: '#070d1a', border: '1px solid #1e293b',
          borderRadius: 6, touchAction: 'none', userSelect: 'none',
          minHeight: 320,
        }}
        data-testid="p2p-editor-canvas"
        data-canvas-width={CANVAS_VIEW_WIDTH}
        data-canvas-height={CANVAS_VIEW_HEIGHT}
        onPointerMove={onSvgPointerMove as unknown as (event: Event) => void}
        onPointerUp={onSvgPointerUp as unknown as (event: Event) => void}
        onPointerLeave={onSvgPointerUp as unknown as (event: Event) => void}
        onClick={(event) => {
          if ((event.target as Element).tagName === 'svg') setSelection(null);
        }}
      >
        <defs>
          <marker
            id="p2p-edge-arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
          </marker>
          <marker
            id="p2p-edge-arrow-conditional" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
          </marker>
          <marker
            id="p2p-edge-arrow-selected" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8" />
          </marker>
        </defs>

        {/* Edges first so nodes overlay them */}
        {value.edges.map((edge) => {
          const from = positions[edge.fromNodeId];
          const to = positions[edge.toNodeId];
          if (!from || !to) return null;
          const startX = from.x + CANVAS_NODE_WIDTH;
          const startY = from.y + CANVAS_NODE_HEIGHT / 2;
          const endX = to.x;
          const endY = to.y + CANVAS_NODE_HEIGHT / 2;
          // Cubic bezier so curves don't overlap; control points pulled toward
          // horizontal midpoint to give a left→right flow look.
          const controlOffset = Math.max(40, Math.abs(endX - startX) / 2);
          const path = `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`;
          const isSelected = selection?.kind === 'edge' && selection.id === edge.id;
          const stroke = isSelected ? '#38bdf8' : edge.edgeKind === 'conditional' ? '#f59e0b' : '#64748b';
          const markerId = isSelected
            ? 'url(#p2p-edge-arrow-selected)'
            : edge.edgeKind === 'conditional'
              ? 'url(#p2p-edge-arrow-conditional)'
              : 'url(#p2p-edge-arrow)';
          return (
            <g
              key={edge.id}
              data-testid={`p2p-editor-edge-shape-${edge.id}`}
              data-edge-kind={edge.edgeKind}
              onClick={(event) => { event.stopPropagation(); setSelection({ kind: 'edge', id: edge.id }); }}
              style={{ cursor: 'pointer' }}
            >
              <path
                d={path} fill="none" stroke={stroke}
                strokeWidth={isSelected ? 3 : 2}
                markerEnd={markerId}
              />
              {edge.edgeKind === 'conditional' && edge.condition && (
                <text
                  x={(startX + endX) / 2} y={(startY + endY) / 2 - 6}
                  textAnchor="middle" fill="#fbbf24" fontSize="10"
                  pointerEvents="none"
                >
                  {edge.condition.kind}={edge.condition.equals || '?'}
                </text>
              )}
            </g>
          );
        })}

        {/* In-progress edge being created */}
        {dragState?.kind === 'edge_create' && positions[dragState.nodeId] && (
          <path
            data-testid="p2p-editor-edge-preview"
            d={(() => {
              const pos = positions[dragState.nodeId];
              const startX = pos.x + CANVAS_NODE_WIDTH;
              const startY = pos.y + CANVAS_NODE_HEIGHT / 2;
              const endX = dragState.cursorX ?? startX;
              const endY = dragState.cursorY ?? startY;
              return `M ${startX} ${startY} L ${endX} ${endY}`;
            })()}
            fill="none" stroke="#38bdf8" strokeWidth={2} strokeDasharray="4 3"
            pointerEvents="none"
          />
        )}

        {value.nodes.map((node) => {
          const pos = positions[node.id] ?? { x: 0, y: 0 };
          const isSelected = selection?.kind === 'node' && selection.id === node.id;
          const fill = node.nodeKind === 'script'
            ? '#1e3a5f'
            : node.nodeKind === 'logic'
              ? '#3b2a55'
              : '#0f172a';
          return (
            <g
              key={node.id}
              transform={`translate(${pos.x} ${pos.y})`}
              data-testid={`p2p-editor-node-shape-${node.id}`}
              data-node-kind={node.nodeKind}
              data-node-x={Math.round(pos.x)}
              data-node-y={Math.round(pos.y)}
              onClick={(event) => { event.stopPropagation(); setSelection({ kind: 'node', id: node.id }); }}
              style={{ cursor: readOnly ? 'default' : 'grab' }}
            >
              <rect
                width={CANVAS_NODE_WIDTH} height={CANVAS_NODE_HEIGHT}
                rx={8} ry={8}
                fill={fill}
                stroke={isSelected ? '#38bdf8' : '#334155'}
                strokeWidth={isSelected ? 2.5 : 1.2}
                onPointerDown={(event) => beginNodeDrag(event as unknown as PointerEvent, node.id)}
              />
              <text
                x={10} y={22} fill="#e2e8f0" fontSize="13" fontWeight="600"
                pointerEvents="none"
              >
                {(node.title ?? node.id).slice(0, 22)}
              </text>
              <text
                x={10} y={40} fill="#94a3b8" fontSize="10"
                pointerEvents="none"
              >
                {node.nodeKind} · {node.preset}
              </text>
              <text
                x={10} y={56} fill="#64748b" fontSize="10"
                pointerEvents="none"
              >
                {node.permissionScope ?? 'analysis_only'}
              </text>
              {/* Right anchor: drag origin for new edges */}
              {!readOnly && (
                <circle
                  cx={CANVAS_NODE_WIDTH} cy={CANVAS_NODE_HEIGHT / 2} r={6}
                  fill="#38bdf8" stroke="#0f172a" strokeWidth={1.5}
                  data-testid={`p2p-editor-node-anchor-${node.id}`}
                  onPointerDown={(event) => beginEdgeCreate(event as unknown as PointerEvent, node.id)}
                  style={{ cursor: 'crosshair' }}
                />
              )}
            </g>
          );
        })}
      </svg>

      {inspectorBody}

      {diagnostics.length > 0 && (
        <div data-testid="p2p-editor-diagnostics">
          <div style={{ ...sectionLabelStyle, marginBottom: 4 }}>
            {t('p2p.workflow.editor.diagnostics_header', 'Diagnostics')}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: '#fca5a5', display: 'grid', gap: 3 }}>
            {diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${index}`}>
                {t(diagnostic.messageKey, diagnostic.summary ?? diagnostic.code)}
                {diagnostic.fieldPath ? ` (${diagnostic.fieldPath})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
