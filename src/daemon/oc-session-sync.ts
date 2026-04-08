/**
 * OC Session Auto-Sync — materialization pipeline.
 *
 * When OpenClaw connects, fetches all remote sessions and materializes them
 * as IM.codes main sessions + sub-sessions. Distinct from the catalog cache
 * (provider.sync_sessions) which only stores the list for UI display.
 */
import { getProvider } from '../agent/provider-registry.js';
import {
  launchTransportSession,
  isProviderSessionBound,
  resolveSessionName,
  getTransportRuntime,
  registerProviderRoute,
  type LaunchOpts,
} from '../agent/session-manager.js';
import { getSession, findSessionByProviderSessionId, upsertSession } from '../store/session-store.js';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import logger from '../util/logger.js';
import type { ServerLink } from './server-link.js';
import type { RemoteSessionInfo } from '../agent/transport-provider.js';
import { normalizeOpenClawDisplayName, preferredOpenClawLabel } from '../agent/openclaw-display.js';

// ── Configuration ───────────────────────────────────────────────────────────

/** Default OC root directory. Override via connect --cwd. */
let ocRoot = join(homedir(), 'clawd');

export function setOcRoot(dir: string): void { ocRoot = dir; }
export function getOcRoot(): string { return ocRoot; }

// ── Key parsing ─────────────────────────────────────────────────────────────

/** Extract agent name from a sanitized OC key: `agent___{name}___...` → `name` */
export function extractAgentName(sanitizedKey: string): string | null {
  const parts = sanitizedKey.split('___');
  // Expected: ['agent', agentName, type, ...]
  if (parts.length < 3 || parts[0] !== 'agent') return null;
  return parts[1];
}

/** Check if a sanitized key is a :main session */
export function isMainSession(sanitizedKey: string): boolean {
  return sanitizedKey.endsWith('___main') && sanitizedKey.split('___').length === 3;
}

/** Check if a session should be filtered (metadata, not a real conversation) */
export function shouldFilter(sanitizedKey: string): boolean {
  if (sanitizedKey.includes('___cron___')) return true; // :cron: (defense-in-depth, also filtered by provider)
  if (sanitizedKey.endsWith('___sessions')) return true; // :sessions (OC metadata)
  return false;
}

/** Check if a session key is an orphan (created with our internal name format by old bug) */
export function isOrphanKey(sanitizedKey: string): boolean {
  return sanitizedKey.includes('___deck_sub_') || sanitizedKey.includes('___deck_agent_');
}

// ── Grouping ────────────────────────────────────────────────────────────────

export interface OcSessionGroup {
  agentName: string;
  mainSession: RemoteSessionInfo | null;
  channelSessions: RemoteSessionInfo[];
}

/** Group OC sessions by agent name. Filters out metadata sessions. */
export function groupByAgent(sessions: RemoteSessionInfo[]): OcSessionGroup[] {
  const groups = new Map<string, OcSessionGroup>();

  for (const s of sessions) {
    if (shouldFilter(s.key)) continue;

    const agentName = extractAgentName(s.key);
    if (!agentName) {
      logger.debug({ key: s.key }, 'oc-sync: cannot extract agent name — skipped');
      continue;
    }

    let group = groups.get(agentName);
    if (!group) {
      group = { agentName, mainSession: null, channelSessions: [] };
      groups.set(agentName, group);
    }

    if (isMainSession(s.key)) {
      group.mainSession = s;
    } else {
      group.channelSessions.push(s);
    }
  }

  return [...groups.values()];
}

// ── Session naming ──────────────────────────────────────────────────────────

export function mainSessionName(agentName: string): string {
  return `deck_agent___${agentName}`;
}

export function mainSessionLabel(agentName: string): string {
  return `OC:${agentName}`;
}

export function mainSessionProjectDir(agentName: string): string {
  return agentName === 'main' ? ocRoot : join(ocRoot, 'agents', agentName);
}

// ── Sync pipeline ───────────────────────────────────────────────────────────

export async function syncOcSessions(serverLink: ServerLink): Promise<void> {
  const provider = getProvider('openclaw');
  if (!provider || !provider.capabilities.sessionRestore || !provider.listSessions) {
    logger.debug('oc-sync: no openclaw provider or no listSessions capability');
    return;
  }

  let sessions: RemoteSessionInfo[];
  try {
    sessions = await provider.listSessions();
  } catch (err) {
    logger.warn({ err }, 'oc-sync: failed to list OC sessions');
    return;
  }

  // ── Delete orphan sessions (created with internal names by old key format bug) ──
  let deleted = 0;
  for (const s of sessions) {
    if (isOrphanKey(s.key)) {
      try {
        await provider.endSession(s.key);
        deleted++;
        logger.info({ key: s.key }, 'oc-sync: deleted orphan session from OC gateway');
      } catch (err) {
        logger.debug({ err, key: s.key }, 'oc-sync: failed to delete orphan session');
      }
    }
  }
  if (deleted > 0) logger.info({ deleted }, 'oc-sync: orphan cleanup complete');

  const groups = groupByAgent(sessions);
  let created = 0;

  for (const group of groups) {
    // ── Main session ──
    const mName = mainSessionName(group.agentName);
    const mainExists = !!getSession(mName);

    if (group.mainSession) {
      const mainRecord = getSession(mName);
      const needsRuntime = !getTransportRuntime(mName);
      // Preserve existing label — only fall back to OC displayName if store has none
      const mainLabel = preferredOpenClawLabel(mainRecord?.label, group.mainSession.displayName, group.mainSession.key) || mainSessionLabel(group.agentName);

      if (mainExists && needsRuntime) {
        // Session in store but runtime lost (daemon restart / OC reconnect) — recreate runtime
        try {
          await launchTransportSession({
            name: mName, projectName: mName, role: 'w1', agentType: 'openclaw',
            label: mainLabel,
            projectDir: mainSessionProjectDir(group.agentName),
            bindExistingKey: group.mainSession.key, skipCreate: true, skipStore: true,
          });
          upsertSession({ ...mainRecord!, state: 'idle', label: mainLabel, updatedAt: Date.now() });
          logger.info({ session: mName, ocKey: group.mainSession.key }, 'oc-sync: reconnected main session runtime');
        } catch (err) {
          registerProviderRoute(group.mainSession.key, mName);
          logger.warn({ err, session: mName }, 'oc-sync: failed to recreate main runtime, route-only fallback');
        }
      } else if (!mainExists) {
        // New session — check uniqueness then create
        if (isProviderSessionBound(group.mainSession.key)) {
          logger.debug({ key: group.mainSession.key, mName }, 'oc-sync: main session providerSessionId already bound — skipped');
        } else {
          try {
            const opts: LaunchOpts = {
              name: mName,
              projectName: mName,
              role: 'w1',
              agentType: 'openclaw',
              label: mainLabel,
              projectDir: mainSessionProjectDir(group.agentName),
              description: normalizeOpenClawDisplayName(group.mainSession.displayName),
              bindExistingKey: group.mainSession.key,
              skipCreate: true,
            };
            await launchTransportSession(opts);
            created++;
            logger.info({ session: mName, ocKey: group.mainSession.key }, 'oc-sync: materialized main session');
          } catch (err) {
            logger.warn({ err, session: mName }, 'oc-sync: failed to materialize main session');
          }
        }
      }
    }

    // ── Sub-sessions (channel bindings) ──
    for (const ch of group.channelSessions) {
      // Route exists AND runtime exists → fully alive, skip
      const existingRoute = resolveSessionName(ch.key);
      if (existingRoute && getTransportRuntime(existingRoute)) continue;

      // Route exists but runtime missing → need to rebuild runtime
      if (existingRoute || isProviderSessionBound(ch.key)) {
        const sName = existingRoute || resolveSessionName(ch.key);
        const storeEntry = sName ? getSession(sName) : findSessionByProviderSessionId(ch.key);
        if (storeEntry && !getTransportRuntime(storeEntry.name)) {
          try {
            await launchTransportSession({
              name: storeEntry.name, projectName: storeEntry.name, role: 'w1', agentType: 'openclaw',
              label: preferredOpenClawLabel(storeEntry.label, ch.displayName, ch.key),
              projectDir: mainSessionProjectDir(group.agentName),
              bindExistingKey: ch.key, skipCreate: true, skipStore: true,
              parentSession: mName,
            });
            const newLabel = preferredOpenClawLabel(storeEntry.label, ch.displayName, ch.key);
            upsertSession({ ...storeEntry, state: 'idle', parentSession: mName, label: newLabel, updatedAt: Date.now() });
            // Update server DB label (may have been stored with sanitized key before displayName fix)
            const subId = storeEntry.name.replace('deck_sub_', '');
            try {
              serverLink.send({
                type: 'subsession.sync', id: subId, sessionType: 'openclaw',
                cwd: mainSessionProjectDir(group.agentName), shellBin: null, ccSessionId: null,
                parentSession: mName, label: newLabel,
                runtimeType: 'transport', providerId: 'openclaw', providerSessionId: ch.key,
              });
            } catch { /* not connected */ }
            logger.info({ session: storeEntry.name, ocKey: ch.key, parent: mName, label: newLabel }, 'oc-sync: rebuilt runtime for existing sub-session');
          } catch (err) {
            logger.warn({ err, session: storeEntry.name }, 'oc-sync: failed to rebuild runtime');
          }
        }
        continue;
      }

      // Check session store — handles OC reconnect without daemon restart
      const existingInStore = findSessionByProviderSessionId(ch.key);
      if (existingInStore) {
        // Exists in store but runtime/route lost — recreate runtime + re-register route
        if (!getTransportRuntime(existingInStore.name)) {
          try {
            await launchTransportSession({
              name: existingInStore.name, projectName: existingInStore.name, role: 'w1', agentType: 'openclaw',
              label: preferredOpenClawLabel(existingInStore.label, ch.displayName, ch.key),
              projectDir: mainSessionProjectDir(group.agentName),
              bindExistingKey: ch.key, skipCreate: true, skipStore: true,
              parentSession: mName,
            });
            // Update store: mark running, set parentSession + label (preserve existing label)
            const reconnLabel = preferredOpenClawLabel(existingInStore.label, ch.displayName, ch.key);
            upsertSession({
              ...existingInStore,
              state: 'idle',
              parentSession: mName,
              label: reconnLabel,
              updatedAt: Date.now(),
            });
            // Update server DB label
            const reconnSubId = existingInStore.name.replace('deck_sub_', '');
            try {
              serverLink.send({
                type: 'subsession.sync', id: reconnSubId, sessionType: 'openclaw',
                cwd: mainSessionProjectDir(group.agentName), shellBin: null, ccSessionId: null,
                parentSession: mName, label: reconnLabel,
                runtimeType: 'transport', providerId: 'openclaw', providerSessionId: ch.key,
              });
            } catch { /* not connected */ }
            logger.info({ session: existingInStore.name, ocKey: ch.key, parent: mName, label: reconnLabel }, 'oc-sync: reconnected sub-session runtime');
          } catch (err) {
            registerProviderRoute(ch.key, existingInStore.name);
            logger.warn({ err, session: existingInStore.name }, 'oc-sync: failed to recreate runtime, route-only fallback');
          }
        } else {
          registerProviderRoute(ch.key, existingInStore.name);
        }
        continue;
      }

      const subId = randomUUID();
      const subName = `deck_sub_${subId}`;
      const parentSession = mName;

      try {
        const opts: LaunchOpts = {
          name: subName,
          projectName: subName,
          role: 'w1',
          agentType: 'openclaw',
          label: preferredOpenClawLabel(undefined, ch.displayName, ch.key),
          projectDir: mainSessionProjectDir(group.agentName),
          description: normalizeOpenClawDisplayName(ch.displayName),
          bindExistingKey: ch.key,
          skipCreate: true,
          parentSession: mName,
        };
        await launchTransportSession(opts);
        created++;

        // Sync to server DB
        try {
          serverLink.send({
            type: 'subsession.sync',
            id: subId,
            sessionType: 'openclaw',
            cwd: mainSessionProjectDir(group.agentName),
            shellBin: null,
            ccSessionId: null,
            parentSession,
            label: preferredOpenClawLabel(undefined, ch.displayName, ch.key),
            runtimeType: 'transport',
            providerId: 'openclaw',
            providerSessionId: ch.key,
          });
        } catch { /* not connected */ }

        logger.info({ session: subName, ocKey: ch.key, parent: parentSession }, 'oc-sync: materialized sub-session');
      } catch (err) {
        logger.warn({ err, ocKey: ch.key }, 'oc-sync: failed to materialize sub-session');
      }
    }
  }

  if (created > 0) {
    logger.info({ created, groups: groups.length }, 'oc-sync: materialization complete');
  } else {
    logger.debug({ groups: groups.length }, 'oc-sync: no new sessions to materialize');
  }
}
