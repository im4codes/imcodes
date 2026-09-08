import type { Database } from '../db/client.js';
import { resolveEffectiveShareCoverage } from '../db/tab-sharing.js';
import { signJwt, verifyJwt } from '../security/crypto.js';
import {
  SHARED_MACHINE_AUTHORITY_TYPE,
  type SharedMachineAuthorityClaims,
} from '../../../shared/shared-machine-authority.js';
import type { ShareTarget } from '../../../shared/tab-sharing.js';
import {
  resolveControlledMachineOperatorAccess,
  type ControlledMachineOperatorAccessRow,
} from './machine-access.js';

const AUTHORITY_TTL_SECONDS = 24 * 60 * 60;

function parseTarget(value: unknown): ShareTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (target.kind === 'server' && typeof target.serverId === 'string' && target.serverId) {
    return { kind: 'server', serverId: target.serverId };
  }
  if (target.kind === 'main' && typeof target.serverId === 'string' && target.serverId
    && typeof target.sessionName === 'string' && target.sessionName) {
    return { kind: 'main', serverId: target.serverId, sessionName: target.sessionName };
  }
  if (target.kind === 'subsession' && typeof target.serverId === 'string' && target.serverId
    && typeof target.subSessionId === 'string' && target.subSessionId) {
    return { kind: 'subsession', serverId: target.serverId, subSessionId: target.subSessionId };
  }
  return null;
}

export function issueSharedMachineAuthority(
  claims: SharedMachineAuthorityClaims,
  signingKey: string,
): string {
  return signJwt(claims as unknown as Record<string, unknown>, signingKey, AUTHORITY_TTL_SECONDS);
}

type SessionBinding = { projectName: string; parentSessionName: string | null; subSessionId: string | null };

async function readSessionBinding(
  db: Database,
  sourceServerId: string,
  sessionName: string,
): Promise<SessionBinding | null> {
  const subSessionId = sessionName.match(/^deck_sub_([A-Za-z0-9_-]+)$/)?.[1];
  if (subSessionId) {
    const row = await db.queryOne<{ project_name: string; parent_session: string | null }>(
      `SELECT s.project_name, ss.parent_session
         FROM sub_sessions ss
         JOIN sessions s ON s.server_id = ss.server_id AND s.name = ss.parent_session
        WHERE ss.server_id = $1 AND ss.id = $2 AND ss.closed_at IS NULL
        LIMIT 1`,
      [sourceServerId, subSessionId],
    );
    return row ? { projectName: row.project_name, parentSessionName: row.parent_session, subSessionId } : null;
  }
  const row = await db.queryOne<{ project_name: string }>(
    'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
    [sourceServerId, sessionName],
  );
  return row ? { projectName: row.project_name, parentSessionName: null, subSessionId: null } : null;
}

function targetCoversBinding(target: ShareTarget, sessionName: string, binding: SessionBinding): boolean {
  if (target.kind === 'server') return true;
  if (target.kind === 'main') {
    return target.sessionName === sessionName || target.sessionName === binding.parentSessionName;
  }
  return target.subSessionId === binding.subSessionId;
}

export async function issueSharedMachineAuthorityForSession(
  db: Database,
  input: {
    actorUserId: string;
    sourceServerId: string;
    sessionName: string;
    shareTarget: ShareTarget;
    actionId: string;
    signingKey: string;
  },
): Promise<string | null> {
  const binding = await readSessionBinding(db, input.sourceServerId, input.sessionName);
  if (!binding || !targetCoversBinding(input.shareTarget, input.sessionName, binding)) return null;
  return issueSharedMachineAuthority({
    type: SHARED_MACHINE_AUTHORITY_TYPE,
    sub: input.actorUserId,
    sourceServerId: input.sourceServerId,
    sessionName: input.sessionName,
    projectName: binding.projectName,
    shareTarget: input.shareTarget,
    actionId: input.actionId,
  }, input.signingKey);
}

export type SharedMachineAuthorityDecision =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'participant'; actorUserId: string; sessionName: string; projectName: string };

/**
 * Verify the server-minted turn authority and re-read the live share grant.
 * Invalid presence never falls back to source-owner authority.
 */
export async function resolveSharedMachineAuthority(
  db: Database,
  input: {
    token: string | undefined;
    signingKey: string;
    authenticatedSourceServerId: string;
    now: number;
  },
): Promise<SharedMachineAuthorityDecision> {
  if (!input.token) return { kind: 'absent' };
  const raw = verifyJwt(input.token, input.signingKey);
  const shareTarget = parseTarget(raw?.shareTarget);
  if (!raw || raw.type !== SHARED_MACHINE_AUTHORITY_TYPE
    || typeof raw.sub !== 'string' || !raw.sub
    || typeof raw.sourceServerId !== 'string'
    || raw.sourceServerId !== input.authenticatedSourceServerId
    || typeof raw.sessionName !== 'string' || !raw.sessionName
    || typeof raw.projectName !== 'string' || !raw.projectName
    || typeof raw.actionId !== 'string' || !raw.actionId
    || !shareTarget || shareTarget.serverId !== input.authenticatedSourceServerId) {
    return { kind: 'invalid' };
  }
  const binding = await readSessionBinding(db, input.authenticatedSourceServerId, raw.sessionName);
  if (!binding || binding.projectName !== raw.projectName
    || !targetCoversBinding(shareTarget, raw.sessionName, binding)) {
    return { kind: 'invalid' };
  }
  const coverage = await resolveEffectiveShareCoverage(db, {
    userId: raw.sub,
    target: shareTarget,
    now: input.now,
  });
  if (!coverage || coverage.effectiveRole !== 'participant') return { kind: 'invalid' };
  return {
    kind: 'participant',
    actorUserId: raw.sub,
    sessionName: raw.sessionName,
    projectName: raw.projectName,
  };
}

export async function resolveMachineOperationalUser(
  db: Database,
  input: {
    token: string | undefined;
    signingKey: string;
    authenticatedSourceServerId: string;
    sourceOwnerUserId: string;
    now: number;
  },
): Promise<{ userId: string; delegatedActorUserId?: string } | null> {
  const delegated = await resolveSharedMachineAuthority(db, input);
  if (delegated.kind === 'invalid') return null;
  return delegated.kind === 'participant'
    ? { userId: input.sourceOwnerUserId, delegatedActorUserId: delegated.actorUserId }
    : { userId: input.sourceOwnerUserId };
}

/**
 * Single action-admission boundary for daemon-originated controlled-device
 * operations. The signed shared-turn context is verified against its exact
 * source session/project and live participant grant, then the exact target is
 * resolved as the source owner's current controlled device. A present but
 * invalid delegated context never falls back to owner authority.
 */
export async function resolveMachineOperationalAccess(
  db: Database,
  input: {
    token: string | undefined;
    signingKey: string;
    authenticatedSourceServerId: string;
    sourceOwnerUserId: string;
    targetServerId: string;
    now: number;
  },
): Promise<{
  target: ControlledMachineOperatorAccessRow;
  delegatedActorUserId?: string;
} | null> {
  const operational = await resolveMachineOperationalUser(db, input);
  if (!operational) return null;
  const target = await resolveControlledMachineOperatorAccess(
    db,
    operational.userId,
    input.targetServerId,
    input.now,
  );
  if (!target) return null;
  return {
    target,
    ...(operational.delegatedActorUserId
      ? { delegatedActorUserId: operational.delegatedActorUserId }
      : {}),
  };
}
