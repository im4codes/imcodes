import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { EnvConfig } from '../env.js';
import { R2_RELAY_LIMITS, type R2RelayConfig } from '../../../shared/r2-relay.js';
import logger from '../util/logger.js';

export function r2RelayConfig(env: Partial<EnvConfig>): R2RelayConfig | null {
  if (env.USE_R2_RELAY !== 'true' || !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID ?? '')
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET ?? '')
    || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null;
  return { accountId: env.R2_ACCOUNT_ID!, bucket: env.R2_BUCKET!,
    accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY };
}
const encode = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const hmac = (key: string | Buffer, v: string) => createHmac('sha256', key).update(v).digest();
export function isR2StagingKey(key: string): boolean {
  return /^staging\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{32}-[^/\\]+$/.test(key) && !/[\x00-\x1f]/.test(key);
}
export function r2StagingKey(filename: string, now = Date.now()): string {
  const safeName = Array.from(Buffer.from(filename, 'utf8').toString('utf8').replace(/[\x00-\x1f/\\]/g, '_')).slice(0, 160).join('') || 'file';
  return `${R2_RELAY_LIMITS.PREFIX}${new Date(now).toISOString().slice(0, 10)}/${randomBytes(16).toString('hex')}-${safeName}`;
}
/** S3 SigV4 query signing, credentials remain server-only. */
export function presignR2(config: R2RelayConfig, method: string, key: string,
  query: Record<string, string> = {}, now = Date.now()): string {
  if (key && !isR2StagingKey(key)) throw new Error('invalid_staging_key');
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const date = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8); const scope = `${day}/auto/s3/aws4_request`;
  const pathname = `/${config.bucket}/${key.split('/').map(encode).join('/')}`;
  const fields: Record<string, string> = { ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': date, 'X-Amz-Expires': String(R2_RELAY_LIMITS.URL_TTL_SECONDS), 'X-Amz-SignedHeaders': 'host' };
  const qs = Object.keys(fields).sort().map((k) => `${encode(k)}=${encode(fields[k]!)}`).join('&');
  const canonical = `${method}\n${pathname}\n${qs}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), 'auto'), 's3'), 'aws4_request');
  const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString('hex');
  return `https://${host}${pathname}?${qs}&X-Amz-Signature=${signature}`;
}
export async function r2Request(config: R2RelayConfig, method: string, key: string,
  query: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(presignR2(config, method, key, query), { method, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`r2_status_${response.status}`); }
  return response;
}
const xmlDecode = (v: string) => v.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi, (match, k: string) => {
  if (!k.startsWith('#')) return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string, string>)[k] ?? match;
  const code = k[1]?.toLowerCase() === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1));
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
});
/** Durable inventory lives in R2: LastModified survives restarts and replicas. */
export async function sweepR2Staging(config: R2RelayConfig, now = Date.now()): Promise<number> {
  let token = ''; let deleted = 0; const seen = new Set<string>();
  do {
    const response = await r2Request(config, 'GET', '', { 'list-type': '2', prefix: R2_RELAY_LIMITS.PREFIX,
      ...(token ? { 'continuation-token': token } : {}) });
    const xml = await response.text();
    for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlDecode(/<Key>([\s\S]*?)<\/Key>/.exec(block[1]!)?.[1] ?? '');
      const modified = Date.parse(/<LastModified>(.*?)<\/LastModified>/.exec(block[1]!)?.[1] ?? '');
      if (isR2StagingKey(key) && Number.isFinite(modified) && now - modified >= R2_RELAY_LIMITS.OBJECT_TTL_MS) {
        try {
          await (await r2Request(config, 'DELETE', key)).body?.cancel(); deleted++;
        } catch { logger.warn({}, 'R2 staging object deletion failed; retrying next sweep'); }
      }
    }
    const next = xmlDecode(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '');
    if (next && seen.has(next)) throw new Error('r2_repeated_page');
    if (next) seen.add(next);
    token = next;
  } while (token);
  return deleted;
}
export function startR2RelayCleanup(env: Partial<EnvConfig>): (() => void) | undefined {
  const config = r2RelayConfig(env); if (!config) return;
  let running = false;
  const sweep = async () => {
    if (running) return; running = true;
    try { await sweepR2Staging(config); }
    catch { logger.warn({}, 'R2 staging cleanup failed; retrying on next sweep'); }
    finally { running = false; }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), R2_RELAY_LIMITS.SWEEP_INTERVAL_MS);
  timer.unref(); return () => clearInterval(timer);
}
