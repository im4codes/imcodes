import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env.js';
import {
  REMOTE_DESKTOP_LINK_LIMITS,
  REMOTE_DESKTOP_LINK_MUTATION,
  REMOTE_DESKTOP_PRESENTATION_SOURCE,
  REMOTE_DESKTOP_PRIVACY_LIMITS,
  REMOTE_DESKTOP_PRIVACY_PHASE,
  REMOTE_DESKTOP_SHELL_MSG,
  isCanonicalRemoteDesktopLinkToken,
  isCanonicalRemoteDesktopCreationRequestId,
  isRemoteDesktopPreProofResponseSafe,
  validateRemoteDesktopClaimProof,
  validateRemoteDesktopLinkCreateRequest,
  validateRemoteDesktopShellMessage,
  type RemoteDesktopLinkCreateRequest,
  type RemoteDesktopLinkMutation,
} from '../../../shared/remote-desktop-access.js';
import {
  isBoundedRemoteDesktopString,
  isRemoteDesktopId,
} from '../../../shared/remote-desktop-contract-primitives.js';
import {
  PUBLIC_UNAVAILABLE,
  issueClaimChallenge,
  resolveLinkProof,
} from '../services/remote-desktop-guest-bootstrap.js';
import {
  LINK_REFUSAL,
  LinkAuthorityError,
  createGuestLink,
  listOwnerLinks,
  mutateGuestLink,
  type OwnerLinkView,
} from '../services/remote-desktop-guest-links.js';
import {
  nativeShellIssuer,
  resolveBrowserAccountSession,
  resolveNativeShellSession,
  type AccountSession,
} from '../services/remote-desktop-account-auth.js';
import {
  OWNER_HOST_MANAGEMENT_ERROR,
  OwnerHostManagementError,
  getOwnerRemoteDesktopHostSummary,
  rotateOwnerPublicNodeId,
} from '../services/remote-desktop-owner-management.js';
import {
  REMOTE_DESKTOP_GUEST_EFFECT_RETENTION_MS,
  readDatabaseClock,
} from '../services/remote-desktop-guest-due-worker.js';
import { resolveExecutionEndpoint } from '../services/remote-desktop-host-identity.js';
import {
  PRIVACY_DB_PHASE_IDLE,
  PRIVACY_REFUSAL,
  PrivacyBarrierError,
  beginPrivacyEpoch,
  beginPrivacyEpochTx,
  dispatchBeginPrivacyEpochEffects,
  endManagementWebPrivacy,
  endSignedShellPrivacy,
  getPrivacyState,
  markRecoveryRequired,
} from '../services/remote-desktop-management-privacy.js';
import {
  getRemoteDesktopShellLaunchContextDispatcher,
  redeemRemoteDesktopShellLaunchContext,
} from '../services/remote-desktop-shell-launch-context.js';

/**
 * Public guest-access surface plus account-Owner management.
 *
 * The public half is flat and unauthenticated on purpose: it is reached with a
 * bearer nobody has an account for. Everything it can refuse refuses with one
 * identical body, and the success path is the only place `serverId` ever
 * appears.
 *
 * Browser claims use a Server challenge and P-256 proof; no public request ever
 * carries or learns an internal link id.
 */
export const remoteDesktopGuestAccessRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; role: string };
}>();

type RouteEnv = {
  Bindings: Env;
  Variables: { userId: string; role: string };
};
type JsonRecord = Record<string, unknown>;

const OWNER_REQUEST_MAX_BYTES = 64 * 1024;
const MANAGEMENT_PRIVACY_SESSION_HASH_DOMAIN = 'imcodes.remote-desktop.management-privacy-session.v1';

/** Bounded body read. An oversized or unparseable body is just unavailable. */
async function readJson(c: Context<RouteEnv>): Promise<unknown> {
  try {
    const declared = c.req.header('content-length');
    if (declared !== undefined) {
      const bytes = Number(declared);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > OWNER_REQUEST_MAX_BYTES) return null;
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text, 'utf8') > OWNER_REQUEST_MAX_BYTES) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function requestAccountSession(c: Context<RouteEnv>): Promise<AccountSession | null> {
  const authorization = c.req.header('authorization');
  // Any Authorization header commits the request to native-shell auth. Never
  // fall back to a browser cookie after an invalid Bearer: the global CSRF
  // middleware intentionally exempts Bearer requests.
  if (authorization !== undefined) {
    return resolveNativeShellSession(
      c.env.DB,
      authorization,
      nativeShellIssuer(c.env.SERVER_URL),
    );
  }
  return resolveBrowserAccountSession(c.env.DB, c.env.JWT_SIGNING_KEY, c.req.header('cookie'));
}

function asExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  const actual = Object.keys(record).sort();
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(record, key))
    || actual.some((key) => !allowed.has(key))) return null;
  return record;
}

function parsePrivacy(value: unknown): { epochId: string; revision: number } | null {
  const privacy = asExactRecord(value, ['epochId', 'revision']);
  if (!privacy
    || typeof privacy.epochId !== 'string' || privacy.epochId.length === 0 || privacy.epochId.length > 128
    || !Number.isSafeInteger(privacy.revision) || (privacy.revision as number) <= 0) return null;
  return { epochId: privacy.epochId, revision: privacy.revision as number };
}

function managementPrivacySessionHash(session: AccountSession): string {
  return createHash('sha256')
    .update(MANAGEMENT_PRIVACY_SESSION_HASH_DOMAIN, 'utf8')
    .update(Buffer.from([0]))
    .update(session.kind, 'utf8')
    .update(Buffer.from([0]))
    .update(session.id, 'utf8')
    .digest('hex');
}

function parseCreate(value: unknown): {
  request: RemoteDesktopLinkCreateRequest;
  privacy: { epochId: string; revision: number };
  stepUpGrant: string;
} | null {
  const body = asExactRecord(value, ['request', 'privacyEpoch', 'stepUpGrant']);
  if (!body || typeof body.stepUpGrant !== 'string' || body.stepUpGrant.length > 512) return null;
  const request = validateRemoteDesktopLinkCreateRequest(body.request);
  const privacy = parsePrivacy(body.privacyEpoch);
  if (!request.ok || !privacy) return null;
  return { request: request.value, privacy, stepUpGrant: body.stepUpGrant };
}

function parseMutation(value: unknown): {
  hostId: string;
  requestId: string;
  mutation: RemoteDesktopLinkMutation;
  label?: string;
  expiresAt?: number;
  privacy: { epochId: string; revision: number };
  stepUpGrant: string;
} | null {
  const body = asExactRecord(
    value,
    ['hostId', 'requestId', 'mutation', 'privacyEpoch', 'stepUpGrant'],
    ['label', 'expiresAt'],
  );
  const privacy = body ? parsePrivacy(body.privacyEpoch) : null;
  if (!body || !privacy
    || !isRemoteDesktopId(body.hostId)
    || !isCanonicalRemoteDesktopCreationRequestId(body.requestId)
    || typeof body.stepUpGrant !== 'string' || body.stepUpGrant.length > 512
    || typeof body.mutation !== 'string'
    || !Object.values(REMOTE_DESKTOP_LINK_MUTATION).includes(body.mutation as RemoteDesktopLinkMutation)) return null;

  const mutation = body.mutation as RemoteDesktopLinkMutation;
  if (mutation === REMOTE_DESKTOP_LINK_MUTATION.SET_LABEL) {
    if (!isBoundedRemoteDesktopString(body.label, REMOTE_DESKTOP_LINK_LIMITS.LABEL_BYTES)
      || Object.hasOwn(body, 'expiresAt')) return null;
  } else if (mutation === REMOTE_DESKTOP_LINK_MUTATION.SHORTEN_EXPIRY) {
    if (!Number.isSafeInteger(body.expiresAt) || (body.expiresAt as number) <= 0
      || Object.hasOwn(body, 'label')) return null;
  } else if (Object.hasOwn(body, 'label') || Object.hasOwn(body, 'expiresAt')) {
    return null;
  }
  return {
    hostId: body.hostId,
    requestId: body.requestId,
    mutation,
    label: body.label as string | undefined,
    expiresAt: body.expiresAt as number | undefined,
    privacy,
    stepUpGrant: body.stepUpGrant,
  };
}

function parseRevoke(value: unknown): Omit<NonNullable<ReturnType<typeof parseMutation>>, 'mutation'> | null {
  const body = asExactRecord(value, ['hostId', 'requestId', 'privacyEpoch', 'stepUpGrant']);
  if (!body) return null;
  const parsed = parseMutation({ ...body, mutation: REMOTE_DESKTOP_LINK_MUTATION.REVOKE });
  if (!parsed) return null;
  const { mutation: _mutation, ...rest } = parsed;
  return rest;
}

/** Explicit response allowlist: hashes, bearers and browser material cannot leak if the service grows. */
function presentOwnerLink(link: OwnerLinkView): Record<string, unknown> {
  return {
    id: link.id,
    hostId: link.hostId,
    label: link.label,
    kind: link.kind,
    mode: link.mode,
    expiresAt: link.expiresAt,
    authorityGeneration: link.authorityGeneration,
    expiryRevision: link.expiryRevision,
    commitRevision: link.commitRevision,
    state: link.state,
    claimed: link.claimed,
    createdAt: link.createdAt,
    ...(link.connectionAudit ? { connectionAudit: {
      connectionCount: link.connectionAudit.connectionCount,
      totalDurationMs: link.connectionAudit.totalDurationMs,
      lastConnectedAt: link.connectionAudit.lastConnectedAt,
      recentConnections: link.connectionAudit.recentConnections.map((entry) => ({
        ipAddress: entry.ipAddress,
        connectedAt: entry.connectedAt,
        disconnectedAt: entry.disconnectedAt,
        durationMs: entry.durationMs,
      })),
    } } : {}),
  };
}

function mapOwnerError(c: Context<RouteEnv>, error: unknown): Response | null {
  if (error instanceof LinkAuthorityError) {
    if (error.refusal === LINK_REFUSAL.INVALID) return c.json({ error: 'request_invalid' }, 400);
    if (error.refusal === LINK_REFUSAL.UNAUTHORIZED || error.refusal === LINK_REFUSAL.NOT_FOUND) {
      return c.json({ error: 'not_found_or_unauthorized' }, 404);
    }
    if (error.refusal === LINK_REFUSAL.STEP_UP_REQUIRED) return c.json({ error: 'step_up_required' }, 403);
    if (error.refusal === LINK_REFUSAL.PRIVACY_REQUIRED) return c.json({ error: 'privacy_required' }, 409);
    return c.json({ error: 'conflict' }, 409);
  }
  if (error instanceof OwnerHostManagementError) {
    if (error.code === OWNER_HOST_MANAGEMENT_ERROR.INVALID) return c.json({ error: 'request_invalid' }, 400);
    if (error.code === OWNER_HOST_MANAGEMENT_ERROR.UNAUTHORIZED) {
      return c.json({ error: 'not_found_or_unauthorized' }, 404);
    }
    return c.json({ error: 'step_up_required' }, 403);
  }
  return null;
}

/**
 * Resolve a link bearer.
 *
 * Always 200 with the same bounded body on failure. A status-code or shape
 * difference between "unknown link" and "revoked link" would itself be the
 * enumeration oracle this endpoint exists to avoid, so the response is asserted
 * safe before it is sent rather than assumed safe by construction.
 */
async function issueGuestClaimChallenge(c: Context<RouteEnv>): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  const body = await readJson(c);
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const token = typeof record?.token === 'string' ? record.token : '';
  if (!isCanonicalRemoteDesktopLinkToken(token)) return c.json(PUBLIC_UNAVAILABLE);
  return c.json(await issueClaimChallenge(c.env.DB, { token, now: Date.now() }));
}

remoteDesktopGuestAccessRoutes.post('/remote-desktop/guest/challenge', issueGuestClaimChallenge);
// The pre-app fragment scrubber uses this explicit path. It performs the same
// pre-proof operation as the ordinary challenge endpoint: consume the raw
// bearer only long enough to mint a bounded, non-disclosing browser challenge.
remoteDesktopGuestAccessRoutes.post('/remote-desktop/guest/link/bootstrap', issueGuestClaimChallenge);

remoteDesktopGuestAccessRoutes.post('/remote-desktop/guest/resolve', async (c) => {
  c.header('Cache-Control', 'no-store');
  const parsed = validateRemoteDesktopClaimProof(await readJson(c));
  if (!parsed.ok) return c.json(PUBLIC_UNAVAILABLE);

  const result = await resolveLinkProof(c.env.DB, {
    proof: parsed.value,
    now: Date.now(),
  });
  if (!result.ok) {
    // Belt and braces: never let a future edit widen the pre-proof body.
    return c.json(isRemoteDesktopPreProofResponseSafe(result.body) ? result.body : PUBLIC_UNAVAILABLE);
  }
  return c.json({
    status: 'ready',
    serverId: result.serverId,
    hostId: result.hostId,
    bootstrapTicket: result.bootstrapTicket,
    expiresAt: result.expiresAt,
    mode: result.mode,
    source: result.source,
  });
});

/** Owner canonical-host summary. Public ID is non-secret but still Owner-scoped. */
remoteDesktopGuestAccessRoutes.get('/remote-desktop/guest/host', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession) return c.json({ error: 'unauthorized' }, 401);
  const hostId = c.req.query('hostId');
  if (!isRemoteDesktopId(hostId)) return c.json({ error: 'request_invalid' }, 400);
  try {
    const host = await getOwnerRemoteDesktopHostSummary(c.env.DB, { accountSession, hostId });
    return c.json({ host });
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    throw error;
  }
});

/**
 * Enter the Server-enforced no-route gate before management Web creates or
 * accepts any raw invite/password bytes. The canonical endpoint is recorded
 * for audit/recovery, but no daemon generation is asserted because this path
 * is valid only when the transactional route snapshot is empty.
 */
remoteDesktopGuestAccessRoutes.post('/remote-desktop/guest/privacy/begin', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession) return c.json({ error: 'unauthorized' }, 401);
  const body = asExactRecord(
    await readJson(c),
    accountSession.kind === 'native' ? ['hostId', 'launchContext'] : ['hostId'],
  );
  if (!body || !isRemoteDesktopId(body.hostId)) {
    return c.json({ error: 'request_invalid' }, 400);
  }
  try {
    if (accountSession.kind === 'native') {
      const dispatcher = getRemoteDesktopShellLaunchContextDispatcher();
      if (!dispatcher) return c.json({ error: 'privacy_unavailable' }, 409);
      const now = await c.env.DB.transaction(readDatabaseClock);
      const epochId = randomUUID();
      const redeemed = await redeemRemoteDesktopShellLaunchContext({
        db: c.env.DB,
        accountSession,
        context: body.launchContext,
        dispatcher,
        now,
        onRedeemedTx: async (tx, binding) => {
          if (binding.hostId !== body.hostId) {
            throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
          }
          const beginInput = {
            hostId: binding.hostId,
            epochId,
            presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
            initiatingSessionHash: managementPrivacySessionHash(accountSession),
            executionServerId: binding.executionServerId,
            daemonGeneration: binding.endpointGeneration,
            leaseExpiresAt: now + REMOTE_DESKTOP_PRIVACY_LIMITS.MAX_LEASE_MS,
            deadline: now + REMOTE_DESKTOP_PRIVACY_LIMITS.MAX_LEASE_MS,
            now,
          } as const;
          return {
            beginInput,
            epoch: await beginPrivacyEpochTx(tx, beginInput),
          };
        },
      });
      if (!redeemed) return c.json({ error: 'privacy_unavailable' }, 409);
      await dispatchBeginPrivacyEpochEffects(
        redeemed.result.beginInput,
        redeemed.result.epoch,
      );
      return c.json({
        epochId: redeemed.result.epoch.epochId,
        revision: redeemed.result.epoch.revision,
        phase: redeemed.result.epoch.phase,
      });
    }
    await getOwnerRemoteDesktopHostSummary(c.env.DB, { accountSession, hostId: body.hostId });
    // Management Web never asks a Worker to shield: if any route exists the
    // privacy transaction below refuses. A FULL endpoint therefore needs only
    // its durable canonical mapping here, not pod-local runtime ownership.
    const endpoint = await resolveExecutionEndpoint({
      db: c.env.DB,
      hostId: body.hostId,
      fullEndpointEligible: async () => true,
    });
    if (!endpoint) return c.json({ error: 'privacy_unavailable' }, 409);
    const now = await c.env.DB.transaction(readDatabaseClock);
    const epoch = await beginPrivacyEpoch(c.env.DB, {
      hostId: body.hostId,
      epochId: randomUUID(),
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.MANAGEMENT_WEB,
      initiatingSessionHash: managementPrivacySessionHash(accountSession),
      executionServerId: endpoint.serverId,
      daemonGeneration: null,
      leaseExpiresAt: now + REMOTE_DESKTOP_PRIVACY_LIMITS.MAX_LEASE_MS,
      deadline: now + REMOTE_DESKTOP_PRIVACY_LIMITS.MAX_LEASE_MS,
      now,
    });
    return c.json({ epochId: epoch.epochId, revision: epoch.revision });
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    if (error instanceof PrivacyBarrierError) {
      // Route presence, a competing epoch and recovery-required are deliberately
      // indistinguishable to the browser.
      return c.json({ error: 'privacy_unavailable' }, 409);
    }
    throw error;
  }
});

/** Clear only the exact no-route management-Web epoch after local secret UI is gone. */
remoteDesktopGuestAccessRoutes.post('/remote-desktop/guest/privacy/end', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession) return c.json({ error: 'unauthorized' }, 401);
  const body = asExactRecord(await readJson(c), ['hostId', 'epochId', 'revision']);
  if (!body || !isRemoteDesktopId(body.hostId) || !isRemoteDesktopId(body.epochId)
    || !Number.isSafeInteger(body.revision) || (body.revision as number) <= 0) {
    return c.json({ error: 'request_invalid' }, 400);
  }
  try {
    await getOwnerRemoteDesktopHostSummary(c.env.DB, { accountSession, hostId: body.hostId });
    const now = await c.env.DB.transaction(readDatabaseClock);
    const state = accountSession.kind === 'native'
      ? await endSignedShellPrivacy(c.env.DB, {
        hostId: body.hostId,
        epochId: body.epochId,
        revision: body.revision as number,
        now,
      })
      : await endManagementWebPrivacy(c.env.DB, {
        hostId: body.hostId,
        epochId: body.epochId,
        revision: body.revision as number,
        now,
      });
    if (accountSession.kind === 'web'
      && (state.phase !== PRIVACY_DB_PHASE_IDLE || !state.admissionOpen)) {
      return c.json({ error: 'privacy_unavailable' }, 409);
    }
    return c.json({ status: state.phase === PRIVACY_DB_PHASE_IDLE ? 'ended' : 'ending' });
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    if (error instanceof PrivacyBarrierError) {
      return c.json({ error: 'privacy_unavailable' }, 409);
    }
    throw error;
  }
});

/** Native shell polls this bounded state before enabling or after clearing secret UI. */
remoteDesktopGuestAccessRoutes.get('/remote-desktop/guest/privacy/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession || accountSession.kind !== 'native') {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const hostId = c.req.query('hostId');
  const epochId = c.req.query('epochId');
  const revision = Number(c.req.query('revision'));
  if (!isRemoteDesktopId(hostId) || !isRemoteDesktopId(epochId)
    || !Number.isSafeInteger(revision) || revision <= 0) {
    return c.json({ error: 'request_invalid' }, 400);
  }
  try {
    await getOwnerRemoteDesktopHostSummary(c.env.DB, { accountSession, hostId });
    const state = await getPrivacyState(c.env.DB, hostId);
    if (!state || state.revision !== revision) {
      return c.json({ error: 'privacy_unavailable' }, 409);
    }
    if (state.phase === PRIVACY_DB_PHASE_IDLE && state.epochId === null) {
      return c.json({ status: 'ended' });
    }
    if (state.epochId !== epochId) return c.json({ error: 'privacy_unavailable' }, 409);
    return c.json({
      status: state.phase === 'active'
        ? 'active'
        : state.phase === 'recovery_required'
          ? 'recovery_required'
          : state.phase,
    });
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    throw error;
  }
});

/**
 * A signed shell must be able to fail the current epoch closed immediately
 * when its clipboard watchdog or local cleanup becomes uncertain. Waiting for
 * the lease sweep would remain safe, but would leave a bounded interval where
 * the durable row still claimed the secret surface could be cleaned normally.
 *
 * This endpoint grants no management authority: only the current native Owner
 * session may call it, and it can only tighten the exact current signed-shell
 * epoch/generation into the terminal recovery state.
 */
remoteDesktopGuestAccessRoutes.post('/remote-desktop/guest/privacy/recovery', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession || accountSession.kind !== 'native') {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = asExactRecord(
    await readJson(c),
    ['hostId', 'epochId', 'revision', 'endpointGeneration', 'reason'],
  );
  const parsed = body && validateRemoteDesktopShellMessage({
    type: REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED,
    hostId: body.hostId,
    epochId: body.epochId,
    endpointGeneration: body.endpointGeneration,
    reason: body.reason,
  });
  if (!body || !parsed || !parsed.ok
    || parsed.value.type !== REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED
    || typeof body.revision !== 'number'
    || !Number.isSafeInteger(body.revision) || body.revision <= 0) {
    return c.json({ error: 'request_invalid' }, 400);
  }
  try {
    await getOwnerRemoteDesktopHostSummary(c.env.DB, {
      accountSession,
      hostId: parsed.value.hostId,
    });
    const current = await getPrivacyState(c.env.DB, parsed.value.hostId);
    if (!current
      || current.epochId !== parsed.value.epochId
      || current.revision !== body.revision
      || current.presentationSource !== REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL
      || current.daemonGeneration !== parsed.value.endpointGeneration) {
      return c.json({ error: 'privacy_unavailable' }, 409);
    }
    if (current.phase === REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED) {
      return c.json({ status: REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED });
    }
    const now = await c.env.DB.transaction(readDatabaseClock);
    await markRecoveryRequired(c.env.DB, {
      hostId: parsed.value.hostId,
      epochId: parsed.value.epochId,
      reason: parsed.value.reason,
      now,
      expectedRevision: body.revision,
      expectedDaemonGeneration: parsed.value.endpointGeneration,
      expectedPresentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
    });
    return c.json({ status: REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED });
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    if (error instanceof PrivacyBarrierError) {
      return c.json({ error: 'privacy_unavailable' }, 409);
    }
    throw error;
  }
});

remoteDesktopGuestAccessRoutes.post('/remote-desktop/guest/host/rotate', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession) return c.json({ error: 'unauthorized' }, 401);
  const body = asExactRecord(await readJson(c), ['hostId', 'requestId', 'stepUpGrant']);
  if (!body || !isRemoteDesktopId(body.hostId)
    || !isCanonicalRemoteDesktopCreationRequestId(body.requestId)
    || typeof body.stepUpGrant !== 'string' || body.stepUpGrant.length > 512) {
    return c.json({ error: 'request_invalid' }, 400);
  }
  try {
    const now = await c.env.DB.transaction(readDatabaseClock);
    const result = await rotateOwnerPublicNodeId(c.env.DB, {
      accountSession,
      hostId: body.hostId,
      requestId: body.requestId,
      stepUpToken: body.stepUpGrant,
      now,
    });
    return c.json(result);
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    throw error;
  }
});

/** Owner inventory for one canonical host. Non-secret metadata only. */
remoteDesktopGuestAccessRoutes.get('/remote-desktop/guest/links', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession) return c.json({ error: 'unauthorized' }, 401);
  const hostId = c.req.query('hostId');
  if (!isRemoteDesktopId(hostId)) return c.json({ error: 'request_invalid' }, 400);
  try {
    const links = await listOwnerLinks(c.env.DB, { ownerUserId: accountSession.userId, hostId });
    return c.json({ links: links.map(presentOwnerLink) });
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    throw error;
  }
});

remoteDesktopGuestAccessRoutes.post('/remote-desktop/guest/links', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession) return c.json({ error: 'unauthorized' }, 401);
  const parsed = parseCreate(await readJson(c));
  if (!parsed) return c.json({ error: 'request_invalid' }, 400);
  try {
    const now = await c.env.DB.transaction(readDatabaseClock);
    const result = await createGuestLink(c.env.DB, {
      ownerUserId: accountSession.userId,
      accountSession,
      stepUpToken: parsed.stepUpGrant,
      ...parsed.request,
      privacy: parsed.privacy,
      now,
    });
    return c.json({ link: presentOwnerLink(result.link), replayed: result.replayed }, result.replayed ? 200 : 201);
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    throw error;
  }
});

remoteDesktopGuestAccessRoutes.patch('/remote-desktop/guest/links/:linkId', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession) return c.json({ error: 'unauthorized' }, 401);
  const parsed = parseMutation(await readJson(c));
  const linkId = c.req.param('linkId');
  if (!parsed || !isRemoteDesktopId(linkId)) return c.json({ error: 'request_invalid' }, 400);
  try {
    const now = await c.env.DB.transaction(readDatabaseClock);
    const result = await mutateGuestLink(c.env.DB, {
      ownerUserId: accountSession.userId,
      accountSession,
      stepUpToken: parsed.stepUpGrant,
      requestId: parsed.requestId,
      hostId: parsed.hostId,
      linkId,
      mutation: parsed.mutation,
      label: parsed.label,
      expiresAt: parsed.expiresAt,
      privacy: parsed.privacy,
      now,
      retainUntil: now + REMOTE_DESKTOP_GUEST_EFFECT_RETENTION_MS,
    });
    return c.json({ link: presentOwnerLink(result.link), effectsEmitted: result.effectsEmitted });
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    throw error;
  }
});

remoteDesktopGuestAccessRoutes.delete('/remote-desktop/guest/links/:linkId', async (c) => {
  c.header('Cache-Control', 'no-store');
  const accountSession = await requestAccountSession(c);
  if (!accountSession) return c.json({ error: 'unauthorized' }, 401);
  const parsed = parseRevoke(await readJson(c));
  const linkId = c.req.param('linkId');
  if (!parsed || !isRemoteDesktopId(linkId)) return c.json({ error: 'request_invalid' }, 400);
  try {
    const now = await c.env.DB.transaction(readDatabaseClock);
    const result = await mutateGuestLink(c.env.DB, {
      ownerUserId: accountSession.userId,
      accountSession,
      stepUpToken: parsed.stepUpGrant,
      requestId: parsed.requestId,
      hostId: parsed.hostId,
      linkId,
      mutation: REMOTE_DESKTOP_LINK_MUTATION.REVOKE,
      privacy: parsed.privacy,
      now,
      retainUntil: now + REMOTE_DESKTOP_GUEST_EFFECT_RETENTION_MS,
    });
    return c.json({ link: presentOwnerLink(result.link), effectsEmitted: result.effectsEmitted });
  } catch (error) {
    const response = mapOwnerError(c, error);
    if (response) return response;
    throw error;
  }
});
