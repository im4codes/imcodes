import crypto from 'node:crypto';

/**
 * The compose-only web session JWT the browser harness scenarios present to the real server.
 * The user is an owner so the real SPA's owner-scoped capabilities probe is authorized. The signing
 * key is test-only and is never accepted by production deployments.
 */
export function signPerfJwt(signingKey) {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64(JSON.stringify({ sub: 'imc_perf_user', role: 'owner', type: 'web', iat: now, exp: now + 3600 }));
  const input = `${header}.${claims}`;
  return `${input}.${crypto.createHmac('sha256', signingKey).update(input).digest('base64url')}`;
}
