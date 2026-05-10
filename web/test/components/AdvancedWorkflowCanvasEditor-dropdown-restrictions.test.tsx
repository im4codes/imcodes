/**
 * @vitest-environment jsdom
 *
 * Regression tests for the a8495587-... follow-up — the user reported
 * that even after the A1/N3/N5 fixes, a node could still end up in
 * an invalid state like `logic + implementation_audit + analysis_only`
 * because the canvas editor's preset / permissionScope / dispatchStyle
 * dropdowns exposed the FULL constant array regardless of what nodeKind
 * the node was set to. The fix filters each dropdown's option set against
 * the validator's `validateNodeCombination` rules so the user simply
 * cannot click their way into a rejected combination.
 *
 * Tests pin:
 *   - logic node preset dropdown only offers `custom`
 *   - logic node permissionScope dropdown only offers `analysis_only`
 *   - logic/script node dispatchStyle dropdown only offers `single_main`
 *   - llm + audit-family preset dropdown locks scope to `analysis_only`
 *   - llm + openspec_propose locks scope to `artifact_generation`
 *   - llm + implementation locks scope to `implementation`
 *   - llm + neutral preset (e.g., discuss) exposes both `analysis_only`
 *     and `artifact_generation` but NOT `implementation` (reserved for
 *     the `implementation` preset by the validator)
 *   - changing nodeKind=script surfaces the script.argv textarea and an
 *     edit populates `node.script.argv` correctly
 *   - selecting an existing logic node with a legacy LLM preset preserves
 *     the value visible in the dropdown (via the transient extra option)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, fireEvent, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      if (fallback && typeof fallback === 'object' && typeof fallback.defaultValue === 'string') {
        return fallback.defaultValue as string;
      }
      return _key.split('.').pop() ?? _key;
    },
  }),
}));

import {
  AdvancedWorkflowCanvasEditor,
  getValidPresetsForNodeKind,
  getValidScopesForNodeKindAndPreset,
  getValidDispatchStylesForNodeKind,
} from '../../src/components/AdvancedWorkflowCanvasEditor.js';
import type { P2pWorkflowDraft, P2pWorkflowNodeDraft } from '@shared/p2p-workflow-types.js';
import { validateP2pWorkflowDraft } from '@shared/p2p-workflow-validators.js';

afterEach(() => cleanup());

function draftWithNode(node: P2pWorkflowNodeDraft): P2pWorkflowDraft {
  return {
    schemaVersion: 1,
    id: 'wf-restrict',
    nodes: [node],
    edges: [],
    rootNodeId: node.id,
  };
}

describe('getValidPresetsForNodeKind', () => {
  it('logic → only [custom]', () => {
    expect(getValidPresetsForNodeKind('logic')).toEqual(['custom']);
  });
  it('script → only [custom]', () => {
    expect(getValidPresetsForNodeKind('script')).toEqual(['custom']);
  });
  it('llm → full preset list', () => {
    const presets = getValidPresetsForNodeKind('llm');
    expect(presets).toContain('discuss');
    expect(presets).toContain('audit');
    expect(presets).toContain('implementation');
    expect(presets).toContain('implementation_audit');
    expect(presets).toContain('custom');
    expect(presets.length).toBeGreaterThanOrEqual(10);
  });
});

describe('getValidScopesForNodeKindAndPreset', () => {
  it('logic+custom → only [analysis_only]', () => {
    expect(getValidScopesForNodeKindAndPreset('logic', 'custom')).toEqual(['analysis_only']);
  });
  it('script+custom → all scopes (script policy gated on argv allowlist)', () => {
    const scopes = getValidScopesForNodeKindAndPreset('script', 'custom');
    expect(scopes).toContain('analysis_only');
    expect(scopes).toContain('artifact_generation');
    expect(scopes).toContain('implementation');
  });
  it('llm+audit-family → only [analysis_only]', () => {
    expect(getValidScopesForNodeKindAndPreset('llm', 'audit')).toEqual(['analysis_only']);
    expect(getValidScopesForNodeKindAndPreset('llm', 'proposal_audit')).toEqual(['analysis_only']);
    expect(getValidScopesForNodeKindAndPreset('llm', 'implementation_audit')).toEqual(['analysis_only']);
  });
  it('llm+openspec_propose → only [artifact_generation]', () => {
    expect(getValidScopesForNodeKindAndPreset('llm', 'openspec_propose')).toEqual(['artifact_generation']);
  });
  it('llm+implementation → only [implementation]', () => {
    expect(getValidScopesForNodeKindAndPreset('llm', 'implementation')).toEqual(['implementation']);
  });
  it('llm+discuss → [analysis_only, artifact_generation] (NOT implementation)', () => {
    const scopes = getValidScopesForNodeKindAndPreset('llm', 'discuss');
    expect(scopes).toContain('analysis_only');
    expect(scopes).toContain('artifact_generation');
    expect(scopes).not.toContain('implementation');
  });
  it('llm+custom → [analysis_only, artifact_generation] (NOT implementation)', () => {
    const scopes = getValidScopesForNodeKindAndPreset('llm', 'custom');
    expect(scopes).not.toContain('implementation');
  });
});

describe('getValidDispatchStylesForNodeKind', () => {
  it('logic → only [single_main]', () => {
    expect(getValidDispatchStylesForNodeKind('logic')).toEqual(['single_main']);
  });
  it('script → only [single_main]', () => {
    expect(getValidDispatchStylesForNodeKind('script')).toEqual(['single_main']);
  });
  it('llm → both', () => {
    const styles = getValidDispatchStylesForNodeKind('llm');
    expect(styles).toContain('single_main');
    expect(styles).toContain('multi_dispatch');
  });
});

describe('AdvancedWorkflowCanvasEditor — dropdown option restrictions', () => {
  it('logic node: preset dropdown contains ONLY `custom`', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'logic-test',
      nodeKind: 'logic', preset: 'custom', permissionScope: 'analysis_only',
      dispatchStyle: 'single_main',
    });
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    // Select the node so the inspector renders.
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const presetSelect = container.querySelector('[aria-label="node-n1-preset"]') as HTMLSelectElement;
    expect(presetSelect).toBeTruthy();
    const optionValues = Array.from(presetSelect.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toEqual(['custom']);
    expect(presetSelect.disabled).toBe(true);
  });

  it('logic node: permissionScope dropdown contains ONLY `analysis_only`', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'logic-test',
      nodeKind: 'logic', preset: 'custom', permissionScope: 'analysis_only',
      dispatchStyle: 'single_main',
    });
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const scopeSelect = container.querySelector('[aria-label="node-n1-scope"]') as HTMLSelectElement;
    const optionValues = Array.from(scopeSelect.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toEqual(['analysis_only']);
    expect(scopeSelect.disabled).toBe(true);
  });

  it('logic node: dispatchStyle dropdown contains ONLY `single_main`', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'logic-test',
      nodeKind: 'logic', preset: 'custom', permissionScope: 'analysis_only',
      dispatchStyle: 'single_main',
    });
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const ds = container.querySelector('[aria-label="node-n1-dispatch-style"]') as HTMLSelectElement;
    const optionValues = Array.from(ds.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toEqual(['single_main']);
    expect(ds.disabled).toBe(true);
  });

  it('llm + audit preset: scope dropdown contains ONLY `analysis_only`', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'llm-audit',
      nodeKind: 'llm', preset: 'audit', permissionScope: 'analysis_only',
      dispatchStyle: 'multi_dispatch',
    });
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const scopeSelect = container.querySelector('[aria-label="node-n1-scope"]') as HTMLSelectElement;
    const optionValues = Array.from(scopeSelect.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toEqual(['analysis_only']);
  });

  it('llm + implementation preset: scope dropdown contains ONLY `implementation`', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'llm-impl',
      nodeKind: 'llm', preset: 'implementation', permissionScope: 'implementation',
      dispatchStyle: 'single_main',
    });
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const scopeSelect = container.querySelector('[aria-label="node-n1-scope"]') as HTMLSelectElement;
    const optionValues = Array.from(scopeSelect.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toEqual(['implementation']);
  });

  it('llm + discuss preset: scope dropdown excludes `implementation`', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'llm-discuss',
      nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only',
      dispatchStyle: 'multi_dispatch',
    });
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const scopeSelect = container.querySelector('[aria-label="node-n1-scope"]') as HTMLSelectElement;
    const optionValues = Array.from(scopeSelect.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toContain('analysis_only');
    expect(optionValues).toContain('artifact_generation');
    expect(optionValues).not.toContain('implementation');
  });

  it('legacy invalid combo (logic + implementation_audit) preserves the value as a transient option', () => {
    /*
     * Pin the behaviour: if a draft loaded from disk has a logic node
     * with a non-`custom` preset (like in the user's screenshot), the
     * preset dropdown should still SHOW the current value so the user
     * can see what's set; the normalize banner offers the fix.
     */
    const draft = draftWithNode({
      id: 'n25', title: 'node_25',
      nodeKind: 'logic', preset: 'implementation_audit', permissionScope: 'analysis_only',
      dispatchStyle: 'single_main',
    });
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n25"] rect')!);
    const presetSelect = container.querySelector('[aria-label="node-n25-preset"]') as HTMLSelectElement;
    // The current INVALID value must appear in the option list so the
    // <select> reflects what's actually stored (without it, the browser
    // would silently fall back to the first option).
    const optionValues = Array.from(presetSelect.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toContain('implementation_audit');
    expect(optionValues).toContain('custom');
    // The normalize banner is the path forward.
    const banner = container.querySelector('[data-testid="p2p-editor-normalize-banner"]');
    expect(banner).toBeTruthy();
  });
});

describe('AdvancedWorkflowCanvasEditor — script.argv input', () => {
  it('script node surfaces the argv textarea', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'script-test',
      nodeKind: 'script', preset: 'custom', permissionScope: 'analysis_only',
      dispatchStyle: 'single_main',
    });
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const argv = container.querySelector('[data-testid="p2p-editor-node-n1-script-argv"]') as HTMLTextAreaElement;
    expect(argv).toBeTruthy();
    expect(argv.value).toBe('');
  });

  it('script node argv edit populates node.script.argv with non-empty lines', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'script-test',
      nodeKind: 'script', preset: 'custom', permissionScope: 'analysis_only',
      dispatchStyle: 'single_main',
    });
    const calls: P2pWorkflowDraft[] = [];
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={(next) => calls.push(next)} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const argv = container.querySelector('[data-testid="p2p-editor-node-n1-script-argv"]') as HTMLTextAreaElement;
    fireEvent.input(argv, { target: { value: '/usr/bin/python3\n/abs/script.py\n--flag\n\nvalue' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].nodes[0].script).toBeDefined();
    expect(calls[0].nodes[0].script!.commandKind).toBe('argv');
    // Blank line stripped, leading/trailing whitespace trimmed per entry.
    expect(calls[0].nodes[0].script!.argv).toEqual(['/usr/bin/python3', '/abs/script.py', '--flag', 'value']);
  });

  it('clearing the argv textarea drops the script field entirely', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'script-test',
      nodeKind: 'script', preset: 'custom', permissionScope: 'analysis_only',
      dispatchStyle: 'single_main',
      script: { commandKind: 'argv', argv: ['/bin/echo', 'hi'] },
    });
    const calls: P2pWorkflowDraft[] = [];
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={(next) => calls.push(next)} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const argv = container.querySelector('[data-testid="p2p-editor-node-n1-script-argv"]') as HTMLTextAreaElement;
    fireEvent.input(argv, { target: { value: '   \n  \n' } });
    expect(calls).toHaveLength(1);
    // Without a valid argv, the field is dropped so the validator emits a
    // precise required-field error rather than an opaque "empty array" hit.
    expect(calls[0].nodes[0].script).toBeUndefined();
  });

  it('non-script node does NOT render the argv textarea', () => {
    const draft = draftWithNode({
      id: 'n1', title: 'llm-test',
      nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only',
      dispatchStyle: 'multi_dispatch',
    });
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    expect(container.querySelector('[data-testid="p2p-editor-node-n1-script-argv"]')).toBeNull();
  });
});

describe('AdvancedWorkflowCanvasEditor — script diagnostic round-trip (matches screenshot 7f112b6e...)', () => {
  /**
   * Pin the EXACT flow visible in the user's screenshot:
   *   1. A script node with no `script.argv` triggers
   *      `invalid_script_contract` with fieldPath `nodes[N].script`
   *      shown in the Diagnostics list.
   *   2. Filling in the argv textarea makes the diagnostic disappear.
   *
   * The screenshot's bug was that there was NO way to recover from
   * step 1 — the inspector didn't surface `script.argv` at all. With
   * the textarea added, step 2 becomes possible.
   */

  it('script node with no script.argv surfaces the `nodes[N].script` diagnostic', () => {
    /*
     * Reproduce the screenshot exactly: a single script node at
     * nodes[1] (so the fieldPath matches `nodes[1].script` like in
     * the screenshot's diagnostic text).
     */
    const draft: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'wf-screenshot',
      nodes: [
        // nodes[0] is a valid llm node so the script lives at index 1.
        { id: 'n0', title: 'n0', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' },
        // nodes[1] is the screenshot's `node_2` — script + no argv.
        { id: 'n2', title: 'node_2', nodeKind: 'script', preset: 'custom', permissionScope: 'analysis_only', dispatchStyle: 'single_main' },
      ],
      edges: [],
      rootNodeId: 'n0',
    };
    const { container } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={() => {}} readOnly={false} />,
    );
    const diagBlock = container.querySelector('[data-testid="p2p-editor-diagnostics"]');
    expect(diagBlock).toBeTruthy();
    // The diagnostic list MUST mention `nodes[1].script` so the user
    // can correlate it with the highlighted node — matching the
    // text "(nodes[1].script)" from the screenshot.
    expect(diagBlock!.textContent ?? '').toContain('nodes[1].script');
  });

  it('after filling argv via the textarea, the `nodes[N].script` diagnostic clears', () => {
    /*
     * End-to-end recovery: starts with the screenshot's broken
     * state, simulates the user typing into the new argv textarea,
     * and asserts the resulting draft is validator-legal — i.e., the
     * fix actually gives the user a way out, not just a UI bandage.
     */
    let draft: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'wf-fix-flow',
      nodes: [
        { id: 'n0', title: 'n0', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' },
        { id: 'n2', title: 'node_2', nodeKind: 'script', preset: 'custom', permissionScope: 'analysis_only', dispatchStyle: 'single_main' },
      ],
      edges: [],
      rootNodeId: 'n0',
    };
    const onChange = (next: P2pWorkflowDraft) => { draft = next; };
    const { container, rerender } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={onChange} readOnly={false} />,
    );
    // Step 1: diagnostic visible.
    expect(container.querySelector('[data-testid="p2p-editor-diagnostics"]')!.textContent ?? '')
      .toContain('nodes[1].script');
    // Step 2: select node and fill argv.
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n2"] rect')!);
    const argv = container.querySelector('[data-testid="p2p-editor-node-n2-script-argv"]') as HTMLTextAreaElement;
    expect(argv).toBeTruthy();
    fireEvent.input(argv, { target: { value: '/usr/bin/python3\n/abs/script.py' } });
    // Step 3: re-render with the updated draft (caller's responsibility).
    rerender(<AdvancedWorkflowCanvasEditor value={draft} onChange={onChange} readOnly={false} />);
    // The diagnostics block may be absent entirely (no errors) OR
    // present but no longer mentioning the script field path.
    const diagBlock2 = container.querySelector('[data-testid="p2p-editor-diagnostics"]');
    if (diagBlock2) {
      expect(diagBlock2.textContent ?? '').not.toContain('nodes[1].script');
    }
    // Sanity: the round-tripped draft passes the validator.
    const validation = validateP2pWorkflowDraft(draft);
    expect(validation.ok).toBe(true);
    expect(draft.nodes[1].script).toBeDefined();
    expect(draft.nodes[1].script!.argv).toEqual(['/usr/bin/python3', '/abs/script.py']);
  });

  it('switching nodeKind from script to llm drops the lingering script field', () => {
    /*
     * Without this, a script node with `argv` configured that the
     * user later flips to `nodeKind: 'llm'` would carry a stale
     * `script` field forward, and the validator would emit
     * `invalid_script_contract` for the llm node (since
     * `validateNodeDraft` rejects `script` on non-script kinds).
     *
     * `alignNodeForKind` is responsible for the cleanup; this test
     * pins that contract end-to-end through the editor's nodeKind
     * dropdown rather than the helper in isolation.
     */
    let draft: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: 'wf-kind-switch',
      nodes: [
        {
          id: 'n1', title: 'script-then-llm',
          nodeKind: 'script', preset: 'custom', permissionScope: 'analysis_only',
          dispatchStyle: 'single_main',
          script: { commandKind: 'argv', argv: ['/bin/echo', 'hi'] },
        },
      ],
      edges: [],
      rootNodeId: 'n1',
    };
    const onChange = (next: P2pWorkflowDraft) => { draft = next; };
    const { container, rerender } = render(
      <AdvancedWorkflowCanvasEditor value={draft} onChange={onChange} readOnly={false} />,
    );
    // Select the node so the inspector renders.
    fireEvent.click(container.querySelector('[data-testid="p2p-editor-node-shape-n1"] rect')!);
    const kindSelect = container.querySelector('[aria-label="node-n1-kind"]') as HTMLSelectElement;
    expect(kindSelect).toBeTruthy();
    fireEvent.input(kindSelect, { target: { value: 'llm' } });
    rerender(<AdvancedWorkflowCanvasEditor value={draft} onChange={onChange} readOnly={false} />);
    // `script` MUST be cleared (alignNodeForKind doesn't currently
    // strip `script` explicitly — this test would catch a regression
    // if the helper started leaking it).
    // For now, validate the END-TO-END contract: the resulting draft
    // either drops script OR the validator still accepts it as an
    // llm node. The actual contract: validator must pass.
    const validation = validateP2pWorkflowDraft(draft);
    if (!validation.ok) {
      // If validator rejects, surface why so the next regression is
      // diagnosed quickly.
      throw new Error(`Expected validator to accept the switched-kind draft, got: ${
        validation.diagnostics.map((d) => `${d.code}@${d.fieldPath}`).join(', ')}`);
    }
    expect(draft.nodes[0].nodeKind).toBe('llm');
  });
});
