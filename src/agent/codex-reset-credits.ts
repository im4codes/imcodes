/**
 * Codex rate-limit reset credits — list (ChatGPT backend HTTP) + consume (codex
 * app-server JSON-RPC). The local OAuth token from `~/.codex/auth.json` is read
 * into memory ONLY for the Authorization header / handshake; it is never logged
 * and never returned to the caller. Only the non-secret credit list and the
 * consume outcome leave this module.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import logger from '../util/logger.js';
import { callCodexAppServerMethod } from './codex-runtime-config.js';
import type {
  CodexResetCredit,
  CodexResetCreditsList,
  CodexConsumeOutcome,
} from '../../shared/codex-reset-credits.js';
import { CODEX_RESET_CREDITS_ERROR } from '../../shared/codex-reset-credits.js';

const CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CREDITS_TIMEOUT_MS = 10_000;

export type FetchCreditsResult =
  | { ok: true; list: CodexResetCreditsList }
  | { ok: false; error: string };

export type ConsumeCreditResult =
  | { ok: true; outcome: CodexConsumeOutcome }
  | { ok: false; error: string };

/** Read the codex OAuth token + account id from ~/.codex/auth.json (in-memory only). */
async function readCodexTokens(): Promise<{ accessToken: string; accountId?: string } | null> {
  try {
    const raw = await readFile(join(homedir(), '.codex', 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      tokens?: { access_token?: string; account_id?: string };
      access_token?: string;
      account_id?: string;
    };
    const accessToken = parsed.tokens?.access_token ?? parsed.access_token;
    const accountId = parsed.tokens?.account_id ?? parsed.account_id;
    if (!accessToken) return null;
    return { accessToken, ...(accountId ? { accountId } : {}) };
  } catch {
    return null;
  }
}

function normalizeCredit(raw: Record<string, any>): CodexResetCredit {
  return {
    id: String(raw?.id ?? ''),
    status: String(raw?.status ?? 'unknown'),
    ...(raw?.granted_at ? { grantedAt: String(raw.granted_at) } : {}),
    ...(raw?.expires_at ? { expiresAt: String(raw.expires_at) } : {}),
    ...(raw?.title ? { title: String(raw.title) } : {}),
    ...(raw?.description ? { description: String(raw.description) } : {}),
  };
}

/** GET the account's reset-credit list. */
export async function fetchCodexResetCredits(): Promise<FetchCreditsResult> {
  const tokens = await readCodexTokens();
  if (!tokens) return { ok: false, error: CODEX_RESET_CREDITS_ERROR.NO_CODEX_AUTH };
  try {
    const res = await fetch(CREDITS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'codex-cli',
        ...(tokens.accountId ? { 'chatgpt-account-id': tokens.accountId } : {}),
      },
      signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'codex reset-credits: list request failed');
      return { ok: false, error: CODEX_RESET_CREDITS_ERROR.REQUEST_FAILED };
    }
    const body = await res.json() as { credits?: unknown[]; available_count?: number };
    const credits: CodexResetCredit[] = Array.isArray(body.credits)
      ? body.credits.map((c) => normalizeCredit(c as Record<string, any>))
      : [];
    const availableCount = typeof body.available_count === 'number'
      ? body.available_count
      : credits.filter((c) => c.status === 'available').length;
    return { ok: true, list: { credits, availableCount } };
  } catch (err) {
    // Never interpolate the token; err from fetch does not contain it.
    logger.warn({ err: String(err) }, 'codex reset-credits: list error');
    return { ok: false, error: CODEX_RESET_CREDITS_ERROR.REQUEST_FAILED };
  }
}

/** Map the app-server's camelCase outcome to our normalized union. */
export function normalizeConsumeOutcome(raw: unknown): CodexConsumeOutcome {
  switch (typeof raw === 'string' ? raw : '') {
    case 'reset':
      return 'reset';
    case 'nothingToReset':
    case 'nothing_to_reset':
      return 'nothing_to_reset';
    case 'alreadyRedeemed':
    case 'already_redeemed':
      return 'already_redeemed';
    case 'noCredits':
    case 'noCreditsAvailable':
    case 'no_credits':
      return 'no_credits';
    default:
      return 'error';
  }
}

/** Consume one reset credit via codex app-server. `nothingToReset` burns nothing. */
export async function consumeCodexResetCredit(idempotencyKey: string): Promise<ConsumeCreditResult> {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return { ok: false, error: CODEX_RESET_CREDITS_ERROR.INVALID_PARAMS };
  }
  const picked = await callCodexAppServerMethod<{ errored: boolean; outcome?: unknown }>(
    'account/rateLimitResetCredit/consume',
    { idempotencyKey },
    (msg) => (msg.error ? { errored: true } : { errored: false, outcome: msg.result?.outcome }),
  );
  if (picked === undefined) return { ok: false, error: CODEX_RESET_CREDITS_ERROR.APP_SERVER_TIMEOUT };
  if (picked.errored) return { ok: false, error: CODEX_RESET_CREDITS_ERROR.REQUEST_FAILED };
  return { ok: true, outcome: normalizeConsumeOutcome(picked.outcome) };
}
