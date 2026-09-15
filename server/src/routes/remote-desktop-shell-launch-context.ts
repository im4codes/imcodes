import { Hono } from 'hono';
import type { Env } from '../env.js';
import { nativeShellIssuer, resolveNativeShellSession } from '../services/remote-desktop-account-auth.js';
import {
  getRemoteDesktopShellLaunchContextDispatcher,
  issueRemoteDesktopShellLaunchContext,
  type RemoteDesktopShellLaunchContextDispatcher,
} from '../services/remote-desktop-shell-launch-context.js';
import { REMOTE_DESKTOP_PRIVACY_LIMITS } from '../../../shared/remote-desktop-access.js';

type RouteEnv = { Bindings: Env };
const JSON_BYTES = REMOTE_DESKTOP_PRIVACY_LIMITS.LAUNCH_CONTEXT_BYTES;

async function boundedJson(request: Request): Promise<unknown> {
  const body = await request.text();
  if (Buffer.byteLength(body, 'utf8') > JSON_BYTES) throw new Error('body_too_large');
  return JSON.parse(body) as unknown;
}

function issueBody(value: unknown): { hostId: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 1 || typeof row.hostId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(row.hostId)) return null;
  return { hostId: row.hostId };
}

export function createRemoteDesktopShellLaunchContextRoutes(
  dispatcherOverride?: RemoteDesktopShellLaunchContextDispatcher,
): Hono<RouteEnv> {
  const routes = new Hono<RouteEnv>();
  routes.use('/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
  });

  routes.post('/shell/launch-context/issue', async (c) => {
    // Deliberately no cookie fallback: an ordinary management Web session is
    // not the signed local account shell and may not request local launch.
    const accountSession = await resolveNativeShellSession(
      c.env.DB,
      c.req.header('authorization'),
      nativeShellIssuer(c.env.SERVER_URL),
    );
    if (!accountSession) return c.json({ error: 'unauthorized' }, 401);
    const parsed = issueBody(await boundedJson(c.req.raw).catch(() => null));
    if (!parsed) return c.json({ error: 'invalid_request' }, 400);
    const dispatcher = dispatcherOverride ?? getRemoteDesktopShellLaunchContextDispatcher();
    if (!dispatcher) return c.json({ error: 'unavailable' }, 503);
    const issued = await issueRemoteDesktopShellLaunchContext({
      db: c.env.DB,
      accountSession,
      hostId: parsed.hostId,
      dispatcher,
    });
    if (!issued) return c.json({ error: 'unavailable' }, 503);
    // The exact context is delivered only through dispatcher.dispatch(), never
    // through the ordinary HTTP response or a browser cookie session.
    return c.json(issued, 202);
  });

  return routes;
}

export const remoteDesktopShellLaunchContextRoutes =
  createRemoteDesktopShellLaunchContextRoutes();
