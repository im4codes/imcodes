import { describe, expect, it } from 'vitest';
import {
  validateP2pPersistedWorkflowSnapshot,
  validateP2pWorkflowLaunchEnvelope,
  validateP2pWorkflowStatusProjection,
} from '../../shared/p2p-workflow-validators.js';
import type { P2pWorkflowDraft, P2pWorkflowLaunchEnvelope } from '../../shared/p2p-workflow-types.js';

const draft: P2pWorkflowDraft = {
  schemaVersion: 1,
  id: 'wf_valid',
  nodes: [
    { id: 'n1', nodeKind: 'llm', preset: 'audit', permissionScope: 'analysis_only' },
  ],
  edges: [],
  rootNodeId: 'n1',
};

describe('p2p workflow validators', () => {
  it('accepts a valid advanced launch envelope', () => {
    const envelope: P2pWorkflowLaunchEnvelope = {
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
    };
    expect(validateP2pWorkflowLaunchEnvelope(envelope).ok).toBe(true);
  });

  // Audit:R3 PR-γ / N-M5 / V-4 — `expectedStaticPolicyHash` is a v1a-added
  // optional field for daemon-side `static_policy_mismatch_recompiled`.
  it('accepts expectedStaticPolicyHash on launch envelope', () => {
    const envelope: P2pWorkflowLaunchEnvelope = {
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
      expectedStaticPolicyHash: 'fnv1a64:abcdef0123456789',
    };
    expect(validateP2pWorkflowLaunchEnvelope(envelope).ok).toBe(true);
  });

  it('rejects malformed expectedStaticPolicyHash', () => {
    // empty string / wrong type / oversize all rejected with invalid_launch_envelope
    expect(validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
      expectedStaticPolicyHash: '',
    }).ok).toBe(false);
    expect(validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
      expectedStaticPolicyHash: 'x'.repeat(200),
    }).ok).toBe(false);
    expect(validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
      expectedStaticPolicyHash: 12345 as unknown as string,
    }).ok).toBe(false);
  });

  // R3 PR-δ (A6 / Cu1-M2) — multi-byte characters were previously accepted
  // because the validator only checked JS string `length`. The fix enforces
  // visible-ASCII pattern + UTF-8 byte length cap; both must reject.
  it('rejects expectedStaticPolicyHash with non-ASCII characters', () => {
    expect(validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
      expectedStaticPolicyHash: 'fnv1a64:abc中文ef',
    }).ok).toBe(false);
  });

  it('rejects expectedStaticPolicyHash with control characters', () => {
    expect(validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
      expectedStaticPolicyHash: 'fnv1a64:abc\nef',
    }).ok).toBe(false);
  });

  it('rejects future schema versions', () => {
    const result = validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 999,
      workflowKind: 'advanced',
      advancedDraft: draft,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('unsupported_schema_version');
  });

  it('rejects mixed old and new advanced fields', () => {
    const result = validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedPresetKey: 'openspec',
      advancedDraft: draft,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('mixed_advanced_schema_fields');
  });

  it('rejects forbidden private envelope fields recursively', () => {
    const result = validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
      launchContext: { token: 'secret' },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('forbidden_envelope_field');
    expect(result.diagnostics[0]?.fieldPath).toBe('launchContext.token');
  });

  it('rejects invalid node kind and invalid variable values', () => {
    const result = validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: {
        ...draft,
        nodes: [{ id: 'n1', nodeKind: 'audit', preset: 'audit' }],
        variables: [{ name: 'Bad', value: { nested: true } }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('invalid_workflow_graph');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('invalid_workflow_variable');
  });

  it('validates launch context and required daemon capabilities', () => {
    const result = validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
      requiredDaemonCapabilities: ['p2p.workflow.v1', 'p2p.workflow.unknown.v1'],
      launchContext: { requestId: 'bad request id with spaces' },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_required_capability', fieldPath: 'requiredDaemonCapabilities[1]' }),
      expect.objectContaining({ code: 'invalid_launch_envelope', fieldPath: 'launchContext.requestId' }),
    ]));
  });

  it('validates start context sources and file reference paths', () => {
    const result = validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: {
        ...draft,
        startContext: {
          sources: [
            { kind: 'current_prompt', id: 'prompt' },
            { kind: 'file_reference', id: 'file', path: '../secret.txt' },
          ],
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsafe_artifact_path', fieldPath: 'startContext.sources[1].path' }),
    ]));
  });

  it('rejects invalid node preset and permission scope combinations', () => {
    const result = validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: {
        ...draft,
        nodes: [
          { id: 'n1', nodeKind: 'logic', preset: 'audit', permissionScope: 'analysis_only' },
          { id: 'n2', nodeKind: 'llm', preset: 'openspec_propose', permissionScope: 'analysis_only' },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === 'invalid_workflow_graph')).toHaveLength(2);
  });

  it('accepts artifact-producing openspec proposal nodes with explicit contracts', () => {
    const result = validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: {
        ...draft,
        nodes: [{
          id: 'n1',
          nodeKind: 'llm',
          preset: 'openspec_propose',
          permissionScope: 'artifact_generation',
          artifacts: [{
            convention: 'openspec_convention',
            paths: ['openspec/changes/demo/specs/demo/spec.md'],
            permissionScope: 'artifact_generation',
          }],
        }],
      },
    });

    expect(result.ok).toBe(true);
  });

  it('guards forbidden-field scans against cycles and excessive arrays', () => {
    const cyclicDraft = { ...draft, self: null as unknown };
    cyclicDraft.self = cyclicDraft;
    expect(validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: cyclicDraft,
    }).ok).toBe(true);

    const result = validateP2pWorkflowLaunchEnvelope({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: draft,
      nested: new Array(1001).fill('x'),
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('forbidden_envelope_field');
  });

  it('validates public projections and persisted snapshots', () => {
    const projection = {
      projectionVersion: 1,
      runId: 'run-1',
      workflowId: 'wf-1',
      status: 'running',
      completedNodeIds: ['n1'],
      diagnostics: [],
      updatedAt: '2026-05-09T00:00:00.000Z',
    };

    expect(validateP2pWorkflowStatusProjection(projection).ok).toBe(true);
    expect(validateP2pPersistedWorkflowSnapshot(projection).ok).toBe(true);
    expect(validateP2pWorkflowStatusProjection({ ...projection, projectionVersion: 999 }).diagnostics[0]?.code).toBe('unsupported_schema_version');
    expect(validateP2pPersistedWorkflowSnapshot({ ...projection, capabilitySnapshot: { daemonId: 'd' } }).ok).toBe(false);
  });
});
