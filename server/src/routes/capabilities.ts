import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { randomUUID } from 'node:crypto';
import {
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_BLOB_TOKEN_HEADER,
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_ERROR,
  CAPABILITY_HTTP_PATH,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_KIND,
  CAPABILITY_LIFECYCLE_STATES,
  CAPABILITY_LIMITS,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_MANAGE_PHASE,
  CAPABILITY_MANAGEMENT_ACTIONS,
  CAPABILITY_OPERATION_MSG,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_SYNC_MSG,
  capabilityConfirmationPath,
  capabilityBlobAccessPath,
  capabilityBlobTransferPath,
  capabilityCancellationPath,
  capabilityManagePath,
  capabilityOperationPath,
  isCapabilityCredentialFreeHttpsUrl,
  validateCapabilityInstallRequest,
  type CapabilityInstallRequest,
  type CapabilityManagementAction,
  type CapabilityOperationConfirmFrame,
  type CapabilityOperationCancelFrame,
  type CapabilityOperationInstallFrame,
  type CapabilityOperationManageFrame,
  type CapabilityManageRequest,
  type CapabilityReadiness,
  type CapabilityScope,
} from '../../../shared/capability-management.js';
import { COOKIE_SESSION } from '../../../shared/cookie-names.js';
import type { Env } from '../env.js';
import {
  acknowledgeCapabilityReadiness,
  cancelCapabilityOperation,
  confirmCapabilityOperation,
  createInstallOperation,
  getCapability,
  getCapabilityOperation,
  getCapabilitySyncSnapshot,
  failCapabilityPendingActivationByVersion,
  listCapabilities,
  listCapabilityAuditEvidence,
  listRecentCapabilityOperations,
  manageCapability,
  resolveCapabilityManagementTarget,
  reserveLocalCapabilityManage,
  updateCapabilityOperation,
} from '../db/capabilities.js';
import { requireAuth, requireOwner } from '../security/authorization.js';
import { sha256Hex } from '../security/crypto.js';
import {
  toCapabilityOperationWire,
  toCapabilitySummary,
  toCapabilitySyncSnapshot,
} from '../services/capability-wire.js';
import {
  consumeCapabilityBlobAccess,
  issueCapabilityBlobAccess,
  persistCapabilityBlobUpload,
  readCapabilityBlobDownload,
} from '../services/capability-package-storage.js';
import { createCapabilityAuthorizationSigner } from '../services/capability-authorization.js';
import { MemoryRateLimiter } from '../ws/rate-limiter.js';
import { WsBridge } from '../ws/bridge.js';
import logger from '../util/logger.js';

type CapabilityRouteVariables = {
  userId: string;
  role: string;
  authServerId?: string;
};

export const capabilityRoutes = new Hono<{ Bindings: Env; Variables: CapabilityRouteVariables }>();
const capabilityRateLimiter = new MemoryRateLimiter();

const CAPABILITY_ROUTE_RATE_LIMIT = 60;
const CAPABILITY_ROUTE_RATE_WINDOW_MS = 60_000;
const CAPABILITY_RECENT_TERMINAL_OPERATIONS = CAPABILITY_LIMITS.AMBIGUOUS_CHOICES;
const CAPABILITY_ACTIVE_OPERATIONS = CAPABILITY_LIMITS.LIST_MAX;

function ownerId(c: { get: (key: 'userId') => string }): string {
  return c.get('userId');
}

function requiredOpaqueId(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized && normalized.length <= 128 ? normalized : null;
}

function errorBody(reason: string): { status: 'error'; reason: string; error: string } {
  return { status: 'error', reason, error: reason };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > CAPABILITY_LIMITS.PATH_BYTES) return null;
    output.push(item.trim());
  }
  return output;
}

function encodeCursor(cursor: { updatedAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): { updatedAt: number; id: string } | undefined {
  if (!raw || raw.length > 512) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!isPlainRecord(parsed)
      || !Number.isSafeInteger(parsed.updatedAt)
      || typeof parsed.id !== 'string'
      || parsed.id.length > 128) return undefined;
    return { updatedAt: parsed.updatedAt as number, id: parsed.id };
  } catch {
    return undefined;
  }
}

function rateLimit(c: { get: (key: 'userId') => string }): boolean {
  return capabilityRateLimiter.check(
    `capability:${ownerId(c)}`,
    CAPABILITY_ROUTE_RATE_LIMIT,
    CAPABILITY_ROUTE_RATE_WINDOW_MS,
  );
}

function sanitizeInstallRequest(input: CapabilityInstallRequest, targetServerId: string): Record<string, unknown> {
  const locator = input.source.value?.trim();
  const mcpConfigKeys = input.source.mcpConfig
    ? Object.keys(input.source.mcpConfig).sort().slice(0, CAPABILITY_LIMITS.FINDINGS)
    : [];
  const inlineFileNames = input.source.inlineFiles
    ? Object.keys(input.source.inlineFiles).sort().slice(0, CAPABILITY_LIMITS.FILE_COUNT)
    : [];
  const sourceLabel = capabilitySourceLabel(input);
  return {
    ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
    ...(input.bindingId ? { bindingId: input.bindingId } : {}),
    kind: input.kind,
    sourceKind: input.source.kind,
    ...(locator ? { sourceLocatorDigest: sha256Hex(locator) } : {}),
    ...(input.source.repositorySubdir
      ? { repositorySubdirDigest: sha256Hex(input.source.repositorySubdir) }
      : {}),
    ...(mcpConfigKeys.length > 0 ? { mcpConfigKeys } : {}),
    ...(inlineFileNames.length > 0
      ? {
        inlineFileCount: inlineFileNames.length,
        inlineFileNameDigest: sha256Hex(JSON.stringify(inlineFileNames)),
      }
      : {}),
    ...(sourceLabel ? { sourceLabel } : {}),
    displayName: input.displayName,
    scope: input.scope,
    scopeId: input.scopeId,
    providers: input.providers ?? [],
    machines: input.machines ?? [],
    targetServerId,
  };
}

function capabilitySourceLabel(input: CapabilityInstallRequest): string | undefined {
  const displayName = input.displayName?.trim().slice(0, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS);
  if (input.source.kind === CAPABILITY_SOURCE_KIND.INLINE) return displayName || 'inline-package';
  if (input.source.kind === CAPABILITY_SOURCE_KIND.MCP_CONFIG) return displayName || 'MCP configuration';
  const raw = input.source.value?.trim();
  if (!raw) return displayName || undefined;
  if (input.source.kind === CAPABILITY_SOURCE_KIND.LOCAL_PATH) {
    const basename = raw.split(/[\\/]/).filter(Boolean).at(-1)?.trim();
    return basename?.slice(0, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS) || displayName || undefined;
  }
  try {
    const url = new URL(raw);
    if (input.source.kind === CAPABILITY_SOURCE_KIND.URL) return url.hostname.slice(0, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS);
    const repository = url.pathname.split('/').filter(Boolean).slice(-2)
      .map((segment) => segment.replace(/\.git$/i, ''))
      .join('/');
    return `${url.hostname}${repository ? `/${repository}` : ''}`.slice(0, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS);
  } catch {
    return displayName || undefined;
  }
}

async function readBoundedBinaryBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!body || maxBytes < 1 || maxBytes > CAPABILITY_LIMITS.PACKAGE_BYTES) return null;
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return bytes === maxBytes ? Buffer.concat(chunks, bytes) : null;
}

async function broadcastCapabilitySyncSafely(
  db: Env['DB'],
  ownerUserId: string,
  accountRevision: number,
): Promise<void> {
  await WsBridge.broadcastCapabilitySync(
    ownerUserId,
    db,
    Math.max(0, accountRevision - 1),
  ).catch((error: unknown) => {
    logger.warn({ error, ownerUserId, accountRevision }, 'Capability sync broadcast failed');
    return 0;
  });
}

capabilityRoutes.get('/capabilities', requireOwner(), async (c) => {
  if (!rateLimit(c)) return c.json(errorBody(CAPABILITY_ERROR.RATE_LIMITED), 429);
  const rawLimit = c.req.query('limit');
  const limit = rawLimit ? Number(rawLimit) : CAPABILITY_LIMITS.LIST_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CAPABILITY_LIMITS.LIST_MAX) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  const cursorRaw = c.req.query('cursor');
  const cursor = decodeCursor(cursorRaw);
  if (cursorRaw && !cursor) return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  const kind = c.req.query('kind');
  const state = c.req.query('state');
  const scope = c.req.query('scope');
  const query = c.req.query('query')?.trim();
  if ((kind && !Object.values(CAPABILITY_KIND).includes(kind as never))
    || (state && !CAPABILITY_LIFECYCLE_STATES.includes(state as never))
    || (scope && !Object.values(CAPABILITY_SCOPE).includes(scope as never))
    || (query && query.length > CAPABILITY_LIMITS.DISPLAY_NAME_CHARS)) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  const result = await listCapabilities(c.env.DB, {
    ownerUserId: ownerId(c),
    limit,
    cursor,
    includeRemoved: c.req.query('includeRemoved') === 'true',
    kind: kind as Parameters<typeof listCapabilities>[1]['kind'],
    state: state as Parameters<typeof listCapabilities>[1]['state'],
    scope: scope as Parameters<typeof listCapabilities>[1]['scope'],
    query: query || undefined,
  });
  const operations = await listRecentCapabilityOperations(c.env.DB, {
    ownerUserId: ownerId(c),
    activeLimit: CAPABILITY_ACTIVE_OPERATIONS,
    terminalLimit: CAPABILITY_RECENT_TERMINAL_OPERATIONS,
  });
  return c.json({
    items: result.items.map(toCapabilitySummary),
    operations: operations.map(toCapabilityOperationWire),
    ...(result.nextCursor ? { nextCursor: encodeCursor(result.nextCursor) } : {}),
  });
});

capabilityRoutes.get('/capabilities/operations/:operationId', requireOwner(), async (c) => {
  if (!rateLimit(c)) return c.json(errorBody(CAPABILITY_ERROR.RATE_LIMITED), 429);
  const operationId = requiredOpaqueId(c.req.param('operationId'));
  if (!operationId) return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  const operation = await getCapabilityOperation(c.env.DB, {
    ownerUserId: ownerId(c),
    operationId,
  });
  return operation
    ? c.json({ operation: toCapabilityOperationWire(operation) })
    : c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
});

capabilityRoutes.get('/capabilities/:capabilityId', requireOwner(), async (c) => {
  if (!rateLimit(c)) return c.json(errorBody(CAPABILITY_ERROR.RATE_LIMITED), 429);
  const capabilityId = requiredOpaqueId(c.req.param('capabilityId'));
  if (!capabilityId) return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  const item = await getCapability(c.env.DB, {
    ownerUserId: ownerId(c),
    itemId: capabilityId,
  });
  return item
    ? c.json({ capability: toCapabilitySummary(item) })
    : c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
});

capabilityRoutes.get('/capabilities/:capabilityId/audit', requireOwner(), async (c) => {
  if (!rateLimit(c)) return c.json(errorBody(CAPABILITY_ERROR.RATE_LIMITED), 429);
  const capabilityId = requiredOpaqueId(c.req.param('capabilityId'));
  if (!capabilityId) return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  const item = await getCapability(c.env.DB, {
    ownerUserId: ownerId(c),
    itemId: capabilityId,
  });
  if (!item) return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
  const evidence = await listCapabilityAuditEvidence(c.env.DB, {
    ownerUserId: ownerId(c),
    itemId: item.id,
    limit: CAPABILITY_LIMITS.FINDINGS,
  });
  return c.json({ evidence });
});

capabilityRoutes.post('/capabilities/install', requireOwner(), async (c) => {
  if (!rateLimit(c)) return c.json(errorBody(CAPABILITY_ERROR.RATE_LIMITED), 429);
  const serverId = requiredOpaqueId(c.req.query('serverId'));
  if (!serverId) return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  const body = await c.req.json<CapabilityInstallRequest>().catch(() => null);
  if (!body || !isPlainRecord(body) || !isPlainRecord(body.source)) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  const validationError = validateCapabilityInstallRequest(body);
  if (validationError || (body.source.kind === CAPABILITY_SOURCE_KIND.URL
    && !isCapabilityCredentialFreeHttpsUrl(body.source.value))) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  if (body.capabilityId) {
    const updateTargetId = requiredOpaqueId(body.capabilityId);
    if (!updateTargetId || updateTargetId !== body.capabilityId) {
      return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
    }
    const updateTarget = await getCapability(c.env.DB, {
      ownerUserId: ownerId(c),
      itemId: updateTargetId,
    });
    if (!updateTarget) return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
    if (updateTarget.kind !== body.kind || updateTarget.removedAt !== null) {
      return c.json(errorBody(CAPABILITY_ERROR.CONFLICT), 409);
    }
    const updateBinding = updateTarget.bindings.find((binding) => binding.id === body.bindingId);
    const requestedScopeId = body.scopeId ?? null;
    const bindingScopeId = updateBinding?.projectKey
      ?? updateBinding?.sessionKey
      ?? updateBinding?.serverId
      ?? null;
    if (!updateBinding
      || updateBinding.scope !== body.scope
      || bindingScopeId !== requestedScopeId
      || JSON.stringify([...updateBinding.providerFilter].sort()) !== JSON.stringify([...(body.providers ?? [])].sort())
      || JSON.stringify([...updateBinding.machineFilter].sort()) !== JSON.stringify([...(body.machines ?? [])].sort())) {
      return c.json(errorBody(CAPABILITY_ERROR.CONFLICT), 409);
    }
  }
  const bridge = WsBridge.get(serverId);
  if (!bridge.canAcceptCapabilityOperation(ownerId(c))) {
    return c.json(errorBody(CAPABILITY_ERROR.RUNTIME_PENDING), 503);
  }
  const result = await createInstallOperation(c.env.DB, {
    ownerUserId: ownerId(c),
    idempotencyKey: body.idempotencyKey,
    requestSummary: sanitizeInstallRequest(body, serverId),
  });
  if (result.created) {
    const frame: CapabilityOperationInstallFrame = {
      type: CAPABILITY_OPERATION_MSG.INSTALL,
      operationId: result.operation.id,
      ownerId: ownerId(c),
      revision: result.operation.revision,
      request: body,
    };
    if (!bridge.dispatchCapabilityInstall(ownerId(c), frame)) {
      const failed = await updateCapabilityOperation(c.env.DB, {
        ownerUserId: ownerId(c),
        operationId: result.operation.id,
        expectedRevision: result.operation.revision,
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode: CAPABILITY_ERROR.RUNTIME_PENDING,
      });
      return c.json({
        ...errorBody(CAPABILITY_ERROR.RUNTIME_PENDING),
        ...(failed ? { operation: toCapabilityOperationWire(failed) } : {}),
      }, 503);
    }
  }
  return c.json({ operation: toCapabilityOperationWire(result.operation) }, result.created ? 202 : 200);
});

capabilityRoutes.post('/capabilities/operations/:operationId/confirmation', requireOwner(), async (c) => {
  if (!rateLimit(c)) return c.json(errorBody(CAPABILITY_ERROR.RATE_LIMITED), 429);
  // Confirmation is deliberately browser-only. Provider/AI/daemon Bearer
  // credentials cannot synthesize the one human click.
  if (c.req.header('Authorization') || !getCookie(c, COOKIE_SESSION)) {
    return c.json(errorBody(CAPABILITY_ERROR.FORBIDDEN), 403);
  }
  const operationId = requiredOpaqueId(c.req.param('operationId'));
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!operationId
    || !body
    || !Number.isSafeInteger(body.revision)
    || (body.revision as number) < 1
    || !Object.values(CAPABILITY_CONFIRMATION_DECISION).includes(body.decision as never)) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  const current = await getCapabilityOperation(c.env.DB, {
    ownerUserId: ownerId(c),
    operationId,
  });
  if (!current) return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
  if (!current.artifactDigest || !current.auditDigest) {
    return c.json(errorBody(CAPABILITY_ERROR.CONFIRMATION_STALE), 409);
  }
  // The browser submits only decision + rendered revision. All security-bound
  // evidence and targets are re-read authoritatively from the operation row;
  // optional echoed values are accepted solely as stale-card detection.
  if ((typeof body.artifactDigest === 'string' && body.artifactDigest !== current.artifactDigest)
    || (typeof body.auditDigest === 'string' && body.auditDigest !== current.auditDigest)) {
    return c.json(errorBody(CAPABILITY_ERROR.CONFIRMATION_STALE), 409);
  }
  const scope = Object.values(CAPABILITY_SCOPE).includes(current.requestSummary.scope as CapabilityScope)
    ? current.requestSummary.scope as CapabilityScope
    : CAPABILITY_SCOPE.ACCOUNT;
  const providers = asStringArray(current.requestSummary.providers, CAPABILITY_LIMITS.PROVIDERS) ?? [];
  const machines = asStringArray(current.requestSummary.machines, CAPABILITY_LIMITS.MACHINES) ?? [];
  const scopeId = typeof current.requestSummary.scopeId === 'string'
    ? current.requestSummary.scopeId
    : undefined;
  const capabilityId = requiredOpaqueId(
    typeof current.requestSummary.capabilityId === 'string'
      ? current.requestSummary.capabilityId
      : undefined,
  );
  const bindingId = requiredOpaqueId(
    typeof current.requestSummary.bindingId === 'string'
      ? current.requestSummary.bindingId
      : undefined,
  );
  if ((capabilityId === undefined) !== (bindingId === undefined)) {
    return c.json(errorBody(CAPABILITY_ERROR.CONFIRMATION_STALE), 409);
  }
  const targetServerId = requiredOpaqueId(
    typeof current.requestSummary.targetServerId === 'string'
      ? current.requestSummary.targetServerId
      : undefined,
  );
  const isInstallDecision = body.decision === CAPABILITY_CONFIRMATION_DECISION.INSTALL;
  if (!targetServerId && isInstallDecision) return c.json(errorBody(CAPABILITY_ERROR.CONFIRMATION_STALE), 409);
  const bridge = targetServerId ? WsBridge.get(targetServerId) : null;
  if (isInstallDecision && !bridge?.canAcceptCapabilityOperation(ownerId(c))) {
    return c.json(errorBody(CAPABILITY_ERROR.RUNTIME_PENDING), 503);
  }
  const result = await confirmCapabilityOperation(c.env.DB, {
    ownerUserId: ownerId(c),
    operationId,
    expectedRevision: body.revision as number,
    decision: body.decision as typeof CAPABILITY_CONFIRMATION_DECISION[keyof typeof CAPABILITY_CONFIRMATION_DECISION],
    artifactDigest: current.artifactDigest,
    auditDigest: current.auditDigest,
    targetSummary: {
      scope,
      ...(scopeId ? { scopeId } : {}),
      ...(capabilityId ? { capabilityId } : {}),
      ...(bindingId ? { bindingId } : {}),
      providers,
      machines,
    },
  });
  if (result.status === 'not_found') return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
  if (result.status !== 'ok') return c.json(errorBody(CAPABILITY_ERROR.CONFIRMATION_STALE), 409);
  const frame: CapabilityOperationConfirmFrame = {
    type: CAPABILITY_OPERATION_MSG.CONFIRM,
    operationId,
    expectedRevision: result.operation.revision,
    decision: body.decision as typeof CAPABILITY_CONFIRMATION_DECISION[keyof typeof CAPABILITY_CONFIRMATION_DECISION],
    artifactDigest: current.artifactDigest,
    auditDigest: current.auditDigest,
    scope,
    providers,
    machines,
  };
  const delivered = bridge?.dispatchCapabilityConfirmation(ownerId(c), frame) ?? false;
  if (isInstallDecision && !delivered) {
    const failed = await updateCapabilityOperation(c.env.DB, {
      ownerUserId: ownerId(c),
      operationId,
      expectedRevision: result.operation.revision,
      state: CAPABILITY_INSTALL_STATE.FAILED,
      errorCode: CAPABILITY_ERROR.RUNTIME_PENDING,
    });
    return c.json({
      ...errorBody(CAPABILITY_ERROR.RUNTIME_PENDING),
      ...(failed ? { operation: toCapabilityOperationWire(failed) } : {}),
    }, 503);
  }
  // Cancel is authoritative even while the daemon is offline. A live daemon
  // receives best-effort cleanup; reconnect/status reconciliation observes the
  // server-side cancelled state and must not resurrect the operation.
  return c.json({ operation: toCapabilityOperationWire(result.operation) });
});

capabilityRoutes.post('/capabilities/operations/:operationId/cancel', requireOwner(), async (c) => {
  if (!rateLimit(c)) return c.json(errorBody(CAPABILITY_ERROR.RATE_LIMITED), 429);
  const operationId = requiredOpaqueId(c.req.param('operationId'));
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!operationId || !body || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  const current = await getCapabilityOperation(c.env.DB, {
    ownerUserId: ownerId(c),
    operationId,
  });
  if (!current) return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
  const result = await cancelCapabilityOperation(c.env.DB, {
    ownerUserId: ownerId(c),
    operationId,
    expectedRevision: body.revision as number,
  });
  if (result.status === 'not_found') return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
  if (result.status !== 'ok') return c.json(errorBody(CAPABILITY_ERROR.CONFLICT), 409);

  // Cancellation is authoritative before delivery. Cleanup is live best-effort
  // and an offline daemon cannot block the owner or resurrect this revision.
  const targetServerId = requiredOpaqueId(
    typeof current.requestSummary.targetServerId === 'string'
      ? current.requestSummary.targetServerId
      : undefined,
  );
  if (targetServerId) {
    const frame: CapabilityOperationCancelFrame = {
      type: CAPABILITY_OPERATION_MSG.CANCEL,
      operationId,
      expectedRevision: result.operation.revision,
    };
    WsBridge.get(targetServerId).dispatchCapabilityCancellation(ownerId(c), frame);
  }
  return c.json({ operation: toCapabilityOperationWire(result.operation) });
});

capabilityRoutes.post('/capabilities/:capabilityId/manage', requireOwner(), async (c) => {
  if (!rateLimit(c)) return c.json(errorBody(CAPABILITY_ERROR.RATE_LIMITED), 429);
  const capabilityId = requiredOpaqueId(c.req.param('capabilityId'));
  if (!capabilityId) return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  const body = await c.req.json<CapabilityManageRequest & { expectedRevision?: number }>().catch(() => null);
  if (!body
    || !Object.values(CAPABILITY_MANAGE_ACTION).includes(body.action)
    || body.action === CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION
    || !Number.isSafeInteger(body.expectedRevision)
    || (body.expectedRevision ?? 0) < 1) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  if ((body.action === CAPABILITY_MANAGE_ACTION.UNINSTALL
      || body.action === CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS)
    && !body.userIntent?.trim()) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  const scope = body.scope;
  const needsBinding = body.action !== CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS;
  const target = needsBinding ? await resolveCapabilityManagementTarget(c.env.DB, {
    ownerUserId: ownerId(c),
    itemId: capabilityId,
    expectedRevision: body.expectedRevision!,
    bindingId: body.bindingId,
    targetVersionId: body.versionId,
  }) : null;
  if (target && target.status === 'not_found') return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
  if (target && target.status === 'stale') return c.json(errorBody(CAPABILITY_ERROR.CONFLICT), 409);
  if (target && (target.status === 'binding_not_found' || target.status === 'version_not_found')) {
    return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
  }
  if (target?.status === 'ambiguous_binding') {
    const current = await getCapability(c.env.DB, { ownerUserId: ownerId(c), itemId: capabilityId });
    if (!current) return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
    return c.json({
      ...errorBody(CAPABILITY_ERROR.AMBIGUOUS),
      choices: target.bindings.map((binding) => ({
        id: current.id,
        kind: current.kind,
        name: current.name,
        state: current.lifecycleState,
        scope: binding.scope,
        bindingId: binding.id,
        scopeId: binding.projectKey ?? binding.sessionKey ?? binding.serverId ?? undefined,
      })),
    }, 409);
  }
  let localRequestId: string | null = null;
  if (target?.status === 'ok' && target.binding.scope === CAPABILITY_SCOPE.LOCAL) {
    const localServerId = target.binding.serverId;
    if (!localServerId || (c.req.query('serverId') && c.req.query('serverId') !== localServerId)) {
      return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
    }
    const bridge = WsBridge.get(localServerId);
    if (!bridge.canAcceptCapabilityOperation(ownerId(c))) {
      return c.json({ ...errorBody(CAPABILITY_ERROR.RUNTIME_PENDING), retryable: true }, 503);
    }
    const requestId = randomUUID();
    const localManageTimeoutMs = 10_000;
    // Keep the durable reservation alive beyond the network wait so a timely
    // daemon ACK cannot be followed by an expiry race before the DB commit.
    const localManageReservationMs = localManageTimeoutMs + 5_000;
    const reserved = await reserveLocalCapabilityManage(c.env.DB, {
      requestId,
      ownerUserId: ownerId(c),
      itemId: capabilityId,
      bindingId: target.binding.id,
      serverId: localServerId,
      action: body.action as CapabilityOperationManageFrame['action'],
      expectedRevision: body.expectedRevision!,
      targetVersionId: body.versionId,
      timeoutMs: localManageReservationMs,
      authorizationSigner: createCapabilityAuthorizationSigner(c.env.JWT_SIGNING_KEY),
    });
    if (reserved.status !== 'ok') {
      return c.json(errorBody(
        reserved.status === 'not_found' ? CAPABILITY_ERROR.NOT_FOUND : CAPABILITY_ERROR.CONFLICT,
      ), reserved.status === 'not_found' ? 404 : 409);
    }
    localRequestId = reserved.request.requestId;
    if (reserved.request.phase !== 'committed') {
      const phase = reserved.request.phase === 'prepare_sent'
        ? CAPABILITY_MANAGE_PHASE.PREPARE
        : CAPABILITY_MANAGE_PHASE.COMMIT;
      const frame: CapabilityOperationManageFrame = {
        type: CAPABILITY_OPERATION_MSG.MANAGE,
        phase,
        requestId: reserved.request.requestId,
        ownerId: ownerId(c),
        serverId: localServerId,
        capabilityId,
        bindingId: target.binding.id,
        action: body.action as CapabilityOperationManageFrame['action'],
        expectedRevision: body.expectedRevision!,
        authorityRevision: reserved.request.authorityRevision,
        ...(body.action === CAPABILITY_MANAGE_ACTION.ROLLBACK && body.versionId
          ? { versionId: body.versionId }
          : {}),
        ...(reserved.request.authorization ? { authorization: reserved.request.authorization } : {}),
      };
      const daemonResult = await bridge.dispatchCapabilityManage(ownerId(c), frame, localManageTimeoutMs);
      if (!daemonResult) {
        return c.json({
          ...errorBody(CAPABILITY_ERROR.RUNTIME_PENDING),
          retryable: true,
          requestId: reserved.request.requestId,
        }, 503);
      }
      if (!daemonResult.ok) {
        const code = daemonResult.errorCode ?? CAPABILITY_ERROR.CONFLICT;
        return c.json({
          ...errorBody(code),
          retryable: code === CAPABILITY_ERROR.RUNTIME_PENDING,
          requestId: reserved.request.requestId,
        }, code === CAPABILITY_ERROR.RUNTIME_PENDING ? 503 : 409);
      }
    }
  }
  const result = await manageCapability(c.env.DB, {
    ownerUserId: ownerId(c),
    itemId: capabilityId,
    expectedRevision: body.expectedRevision!,
    action: body.action as Exclude<CapabilityManagementAction, typeof CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION>,
    bindingId: body.bindingId,
    targetVersionId: body.versionId,
    scope,
    serverId: target?.status === 'ok' && target.binding.scope === CAPABILITY_SCOPE.LOCAL
      ? target.binding.serverId
      : scope === CAPABILITY_SCOPE.LOCAL || body.bindingId
        ? c.req.query('serverId') ?? null
        : null,
    localRequestId,
    authorizationSigner: createCapabilityAuthorizationSigner(c.env.JWT_SIGNING_KEY),
  });
  if (result.status === 'not_found' || result.status === 'version_not_found') {
    return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
  }
  if (result.status === 'binding_not_found') {
    return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
  }
  if (result.status === 'ambiguous_binding') {
    const current = await getCapability(c.env.DB, { ownerUserId: ownerId(c), itemId: capabilityId });
    if (!current) return c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
    return c.json({
      ...errorBody(CAPABILITY_ERROR.AMBIGUOUS),
      choices: result.bindings.map((binding) => ({
        id: current.id,
        kind: current.kind,
        name: current.name,
        state: current.lifecycleState,
        scope: binding.scope,
        bindingId: binding.id,
        scopeId: binding.projectKey ?? binding.sessionKey ?? binding.serverId ?? undefined,
      })),
    }, 409);
  }
  if (result.status === 'runtime_pending') {
    return c.json({ ...errorBody(CAPABILITY_ERROR.RUNTIME_PENDING), retryable: false }, 503);
  }
  if (result.status !== 'ok') return c.json(errorBody(CAPABILITY_ERROR.CONFLICT), 409);
  await broadcastCapabilitySyncSafely(c.env.DB, ownerId(c), result.accountRevision);
  return c.json({ capability: toCapabilitySummary(result.item), revision: result.accountRevision });
});

capabilityRoutes.post('/capabilities/blobs/:versionId/access', requireAuth(), async (c) => {
  const ownerUserId = ownerId(c);
  const serverId = c.get('authServerId');
  const versionId = requiredOpaqueId(c.req.param('versionId'));
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const capabilityId = requiredOpaqueId(typeof body?.capabilityId === 'string' ? body.capabilityId : undefined);
  const action = Object.values(CAPABILITY_BLOB_ACTION).find((candidate) => candidate === body?.action);
  if (!serverId) return c.json(errorBody(CAPABILITY_ERROR.FORBIDDEN), 403);
  if (!versionId || !capabilityId || !action) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  const access = await issueCapabilityBlobAccess(c.env.DB, {
    ownerUserId,
    serverId,
    capabilityId,
    versionId,
    action,
    signingKey: c.env.JWT_SIGNING_KEY,
  });
  return access
    ? c.json({ access })
    : c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
});

capabilityRoutes.put('/capabilities/blobs/:versionId', requireAuth(), async (c) => {
  const ownerUserId = ownerId(c);
  const serverId = c.get('authServerId');
  const versionId = requiredOpaqueId(c.req.param('versionId'));
  const token = c.req.header(CAPABILITY_BLOB_TOKEN_HEADER)?.trim();
  if (!serverId || !versionId || !token) return c.json(errorBody(CAPABILITY_ERROR.FORBIDDEN), 403);
  const claims = await consumeCapabilityBlobAccess(c.env.DB, token, c.env.JWT_SIGNING_KEY, {
    ownerUserId,
    serverId,
    versionId,
    action: CAPABILITY_BLOB_ACTION.UPLOAD,
  });
  if (!claims) return c.json(errorBody(CAPABILITY_ERROR.FORBIDDEN), 403);
  const declaredLength = c.req.header('content-length');
  if (declaredLength !== undefined && Number(declaredLength) !== claims.maxBytes) {
    await failCapabilityPendingActivationByVersion(c.env.DB, {
      ownerUserId,
      capabilityId: claims.capabilityId,
      versionId,
      errorCode: CAPABILITY_ERROR.INTEGRITY_FAILED,
    });
    return c.json(errorBody(CAPABILITY_ERROR.INTEGRITY_FAILED), 422);
  }
  const content = await readBoundedBinaryBody(c.req.raw.body, claims.maxBytes);
  const persisted = content
    ? await persistCapabilityBlobUpload(c.env.DB, claims, content)
    : null;
  if (!persisted?.stored) {
    await failCapabilityPendingActivationByVersion(c.env.DB, {
      ownerUserId,
      capabilityId: claims.capabilityId,
      versionId,
      errorCode: CAPABILITY_ERROR.INTEGRITY_FAILED,
    });
    return c.json(errorBody(CAPABILITY_ERROR.INTEGRITY_FAILED), 422);
  }
  for (const operationId of persisted.authorizationOperationIds) {
    await WsBridge.dispatchPendingCapabilityAuthorization(ownerUserId, c.env.DB, operationId);
  }
  return c.json({
    status: 'ready',
    blobDigest: claims.blobDigest,
    byteSize: claims.maxBytes,
    revision: persisted.accountRevision,
  });
});

capabilityRoutes.get('/capabilities/blobs/:versionId', requireAuth(), async (c) => {
  const ownerUserId = ownerId(c);
  const serverId = c.get('authServerId');
  const versionId = requiredOpaqueId(c.req.param('versionId'));
  const token = c.req.header(CAPABILITY_BLOB_TOKEN_HEADER)?.trim();
  if (!serverId || !versionId || !token) return c.json(errorBody(CAPABILITY_ERROR.FORBIDDEN), 403);
  const claims = await consumeCapabilityBlobAccess(c.env.DB, token, c.env.JWT_SIGNING_KEY, {
    ownerUserId,
    serverId,
    versionId,
    action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
  });
  if (!claims) return c.json(errorBody(CAPABILITY_ERROR.FORBIDDEN), 403);
  const content = await readCapabilityBlobDownload(c.env.DB, claims);
  if (!content) return c.json(errorBody(CAPABILITY_ERROR.INTEGRITY_FAILED), 409);
  return new Response(new Uint8Array(content), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

capabilityRoutes.get('/capabilities/sync/snapshot', requireAuth(), async (c) => {
  const userId = ownerId(c);
  const authenticatedServerId = c.get('authServerId');
  const serverId = c.req.query('serverId');
  if (!authenticatedServerId || authenticatedServerId !== serverId) {
    return c.json(errorBody(CAPABILITY_ERROR.FORBIDDEN), 403);
  }
  const afterRevisionRaw = c.req.query('afterRevision');
  const afterRevision = afterRevisionRaw === undefined ? undefined : Number(afterRevisionRaw);
  if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  const snapshot = await getCapabilitySyncSnapshot(c.env.DB, {
    ownerUserId: userId,
    maxItems: CAPABILITY_LIMITS.LIST_MAX,
    afterRevision,
  });
  const signer = createCapabilityAuthorizationSigner(c.env.JWT_SIGNING_KEY);
  return c.json({ snapshot: toCapabilitySyncSnapshot(snapshot, CAPABILITY_SYNC_MSG.SNAPSHOT, [signer.key]) });
});

capabilityRoutes.post('/capabilities/:capabilityId/readiness', requireAuth(), async (c) => {
  const userId = ownerId(c);
  const capabilityId = requiredOpaqueId(c.req.param('capabilityId'));
  if (!capabilityId) return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  const authenticatedServerId = c.get('authServerId');
  const serverId = c.req.query('serverId');
  if (!authenticatedServerId || authenticatedServerId !== serverId) {
    return c.json(errorBody(CAPABILITY_ERROR.FORBIDDEN), 403);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body
    || !Object.values(CAPABILITY_READINESS).includes(body.readiness as CapabilityReadiness)
    || !Number.isSafeInteger(body.revision)
    || (body.revision as number) < 0
    || (body.reasons !== undefined && !asStringArray(body.reasons, CAPABILITY_LIMITS.FINDINGS))
    || (body.manifestDigest !== undefined
      && (typeof body.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.manifestDigest)))) {
    return c.json(errorBody(CAPABILITY_ERROR.INVALID_INPUT), 400);
  }
  const readiness = await acknowledgeCapabilityReadiness(c.env.DB, {
    ownerUserId: userId,
    itemId: capabilityId,
    serverId,
    state: body.readiness as CapabilityReadiness,
    reasonCode: Array.isArray(body.reasons) && typeof body.reasons[0] === 'string' ? body.reasons[0] : null,
    accountRevision: body.revision as number,
    manifestDigest: typeof body.manifestDigest === 'string' ? body.manifestDigest : null,
  });
  return readiness
    ? c.json({ readiness })
    : c.json(errorBody(CAPABILITY_ERROR.NOT_FOUND), 404);
});

// Compile-time drift sentinels: all path builders used by the web resolve to
// the exact routes mounted above.
void CAPABILITY_HTTP_PATH.LIST;
void CAPABILITY_HTTP_PATH.INSTALL;
void capabilityOperationPath;
void capabilityConfirmationPath;
void capabilityCancellationPath;
void capabilityManagePath;
void capabilityBlobAccessPath;
void capabilityBlobTransferPath;
void CAPABILITY_MANAGEMENT_ACTIONS;
