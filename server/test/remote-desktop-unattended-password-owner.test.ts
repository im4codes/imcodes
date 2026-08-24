import { createHash, generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { createRemoteDesktopUnattendedPasswordPublicRoutes } from '../src/routes/remote-desktop-unattended-password.js';
import {
  RemoteDesktopUnattendedPasswordProofService,
  UNATTENDED_PASSWORD_RESULT,
  applyUnattendedPasswordMutationTx,
  createServerUnattendedPasswordPepperRing,
  deriveUnattendedPasswordVerifier,
  isUnattendedPasswordGenerationCurrent,
  mutateUnattendedPassword,
  unattendedPasswordStepUpAction,
  type UnattendedPasswordKdf,
  type UnattendedPasswordMutationResult,
  type UnattendedPasswordVerifierMaterial,
} from '../src/services/remote-desktop-unattended-password.js';
import { digestStepUpAction, type AccountSession } from '../src/services/remote-desktop-account-auth.js';
import { REMOTE_DESKTOP_ACTOR_SOURCE } from '../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';

const HOST_ID = 'host-password-owner';
const OWNER_ID = 'owner-password';
const SESSION: AccountSession = { kind: 'web', id: 'web-session-hash', userId: OWNER_ID };
const EPOCH = { epochId: 'epoch-password', revision: 7 };
const NOW = 1_900_000_000_000;
const PASSWORD = 'Correct horse 4! battery';
const NEXT_PASSWORD = 'Different horse 5! battery';
const SERVER_SECRET = 'server-secret-for-password-tests-at-least-32-bytes';
const BROWSER_PUBLIC_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
const BROWSER_PUBLIC_KEY_SPKI = (BROWSER_PUBLIC_KEY.export({ format: 'der', type: 'spki' }) as Buffer)
  .toString('base64url');
const BROWSER_THUMBPRINT = createHash('sha256')
  .update(Buffer.from(BROWSER_PUBLIC_KEY_SPKI, 'base64url'))
  .digest('base64url');
const OTHER_BROWSER_SPKI = (generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
  .export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');

function requestId(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64url');
}

function grantToken(label: string): string {
  return `rdsg_${label}`;
}

function grantHash(token: string): string {
  return createHash('sha256')
    .update('imcodes.remote-desktop.step-up-grant.v1', 'utf8')
    .update(Buffer.from([0]))
    .update(token, 'utf8')
    .digest('hex');
}

class FixtureKdf implements UnattendedPasswordKdf {
  readonly hashedSecrets: string[] = [];

  async hash(secret: string): Promise<string> {
    this.hashedSecrets.push(secret);
    const salt = createHash('sha256').update(`salt:${this.hashedSecrets.length}:${secret}`).digest('hex');
    const verifier = createHash('sha512').update(`verifier:${this.hashedSecrets.length}:${secret}`).digest('hex');
    return `${salt}:${verifier}`;
  }

  async verify(): Promise<boolean> { return false; }
}

type CredentialState = UnattendedPasswordVerifierMaterial & {
  generation: number;
  changedAt: number;
  disabledAt: number | null;
};

type RouteState = {
  routeId: string;
  routeGeneration: number;
  serverId: string | null;
  auditId: string | null;
  sessionId: string | null;
};

type GrantState = {
  id: string;
  userId: string;
  sessionKind: 'web' | 'native';
  sessionId: string;
  hostId: string;
  actionDigest: string;
  requestId: string;
  deadline: number;
  expiresAt: number;
  consumedAt: number | null;
  resultJson: string | null;
};

type MemoryState = {
  ownerId: string;
  mergeState: string;
  privacyEpochId: string;
  privacyRevision: number;
  privacyPhase: string;
  admissionOpen: boolean;
  credential: CredentialState | null;
  grants: Map<string, GrantState>;
  routes: RouteState[];
  sessions: Map<string, { state: 'admitting' | 'active' | 'closed'; passwordGeneration: number | null }>;
  outbox: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  nextSequence: number;
};

class MemoryPasswordDatabase {
  state: MemoryState;
  failOutbox = false;
  private transactionTail: Promise<void> = Promise.resolve();

  readonly db = {
    query: async <T>(sql: string): Promise<T[]> => this.query<T>(sql),
    queryOne: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => (
      this.queryOne<T>(sql, params)
    ),
    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => (
      this.execute(sql, params)
    ),
    transaction: async <T>(run: (tx: Database) => Promise<T>): Promise<T> => {
      let release!: () => void;
      const previous = this.transactionTail;
      this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const snapshot = structuredClone(this.state);
      try {
        return await run(this.db as unknown as Database);
      } catch (error) {
        this.state = snapshot;
        throw error;
      } finally {
        release();
      }
    },
  } as unknown as Database;

  constructor(overrides: Partial<MemoryState> = {}) {
    this.state = {
      ownerId: OWNER_ID,
      mergeState: 'resolved',
      privacyEpochId: EPOCH.epochId,
      privacyRevision: EPOCH.revision,
      privacyPhase: 'active',
      admissionOpen: false,
      credential: null,
      grants: new Map(),
      routes: [],
      sessions: new Map(),
      outbox: [],
      audits: [],
      nextSequence: 1,
      ...overrides,
    };
  }

  addGrant(token: string, action: 'set' | 'change' | 'disable', id: string): string {
    const idempotencyRequestId = requestId(Number(id.at(-1) ?? '1'));
    this.state.grants.set(grantHash(token), {
      id,
      userId: OWNER_ID,
      sessionKind: SESSION.kind,
      sessionId: SESSION.id,
      hostId: HOST_ID,
      actionDigest: digestStepUpAction(unattendedPasswordStepUpAction({
        hostId: HOST_ID, action, requestId: idempotencyRequestId,
      })),
      requestId: idempotencyRequestId,
      deadline: NOW + 60_000,
      expiresAt: NOW + 60_000,
      consumedAt: null,
      resultJson: null,
    });
    return idempotencyRequestId;
  }

  private normalize(sql: string): string { return sql.toLowerCase().replace(/\s+/gu, ' ').trim(); }

  private async query<T>(sql: string): Promise<T[]> {
    const normalized = this.normalize(sql);
    if (normalized.includes('from remote_desktop_host_routes as route')) {
      return this.state.routes.map((route) => ({
        route_id: route.routeId,
        route_generation: route.routeGeneration,
        execution_server_id: route.serverId,
        actor_audit_id: route.auditId,
        guest_session_id: route.sessionId,
      } as T));
    }
    throw new Error(`Unhandled query: ${normalized}`);
  }

  private async queryOne<T>(sql: string, params: unknown[]): Promise<T | null> {
    const normalized = this.normalize(sql);
    if (normalized.startsWith('select pg_advisory_xact_lock')) return { locked: null } as T;
    if (normalized.includes('from users as account')) return { id: OWNER_ID } as T;
    if (normalized.includes('from remote_desktop_step_up_grants')) {
      const grant = this.state.grants.get(String(params[0]));
      return grant ? {
        id: grant.id,
        user_id: grant.userId,
        account_session_kind: grant.sessionKind,
        account_session_id: grant.sessionId,
        canonical_host_id: grant.hostId,
        action_digest: grant.actionDigest,
        request_id: grant.requestId,
        deadline: grant.deadline,
        expires_at: grant.expiresAt,
        consumed_at: grant.consumedAt,
        result_json: grant.resultJson,
      } as T : null;
    }
    if (normalized.includes('from remote_desktop_hosts')) {
      return { id: HOST_ID, owner_user_id: this.state.ownerId, merge_state: this.state.mergeState } as T;
    }
    if (normalized.includes('from remote_desktop_management_privacy')) {
      return {
        host_id: HOST_ID,
        epoch_id: this.state.privacyEpochId,
        revision: this.state.privacyRevision,
        phase: this.state.privacyPhase,
        admission_open: this.state.admissionOpen,
        presentation_source: 'management_web',
        execution_server_id: 'server-owner',
        daemon_generation: 2,
        worker_generation: 3,
        route_snapshot: [],
        acknowledged_routes: [],
        lease_expires_at: NOW + 60_000,
        deadline: NOW + 30_000,
        recovery_reason: null,
        fresh_frame_generation: null,
      } as T;
    }
    if (normalized.includes('from remote_desktop_unattended_passwords')) {
      const credential = this.state.credential;
      return credential ? {
        generation: credential.generation,
        disabled_at: credential.disabledAt,
      } as T : null;
    }
    if (normalized.startsWith('select sequence from remote_desktop_guest_outbox')) return null;
    if (normalized.startsWith('insert into remote_desktop_host_effect_sequences')) {
      const sequence = this.state.nextSequence;
      this.state.nextSequence += 1;
      return { sequence } as T;
    }
    if (normalized.startsWith('insert into remote_desktop_guest_outbox')) {
      if (this.failOutbox) throw new Error('synthetic_outbox_failure');
      const payload = JSON.parse(String(params[8])) as Record<string, unknown>;
      this.state.outbox.push(payload);
      return { sequence: payload.sequence } as T;
    }
    throw new Error(`Unhandled queryOne: ${normalized}`);
  }

  private async execute(sql: string, params: unknown[]): Promise<{ changes: number }> {
    const normalized = this.normalize(sql);
    if (normalized.startsWith('insert into remote_desktop_unattended_passwords')) {
      this.state.credential = {
        verifierVersion: String(params[1]) as 'scrypt-v1',
        verifier: String(params[2]),
        salt: String(params[3]),
        pepperVersion: String(params[4]),
        generation: Number(params[5]),
        changedAt: Number(params[6]),
        disabledAt: null,
      };
      return { changes: 1 };
    }
    if (normalized.startsWith('update remote_desktop_unattended_passwords')) {
      const current = this.state.credential;
      if (!current) return { changes: 0 };
      if (normalized.includes('set generation = $2, disabled_at = $3')) {
        if (current.generation !== Number(params[3]) || current.disabledAt !== null) return { changes: 0 };
        current.generation = Number(params[1]);
        current.disabledAt = Number(params[2]);
      } else {
        if (current.generation !== Number(params[7])) return { changes: 0 };
        current.verifierVersion = String(params[1]) as 'scrypt-v1';
        current.verifier = String(params[2]);
        current.salt = String(params[3]);
        current.pepperVersion = String(params[4]);
        current.generation = Number(params[5]);
        current.changedAt = Number(params[6]);
        current.disabledAt = null;
      }
      return { changes: 1 };
    }
    if (normalized.startsWith('update remote_desktop_guest_sessions')) {
      for (const session of this.state.sessions.values()) {
        if (session.state !== 'closed') session.state = 'closed';
      }
      return { changes: this.state.sessions.size };
    }
    if (normalized.startsWith('insert into remote_desktop_guest_audit')) {
      this.state.audits.push({
        hostId: params[1],
        actorReferenceHash: params[2],
        eventType: params[3],
        mode: params[4],
        source: params[5],
        metadata: JSON.parse(String(params[6])),
      });
      return { changes: 1 };
    }
    if (normalized.startsWith('update remote_desktop_step_up_grants')) {
      const grant = [...this.state.grants.values()].find((candidate) => candidate.id === params[2]);
      if (!grant || grant.consumedAt !== null) return { changes: 0 };
      grant.consumedAt = Number(params[0]);
      grant.resultJson = String(params[1]);
      return { changes: 1 };
    }
    if (normalized.startsWith('select pg_notify')) return { changes: 1 };
    throw new Error(`Unhandled execute: ${normalized}`);
  }
}

async function material(password = PASSWORD): Promise<UnattendedPasswordVerifierMaterial> {
  return deriveUnattendedPasswordVerifier({
    password,
    peppers: createServerUnattendedPasswordPepperRing(SERVER_SECRET),
    kdf: new FixtureKdf(),
  });
}

async function ownerMutation(input: {
  memory: MemoryPasswordDatabase;
  token: string;
  requestId: string;
  action: 'set' | 'change' | 'disable';
  password?: string;
}) {
  return mutateUnattendedPassword({
    db: input.memory.db,
    accountSession: SESSION,
    stepUpGrant: input.token,
    privacyEpoch: EPOCH,
    mutation: {
      hostId: HOST_ID,
      action: input.action,
      requestId: input.requestId,
      ...(input.password === undefined ? {} : { password: input.password }),
    },
    peppers: createServerUnattendedPasswordPepperRing(SERVER_SECRET),
    kdf: new FixtureKdf(),
    now: NOW,
  });
}

describe('unattended password Owner mutation and generation', () => {
  it('uses a secret-free action-bound step-up and persists only derived material', async () => {
    const memory = new MemoryPasswordDatabase();
    const token = grantToken('set');
    const idempotencyRequestId = memory.addGrant(token, 'set', 'grant-1');
    const action = unattendedPasswordStepUpAction({
      hostId: HOST_ID, action: 'set', requestId: idempotencyRequestId,
    });
    expect(action).not.toHaveProperty('password');
    expect(JSON.stringify(action)).not.toContain(PASSWORD);

    const used = await ownerMutation({
      memory, token, requestId: idempotencyRequestId, action: 'set', password: PASSWORD,
    });
    expect(used).toEqual({
      ok: true,
      replayed: false,
      result: { hostId: HOST_ID, generation: 1, state: 'enabled', effectsEmitted: 0 },
    });
    expect(memory.state.credential).toMatchObject({ generation: 1, disabledAt: null });
    expect(JSON.stringify(memory.state)).not.toContain(PASSWORD);
    expect(memory.state.outbox).toHaveLength(0);
    expect(memory.state.audits[0]).toMatchObject({
      eventType: 'remote_desktop.password.set',
      metadata: { generation: 1, effectsEmitted: 0 },
    });
  });

  it('serializes concurrent changes without losing either generation advance', async () => {
    const memory = new MemoryPasswordDatabase({
      credential: { ...(await material()), generation: 1, changedAt: NOW - 1, disabledAt: null },
    });
    const tokenA = grantToken('change-a');
    const tokenB = grantToken('change-b');
    const requestA = memory.addGrant(tokenA, 'change', 'grant-2');
    const requestB = memory.addGrant(tokenB, 'change', 'grant-3');
    const results = await Promise.all([
      ownerMutation({ memory, token: tokenA, requestId: requestA, action: 'change', password: NEXT_PASSWORD }),
      ownerMutation({ memory, token: tokenB, requestId: requestB, action: 'change', password: PASSWORD }),
    ]);
    expect(results.map((result) => result.ok && result.result.generation).sort()).toEqual([2, 3]);
    expect(memory.state.credential?.generation).toBe(3);
  });

  it('revokes every older password route with its real route identity and no fabricated host event', async () => {
    const memory = new MemoryPasswordDatabase({
      credential: { ...(await material()), generation: 4, changedAt: NOW - 1, disabledAt: null },
      routes: [{
        routeId: 'route-password-1', routeGeneration: 9, serverId: 'server-password-1',
        auditId: 'password-audit-1', sessionId: 'guest-password-1',
      }],
      sessions: new Map([['guest-password-1', { state: 'active', passwordGeneration: 4 }]]),
    });
    const token = grantToken('change-route');
    const idempotencyRequestId = memory.addGrant(token, 'change', 'grant-4');
    const used = await ownerMutation({
      memory, token, requestId: idempotencyRequestId, action: 'change', password: NEXT_PASSWORD,
    });
    expect(used.ok && used.result).toMatchObject({ generation: 5, effectsEmitted: 1 });
    expect(memory.state.sessions.get('guest-password-1')?.state).toBe('closed');
    expect(memory.state.outbox).toEqual([expect.objectContaining({
      effect: 'terminal',
      scope: 'route',
      hostId: HOST_ID,
      targetServerId: 'server-password-1',
      routeGeneration: 9,
      actorAuditId: 'password-audit-1',
      authorityKind: 'password',
      sessionAuditId: 'guest-password-1',
      passwordGeneration: 5,
    })]);
    await expect(isUnattendedPasswordGenerationCurrent({
      db: memory.db, hostId: HOST_ID, generation: 4,
    })).resolves.toBe(false);
    await expect(isUnattendedPasswordGenerationCurrent({
      db: memory.db, hostId: HOST_ID, generation: 5,
    })).resolves.toBe(true);
  });

  it('emergency-disables without an old password and invalidates the current generation', async () => {
    const memory = new MemoryPasswordDatabase({
      credential: { ...(await material()), generation: 2, changedAt: NOW - 1, disabledAt: null },
      routes: [{
        routeId: 'route-password-disable', routeGeneration: 3, serverId: 'server-password-1',
        auditId: 'password-audit-disable', sessionId: 'guest-password-disable',
      }],
      sessions: new Map([['guest-password-disable', { state: 'active', passwordGeneration: 2 }]]),
    });
    const token = grantToken('disable');
    const idempotencyRequestId = memory.addGrant(token, 'disable', 'grant-5');
    const used = await ownerMutation({
      memory, token, requestId: idempotencyRequestId, action: 'disable',
    });
    expect(used.ok && used.result).toEqual({
      hostId: HOST_ID, generation: 3, state: 'disabled', effectsEmitted: 1,
    });
    expect(memory.state.credential).toMatchObject({ generation: 3, disabledAt: NOW });
    expect(memory.state.sessions.get('guest-password-disable')?.state).toBe('closed');
    expect(memory.state.outbox).toEqual([expect.objectContaining({
      authorityKind: 'password',
      effect: 'terminal',
      actorAuditId: 'password-audit-disable',
      sessionAuditId: 'guest-password-disable',
      passwordGeneration: 3,
    })]);
    await expect(isUnattendedPasswordGenerationCurrent({
      db: memory.db, hostId: HOST_ID, generation: 3,
    })).resolves.toBe(false);
  });

  it('refuses to invent delivery identity when a live password route is malformed', async () => {
    const original = { ...(await material()), generation: 6, changedAt: NOW - 1, disabledAt: null };
    const memory = new MemoryPasswordDatabase({
      credential: structuredClone(original),
      routes: [{
        routeId: 'route-password-malformed', routeGeneration: 4, serverId: null,
        auditId: null, sessionId: 'guest-password-malformed',
      }],
      sessions: new Map([['guest-password-malformed', { state: 'active', passwordGeneration: 6 }]]),
    });
    const token = grantToken('malformed-route');
    const idempotencyRequestId = memory.addGrant(token, 'disable', 'grant-8');
    await expect(ownerMutation({
      memory, token, requestId: idempotencyRequestId, action: 'disable',
    })).rejects.toThrow('password_route_invariant_failed');
    expect(memory.state.credential).toEqual(original);
    expect(memory.state.outbox).toHaveLength(0);
    expect(memory.state.grants.get(grantHash(token))?.consumedAt).toBeNull();
  });

  it('rolls credential, route invalidation and single-use grant back together when outbox append fails', async () => {
    const original = { ...(await material()), generation: 8, changedAt: NOW - 1, disabledAt: null };
    const memory = new MemoryPasswordDatabase({
      credential: structuredClone(original),
      routes: [{
        routeId: 'route-password-fail', routeGeneration: 2, serverId: 'server-password-1',
        auditId: 'password-audit-fail', sessionId: 'guest-password-fail',
      }],
      sessions: new Map([['guest-password-fail', { state: 'active', passwordGeneration: 8 }]]),
    });
    memory.failOutbox = true;
    const token = grantToken('rollback');
    const idempotencyRequestId = memory.addGrant(token, 'change', 'grant-6');
    await expect(ownerMutation({
      memory, token, requestId: idempotencyRequestId, action: 'change', password: NEXT_PASSWORD,
    })).rejects.toThrow('synthetic_outbox_failure');
    expect(memory.state.credential).toEqual(original);
    expect(memory.state.sessions.get('guest-password-fail')?.state).toBe('active');
    expect(memory.state.outbox).toHaveLength(0);
    expect(memory.state.grants.get(grantHash(token))?.consumedAt).toBeNull();
  });

  it('fails closed on a stale privacy epoch or non-owner inside the mutation transaction', async () => {
    const passwordMaterial = await material();
    for (const variant of ['privacy', 'owner'] as const) {
      const memory = new MemoryPasswordDatabase({
        ...(variant === 'privacy' ? { privacyRevision: EPOCH.revision + 1 } : { ownerId: 'someone-else' }),
      });
      await expect(applyUnattendedPasswordMutationTx(memory.db, {
        accountSession: SESSION,
        privacyEpoch: EPOCH,
        mutation: { hostId: HOST_ID, action: 'set', requestId: requestId(7) },
        material: passwordMaterial,
        now: NOW,
      })).rejects.toThrow();
      expect(memory.state.credential).toBeNull();
    }
  });
});

describe('unattended password public proof boundary', () => {
  it('rejects a valid-shaped SPKI paired with another key thumbprint before password or issuer work', async () => {
    const verify = vi.fn(async () => ({
      result: UNATTENDED_PASSWORD_RESULT.VERIFIED as const,
      hostId: HOST_ID,
      generation: 12,
    }));
    const issue = vi.fn();
    const service = new RemoteDesktopUnattendedPasswordProofService({
      verifier: { verify },
      bootstrapIssuer: { issue },
    });
    await expect(service.prove({
      publicNodeId: '5837462190',
      password: PASSWORD,
      browserPublicKeySpki: OTHER_BROWSER_SPKI,
      browserKeyThumbprint: BROWSER_THUMBPRINT,
      source: 'source-ip',
      now: NOW,
    })).resolves.toEqual({ ok: false, body: { status: 'unavailable' } });
    expect(verify).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('issues only a node-password Control bootstrap and never gives the issuer password/verifier material', async () => {
    const issuerInputs: unknown[] = [];
    const service = new RemoteDesktopUnattendedPasswordProofService({
      verifier: {
        verify: async () => ({ result: UNATTENDED_PASSWORD_RESULT.VERIFIED, hostId: HOST_ID, generation: 12 }),
      },
      bootstrapIssuer: {
        issue: async (input) => {
          issuerInputs.push(input);
          return {
            ok: true,
            serverId: 'server-password-1',
            hostId: HOST_ID,
            bootstrapTicket: 'bootstrap-password-1',
            expiresAt: NOW + 30_000,
            mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
            source: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
          };
        },
      },
    });
    await expect(service.prove({
      publicNodeId: '5837462190',
      password: PASSWORD,
      browserPublicKeySpki: BROWSER_PUBLIC_KEY_SPKI,
      browserKeyThumbprint: BROWSER_THUMBPRINT,
      source: 'source-ip',
      now: NOW,
    })).resolves.toMatchObject({
      ok: true,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      source: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
    });
    expect(issuerInputs).toEqual([{
      hostId: HOST_ID,
      publicNodeId: '5837462190',
      credentialGeneration: 12,
      browserPublicKeySpki: BROWSER_PUBLIC_KEY_SPKI,
      browserKeyThumbprint: BROWSER_THUMBPRINT,
      now: NOW,
    }]);
    expect(JSON.stringify(issuerInputs)).not.toContain(PASSWORD);
    expect(JSON.stringify(issuerInputs)).not.toMatch(/verifier|salt|pepper/iu);
  });

  it('fails closed if a bootstrap adapter tries to widen or misclassify password authority', async () => {
    const service = new RemoteDesktopUnattendedPasswordProofService({
      verifier: {
        verify: async () => ({ result: UNATTENDED_PASSWORD_RESULT.VERIFIED, hostId: HOST_ID, generation: 12 }),
      },
      bootstrapIssuer: {
        issue: async () => ({
          ok: true,
          serverId: 'server-password-1',
          hostId: HOST_ID,
          bootstrapTicket: 'bootstrap-password-1',
          expiresAt: NOW + 30_000,
          mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
          source: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
        }),
      },
    });
    await expect(service.prove({
      publicNodeId: '5837462190',
      password: PASSWORD,
      browserPublicKeySpki: BROWSER_PUBLIC_KEY_SPKI,
      browserKeyThumbprint: BROWSER_THUMBPRINT,
      source: 'source-ip',
      now: NOW,
    })).resolves.toEqual({ ok: false, body: { status: 'unavailable' } });
  });

  it('keeps unavailable and rate-limited HTTP classes exact and length-stable', async () => {
    const results = [
      { ok: false as const, body: { status: 'unavailable' as const } },
      { ok: false as const, body: { status: 'unavailable' as const } },
      { ok: false as const, rateLimited: true as const, body: { status: 'rate_limited' as const } },
    ];
    let index = 0;
    const routes = createRemoteDesktopUnattendedPasswordPublicRoutes({
      prove: async () => results[index++]!,
    });
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api', routes);
    const request = () => app.request('/api/remote-desktop/unattended-password/proof', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicNodeId: 5_837_462_190,
        password: PASSWORD,
        browserPublicKeySpki: BROWSER_PUBLIC_KEY_SPKI,
        browserKeyThumbprint: BROWSER_THUMBPRINT,
      }),
    });
    const first = await request();
    const second = await request();
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(await first.text()).toBe('{"status":"unavailable"}');
    expect(await second.text()).toBe('{"status":"unavailable"}');
    expect(first.headers.get('content-length')).toBe(second.headers.get('content-length'));
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('{"status":"rate_limited"}');
  });
});
