import { getCodexRuntimeConfig } from '../agent/codex-runtime-config.js';
import { mergeCodexDisplayMetadata } from '../agent/codex-display.js';
import { persistSessionRecord } from '../agent/session-manager.js';
import { listSessions, upsertSession, type SessionRecord } from '../store/session-store.js';
import { providerQuotaMetaEquals } from '../../shared/provider-quota.js';
import logger from '../util/logger.js';

function stringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function codexDisplayChanged(next: Partial<SessionRecord>, current: SessionRecord): boolean {
  return next.planLabel !== current.planLabel
    || next.quotaLabel !== current.quotaLabel
    || next.quotaUsageLabel !== current.quotaUsageLabel
    || !providerQuotaMetaEquals(next.quotaMeta, current.quotaMeta)
    || !stringArraysEqual(next.codexAvailableModels, current.codexAvailableModels);
}

/**
 * Force-refresh Codex account quota metadata and broadcast it to every Codex
 * session. Reset credits are account-level, so consuming one can change the
 * quota display for any open main/sub Codex session, not just the footer that
 * opened the credit panel.
 */
export async function refreshCodexQuotaMetadataForSessions(reason = 'codex_reset_credit_consume'): Promise<number> {
  let runtime: Awaited<ReturnType<typeof getCodexRuntimeConfig>>;
  try {
    runtime = await getCodexRuntimeConfig({ force: true });
  } catch (err) {
    logger.warn({ err, reason }, 'codex quota refresh failed after reset-credit consume');
    return 0;
  }

  let updated = 0;
  for (const session of listSessions()) {
    if (session.agentType !== 'codex' && session.agentType !== 'codex-sdk') continue;
    const display = mergeCodexDisplayMetadata(runtime, session);
    if (!codexDisplayChanged(display, session)) continue;
    const next: SessionRecord = { ...session, ...display, updatedAt: Date.now() };
    upsertSession(next);
    persistSessionRecord(next, next.name);
    updated += 1;
  }
  if (updated > 0) {
    logger.info({ reason, updated }, 'codex quota metadata refreshed for sessions');
  }
  return updated;
}
