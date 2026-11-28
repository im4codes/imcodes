import type { Context } from 'hono';
import type { Env } from '../env.js';
import {
  SHARED_MACHINE_AUTHORITY_HEADER,
  SHARED_MACHINE_AUTHORITY_TYPE,
  type SharedMachineAuthorityClaims,
} from '../../../shared/shared-machine-authority.js';
import { resolveSharedMachineAuthority } from '../share/shared-machine-authority.js';
import { isSharedOrContributedServer, isWholeServerShareUser } from './server-share-boundary.js';

export { isSharedOrContributedServer, isWholeServerShareUser };

export type DaemonCallerAuthority =
  | {
      ok: true;
      kind: 'interactive_user';
      isDaemon: false;
      userId: string;
      actorUserId: string;
    }
  | {
      ok: true;
      kind: 'participant_daemon';
      isDaemon: true;
      userId: string;
      actorUserId: string;
      sourceServerId: string;
      claims: SharedMachineAuthorityClaims;
    }
  | {
      ok: true;
      kind: 'owner_daemon';
      isDaemon: true;
      userId: string;
      actorUserId: string;
      sourceServerId: string;
      restrictedSharedHost: boolean;
      hasTurnAuthority?: boolean;
    }
  | {
      ok: false;
      status: 403;
      error: 'forbidden';
      reason:
        | 'shared_machine_authority_invalid'
        | 'shared_participant_forbidden'
        | 'shared_host_daemon_authority_required'
        | 'daemon_cross_server_forbidden';
    };

export interface ResolveDaemonCallerOptions {
  /** Reject delegated participant turns (for owner-private stores/actions). */
  denyParticipant?: boolean;
  /** Reject absent-header daemon calls when the source server is shared or group-contributed. Default: true. */
  denySharedHostAbsentAuthority?: boolean;
  /** Target serverId that the request tries to access; enforced for daemons when supplied. */
  targetServerId?: string;
  /** Require `targetServerId === authServerId` for daemon calls (defaults true if targetServerId is passed unless allowOwnerCrossServer is set). */
  allowOwnerCrossServer?: boolean;
}

/**
 * Resolve caller authority with strict daemon/shared-host isolation.
 */
export async function resolveDaemonCallerAuthority<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  E extends { Bindings: Env; Variables?: any } = { Bindings: Env; Variables: any },
>(
  c: Context<E>,
  options: ResolveDaemonCallerOptions = {},
): Promise<DaemonCallerAuthority> {
  const userId = c.get('userId' as never) as string;
  const authServerId = c.get('authServerId' as never) as string | undefined;
  if (!authServerId) {
    return {
      ok: true,
      kind: 'interactive_user',
      isDaemon: false,
      userId,
      actorUserId: userId,
    };
  }

  const now = Date.now();
  const rawHeader = c.req.header(SHARED_MACHINE_AUTHORITY_HEADER);
  const delegated = await resolveSharedMachineAuthority(c.env.DB, {
    token: rawHeader,
    signingKey: c.env.JWT_SIGNING_KEY,
    authenticatedSourceServerId: authServerId,
    sourceOwnerUserId: userId,
    now,
  });

  if (delegated.kind === 'invalid') {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      reason: 'shared_machine_authority_invalid',
    };
  }

  if (delegated.kind === 'participant') {
    if (options.denyParticipant) {
      return {
        ok: false,
        status: 403,
        error: 'forbidden',
        reason: 'shared_participant_forbidden',
      };
    }
    if (options.targetServerId && options.targetServerId !== authServerId) {
      return {
        ok: false,
        status: 403,
        error: 'forbidden',
        reason: 'daemon_cross_server_forbidden',
      };
    }
    const claims: SharedMachineAuthorityClaims = {
      type: SHARED_MACHINE_AUTHORITY_TYPE,
      sub: delegated.actorUserId,
      sourceServerId: authServerId,
      sessionName: delegated.sessionName,
      projectName: delegated.projectName,
      shareTarget: delegated.shareTarget ?? { kind: 'main', serverId: authServerId, sessionName: delegated.sessionName },
      actionId: delegated.actionId ?? '',
      rootSessionName: delegated.rootSessionName,
    };
    return {
      ok: true,
      kind: 'participant_daemon',
      isDaemon: true,
      userId,
      actorUserId: delegated.actorUserId,
      sourceServerId: authServerId,
      claims,
    };
  }

  const restrictedSharedHost = await isSharedOrContributedServer(c.env.DB, authServerId, now);
  if (delegated.kind === 'absent' && restrictedSharedHost && options.denySharedHostAbsentAuthority !== false) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      reason: 'shared_host_daemon_authority_required',
    };
  }

  if (
    options.targetServerId
    && options.targetServerId !== authServerId
    && ((restrictedSharedHost && delegated.kind !== 'owner') || !options.allowOwnerCrossServer)
  ) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      reason: 'daemon_cross_server_forbidden',
    };
  }

  return {
    ok: true,
    kind: 'owner_daemon',
    isDaemon: true,
    userId,
    actorUserId: userId,
    sourceServerId: authServerId,
    restrictedSharedHost,
    hasTurnAuthority: delegated.kind === 'owner',
  };
}

export function daemonScopeFailure<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  E extends { Bindings: Env; Variables?: any } = { Bindings: Env; Variables: any },
>(
  c: Context<E>,
  res: Extract<DaemonCallerAuthority, { ok: false }> | { ok: false; status: 403; error: 'forbidden'; reason: string },
): Response {
  return c.json({ error: res.error, reason: res.reason }, res.status);
}
