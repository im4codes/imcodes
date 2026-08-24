import type { Database } from '../db/client.js';
import {
  isCanonicalRemoteDesktopCreationRequestId,
} from '../../../shared/remote-desktop-access.js';
import { isRemoteDesktopId } from '../../../shared/remote-desktop-contract-primitives.js';
import {
  consumeActionBoundStepUpGrant,
  type AccountSession,
} from './remote-desktop-account-auth.js';
import { rotatePublicNodeId } from './remote-desktop-host-identity.js';

export const OWNER_HOST_MANAGEMENT_ERROR = {
  INVALID: 'invalid',
  UNAUTHORIZED: 'unauthorized',
  STEP_UP_REQUIRED: 'step_up_required',
} as const;

export type OwnerHostManagementErrorCode =
  (typeof OWNER_HOST_MANAGEMENT_ERROR)[keyof typeof OWNER_HOST_MANAGEMENT_ERROR];

export class OwnerHostManagementError extends Error {
  constructor(readonly code: OwnerHostManagementErrorCode) {
    super(code);
    this.name = 'OwnerHostManagementError';
  }
}

export interface OwnerRemoteDesktopHostSummary {
  hostId: string;
  publicNodeId: string;
  mergeState: 'resolved' | 'conflict_pending';
}

interface OwnerHostRow {
  id: string;
  owner_user_id: string;
  merge_state: 'resolved' | 'conflict_pending';
  public_id: string | null;
}

async function loadOwnedHost(
  db: Database,
  ownerUserId: string,
  hostId: string,
  forUpdate = false,
): Promise<OwnerHostRow> {
  const row = await db.queryOne<OwnerHostRow>(
    `SELECT host.id, host.owner_user_id, host.merge_state, identity.public_id
       FROM remote_desktop_hosts AS host
       LEFT JOIN remote_desktop_public_ids AS identity
         ON identity.host_id = host.id AND identity.status = 'active'
      WHERE host.id = $1 AND host.owner_user_id = $2
      ${forUpdate ? 'FOR UPDATE OF host' : ''}`,
    [hostId, ownerUserId],
  );
  if (!row || row.public_id === null) {
    // A missing host, foreign host, and not-yet-qualified host are deliberately
    // indistinguishable at this Owner API boundary.
    throw new OwnerHostManagementError(OWNER_HOST_MANAGEMENT_ERROR.UNAUTHORIZED);
  }
  return row;
}

function toSummary(row: OwnerHostRow): OwnerRemoteDesktopHostSummary {
  return {
    hostId: row.id,
    publicNodeId: row.public_id!,
    mergeState: row.merge_state,
  };
}

/** Owner-only, non-secret canonical-host identity summary. */
export async function getOwnerRemoteDesktopHostSummary(
  db: Database,
  input: { accountSession: AccountSession; hostId: string },
): Promise<OwnerRemoteDesktopHostSummary> {
  if (!isRemoteDesktopId(input.hostId)) {
    throw new OwnerHostManagementError(OWNER_HOST_MANAGEMENT_ERROR.INVALID);
  }
  return toSummary(await loadOwnedHost(db, input.accountSession.userId, input.hostId));
}

export interface RotateOwnerPublicNodeIdInput {
  accountSession: AccountSession;
  hostId: string;
  requestId: string;
  stepUpToken: string;
  now: number;
}

/**
 * Rotate lookup identity under the same transaction that consumes step-up.
 *
 * Password proof currently has no separate durable challenge row. Its
 * post-proof, unredeemed bootstrap rows are identifiable by `node_password` and
 * are cancelled here. `rotatePublicNodeId` and password bootstrap issuance both
 * lock the same active public-ID row, so this deletion cannot miss an issuer
 * admitted from the retiring ID. Link challenges and link bootstraps do not
 * originate from the public node ID and therefore survive rotation. Password
 * generation and admitted guest sessions/routes are intentionally untouched.
 */
export async function rotateOwnerPublicNodeId(
  db: Database,
  input: RotateOwnerPublicNodeIdInput,
): Promise<{
  host: OwnerRemoteDesktopHostSummary;
  previousPublicNodeId: string;
  replayed: boolean;
}> {
  if (!isRemoteDesktopId(input.hostId)
    || !isCanonicalRemoteDesktopCreationRequestId(input.requestId)) {
    throw new OwnerHostManagementError(OWNER_HOST_MANAGEMENT_ERROR.INVALID);
  }

  const used = await consumeActionBoundStepUpGrant<{
    host: OwnerRemoteDesktopHostSummary;
    previousPublicNodeId: string;
  }>(
    db,
    {
      token: input.stepUpToken,
      accountSession: input.accountSession,
      canonicalHostId: input.hostId,
      action: { kind: 'remote_desktop.public_id.rotate', hostId: input.hostId },
      requestId: input.requestId,
    },
    async (tx) => {
      await loadOwnedHost(tx, input.accountSession.userId, input.hostId, true);
      const rotated = await rotatePublicNodeId({
        db: tx,
        hostId: input.hostId,
        now: input.now,
        onRotatedTx: async (rotationTx) => {
          await rotationTx.execute(
            `DELETE FROM remote_desktop_guest_bootstraps
              WHERE host_id = $1
                AND actor_source = 'node_password'
                AND redeemed_at IS NULL`,
            [input.hostId],
          );
        },
      });
      const host = await loadOwnedHost(tx, input.accountSession.userId, input.hostId);
      return { host: toSummary(host), previousPublicNodeId: rotated.previousPublicId };
    },
    input.now,
  );

  if (!used.ok) {
    throw new OwnerHostManagementError(OWNER_HOST_MANAGEMENT_ERROR.STEP_UP_REQUIRED);
  }
  return { ...used.result, replayed: used.replayed };
}
