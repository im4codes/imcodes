import type { Context } from 'hono';
import type { Env } from '../env.js';
import { resolveBearerAuth } from '../security/authorization.js';
import {
  createBearerAccountSession,
  nativeShellIssuer,
  resolveBrowserAccountSession,
  resolveNativeShellSession,
  type AccountSession,
} from '../services/remote-desktop-account-auth.js';

type AccountRouteContext = Pick<Context<{ Bindings: Env }>, 'req' | 'env'>;

/**
 * Resolve the account session used by remote-desktop Owner operations.
 *
 * A present Authorization header is authoritative: signed-shell sessions are
 * checked first, then normal account bearers (including the mobile app's
 * deck_ API key). Invalid or daemon-node bearers never fall back to cookies.
 */
export async function resolveRemoteDesktopAccountSession(
  c: AccountRouteContext,
): Promise<AccountSession | null> {
  const authorization = c.req.header('authorization');
  if (authorization === undefined) {
    return resolveBrowserAccountSession(
      c.env.DB,
      c.env.JWT_SIGNING_KEY,
      c.req.header('cookie'),
    );
  }

  const signedShell = await resolveNativeShellSession(
    c.env.DB,
    authorization,
    nativeShellIssuer(c.env.SERVER_URL),
  );
  if (signedShell) return signedShell;

  const bearer = await resolveBearerAuth(c);
  if (!bearer || bearer.nodeRole) return null;
  const bearerToken = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  if (!bearerToken) return null;
  return createBearerAccountSession({
    userId: bearer.userId,
    bearerToken,
    ...(bearer.keyId ? { apiKeyId: bearer.keyId } : {}),
  });
}
