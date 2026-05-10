import { describe, expect, it } from 'vitest';
import {
  P2P_SANITIZE_MAX_ARRAY_ITEMS,
  P2P_SANITIZE_MAX_STRING_BYTES,
  P2P_WORKFLOW_PROJECTION_VERSION,
} from '../../shared/p2p-workflow-constants.js';
import { validateP2pWorkflowStatusProjection } from '../../shared/p2p-workflow-validators.js';
import {
  sanitizeLegacyP2pProgressSnapshot,
  sanitizeP2pOrchestrationRunForBridge,
  sanitizeP2pRunForPersistAndBroadcast,
  sanitizeP2pRunUpdateForBroadcast,
  sanitizeP2pWorkflowStatusProjection,
  sanitizeServerSideDiagnostic,
  sanitizeWorkflowDiagnosticForRetention,
} from '../src/p2p-workflow-sanitize.js';

describe('p2p workflow server sanitizer', () => {
  it('constructs an allowlisted projection and persisted snapshot', () => {
    const run = sanitizeP2pOrchestrationRunForBridge({
      id: 'run-1',
      discussion_id: 'disc-1',
      server_id: 'wrong-server',
      mode_key: 'audit',
      status: 'running',
      compiledWorkflow: { secret: true },
      rawPrompt: 'do not persist',
      env: { API_KEY: 'secret' },
      diagnostics: [{ code: 'private_projection_field_dropped', summary: 'existing' }],
    }, { serverId: 'server-1' });

    expect(run.id).toBe('run-1');
    expect(run.server_id).toBe('server-1');
    expect(run.workflow_projection.diagnostics.map((diagnostic) => diagnostic.code)).toContain('private_projection_field_dropped');
    expect(run.progress_snapshot).not.toContain('compiledWorkflow');
    expect(run.progress_snapshot).not.toContain('rawPrompt');
    expect(run.progress_snapshot).not.toContain('API_KEY');
  });

  it('drops malicious and private keys from browser run_update while preserving safe legacy fields', () => {
    const poisoned = JSON.parse('{"id":"run-2","status":"running","mode_key":"audit","active_phase":"hop","hop_counts":{"completed":1},"nested":{"constructor":{"polluted":true}},"token":"secret"}');
    const run = sanitizeP2pRunUpdateForBroadcast(poisoned, { serverId: 'server-1' });

    expect(run.active_phase).toBe('hop');
    expect(run.hop_counts).toEqual({ completed: 1 });
    expect('token' in run).toBe(false);
    expect('nested' in run).toBe(false);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('normalizes malformed status projection safely', () => {
    const projection = sanitizeP2pWorkflowStatusProjection({
      runId: 'run-3',
      workflowId: 'wf-1',
      status: 'not-a-status',
      capabilitySnapshot: { daemonId: 'daemon-1', helloEpoch: 2, sentAt: 3, capabilities: ['p2p.workflow.v1'] },
    });

    expect(projection.status).toBe('failed');
    expect(projection.capabilitySnapshot?.daemonId).toBe('daemon-1');
  });

  it('bounds oversized broadcast payloads and records a sanitize diagnostic', () => {
    const run = sanitizeP2pRunUpdateForBroadcast({
      id: 'run-oversized',
      status: 'running',
      mode_key: 'audit',
      active_phase: 'x'.repeat(P2P_SANITIZE_MAX_STRING_BYTES + 100),
      routing_history: Array.from({ length: P2P_SANITIZE_MAX_ARRAY_ITEMS + 10 }, (_, index) => ({
        step: index,
        nested: { value: 'y'.repeat(P2P_SANITIZE_MAX_STRING_BYTES + 100) },
      })),
      hop_states: Array.from({ length: P2P_SANITIZE_MAX_ARRAY_ITEMS + 10 }, (_, index) => ({
        session: 's'.repeat(P2P_SANITIZE_MAX_STRING_BYTES + 100),
        hop_index: index,
      })),
    }, { serverId: 'server-1' });

    expect(run.active_phase.length).toBeLessThanOrEqual(P2P_SANITIZE_MAX_STRING_BYTES);
    expect(Array.isArray(run.routing_history)).toBe(true);
    expect((run.routing_history as unknown[]).length).toBeLessThanOrEqual(P2P_SANITIZE_MAX_ARRAY_ITEMS);
    expect(run.hop_states?.length).toBeLessThanOrEqual(P2P_SANITIZE_MAX_ARRAY_ITEMS);
    expect(String(run.hop_states?.[0]?.session).length).toBeLessThanOrEqual(P2P_SANITIZE_MAX_STRING_BYTES);
    expect(run.workflow_projection.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'private_projection_field_dropped',
        phase: 'sanitize',
        summary: 'Sanitized oversized workflow payload',
      }),
    ]));
  });
});

describe('sanitizeLegacyP2pProgressSnapshot (read-time legacy sanitizer)', () => {
  it('returns an already-valid persisted snapshot unchanged with no diagnostic', () => {
    const validSnapshot = {
      projectionVersion: P2P_WORKFLOW_PROJECTION_VERSION,
      runId: 'run-valid',
      workflowId: 'wf-valid',
      status: 'completed' as const,
      currentNodeId: 'node-1',
      completedNodeIds: ['node-0', 'node-1'],
      diagnostics: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const result = sanitizeLegacyP2pProgressSnapshot(JSON.stringify(validSnapshot));

    expect(result.diagnostic).toBeNull();
    expect(result.projection.runId).toBe('run-valid');
    expect(result.projection.workflowId).toBe('wf-valid');
    expect(result.projection.status).toBe('completed');
    expect(result.projection.currentNodeId).toBe('node-1');
    expect(result.projection.completedNodeIds).toEqual(['node-0', 'node-1']);
    expect(result.projection.diagnostics).toEqual([]);
    expect(result.projection.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.snapshot.runId).toBe('run-valid');
    expect(result.snapshot.workflowId).toBe('wf-valid');
    const snapshotKeys = Object.keys(result.snapshot);
    expect(snapshotKeys).not.toContain('capabilitySnapshot');
    expect(snapshotKeys).not.toContain('artifactSummaries');
    expect(snapshotKeys).not.toContain('nodeSummaries');
    const validation = validateP2pWorkflowStatusProjection(result.projection);
    expect(validation.ok).toBe(true);
  });

  it('strips compiledWorkflow / rawPrompt / scriptRawOutputs from a legacy snapshot and emits the diagnostic', () => {
    const legacy = {
      runId: 'run-legacy',
      workflowId: 'audit',
      status: 'running',
      currentNodeId: 'node-x',
      completedNodeIds: ['node-a'],
      diagnostics: [],
      updatedAt: '2025-06-01T00:00:00.000Z',
      compiledWorkflow: { secret: true, dangerousField: 'do-not-leak' },
      rawPrompt: 'system prompt that must never be persisted',
      scriptRawOutputs: ['stdout content with secret-token'],
      artifactBaselines: [{ path: 'src/x', sha256: 'aaaa' }],
      env: { OPENAI_API_KEY: 'sk-leak' },
      token: 'oauth-secret',
    };
    const result = sanitizeLegacyP2pProgressSnapshot(JSON.stringify(legacy));

    expect(result.diagnostic).not.toBeNull();
    expect(result.diagnostic?.code).toBe('legacy_progress_snapshot_sanitized');
    expect(result.diagnostic?.phase).toBe('sanitize');
    expect(result.projection.diagnostics.map((d) => d.code))
      .toContain('legacy_progress_snapshot_sanitized');

    const projectionJson = JSON.stringify(result.projection);
    const snapshotJson = JSON.stringify(result.snapshot);
    for (const json of [projectionJson, snapshotJson]) {
      expect(json).not.toContain('compiledWorkflow');
      expect(json).not.toContain('rawPrompt');
      expect(json).not.toContain('scriptRawOutputs');
      expect(json).not.toContain('artifactBaselines');
      expect(json).not.toContain('OPENAI_API_KEY');
      expect(json).not.toContain('sk-leak');
      expect(json).not.toContain('oauth-secret');
      expect(json).not.toContain('do-not-leak');
    }

    expect(result.projection.runId).toBe('run-legacy');
    expect(result.projection.workflowId).toBe('audit');
    expect(result.projection.status).toBe('running');

    const validation = validateP2pWorkflowStatusProjection(result.projection);
    expect(validation.ok).toBe(true);
  });

  it('returns a safe empty projection plus the sanitized diagnostic on malformed JSON', () => {
    const result = sanitizeLegacyP2pProgressSnapshot('{not-json');

    expect(result.diagnostic?.code).toBe('legacy_progress_snapshot_sanitized');
    expect(result.projection.runId).toBe('unknown');
    expect(result.projection.workflowId).toBe('legacy');
    expect(result.projection.status).toBe('stale');
    expect(result.projection.completedNodeIds).toEqual([]);
    expect(result.projection.diagnostics.map((d) => d.code))
      .toContain('legacy_progress_snapshot_sanitized');
    expect(result.projection.updatedAt).toMatch(/T/);
    const validation = validateP2pWorkflowStatusProjection(result.projection);
    expect(validation.ok).toBe(true);
  });

  it('also sanitizes the empty-string case as malformed input', () => {
    const result = sanitizeLegacyP2pProgressSnapshot('');
    expect(result.diagnostic?.code).toBe('legacy_progress_snapshot_sanitized');
    expect(result.projection.status).toBe('stale');
  });

  it('never lets __proto__ / constructor keys reach the output projection or snapshot', () => {
    // Use raw JSON.parse so the malicious keys actually appear as own properties
    // rather than being silently coerced by an object literal.
    const poisoned = '{"runId":"run-p","workflowId":"audit","status":"running","completedNodeIds":[],"diagnostics":[],"updatedAt":"2026-01-01T00:00:00.000Z","__proto__":{"polluted":true},"constructor":{"polluted":true},"nested":{"__proto__":{"polluted":true}}}';
    const result = sanitizeLegacyP2pProgressSnapshot(poisoned);

    const projectionJson = JSON.stringify(result.projection);
    const snapshotJson = JSON.stringify(result.snapshot);
    expect(projectionJson).not.toContain('__proto__');
    expect(projectionJson).not.toContain('"constructor"');
    expect(projectionJson).not.toContain('polluted');
    expect(snapshotJson).not.toContain('__proto__');
    expect(snapshotJson).not.toContain('"constructor"');
    expect(snapshotJson).not.toContain('polluted');

    // Object.prototype must remain pristine.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');

    // Even the legacy-shaped poisoned payload should produce a valid projection.
    const validation = validateP2pWorkflowStatusProjection(result.projection);
    expect(validation.ok).toBe(true);
  });

  it("'{}' placeholder does not emit legacy_progress_snapshot_sanitized", () => {
    // Migration `032_p2p_progress_snapshot.sql` defaults this column to '{}'.
    // Newly created rows that have not yet emitted a projection MUST NOT be
    // marked as legacy — that would pollute every fresh /p2p/runs response
    // with a sanitize diagnostic.
    const result = sanitizeLegacyP2pProgressSnapshot('{}');
    expect(result.diagnostic).toBeNull();
    expect(result.projection.diagnostics).toEqual([]);
    // Empty placeholder maps to the canonical "no real status yet" projection.
    expect(result.projection.status).toBe('stale');
    // Snapshot is still a valid persisted shape so consumers stay
    // schema-compatible.
    const snapshotJson = JSON.stringify(result.snapshot);
    expect(snapshotJson).not.toContain('legacy_progress_snapshot_sanitized');
    expect(result.snapshot.projectionVersion).toBe(P2P_WORKFLOW_PROJECTION_VERSION);
  });

  it('legacy diagnostic uses real runId from row context when provided', () => {
    // Clearly-legacy payload (`compiledWorkflow` is on the forbidden list) so
    // the function falls into the legacy-projection branch. Without context
    // the diagnostic would say `runId: 'unknown'`; with context it MUST
    // surface the originating row id so audits can trace it back.
    const legacyJson = JSON.stringify({
      compiledWorkflow: { secret: true },
      status: 'failed',
    });
    const result = sanitizeLegacyP2pProgressSnapshot(legacyJson, {
      runId: 'real-row-id',
      workflowId: 'discussion-x',
    });
    expect(result.diagnostic).not.toBeNull();
    expect(result.diagnostic?.code).toBe('legacy_progress_snapshot_sanitized');
    expect(result.diagnostic?.runId).toBe('real-row-id');
    expect(result.projection.runId).toBe('real-row-id');
    expect(result.projection.workflowId).toBe('discussion-x');
  });
});

describe('sanitizeWorkflowDiagnosticForRetention / sanitizeServerSideDiagnostic', () => {
  it('preserves known workflow diagnostics in live projection', () => {
    // The daemon emits parse/compile/bind/execute-phase diagnostics. The
    // bridge MUST surface every code in P2P_WORKFLOW_DIAGNOSTIC_CODES, not
    // just the two server-side sanitize codes.
    const projection = sanitizeP2pWorkflowStatusProjection({
      runId: 'run-known',
      workflowId: 'audit',
      status: 'running',
      diagnostics: [
        { code: 'daemon_busy', phase: 'bind', severity: 'error', messageKey: 'should-be-ignored', summary: 'busy' },
        { code: 'missing_required_capability', phase: 'execute', severity: 'error', summary: 'missing cap' },
        { code: 'loop_budget_exhausted', phase: 'execute', severity: 'error' },
        { code: 'script_machine_output_invalid', phase: 'execute', severity: 'warning' },
      ],
    });

    const codes = projection.diagnostics.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining([
      'daemon_busy',
      'missing_required_capability',
      'loop_budget_exhausted',
      'script_machine_output_invalid',
    ]));
    // messageKey must be RECOMPUTED from the code, never trusted from raw input.
    const daemonBusy = projection.diagnostics.find((d) => d.code === 'daemon_busy');
    expect(daemonBusy?.messageKey).toBe('p2p.workflow.diagnostics.daemon_busy');
    expect(daemonBusy?.summary).toBe('busy');
    expect(daemonBusy?.phase).toBe('bind');
    // Severity preserved from raw input when valid.
    expect(daemonBusy?.severity).toBe('error');
  });

  it('preserves valid persisted snapshot diagnostics on read', () => {
    // Round-trip an already-valid persisted snapshot that contains
    // daemon_busy. The valid-snapshot branch must NOT add a
    // legacy_progress_snapshot_sanitized noise diagnostic, and it must
    // preserve the workflow diagnostic intact.
    const validSnapshot = {
      projectionVersion: P2P_WORKFLOW_PROJECTION_VERSION,
      runId: 'run-persisted',
      workflowId: 'audit',
      status: 'running' as const,
      currentNodeId: 'node-x',
      completedNodeIds: ['node-0'],
      diagnostics: [
        { code: 'daemon_busy', phase: 'bind', severity: 'error', messageKey: 'p2p.workflow.diagnostics.daemon_busy', summary: 'busy' },
      ],
      updatedAt: '2026-02-01T00:00:00.000Z',
    };
    const result = sanitizeLegacyP2pProgressSnapshot(JSON.stringify(validSnapshot));

    expect(result.diagnostic).toBeNull();
    const codes = result.projection.diagnostics.map((d) => d.code);
    expect(codes).toContain('daemon_busy');
    expect(codes).not.toContain('legacy_progress_snapshot_sanitized');
    const preserved = result.projection.diagnostics.find((d) => d.code === 'daemon_busy');
    expect(preserved?.messageKey).toBe('p2p.workflow.diagnostics.daemon_busy');
    expect(preserved?.summary).toBe('busy');
  });

  it('drops unknown diagnostic codes but keeps known sanitize diagnostics', () => {
    const projection = sanitizeP2pWorkflowStatusProjection({
      runId: 'run-mixed',
      workflowId: 'audit',
      status: 'running',
      diagnostics: [
        { code: 'private_projection_field_dropped', phase: 'sanitize', summary: 'dropped one' },
        { code: 'totally_made_up_code', phase: 'execute', summary: 'should-be-dropped' },
        { code: 'forbidden_envelope_field', phase: 'parse', summary: 'forbidden' },
        { code: '', summary: 'empty code' },
        { code: 'daemon_busy', phase: 'bind' },
      ],
    });

    const codes = projection.diagnostics.map((d) => d.code);
    expect(codes).toContain('private_projection_field_dropped');
    expect(codes).toContain('forbidden_envelope_field');
    expect(codes).toContain('daemon_busy');
    expect(codes).not.toContain('totally_made_up_code');
  });

  it('preserves warning severity for lenient script diagnostics', () => {
    const projection = sanitizeP2pWorkflowStatusProjection({
      runId: 'run-warning',
      workflowId: 'audit',
      status: 'running',
      diagnostics: [
        { code: 'script_machine_output_invalid', phase: 'execute', severity: 'warning', summary: 'lenient parser warning' },
      ],
    });

    const warning = projection.diagnostics.find((d) => d.code === 'script_machine_output_invalid');
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warning');
  });

  it('sanitizeServerSideDiagnostic still rejects non-sanitize codes', () => {
    // sanitizeServerSideDiagnostic is used ONLY for server-emitted sanitize
    // events. It must reject daemon-origin codes like daemon_busy.
    const accepted = sanitizeServerSideDiagnostic(
      { code: 'private_projection_field_dropped', summary: 'ok' },
      'run-x',
    );
    expect(accepted?.code).toBe('private_projection_field_dropped');
    expect(accepted?.runId).toBe('run-x');

    const rejected = sanitizeServerSideDiagnostic({ code: 'daemon_busy', summary: 'no' }, 'run-x');
    expect(rejected).toBeNull();
  });

  it('sanitizeWorkflowDiagnosticForRetention bounds string fields', () => {
    const oversized = 'x'.repeat(P2P_SANITIZE_MAX_STRING_BYTES + 100);
    const diag = sanitizeWorkflowDiagnosticForRetention({
      code: 'daemon_busy',
      phase: 'bind',
      severity: 'error',
      summary: oversized,
      fieldPath: oversized,
      nodeId: oversized,
      runId: oversized,
    });
    expect(diag).not.toBeNull();
    expect(diag!.summary!.length).toBeLessThanOrEqual(P2P_SANITIZE_MAX_STRING_BYTES);
    expect(diag!.fieldPath!.length).toBeLessThanOrEqual(P2P_SANITIZE_MAX_STRING_BYTES);
    expect(diag!.nodeId!.length).toBeLessThanOrEqual(P2P_SANITIZE_MAX_STRING_BYTES);
    expect(diag!.runId!.length).toBeLessThanOrEqual(P2P_SANITIZE_MAX_STRING_BYTES);
  });
});

describe('sanitizeP2pRunForPersistAndBroadcast — DB ↔ broadcast diagnostic parity', () => {
  it('produces identical diagnostic code sets between DB upsert and broadcast', () => {
    const oversized = 'x'.repeat(P2P_SANITIZE_MAX_STRING_BYTES + 100);
    const { persisted, broadcast } = sanitizeP2pRunForPersistAndBroadcast({
      id: 'run-parity',
      discussion_id: 'disc-1',
      mode_key: 'audit',
      status: 'running',
      diagnostics: [
        { code: 'daemon_busy', phase: 'bind', severity: 'error', summary: 'busy' },
        { code: 'missing_required_capability', phase: 'execute' },
      ],
      // Triggers truncation diagnostic via legacyPayloadTruncated path.
      routing_history: Array.from({ length: P2P_SANITIZE_MAX_ARRAY_ITEMS + 10 }, (_, idx) => ({
        step: idx,
        nested: { value: oversized },
      })),
    }, { serverId: 'server-1' });

    const persistedCodes = [...persisted.workflow_projection.diagnostics.map((d) => d.code)].sort();
    const broadcastCodes = [...broadcast.workflow_projection.diagnostics.map((d) => d.code)].sort();
    expect(broadcastCodes).toEqual(persistedCodes);
    // Specifically include the daemon-emitted code AND the truncation code.
    expect(persistedCodes).toContain('daemon_busy');
    expect(persistedCodes).toContain('missing_required_capability');
    expect(persistedCodes).toContain('private_projection_field_dropped');

    // The serialized DB column must reflect the same diagnostics so that
    // subsequent /p2p/runs reads see the same set.
    const persistedSnap = JSON.parse(persisted.progress_snapshot) as { diagnostics: Array<{ code: string }> };
    const persistedSnapCodes = persistedSnap.diagnostics.map((d) => d.code).sort();
    expect(persistedSnapCodes).toEqual(persistedCodes);
  });

  it('shares the same projection object reference between persisted and broadcast', () => {
    const { persisted, broadcast } = sanitizeP2pRunForPersistAndBroadcast({
      id: 'run-share',
      mode_key: 'audit',
      status: 'running',
      diagnostics: [{ code: 'daemon_busy', phase: 'bind' }],
    }, { serverId: 'server-1' });

    expect(persisted.workflow_projection).toBe(broadcast.workflow_projection);
  });
});
