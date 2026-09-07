import { Hono } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import {
  deleteVerificationMachine,
  getVerificationMachine,
  listVerificationMachines,
  recordVerificationMachineStatus,
  upsertVerificationMachine,
} from '../db/verification-machine-queries.js';
import { listControlledMachines } from './machines.js';
import {
  VERIFICATION_MACHINE_KINDS,
  VERIFICATION_MACHINE_LIMITS,
  VERIFICATION_MACHINE_SCOPES,
  VERIFICATION_MACHINE_STATUS_LIST,
  isVerificationMachineId,
  isVerificationMachineKind,
  isVerificationMachineScope,
  normalizeVerificationMachineAlias,
  normalizeVerificationMachineTarget,
  verificationMachineAliasError,
  verificationMachineScopeKeyError,
  verificationMachineTargetError,
  type VerificationMachineScope,
} from '../../../shared/verification-machine.js';

export const verificationMachineRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; authServerId?: string };
}>();

verificationMachineRoutes.use('/*', requireAuth());

function normalizedScopeKey(scope: VerificationMachineScope, value: unknown): string | null {
  if (verificationMachineScopeKeyError(scope, value) !== null) return null;
  return scope === VERIFICATION_MACHINE_SCOPES.USER ? '' : String(value).trim();
}

verificationMachineRoutes.get('/', async (c) => {
  const projectKey = c.req.query('projectKey')?.trim() || undefined;
  const profiles = await listVerificationMachines(c.env.DB, c.get('userId' as never) as string, projectKey);
  if (profiles.length > VERIFICATION_MACHINE_LIMITS.MAX_ITEMS) {
    return c.json({ error: 'verification_machine_list_over_limit' }, 413);
  }
  return c.json({ profiles });
});

verificationMachineRoutes.put('/', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'verification_machine_request_invalid' }, 400);
  const scope = isVerificationMachineScope(body.scope) ? body.scope : null;
  const kind = isVerificationMachineKind(body.kind) ? body.kind : null;
  if (!scope) return c.json({ error: 'verification_machine_scope_invalid' }, 400);
  if (!kind) return c.json({ error: 'verification_machine_kind_invalid' }, 400);
  const scopeKey = normalizedScopeKey(scope, body.scopeKey);
  if (scopeKey === null) return c.json({ error: 'verification_machine_scope_key_invalid' }, 400);
  const aliasReason = verificationMachineAliasError(body.alias);
  if (aliasReason) return c.json({ error: aliasReason }, 400);
  const targetReason = verificationMachineTargetError(kind, body.target);
  if (targetReason) return c.json({ error: targetReason }, 400);
  const userId = c.get('userId' as never) as string;
  const id = body.id === undefined ? randomHex(16) : body.id;
  if (!isVerificationMachineId(id)) return c.json({ error: 'verification_machine_id_invalid' }, 400);
  const existing = await getVerificationMachine(c.env.DB, userId, id);
  if (existing === null && body.id !== undefined) {
    return c.json({ error: 'verification_machine_not_found' }, 404);
  }
  if (kind === VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE) {
    const target = normalizeVerificationMachineTarget(String(body.target));
    const { machines } = await listControlledMachines(c.env.DB, userId, Date.now());
    if (!machines.some((machine) => machine.nodeId === target)) {
      return c.json({ error: 'verification_machine_target_unauthorized' }, 403);
    }
  }
  const expectedRevision = typeof body.expectedRevision === 'number'
    && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0
    ? body.expectedRevision
    : undefined;
  const result = await upsertVerificationMachine(c.env.DB, {
    id,
    userId,
    scope,
    scopeKey,
    alias: normalizeVerificationMachineAlias(String(body.alias)),
    kind,
    target: normalizeVerificationMachineTarget(String(body.target)),
    enabled: body.enabled !== false,
    source: c.req.header('X-Server-Id') ? 'mcp' : 'web',
    expectedRevision,
  });
  if (result === 'revision_conflict' || result === 'alias_conflict') {
    return c.json({ error: result }, 409);
  }
  return c.json({ profile: result });
});

verificationMachineRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isVerificationMachineId(id)) return c.json({ error: 'verification_machine_id_invalid' }, 400);
  const revisionText = c.req.query('expectedRevision');
  const expectedRevision = revisionText && /^\d+$/u.test(revisionText) ? Number(revisionText) : undefined;
  const result = await deleteVerificationMachine(
    c.env.DB,
    c.get('userId' as never) as string,
    id,
    expectedRevision,
  );
  if (result === 'revision_conflict') return c.json({ error: result }, 409);
  return c.json({ deleted: result === 'deleted' });
});

verificationMachineRoutes.post('/:id/verification', async (c) => {
  // Only a full daemon can attest a real-machine probe. A browser may manage
  // registrations, but it must never be able to forge a "verified" result.
  if (!c.get('authServerId')) return c.json({ error: 'verification_machine_daemon_required' }, 403);
  const id = c.req.param('id');
  if (!isVerificationMachineId(id)) return c.json({ error: 'verification_machine_id_invalid' }, 400);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const status = typeof body?.status === 'string'
    && (VERIFICATION_MACHINE_STATUS_LIST as readonly string[]).includes(body.status)
    ? body.status as (typeof VERIFICATION_MACHINE_STATUS_LIST)[number]
    : null;
  if (!status) return c.json({ error: 'verification_machine_status_invalid' }, 400);
  const profile = await recordVerificationMachineStatus(
    c.env.DB,
    c.get('userId' as never) as string,
    id,
    status,
  );
  return profile ? c.json({ profile }) : c.json({ error: 'verification_machine_not_found' }, 404);
});
