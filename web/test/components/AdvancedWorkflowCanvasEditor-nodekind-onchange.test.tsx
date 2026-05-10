/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { h } from 'preact';
import { render, fireEvent, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && typeof fallbackOrOpts === 'object' && typeof fallbackOrOpts.defaultValue === 'string') {
        // Minimal interpolation: replace {{count}} so banner test can read it.
        return (fallbackOrOpts.defaultValue as string).replace(/\{\{count\}\}/g, String(fallbackOrOpts.count ?? ''));
      }
      return _key.split('.').pop() ?? _key;
    },
  }),
}));

import {
  AdvancedWorkflowCanvasEditor,
  alignNodeForKind,
  normalizeP2pWorkflowDraftForEditing,
} from '../../src/components/AdvancedWorkflowCanvasEditor.js';
import type { P2pWorkflowDraft, P2pWorkflowNodeDraft } from '@shared/p2p-workflow-types.js';
import { validateP2pWorkflowDraft } from '@shared/p2p-workflow-validators.js';

/**
 * Audit fix (e940d73f-a8e / A1+N3) regression tests.
 *
 * Pin the contract that:
 *   - switching `nodeKind` to logic/script auto-aligns
 *     preset / permissionScope / dispatchStyle so the validator does
 *     NOT reject the resulting node;
 *   - loading a legacy draft with non-aligned logic/script nodes
 *     produces a normalize banner whose Apply button rewrites the
 *     draft into a validator-legal shape.
 */

const baseDraft = (): P2pWorkflowDraft => ({
  schemaVersion: 1,
  id: 'wf-1',
  nodes: [{ id: 'n1', title: 'n1', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' }],
  edges: [],
  rootNodeId: 'n1',
});

describe('alignNodeForKind (A1)', () => {
  const start: P2pWorkflowNodeDraft = {
    id: 'n1', title: 'n1',
    nodeKind: 'llm', preset: 'discuss',
    permissionScope: 'analysis_only', dispatchStyle: 'multi_dispatch',
  };

  it('switching to logic forces preset=custom + scope=analysis_only + dispatch=single_main', () => {
    const next = alignNodeForKind(start, 'logic');
    expect(next.nodeKind).toBe('logic');
    expect(next.preset).toBe('custom');
    expect(next.permissionScope).toBe('analysis_only');
    expect(next.dispatchStyle).toBe('single_main');
  });

  it('switching to script forces preset=custom + dispatch=single_main', () => {
    const next = alignNodeForKind(start, 'script');
    expect(next.nodeKind).toBe('script');
    expect(next.preset).toBe('custom');
    expect(next.dispatchStyle).toBe('single_main');
    // scope is intentionally NOT forced — script accepts any
    expect(next.permissionScope).toBeUndefined();
  });

  it('switching back to llm restores preset default scope/dispatch', () => {
    const fromLogic: P2pWorkflowNodeDraft = {
      ...start, nodeKind: 'logic', preset: 'custom',
      permissionScope: 'analysis_only', dispatchStyle: 'single_main',
    };
    const next = alignNodeForKind(fromLogic, 'llm');
    expect(next.nodeKind).toBe('llm');
    // preset stays whatever the user picks; alignNodeForKind doesn't force preset on llm.
    expect(next).not.toHaveProperty('preset');
  });
});

describe('normalizeP2pWorkflowDraftForEditing (N3)', () => {
  it('normalizes a legacy {logic+discuss+implementation} node', () => {
    const draft: P2pWorkflowDraft = {
      ...baseDraft(),
      nodes: [
        { id: 'n1', title: 'n1', nodeKind: 'logic', preset: 'discuss', permissionScope: 'implementation' },
      ],
    };
    const { draft: out, repairs } = normalizeP2pWorkflowDraftForEditing(draft);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].nodeId).toBe('n1');
    expect(repairs[0].fields).toEqual(expect.arrayContaining(['preset', 'permissionScope']));
    expect(out.nodes[0].preset).toBe('custom');
    expect(out.nodes[0].permissionScope).toBe('analysis_only');
    // Critical: the normalized draft must pass the validator.
    const validation = validateP2pWorkflowDraft(out);
    expect(validation.ok).toBe(true);
  });

  it('valid draft passes through unchanged with zero repairs', () => {
    const { draft, repairs } = normalizeP2pWorkflowDraftForEditing(baseDraft());
    expect(repairs).toHaveLength(0);
    expect(draft).toEqual(baseDraft());
  });

  it('multiple invalid nodes produce multiple repairs', () => {
    const draft: P2pWorkflowDraft = {
      ...baseDraft(),
      nodes: [
        { id: 'a', title: 'a', nodeKind: 'logic', preset: 'discuss', permissionScope: 'implementation' },
        { id: 'b', title: 'b', nodeKind: 'script', preset: 'audit', permissionScope: 'analysis_only' },
      ],
    };
    const { repairs } = normalizeP2pWorkflowDraftForEditing(draft);
    expect(repairs).toHaveLength(2);
  });
});

describe('AdvancedWorkflowCanvasEditor — nodeKind onChange + normalize banner', () => {
  beforeEach(() => cleanup());

  it('shows normalize banner for legacy invalid logic node', () => {
    const draft: P2pWorkflowDraft = {
      ...baseDraft(),
      nodes: [{ id: 'n1', title: 'n1', nodeKind: 'logic', preset: 'discuss', permissionScope: 'implementation' }],
    };
    const { container, getByTestId } = render(
      h(AdvancedWorkflowCanvasEditor, { value: draft, onChange: () => {} }),
    );
    const banner = getByTestId('p2p-editor-normalize-banner');
    expect(banner).toBeTruthy();
    expect(banner.getAttribute('data-repairs-count')).toBe('1');
    // Apply + Dismiss buttons must be present.
    expect(container.querySelector('[data-testid="p2p-editor-normalize-apply"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="p2p-editor-normalize-dismiss"]')).toBeTruthy();
  });

  it('Apply button calls onChange with normalized draft', () => {
    const draft: P2pWorkflowDraft = {
      ...baseDraft(),
      nodes: [{ id: 'n1', title: 'n1', nodeKind: 'logic', preset: 'discuss', permissionScope: 'implementation' }],
    };
    const calls: P2pWorkflowDraft[] = [];
    const { getByTestId } = render(
      h(AdvancedWorkflowCanvasEditor, { value: draft, onChange: (next: P2pWorkflowDraft) => calls.push(next) }),
    );
    fireEvent.click(getByTestId('p2p-editor-normalize-apply'));
    expect(calls).toHaveLength(1);
    expect(calls[0].nodes[0].preset).toBe('custom');
    expect(calls[0].nodes[0].permissionScope).toBe('analysis_only');
  });

  it('valid draft does NOT show banner', () => {
    const { container } = render(
      h(AdvancedWorkflowCanvasEditor, { value: baseDraft(), onChange: () => {} }),
    );
    expect(container.querySelector('[data-testid="p2p-editor-normalize-banner"]')).toBeNull();
  });
});
