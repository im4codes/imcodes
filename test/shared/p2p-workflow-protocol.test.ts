import { describe, expect, it } from 'vitest';
import {
  P2P_BRIDGE_ERROR_CODES,
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_SCHEMA_VERSION,
} from '../../shared/p2p-workflow-constants.js';
import {
  P2P_WORKFLOW_DIAGNOSTIC_CODES,
  P2P_WORKFLOW_DIAGNOSTIC_PHASE_MATRIX,
  assertP2pDiagnosticMatrixComplete,
  makeP2pWorkflowDiagnostic,
} from '../../shared/p2p-workflow-diagnostics.js';
import {
  P2P_WORKFLOW_MESSAGE_REGISTRY,
  P2P_WORKFLOW_MSG,
  isP2pWorkflowRequestId,
  parseP2pWorkflowMessageType,
  requiresP2pWorkflowRequestId,
} from '../../shared/p2p-workflow-messages.js';
import { P2P_CONFIG_MSG } from '../../shared/p2p-config-events.js';

describe('p2p workflow protocol', () => {
  it('exposes stable schema and capability constants', () => {
    expect(P2P_WORKFLOW_SCHEMA_VERSION).toBe(1);
    expect(P2P_WORKFLOW_CAPABILITY_V1).toBe('p2p.workflow.v1');
    expect(P2P_BRIDGE_ERROR_CODES.PENDING_LIMIT_EXCEEDED).toBe('p2p_pending_limit_exceeded');
  });

  it('keeps diagnostic enum and phase matrix in sync', () => {
    expect(() => assertP2pDiagnosticMatrixComplete()).not.toThrow();
    for (const code of P2P_WORKFLOW_DIAGNOSTIC_CODES) {
      expect(P2P_WORKFLOW_DIAGNOSTIC_PHASE_MATRIX[code].length).toBeGreaterThan(0);
      expect(makeP2pWorkflowDiagnostic(code).messageKey).toBe(`p2p.workflow.diagnostics.${code}`);
    }
  });

  it('parses known p2p messages and drops unknown p2p messages', () => {
    expect(parseP2pWorkflowMessageType(P2P_WORKFLOW_MSG.STATUS)).toMatchObject({
      kind: 'known',
      descriptor: {
        allowedIngress: ['browser'],
        requestScoped: true,
        broadcastAllowed: false,
        expectedResponseType: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
        serverHandling: 'forward_to_daemon',
      },
    });
    expect(parseP2pWorkflowMessageType(P2P_WORKFLOW_MSG.RUN_COMPLETE)).toMatchObject({
      kind: 'known',
      descriptor: {
        allowedIngress: ['daemon'],
        serverHandling: 'persist_run_and_broadcast',
        browserDelivery: 'broadcast',
      },
    });
    expect(parseP2pWorkflowMessageType('p2p.future_message')).toEqual({
      kind: 'drop',
      diagnosticCode: 'unknown_p2p_message',
      reason: 'unknown_p2p_message',
    });
  });

  it('requires bounded ascii request ids for request-scoped messages', () => {
    expect(requiresP2pWorkflowRequestId(P2P_WORKFLOW_MSG.STATUS)).toBe(true);
    expect(requiresP2pWorkflowRequestId(P2P_WORKFLOW_MSG.RUN_UPDATE)).toBe(false);
    expect(isP2pWorkflowRequestId('req_123')).toBe(true);
    expect(isP2pWorkflowRequestId('')).toBe(false);
    expect(isP2pWorkflowRequestId('é')).toBe(false);
    expect(isP2pWorkflowRequestId('x'.repeat(129))).toBe(false);
  });

  it('protocol registry includes p2p.config.save and save_response', () => {
    // Cross-protocol routing: p2p.config.* must be registered alongside the
    // workflow registry so the bridge default-deny excludes them and the
    // generic forward_to_daemon / singlecast_response handlers route them.
    expect(P2P_WORKFLOW_MESSAGE_REGISTRY[P2P_CONFIG_MSG.SAVE]).toBeDefined();
    expect(P2P_WORKFLOW_MESSAGE_REGISTRY[P2P_CONFIG_MSG.SAVE_RESPONSE]).toBeDefined();
    expect(parseP2pWorkflowMessageType(P2P_CONFIG_MSG.SAVE)).toMatchObject({
      kind: 'known',
      descriptor: {
        type: P2P_CONFIG_MSG.SAVE,
        category: 'config',
        allowedIngress: ['browser'],
        serverHandling: 'forward_to_daemon',
        browserDelivery: 'none',
        expectedResponseType: P2P_CONFIG_MSG.SAVE_RESPONSE,
        requestScoped: true,
        response: false,
        broadcastAllowed: false,
      },
    });
    expect(parseP2pWorkflowMessageType(P2P_CONFIG_MSG.SAVE_RESPONSE)).toMatchObject({
      kind: 'known',
      descriptor: {
        type: P2P_CONFIG_MSG.SAVE_RESPONSE,
        category: 'config',
        allowedIngress: ['daemon'],
        serverHandling: 'singlecast_response',
        browserDelivery: 'singlecast',
        responseTo: P2P_CONFIG_MSG.SAVE,
        requestScoped: true,
        response: true,
        broadcastAllowed: false,
      },
    });
  });

  it('p2p.config descriptors carry category "config" and workflow descriptors carry category "workflow"', () => {
    // Category is a load-bearing field — workflow consumers may filter by it
    // and the registry must preserve the "category for every descriptor"
    // invariant so PR-G/PR-K reverse-regression can rely on it.
    for (const descriptor of Object.values(P2P_WORKFLOW_MESSAGE_REGISTRY)) {
      expect(descriptor.category).toBeDefined();
      expect(['workflow', 'config']).toContain(descriptor.category);
    }
    expect(P2P_WORKFLOW_MESSAGE_REGISTRY[P2P_CONFIG_MSG.SAVE].category).toBe('config');
    expect(P2P_WORKFLOW_MESSAGE_REGISTRY[P2P_CONFIG_MSG.SAVE_RESPONSE].category).toBe('config');
    expect(P2P_WORKFLOW_MESSAGE_REGISTRY[P2P_WORKFLOW_MSG.STATUS].category).toBe('workflow');
    expect(P2P_WORKFLOW_MESSAGE_REGISTRY[P2P_WORKFLOW_MSG.RUN_UPDATE].category).toBe('workflow');
    expect(P2P_WORKFLOW_MESSAGE_REGISTRY[P2P_WORKFLOW_MSG.DAEMON_HELLO].category).toBe('workflow');
  });

  it('parseP2pWorkflowMessageType returns "known" for p2p.config.save', () => {
    // After PR-E registration, p2p.config.save must no longer fall through to
    // the unknown_p2p_message drop branch but unrelated p2p.* must still drop.
    const knownConfig = parseP2pWorkflowMessageType(P2P_CONFIG_MSG.SAVE);
    expect(knownConfig.kind).toBe('known');
    expect(requiresP2pWorkflowRequestId(P2P_CONFIG_MSG.SAVE)).toBe(true);
    expect(requiresP2pWorkflowRequestId(P2P_CONFIG_MSG.SAVE_RESPONSE)).toBe(true);
    // Default-deny still works for any p2p.* not in the registry.
    expect(parseP2pWorkflowMessageType('p2p.config.future_secret')).toEqual({
      kind: 'drop',
      diagnosticCode: 'unknown_p2p_message',
      reason: 'unknown_p2p_message',
    });
  });
});
