/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_ERROR,
  CAPABILITY_HTTP_PATH,
  CAPABILITY_KIND,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  capabilityCancellationPath,
  capabilityConfirmationPath,
  capabilityManagePath,
  capabilityOperationPath,
  type CapabilityOperation,
} from '@shared/capability-management.js';

const apiFetchMock = vi.fn();
vi.mock('../src/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/api.js')>(),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import {
  CapabilityManageAmbiguousError,
  CapabilityRequestError,
  cancelCapabilityOperation,
  decideCapabilityOperation,
  getCapabilityOperation,
  installCapability,
  listCapabilities,
  manageCapability,
  normalizeCapabilityManageError,
  parseCapabilityRequestError,
  parseCapabilityManageChoices,
} from '../src/api/capabilities.js';

const operation: CapabilityOperation = {
  id: 'op-1',
  capabilityId: 'cap-1',
  kind: CAPABILITY_KIND.SKILL,
  state: 'awaiting_confirmation',
  revision: 4,
  scope: CAPABILITY_SCOPE.ACCOUNT,
  artifactDigest: 'artifact-digest',
  auditDigest: 'audit-digest',
  findings: [],
  providers: ['codex'],
  machines: ['machine-1'],
  hasScripts: false,
  hasExecutables: false,
  createdAt: 1,
  updatedAt: 2,
};

describe('capability API client', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('uses shared paths and preserves serverId pod routing', async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ operation });
    await listCapabilities('server 1');
    await getCapabilityOperation(operation.id, 'server 1');
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`${CAPABILITY_HTTP_PATH.LIST}?serverId=server%201`);
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe(`${capabilityOperationPath(operation.id)}?serverId=server%201`);
  });

  it('submits the shared install request without a browser-only wrapper', async () => {
    apiFetchMock.mockResolvedValue({ operation });
    const request = {
      kind: CAPABILITY_KIND.SKILL,
      scope: CAPABILITY_SCOPE.ACCOUNT,
      source: { kind: CAPABILITY_SOURCE_KIND.URL, value: 'https://example.test/skill.zip' },
      idempotencyKey: 'idem-1',
    } as const;
    await installCapability({ request, serverId: 'server-1' });
    expect(apiFetchMock).toHaveBeenCalledWith(
      `${CAPABILITY_HTTP_PATH.INSTALL}?serverId=server-1`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
  });

  it('binds browser confirmation to all rendered digest evidence and targets', async () => {
    apiFetchMock.mockResolvedValue({ operation: { ...operation, state: 'installing' } });
    await decideCapabilityOperation(operation, CAPABILITY_CONFIRMATION_DECISION.INSTALL, 'server-1');
    const [, init] = apiFetchMock.mock.calls[0] as [string, RequestInit];
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`${capabilityConfirmationPath(operation.id)}?serverId=server-1`);
    expect(JSON.parse(String(init.body))).toEqual({
      operationId: operation.id,
      revision: operation.revision,
      artifactDigest: operation.artifactDigest,
      auditDigest: operation.auditDigest,
      scope: operation.scope,
      providers: operation.providers,
      machines: operation.machines,
      decision: CAPABILITY_CONFIRMATION_DECISION.INSTALL,
    });
  });

  it('fails locally instead of sending a confirmation without audit evidence', async () => {
    await expect(decideCapabilityOperation({ ...operation, auditDigest: undefined }, CAPABILITY_CONFIRMATION_DECISION.INSTALL))
      .rejects.toThrow('confirmation_evidence_missing');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('rejects an install confirmation response that did not cross the irreversible boundary', async () => {
    apiFetchMock.mockResolvedValue({ operation });
    await expect(decideCapabilityOperation(operation, CAPABILITY_CONFIRMATION_DECISION.INSTALL))
      .rejects.toMatchObject({ reason: CAPABILITY_ERROR.CONFLICT });
  });

  it.each(['queued', 'auditing'] as const)('cancels a %s operation through the authoritative cancellation route', async (state) => {
    const operationId = `op-${state}`;
    const cancellable = { ...operation, id: operationId, state };
    apiFetchMock.mockResolvedValue({ operation: { ...operation, state: 'cancelled' } });
    await cancelCapabilityOperation(cancellable, 'server-1');
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`${capabilityCancellationPath(operationId)}?serverId=server-1`);
    const body = JSON.parse(String((apiFetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toEqual({ revision: operation.revision });
  });

  it('rejects cancellation locally after the irreversible install boundary', async () => {
    await expect(cancelCapabilityOperation({ ...operation, state: 'installing' }, 'server-1'))
      .rejects.toMatchObject({ reason: CAPABILITY_ERROR.CONFLICT });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('posts management actions to the shared capability route', async () => {
    const capability = {
      id: 'cap-1', revision: 1, kind: CAPABILITY_KIND.SKILL, name: 'Review', state: 'disabled', scope: CAPABILITY_SCOPE.ACCOUNT,
      readiness: 'ready', findings: [], updatedAt: 4,
    } as const;
    apiFetchMock.mockResolvedValue({ capability });
    await manageCapability(capability.id, {
      action: CAPABILITY_MANAGE_ACTION.ENABLE,
      bindingId: 'binding-account',
      scope: CAPABILITY_SCOPE.ACCOUNT,
      expectedRevision: capability.revision,
      userIntent: 'Enable Review',
    }, 'server-1');
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`${capabilityManagePath(capability.id)}?serverId=server-1`);
    const body = JSON.parse(String((apiFetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      capabilityId: capability.id,
      bindingId: 'binding-account',
      scope: CAPABILITY_SCOPE.ACCOUNT,
      action: CAPABILITY_MANAGE_ACTION.ENABLE,
      expectedRevision: capability.revision,
    });
  });

  it('preserves typed server binding choices instead of flattening ambiguity', () => {
    const ambiguous = { status: 409, body: JSON.stringify({
      error: 'ambiguous',
      choices: [{
        id: 'cap-1',
        bindingId: 'binding-session',
        name: 'Review',
        kind: CAPABILITY_KIND.SKILL,
        state: 'active',
        scope: CAPABILITY_SCOPE.SESSION,
        scopeId: 'session-1',
      }],
    }) };
    expect(parseCapabilityManageChoices(ambiguous)).toEqual([
      expect.objectContaining({ bindingId: 'binding-session', scopeId: 'session-1' }),
    ]);
    const normalized = normalizeCapabilityManageError(ambiguous);
    expect(normalized).toBeInstanceOf(CapabilityManageAmbiguousError);
    expect((normalized as CapabilityManageAmbiguousError).choices).toEqual([
      expect.objectContaining({ bindingId: 'binding-session', scopeId: 'session-1' }),
    ]);
  });

  it('bounds and preserves content-safe quota errors without trusting oversized bodies', () => {
    const quota = parseCapabilityRequestError({
      status: 429,
      body: JSON.stringify({ status: 'error', reason: CAPABILITY_ERROR.RATE_LIMITED, error: 'Capability quota reached', retryable: true, requestId: 'request_1' }),
    });
    expect(quota).toBeInstanceOf(CapabilityRequestError);
    expect(quota).toMatchObject({
      status: 429,
      reason: CAPABILITY_ERROR.RATE_LIMITED,
      safeMessage: 'Capability quota reached',
      retryable: true,
      requestId: 'request_1',
    });
    expect(parseCapabilityRequestError({
      status: 429,
      body: JSON.stringify({ reason: CAPABILITY_ERROR.RATE_LIMITED, error: 'x'.repeat(5_000) }),
    })).toBeNull();
  });
});
