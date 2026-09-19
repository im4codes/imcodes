import { Hono } from 'hono';
import type { Env } from '../env.js';
import {
  REMOTE_DESKTOP_ACCESS_LIMITS,
  REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE,
  isCanonicalRemoteDesktopBrowserKeyThumbprint,
  isCanonicalRemoteDesktopBrowserPublicKeySpki,
  isRemoteDesktopPublicNodeId,
  validateRemoteDesktopPasswordMutation,
  type RemoteDesktopPasswordMutation,
} from '../../../shared/remote-desktop-access.js';
import { resolveRemoteDesktopAccountSession } from './remote-desktop-account-session.js';
import {
  RemoteDesktopUnattendedPasswordProofService,
  UNATTENDED_PASSWORD_MUTATION_ERROR,
  UNATTENDED_PASSWORD_PUBLIC_RATE_LIMITED,
  UnattendedPasswordMutationError,
  createServerUnattendedPasswordPepperRing,
  mutateUnattendedPassword,
  selectUnattendedPasswordServerSecret,
  validateRemoteDesktopBrowserPublicKeyBinding,
  type UnattendedPasswordPrivacyEpochRef,
} from '../services/remote-desktop-unattended-password.js';

type RouteEnv = { Bindings: Env };
type JsonRecord = Record<string, unknown>;

const PUBLIC_UNAVAILABLE_BODY = JSON.stringify(REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE);
const PUBLIC_RATE_LIMITED_BODY = JSON.stringify(UNATTENDED_PASSWORD_PUBLIC_RATE_LIMITED);

export const remoteDesktopUnattendedPasswordRoutes = new Hono<RouteEnv>();

remoteDesktopUnattendedPasswordRoutes.use('/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
});

remoteDesktopUnattendedPasswordRoutes.post('/remote-desktop/unattended-password', async (c) => {
  const session = await resolveRemoteDesktopAccountSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null);
  const parsed = parseOwnerMutationRequest(body);
  if (!parsed) return c.json({ error: UNATTENDED_PASSWORD_MUTATION_ERROR.INVALID }, 400);

  try {
    const serverSecret = selectUnattendedPasswordServerSecret({
      botEncryptionKey: c.env.BOT_ENCRYPTION_KEY,
      jwtSigningKey: c.env.JWT_SIGNING_KEY,
    });
    const used = await mutateUnattendedPassword({
      db: c.env.DB,
      accountSession: session,
      stepUpGrant: parsed.stepUpGrant,
      privacyEpoch: parsed.privacyEpoch,
      mutation: parsed.mutation,
      peppers: createServerUnattendedPasswordPepperRing(serverSecret),
    });
    if (!used.ok) return c.json({ error: UNATTENDED_PASSWORD_MUTATION_ERROR.STEP_UP }, 403);
    return c.json({ ...used.result, replayed: used.replayed });
  } catch (error) {
    if (error instanceof UnattendedPasswordMutationError) {
      const status = error.code === UNATTENDED_PASSWORD_MUTATION_ERROR.NOT_OWNER ? 403 : 409;
      return c.json({ error: error.code }, status);
    }
    if (error instanceof Error && [
      'invalid_type', 'too_short', 'too_long', 'too_weak',
    ].includes(error.message)) {
      return c.json({ error: UNATTENDED_PASSWORD_MUTATION_ERROR.INVALID }, 400);
    }
    throw error;
  }
});

export function createRemoteDesktopUnattendedPasswordPublicRoutes(
  proofService: Pick<RemoteDesktopUnattendedPasswordProofService, 'prove'>,
): Hono<RouteEnv> {
  const routes = new Hono<RouteEnv>();
  routes.post('/remote-desktop/unattended-password/proof', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = parsePublicProofRequest(body);
    if (!parsed) return fixedPublicResponse(PUBLIC_UNAVAILABLE_BODY, 404);
    let result: Awaited<ReturnType<RemoteDesktopUnattendedPasswordProofService['prove']>>;
    try {
      result = await proofService.prove({
        publicNodeId: String(parsed.publicNodeId),
        password: parsed.password,
        browserPublicKeySpki: parsed.browserPublicKeySpki,
        browserKeyThumbprint: parsed.browserKeyThumbprint,
        source: (c.get('clientIp' as never) as string | undefined) ?? 'unknown',
        now: Date.now(),
      });
    } catch {
      // Initialization, PostgreSQL and KDF failures share the same pre-proof
      // response as an unknown or unavailable target. Never expose internals.
      return fixedPublicResponse(PUBLIC_UNAVAILABLE_BODY, 404);
    }
    if (!result.ok) {
      return result.body.status === UNATTENDED_PASSWORD_PUBLIC_RATE_LIMITED.status
        ? fixedPublicResponse(PUBLIC_RATE_LIMITED_BODY, 429)
        : fixedPublicResponse(PUBLIC_UNAVAILABLE_BODY, 404);
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=UTF-8',
      },
    });
  });
  return routes;
}

function parseOwnerMutationRequest(value: unknown): {
  mutation: RemoteDesktopPasswordMutation;
  privacyEpoch: UnattendedPasswordPrivacyEpochRef;
  stepUpGrant: string;
} | null {
  const body = asExactRecord(value, ['mutation', 'privacyEpoch', 'stepUpGrant']);
  if (!body || typeof body.stepUpGrant !== 'string' || body.stepUpGrant.length > 512) return null;
  const mutation = validateRemoteDesktopPasswordMutation(body.mutation);
  const privacy = asExactRecord(body.privacyEpoch, ['epochId', 'revision']);
  if (!mutation.ok || !privacy
    || typeof privacy.epochId !== 'string' || privacy.epochId.length === 0 || privacy.epochId.length > 128
    || !Number.isSafeInteger(privacy.revision) || (privacy.revision as number) <= 0) return null;
  return {
    mutation: mutation.value,
    privacyEpoch: { epochId: privacy.epochId, revision: privacy.revision as number },
    stepUpGrant: body.stepUpGrant,
  };
}

function parsePublicProofRequest(value: unknown): {
  publicNodeId: number;
  password: string;
  browserPublicKeySpki: string;
  browserKeyThumbprint: string;
} | null {
  const body = asExactRecord(value, [
    'publicNodeId', 'password', 'browserPublicKeySpki', 'browserKeyThumbprint',
  ]);
  if (!body || !isRemoteDesktopPublicNodeId(body.publicNodeId)
    || typeof body.password !== 'string'
    || Buffer.byteLength(body.password, 'utf8') < REMOTE_DESKTOP_ACCESS_LIMITS.PASSWORD_MIN_BYTES
    || Buffer.byteLength(body.password, 'utf8') > REMOTE_DESKTOP_ACCESS_LIMITS.PASSWORD_MAX_BYTES
    || !isCanonicalRemoteDesktopBrowserPublicKeySpki(body.browserPublicKeySpki)
    || !isCanonicalRemoteDesktopBrowserKeyThumbprint(body.browserKeyThumbprint)
    || !validateRemoteDesktopBrowserPublicKeyBinding({
      browserPublicKeySpki: body.browserPublicKeySpki,
      browserKeyThumbprint: body.browserKeyThumbprint,
    })) {
    return null;
  }
  return {
    publicNodeId: body.publicNodeId,
    password: body.password,
    browserPublicKeySpki: body.browserPublicKeySpki,
    browserKeyThumbprint: body.browserKeyThumbprint,
  };
}

function fixedPublicResponse(body: string, status: 404 | 429): Response {
  return new Response(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      'Content-Type': 'application/json; charset=UTF-8',
    },
  });
}

function asExactRecord(value: unknown, keys: readonly string[]): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]) ? record : null;
}
