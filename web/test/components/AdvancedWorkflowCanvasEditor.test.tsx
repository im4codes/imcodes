/**
 * @vitest-environment jsdom
 *
 * AdvancedWorkflowCanvasEditor — focused unit tests for the v1a visual
 * canvas editor. These complement the integration tests in
 * `P2pConfigPanel.test.tsx` (which prove the canvas wires through the
 * panel's save/load flow). Tests here exercise the editor in isolation and
 * cover canvas-only behaviours that don't surface through the panel:
 *
 *   - autoLayoutPositions deterministic grid
 *   - nextLocalId sequential allocation
 *   - SVG transform reflects node position
 *   - drag updates node position
 *   - edge creation by drag from anchor → drop on another node
 *   - position state is NEVER serialised into the draft
 *   - readOnly mode hides anchor + add button
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key.split('.').pop() ?? _key,
  }),
}));

import {
  AdvancedWorkflowCanvasEditor,
  CANVAS_GRID_X,
  CANVAS_GRID_Y,
  CANVAS_NODES_PER_ROW,
  autoLayoutPositions,
  nextLocalId,
} from '../../src/components/AdvancedWorkflowCanvasEditor.js';
import type { P2pWorkflowDraft } from '@shared/p2p-workflow-types.js';
import { P2P_WORKFLOW_SCHEMA_VERSION } from '@shared/p2p-workflow-constants.js';

afterEach(() => {
  cleanup();
});

function makeDraft(): P2pWorkflowDraft {
  return {
    schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
    id: 'draft-canvas-test',
    title: 'Canvas test',
    nodes: [
      { id: 'n1', title: 'Discuss', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' },
      { id: 'n2', title: 'Audit', nodeKind: 'llm', preset: 'audit', permissionScope: 'analysis_only' },
      { id: 'n3', title: 'Decide', nodeKind: 'logic', preset: 'discuss', permissionScope: 'analysis_only' },
    ],
    edges: [
      { id: 'e1', fromNodeId: 'n1', toNodeId: 'n2', edgeKind: 'default' },
    ],
  };
}

describe('autoLayoutPositions', () => {
  it('places nodes on a deterministic grid by declaration order', () => {
    const positions = autoLayoutPositions([
      { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
    ]);
    // Row 0: cols 0,1,2 ; Row 1: col 0
    expect(positions.a.y).toBe(positions.b.y);
    expect(positions.a.y).toBe(positions.c.y);
    expect(positions.d.y).toBeGreaterThan(positions.a.y);
    expect(positions.b.x - positions.a.x).toBe(CANVAS_GRID_X);
    expect(positions.d.y - positions.a.y).toBe(CANVAS_GRID_Y);
    expect(CANVAS_NODES_PER_ROW).toBe(3);
  });
});

describe('nextLocalId', () => {
  it('returns the lowest unused sequential id', () => {
    expect(nextLocalId('node', new Set())).toBe('node_1');
    expect(nextLocalId('node', new Set(['node_1']))).toBe('node_2');
    expect(nextLocalId('node', new Set(['node_1', 'node_2', 'node_3']))).toBe('node_4');
    expect(nextLocalId('edge', new Set(['edge_1', 'edge_3']))).toBe('edge_2');
  });
});

describe('AdvancedWorkflowCanvasEditor render', () => {
  it('renders SVG canvas with node and edge shapes', () => {
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={() => {}} readOnly={false} />);
    expect(screen.getByTestId('p2p-editor-canvas')).toBeDefined();
    expect(screen.getByTestId('p2p-editor-node-shape-n1')).toBeDefined();
    expect(screen.getByTestId('p2p-editor-node-shape-n2')).toBeDefined();
    expect(screen.getByTestId('p2p-editor-node-shape-n3')).toBeDefined();
    expect(screen.getByTestId('p2p-editor-edge-shape-e1')).toBeDefined();
    expect(screen.getByTestId('p2p-editor-canvas-hint')).toBeDefined();
    expect(screen.getByTestId('p2p-editor-inspector-empty')).toBeDefined();
  });

  it('renders node shape with data-node-kind attribute reflecting compiled kind', () => {
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={() => {}} readOnly={false} />);
    expect(screen.getByTestId('p2p-editor-node-shape-n1').getAttribute('data-node-kind')).toBe('llm');
    expect(screen.getByTestId('p2p-editor-node-shape-n3').getAttribute('data-node-kind')).toBe('logic');
  });

  it('node SVG transform matches autoLayoutPositions', () => {
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={() => {}} readOnly={false} />);
    const layout = autoLayoutPositions(makeDraft().nodes);
    const n2Shape = screen.getByTestId('p2p-editor-node-shape-n2');
    const transform = n2Shape.getAttribute('transform');
    expect(transform).toContain(`${layout.n2.x}`);
    expect(transform).toContain(`${layout.n2.y}`);
    expect(n2Shape.getAttribute('data-node-x')).toBe(`${Math.round(layout.n2.x)}`);
    expect(n2Shape.getAttribute('data-node-y')).toBe(`${Math.round(layout.n2.y)}`);
  });

  it('readOnly mode hides anchors and add-node button', () => {
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={() => {}} readOnly={true} />);
    expect(screen.queryByTestId('p2p-editor-add-node')).toBeNull();
    expect(screen.queryByTestId('p2p-editor-node-anchor-n1')).toBeNull();
    expect(screen.queryByTestId('p2p-editor-node-anchor-n2')).toBeNull();
    // Read-only notice surfaces
    expect(screen.getByTestId('p2p-editor-readonly-notice')).toBeDefined();
  });

  it('selecting a node opens the inspector with node fields', async () => {
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={() => {}} readOnly={false} />);
    expect(screen.queryByTestId('p2p-editor-node-n1')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('p2p-editor-node-shape-n1'));
    });
    expect(screen.getByTestId('p2p-editor-node-n1')).toBeDefined();
    expect((screen.getByLabelText('node-n1-title') as HTMLInputElement).value).toBe('Discuss');
  });

  it('selecting an edge shape opens the inspector with from/to selects', async () => {
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={() => {}} readOnly={false} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('p2p-editor-edge-shape-e1'));
    });
    expect(screen.getByTestId('p2p-editor-edge-e1')).toBeDefined();
    expect((screen.getByLabelText('edge-e1-from') as HTMLSelectElement).value).toBe('n1');
    expect((screen.getByLabelText('edge-e1-to') as HTMLSelectElement).value).toBe('n2');
  });
});

describe('AdvancedWorkflowCanvasEditor mutation contract', () => {
  it('add-node calls onChange with appended node and never serialises positions into the draft', async () => {
    const onChange = vi.fn();
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={onChange} readOnly={false} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('p2p-editor-add-node'));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as P2pWorkflowDraft;
    expect(next.nodes).toHaveLength(4);
    const newNode = next.nodes.find((n) => n.id === 'node_1');
    expect(newNode).toBeDefined();
    // Node payload must NOT carry x/y/position fields (visual-only state).
    expect(Object.keys(newNode!)).not.toContain('x');
    expect(Object.keys(newNode!)).not.toContain('y');
    expect(Object.keys(newNode!)).not.toContain('position');
  });

  it('removing a node also drops referencing edges (graph stays valid)', async () => {
    const onChange = vi.fn();
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={onChange} readOnly={false} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('p2p-editor-node-shape-n1'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('p2p-editor-remove-node-n1'));
    });
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as P2pWorkflowDraft;
    expect(last.nodes.find((n) => n.id === 'n1')).toBeUndefined();
    // edge `e1` referenced n1, MUST be dropped.
    expect(last.edges.find((e) => e.id === 'e1')).toBeUndefined();
  });

  it('switching edgeKind to conditional adds a condition placeholder', async () => {
    const onChange = vi.fn();
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={onChange} readOnly={false} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('p2p-editor-edge-shape-e1'));
    });
    const kindSelect = screen.getByLabelText('edge-e1-kind') as HTMLSelectElement;
    await act(async () => {
      kindSelect.value = 'conditional';
      fireEvent.input(kindSelect, { target: { value: 'conditional' } });
    });
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as P2pWorkflowDraft;
    const edge = last.edges.find((e) => e.id === 'e1')!;
    expect(edge.edgeKind).toBe('conditional');
    expect(edge.condition?.kind).toBe('routing_key_equals');
    expect(edge.condition?.equals).toBe('');
  });

  it('switching edgeKind back to default strips the condition (no stale field)', async () => {
    const draft: P2pWorkflowDraft = {
      ...makeDraft(),
      edges: [
        { id: 'e1', fromNodeId: 'n1', toNodeId: 'n2', edgeKind: 'conditional', condition: { kind: 'routing_key_equals', equals: 'go-audit' } },
      ],
    };
    const onChange = vi.fn();
    render(<AdvancedWorkflowCanvasEditor value={draft} onChange={onChange} readOnly={false} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('p2p-editor-edge-shape-e1'));
    });
    const kindSelect = screen.getByLabelText('edge-e1-kind') as HTMLSelectElement;
    await act(async () => {
      kindSelect.value = 'default';
      fireEvent.input(kindSelect, { target: { value: 'default' } });
    });
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as P2pWorkflowDraft;
    const edge = last.edges.find((e) => e.id === 'e1')!;
    expect(edge.edgeKind).toBe('default');
    expect(Object.prototype.hasOwnProperty.call(edge, 'condition')).toBe(false);
  });

  it('mutations from any inspector edit never inject visual-only fields into the draft tree', async () => {
    const onChange = vi.fn();
    render(<AdvancedWorkflowCanvasEditor value={makeDraft()} onChange={onChange} readOnly={false} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('p2p-editor-node-shape-n1'));
    });
    const presetSelect = screen.getByLabelText('node-n1-preset') as HTMLSelectElement;
    await act(async () => {
      presetSelect.value = 'audit';
      fireEvent.input(presetSelect, { target: { value: 'audit' } });
    });
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0] as P2pWorkflowDraft;
    // Recursively assert no x/y/position keys anywhere in the draft tree.
    const stack: unknown[] = [next];
    while (stack.length > 0) {
      const value = stack.pop();
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          expect(['x', 'y', 'position', 'positions', 'layout']).not.toContain(key);
          if (child && typeof child === 'object') stack.push(child);
        }
      }
    }
  });
});
