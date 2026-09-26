import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNATTENDED_PASSWORD_RATE_LIMIT_POLICY,
  LayeredUnattendedPasswordRateLimiter,
  PostgresUnattendedPasswordRateLimitStore,
  PostgresUnattendedPasswordTargetRepository,
  RemoteDesktopUnattendedPasswordService,
  UNATTENDED_PASSWORD_BUDGET_SCOPE,
  UNATTENDED_PASSWORD_DUMMY_VERSION,
  UNATTENDED_PASSWORD_JITTER_MAX_MS,
  UNATTENDED_PASSWORD_MIN_RESPONSE_MS,
  UNATTENDED_PASSWORD_HOST_AVAILABILITY,
  UNATTENDED_PASSWORD_RESULT,
  UNATTENDED_PASSWORD_TARGET_STATE,
  UNATTENDED_PASSWORD_VERIFIER_VERSION,
  UNATTENDED_PASSWORD_WORK_STAGE,
  createVersionedDummyVerifier,
  createLazyPostgresUnattendedPasswordProofService,
  createPostgresUnattendedPasswordHostAvailability,
  deriveUnattendedPasswordVerifier,
  summarizeTimingDistribution,
  timingDistributionWithinBaseline,
  transitionLayeredPasswordBudgets,
  validateUnattendedPasswordPolicy,
  type ResolvedUnattendedPasswordTarget,
  type UnattendedPasswordBudget,
  type UnattendedPasswordBudgetState,
  type UnattendedPasswordKdf,
  type UnattendedPasswordRateLimitDecision,
  type UnattendedPasswordRateLimitPolicy,
  type UnattendedPasswordRateLimitStore,
  type UnattendedPasswordTiming,
  type UnattendedPasswordVerifierMaterial,
  type VersionedDummyVerifier,
} from '../src/services/remote-desktop-unattended-password.js';
import type { Database } from '../src/db/client.js';
import { HOST_ENDPOINT_ROLE } from '../src/services/remote-desktop-host-identity.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import { MACHINE_PRESENCE_STALENESS_MS } from '../../shared/remote-exec.js';

const PASSWORD = 'Correct horse 4! battery';
const NEXT_PASSWORD = 'Different horse 5! battery';
const PEPPER = 'test-pepper-material-is-at-least-thirty-two-bytes';
const RATE_KEY = 'test-rate-limit-key-is-at-least-thirty-two-bytes';

const peppers = {
  currentVersion: 'pepper-1',
  resolve: (version: string) => version === 'pepper-1' ? PEPPER : null,
};

class FakeTiming implements UnattendedPasswordTiming {
  nowMs = 10_000;
  slept: number[] = [];

  constructor(private readonly jitterMs = 13) {}

  now(): number { return this.nowMs; }
  async sleep(milliseconds: number): Promise<void> {
    this.slept.push(milliseconds);
    this.nowMs += milliseconds;
  }
  jitter(maxInclusive: number): number {
    expect(maxInclusive).toBe(UNATTENDED_PASSWORD_JITTER_MAX_MS);
    return this.jitterMs;
  }
  advance(milliseconds: number): void { this.nowMs += milliseconds; }
}

class CountingKdf implements UnattendedPasswordKdf {
  hashCalls = 0;
  verifyCalls = 0;
  private readonly secretsByStored = new Map<string, string>();

  constructor(private readonly timing?: FakeTiming, private readonly failVerify = false) {}

  async hash(secret: string): Promise<string> {
    this.hashCalls += 1;
    const salt = createHash('sha256').update(`salt:${this.hashCalls}:${secret}`).digest('hex');
    const verifier = createHash('sha512').update(`verifier:${this.hashCalls}:${secret}`).digest('hex');
    const stored = `${salt}:${verifier}`;
    this.secretsByStored.set(stored, secret);
    return stored;
  }

  async verify(secret: string, stored: string): Promise<boolean> {
    this.verifyCalls += 1;
    this.timing?.advance(40);
    if (this.failVerify) throw new Error('synthetic_kdf_failure');
    return this.secretsByStored.get(stored) === secret;
  }
}

function credential(
  material: UnattendedPasswordVerifierMaterial,
  generation = 7,
): NonNullable<ResolvedUnattendedPasswordTarget['credential']> {
  return { ...material, generation, changedAt: 5_000, disabledAt: null };
}

function enabledTarget(
  material: UnattendedPasswordVerifierMaterial,
  generation = 7,
): ResolvedUnattendedPasswordTarget {
  return {
    state: UNATTENDED_PASSWORD_TARGET_STATE.ENABLED,
    hostId: 'host-a',
    credential: credential(material, generation),
  };
}

function unavailableTarget(
  state: Exclude<ResolvedUnattendedPasswordTarget['state'], 'enabled'>,
): ResolvedUnattendedPasswordTarget {
  return {
    state,
    hostId: state === UNATTENDED_PASSWORD_TARGET_STATE.UNKNOWN ? null : 'host-a',
    credential: null,
  };
}

async function fakeMaterials(timing?: FakeTiming): Promise<{
  kdf: CountingKdf;
  real: UnattendedPasswordVerifierMaterial;
  dummy: VersionedDummyVerifier;
}> {
  const kdf = new CountingKdf(timing);
  const real = await deriveUnattendedPasswordVerifier({ password: PASSWORD, peppers, kdf });
  const dummy = await createVersionedDummyVerifier({ peppers, kdf });
  return { kdf, real, dummy };
}

function allowedRateLimiter(decision: Partial<UnattendedPasswordRateLimitDecision> = {}) {
  return {
    admit: async (): Promise<UnattendedPasswordRateLimitDecision> => ({
      allowed: true,
      dummyWorkAllowed: false,
      cooldownUntil: null,
      ...decision,
    }),
  };
}

describe('remote desktop unattended password verifier', () => {
  it('retries a failed lazy dummy initialization and then reuses one service', async () => {
    let hashCalls = 0;
    const lazy = createLazyPostgresUnattendedPasswordProofService({
      db: {} as Database,
      serverSecret: 'lazy-password-proof-secret-is-at-least-32-bytes',
      runtimeAuthorityAvailable: async () => false,
      kdf: {
        hash: async () => {
          hashCalls += 1;
          if (hashCalls === 1) throw new Error('synthetic_dummy_initialization_failure');
          return `${'a'.repeat(64)}:${'b'.repeat(128)}`;
        },
        verify: async () => false,
      },
    });
    const request = {
      publicNodeId: '5000000001',
      password: PASSWORD,
      browserPublicKeySpki: 'invalid',
      browserKeyThumbprint: 'invalid',
      source: 'source-a',
      now: 1,
    };

    await expect(lazy.prove(request)).rejects.toThrow('synthetic_dummy_initialization_failure');
    await expect(lazy.prove(request)).resolves.toEqual({
      ok: false,
      body: { status: 'unavailable' },
    });
    await expect(lazy.prove(request)).resolves.toEqual({
      ok: false,
      body: { status: 'unavailable' },
    });
    expect(hashCalls).toBe(2);
  });

  it('requires canonical endpoint presence and live runtime authority', async () => {
    const now = 80_000;
    let capabilities: unknown = [REMOTE_DESKTOP_CAPABILITY];
    let lastHeartbeatAt = now - 1;
    let runtimeAuthorityAvailable = true;
    const db = {
      query: async () => [{
        server_id: 'controlled-password-1',
        host_id: 'host-password-1',
        endpoint_role: HOST_ENDPOINT_ROLE.CONTROLLED,
        controlled_capabilities: capabilities,
      }],
      queryOne: async () => ({
        status: 'online',
        last_heartbeat_at: lastHeartbeatAt,
      }),
    } as unknown as Database;
    const availability = createPostgresUnattendedPasswordHostAvailability({
      db,
      now: () => now,
      runtimeAuthorityAvailable: async () => runtimeAuthorityAvailable,
    });

    await expect(availability('host-password-1'))
      .resolves.toBe(UNATTENDED_PASSWORD_HOST_AVAILABILITY.ONLINE);
    runtimeAuthorityAvailable = false;
    await expect(availability('host-password-1'))
      .resolves.toBe(UNATTENDED_PASSWORD_HOST_AVAILABILITY.OFFLINE);
    runtimeAuthorityAvailable = true;
    lastHeartbeatAt = now - MACHINE_PRESENCE_STALENESS_MS;
    await expect(availability('host-password-1'))
      .resolves.toBe(UNATTENDED_PASSWORD_HOST_AVAILABILITY.OFFLINE);
    capabilities = [];
    await expect(availability('host-password-1'))
      .resolves.toBe(UNATTENDED_PASSWORD_HOST_AVAILABILITY.UNSUPPORTED);
  });

  it('uses one normalized database lookup and discloses nothing for an unknown ID', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      queryOne: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return null;
      },
    } as unknown as Database;
    const repository = new PostgresUnattendedPasswordTargetRepository(
      db,
      async () => { throw new Error('availability_must_not_run'); },
    );
    await expect(repository.resolve('5000000001')).resolves.toEqual({
      state: UNATTENDED_PASSWORD_TARGET_STATE.UNKNOWN,
      hostId: null,
      credential: null,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('LEFT JOIN remote_desktop_hosts');
    expect(queries[0]?.sql).toContain('LEFT JOIN remote_desktop_unattended_passwords');
    expect(queries[0]?.params).toEqual(['5000000001']);
  });

  it('enforces bounded strength without persisting plaintext', async () => {
    expect(validateUnattendedPasswordPolicy(null)).toEqual({ ok: false, error: 'invalid_type' });
    expect(validateUnattendedPasswordPolicy('Aa1!short')).toEqual({ ok: false, error: 'too_short' });
    expect(validateUnattendedPasswordPolicy('aaaaaaaaaaaa')).toEqual({ ok: false, error: 'too_weak' });
    expect(validateUnattendedPasswordPolicy(PASSWORD)).toEqual({ ok: true });
    expect(validateUnattendedPasswordPolicy('长密码短语用于远程控制安全验证')).toEqual({ ok: true });
    expect(validateUnattendedPasswordPolicy(`Aa1!${'x'.repeat(253)}`)).toEqual({
      ok: false,
      error: 'too_long',
    });

    const first = await deriveUnattendedPasswordVerifier({ password: PASSWORD, peppers });
    const second = await deriveUnattendedPasswordVerifier({ password: PASSWORD, peppers });
    const dummy = await createVersionedDummyVerifier({ peppers });
    expect(first).toMatchObject({
      verifierVersion: UNATTENDED_PASSWORD_VERIFIER_VERSION,
      pepperVersion: 'pepper-1',
    });
    expect(first.salt).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.verifier).toMatch(/^[0-9a-f]{128}$/u);
    expect(first.salt).not.toBe(second.salt);
    expect(JSON.stringify(first)).not.toContain(PASSWORD);
    expect(dummy).toMatchObject({
      dummyVersion: UNATTENDED_PASSWORD_DUMMY_VERSION,
      verifierVersion: first.verifierVersion,
      pepperVersion: first.pepperVersion,
    });
    expect(dummy.salt).toHaveLength(first.salt.length);
    expect(dummy.verifier).toHaveLength(first.verifier.length);
  });

  it('returns only the current canonical-host generation on successful proof', async () => {
    const { kdf, real, dummy } = await fakeMaterials();
    const service = new RemoteDesktopUnattendedPasswordService({
      targets: { resolve: async () => enabledTarget(real, 19) },
      rateLimiter: allowedRateLimiter(),
      peppers,
      dummyVerifier: dummy,
      kdf,
      timing: new FakeTiming(),
    });
    await expect(service.verify({ publicNodeId: '5000000001', password: PASSWORD, source: 'ip-a' }))
      .resolves.toEqual({ result: UNATTENDED_PASSWORD_RESULT.VERIFIED, hostId: 'host-a', generation: 19 });
    await expect(service.verify({ publicNodeId: '5000000001', password: 'wrong password', source: 'ip-a' }))
      .resolves.toEqual({ result: UNATTENDED_PASSWORD_RESULT.UNAVAILABLE });
  });

  it('uses identical admitted work and padding for every public failure state', async () => {
    const states = [
      UNATTENDED_PASSWORD_TARGET_STATE.UNKNOWN,
      UNATTENDED_PASSWORD_TARGET_STATE.RETIRED,
      UNATTENDED_PASSWORD_TARGET_STATE.DISABLED,
      UNATTENDED_PASSWORD_TARGET_STATE.OFFLINE,
      UNATTENDED_PASSWORD_TARGET_STATE.UNSUPPORTED,
    ] as const;
    const evidence: Array<{ stages: string[]; elapsed: number; kdfCalls: number }> = [];

    for (const state of states) {
      const timing = new FakeTiming(13);
      const { kdf, dummy } = await fakeMaterials(timing);
      const stages: string[] = [];
      const service = new RemoteDesktopUnattendedPasswordService({
        targets: { resolve: async () => unavailableTarget(state) },
        rateLimiter: allowedRateLimiter(),
        peppers,
        dummyVerifier: dummy,
        kdf,
        timing,
        observeWork: (stage) => stages.push(stage),
      });
      const before = kdf.verifyCalls;
      const started = timing.now();
      await expect(service.verify({ publicNodeId: '5000000001', password: 'wrong', source: 'ip-a' }))
        .resolves.toEqual({ result: UNATTENDED_PASSWORD_RESULT.UNAVAILABLE });
      evidence.push({ stages, elapsed: timing.now() - started, kdfCalls: kdf.verifyCalls - before });
    }

    const wrongTiming = new FakeTiming(13);
    const wrongMaterials = await fakeMaterials(wrongTiming);
    const wrongStages: string[] = [];
    const wrongService = new RemoteDesktopUnattendedPasswordService({
      targets: { resolve: async () => enabledTarget(wrongMaterials.real) },
      rateLimiter: allowedRateLimiter(),
      peppers,
      dummyVerifier: wrongMaterials.dummy,
      kdf: wrongMaterials.kdf,
      timing: wrongTiming,
      observeWork: (stage) => wrongStages.push(stage),
    });
    const before = wrongMaterials.kdf.verifyCalls;
    const started = wrongTiming.now();
    await expect(wrongService.verify({ publicNodeId: '5000000001', password: 'wrong', source: 'ip-a' }))
      .resolves.toEqual({ result: UNATTENDED_PASSWORD_RESULT.UNAVAILABLE });
    evidence.push({
      stages: wrongStages,
      elapsed: wrongTiming.now() - started,
      kdfCalls: wrongMaterials.kdf.verifyCalls - before,
    });

    expect(new Set(evidence.map((item) => JSON.stringify(item.stages)))).toHaveProperty('size', 1);
    expect(new Set(evidence.map((item) => item.elapsed))).toEqual(new Set([263]));
    expect(evidence.every((item) => item.kdfCalls === 1)).toBe(true);
    expect(evidence[0]?.stages).toEqual([
      UNATTENDED_PASSWORD_WORK_STAGE.LOOKUP,
      UNATTENDED_PASSWORD_WORK_STAGE.RATE_LIMIT,
      UNATTENDED_PASSWORD_WORK_STAGE.KDF,
      UNATTENDED_PASSWORD_WORK_STAGE.HASH,
      UNATTENDED_PASSWORD_WORK_STAGE.PADDING,
    ]);
  });

  it('does dummy KDF work for an unavailable historical pepper and for KDF failure', async () => {
    for (const failVerify of [false, true]) {
      const timing = new FakeTiming(0);
      const materialKdf = new CountingKdf();
      const dummy = await createVersionedDummyVerifier({ peppers, kdf: materialKdf });
      const kdf = new CountingKdf(timing, failVerify);
      const stages: string[] = [];
      const service = new RemoteDesktopUnattendedPasswordService({
        targets: {
          resolve: async () => enabledTarget({
            ...dummy,
            verifierVersion: UNATTENDED_PASSWORD_VERIFIER_VERSION,
            pepperVersion: 'retired-pepper',
          }),
        },
        rateLimiter: allowedRateLimiter(),
        peppers,
        dummyVerifier: dummy,
        kdf,
        timing,
        observeWork: (stage) => stages.push(stage),
      });
      await expect(service.verify({ publicNodeId: '5000000001', password: PASSWORD, source: 'ip-a' }))
        .resolves.toEqual({ result: UNATTENDED_PASSWORD_RESULT.UNAVAILABLE });
      expect(kdf.verifyCalls).toBe(1);
      expect(stages).toContain(UNATTENDED_PASSWORD_WORK_STAGE.KDF);
      expect(timing.nowMs).toBe(10_000 + UNATTENDED_PASSWORD_MIN_RESPONSE_MS);
    }
  });

  it('observes current generation and emergency disable without caching credential state', async () => {
    const timing = new FakeTiming();
    const kdf = new CountingKdf(timing);
    const first = await deriveUnattendedPasswordVerifier({ password: PASSWORD, peppers, kdf });
    const second = await deriveUnattendedPasswordVerifier({ password: NEXT_PASSWORD, peppers, kdf });
    const dummy = await createVersionedDummyVerifier({ peppers, kdf });
    let target = enabledTarget(first, 1);
    const service = new RemoteDesktopUnattendedPasswordService({
      targets: { resolve: async () => target },
      rateLimiter: allowedRateLimiter(),
      peppers,
      dummyVerifier: dummy,
      kdf,
      timing,
    });

    await expect(service.verify({ publicNodeId: '5000000001', password: PASSWORD, source: 'ip-a' }))
      .resolves.toMatchObject({ result: 'verified', generation: 1 });
    target = enabledTarget(second, 2);
    await expect(service.verify({ publicNodeId: '5000000001', password: PASSWORD, source: 'ip-a' }))
      .resolves.toEqual({ result: 'unavailable' });
    await expect(service.verify({ publicNodeId: '5000000001', password: NEXT_PASSWORD, source: 'ip-a' }))
      .resolves.toMatchObject({ result: 'verified', generation: 2 });
    target = unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.DISABLED);
    await expect(service.verify({ publicNodeId: '5000000001', password: NEXT_PASSWORD, source: 'ip-a' }))
      .resolves.toEqual({ result: 'unavailable' });
  });
});

describe('unattended password abuse controls', () => {
  const policy: UnattendedPasswordRateLimitPolicy = {
    budgets: [
      { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.SOURCE, limit: 2, windowMs: 10_000 },
      { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.TARGET, limit: 2, windowMs: 10_000 },
      { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.PAIR, limit: 2, windowMs: 10_000 },
      { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.HOST, limit: 2, windowMs: 10_000 },
      { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.GLOBAL, limit: 2, windowMs: 10_000 },
    ],
    cooldownBaseMs: 1_000,
    cooldownMaxMs: 8_000,
    dummyWorkCooldownMs: 500,
    retentionMs: 60_000,
  };

  it('applies every scope and bounded exponential cooldown with deterministic recovery', () => {
    const budgets: UnattendedPasswordBudget[] = policy.budgets.map((spec) => ({
      ...spec,
      keyHash: `${spec.scope}-hash`,
    }));
    let states: UnattendedPasswordBudgetState[] = budgets.map(() => ({
      windowStartedAt: 0,
      attemptCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    }));
    const first = transitionLayeredPasswordBudgets({ now: 0, budgets, states, policy });
    expect(first.allowed).toBe(true);
    states = [...first.states];
    const second = transitionLayeredPasswordBudgets({ now: 1, budgets, states, policy });
    expect(second.allowed).toBe(true);
    states = [...second.states];
    const blocked = transitionLayeredPasswordBudgets({ now: 2, budgets, states, policy });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedScopes).toEqual([
      UNATTENDED_PASSWORD_BUDGET_SCOPE.SOURCE,
      UNATTENDED_PASSWORD_BUDGET_SCOPE.TARGET,
      UNATTENDED_PASSWORD_BUDGET_SCOPE.PAIR,
      UNATTENDED_PASSWORD_BUDGET_SCOPE.HOST,
      UNATTENDED_PASSWORD_BUDGET_SCOPE.GLOBAL,
    ]);
    expect(blocked.cooldownUntil).toBe(1_002);
    const escalated = transitionLayeredPasswordBudgets({
      now: 1_003,
      budgets,
      states: blocked.states,
      policy,
    });
    expect(escalated.allowed).toBe(false);
    expect(escalated.cooldownUntil).toBe(3_003);
    const recovered = transitionLayeredPasswordBudgets({
      now: 10_001,
      budgets,
      states: escalated.states,
      policy,
    });
    expect(recovered.allowed).toBe(true);
    expect(recovered.states.every((state) => state.attemptCount === 1 && state.cooldownLevel === 0))
      .toBe(true);
  });

  it('uses fresh database time after distributed row-lock acquisition', async () => {
    const clockValues = [100, 250];
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      queryOne: async (sql: string) => {
        if (sql.includes('clock_timestamp')) return { now: clockValues.shift() };
        if (sql.includes('SELECT window_started_at')) {
          return {
            window_started_at: 100,
            attempt_count: 0,
            cooldown_level: 0,
            cooldown_until: null,
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      execute: async (sql: string, params: unknown[]) => {
        writes.push({ sql, params });
        return { changes: 1 };
      },
    } as unknown as Database;
    const db = {
      transaction: async <T>(run: (database: Database) => Promise<T>): Promise<T> => run(tx),
    } as unknown as Database;
    const store = new PostgresUnattendedPasswordRateLimitStore(db);
    const budget = {
      scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.SOURCE,
      keyHash: 'a'.repeat(64),
      limit: 2,
      windowMs: 10_000,
    } as const;
    await expect(store.consume({ budgets: [budget], dummyWorkKeyHash: 'b'.repeat(64), policy }))
      .resolves.toMatchObject({ allowed: true, dummyWorkAllowed: false });
    const update = writes.find((write) => write.sql.includes('SET window_started_at'));
    expect(update?.params[7]).toBe(250);
    expect(clockValues).toEqual([]);
  });

  it('shares distributed state and persists only keyed hashes for all budgets', async () => {
    class SharedStore implements UnattendedPasswordRateLimitStore {
      readonly states = new Map<string, UnattendedPasswordBudgetState>();
      readonly seen: Array<{ budgets: readonly UnattendedPasswordBudget[]; dummy: string }> = [];
      now = 0;
      dummyUntil = 0;

      async consume(input: {
        budgets: readonly UnattendedPasswordBudget[];
        dummyWorkKeyHash: string;
        policy: UnattendedPasswordRateLimitPolicy;
      }): Promise<UnattendedPasswordRateLimitDecision> {
        this.seen.push({ budgets: input.budgets, dummy: input.dummyWorkKeyHash });
        const states = input.budgets.map((budget) => this.states.get(`${budget.scope}:${budget.keyHash}`) ?? ({
          windowStartedAt: this.now,
          attemptCount: 0,
          cooldownLevel: 0,
          cooldownUntil: null,
        }));
        const transition = transitionLayeredPasswordBudgets({
          now: this.now,
          budgets: input.budgets,
          states,
          policy: input.policy,
        });
        input.budgets.forEach((budget, index) => {
          this.states.set(`${budget.scope}:${budget.keyHash}`, transition.states[index]!);
        });
        const dummyWorkAllowed = !transition.allowed && this.dummyUntil <= this.now;
        if (dummyWorkAllowed) this.dummyUntil = this.now + input.policy.dummyWorkCooldownMs;
        return { allowed: transition.allowed, dummyWorkAllowed, cooldownUntil: transition.cooldownUntil };
      }
    }
    const oneAttemptPolicy = {
      ...policy,
      budgets: policy.budgets.map((budget) => ({ ...budget, limit: 1 })),
    };
    const store = new SharedStore();
    const firstPod = new LayeredUnattendedPasswordRateLimiter(store, RATE_KEY, oneAttemptPolicy);
    const secondPod = new LayeredUnattendedPasswordRateLimiter(store, RATE_KEY, oneAttemptPolicy);
    const input = { source: '203.0.113.7', publicNodeId: '5000000001', hostId: 'host-secret-a' };
    expect((await firstPod.admit(input)).allowed).toBe(true);
    const blocked = await secondPod.admit(input);
    expect(blocked).toMatchObject({ allowed: false, dummyWorkAllowed: true });
    await secondPod.admit({ source: '198.51.100.9', publicNodeId: '5999999999', hostId: null });
    const seen = store.seen[0]!;
    expect(seen.budgets.map((budget) => budget.scope)).toEqual([
      'source', 'target', 'pair', 'host', 'global',
    ]);
    for (const budget of seen.budgets) {
      expect(budget.keyHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(budget.keyHash).not.toContain(input.source);
      expect(budget.keyHash).not.toContain(input.publicNodeId);
      expect(budget.keyHash).not.toContain(input.hostId);
    }
    expect(seen.dummy).toMatch(/^[0-9a-f]{64}$/u);
    expect(store.seen[2]?.dummy).toBe(seen.dummy);
    expect(JSON.stringify(store.seen)).not.toContain(input.source);
    expect(JSON.stringify(store.seen)).not.toContain(input.publicNodeId);
    expect(JSON.stringify(store.seen)).not.toContain(input.hostId);
  });

  it('bounds rate-limited dummy KDF work behind a shared cooldown and pads both paths', async () => {
    const timing = new FakeTiming(25);
    const { kdf, dummy } = await fakeMaterials(timing);
    const decisions: UnattendedPasswordRateLimitDecision[] = [
      { allowed: false, dummyWorkAllowed: true, cooldownUntil: 11_000 },
      { allowed: false, dummyWorkAllowed: false, cooldownUntil: 11_000 },
    ];
    const stages: string[][] = [];
    let currentStages: string[] = [];
    const service = new RemoteDesktopUnattendedPasswordService({
      targets: { resolve: async () => unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.UNKNOWN) },
      rateLimiter: { admit: async () => decisions.shift()! },
      peppers,
      dummyVerifier: dummy,
      kdf,
      timing,
      observeWork: (stage) => currentStages.push(stage),
    });
    const before = kdf.verifyCalls;
    const firstStarted = timing.now();
    await expect(service.verify({ publicNodeId: '5000000001', password: 'wrong', source: 'ip-a' }))
      .resolves.toEqual({ result: UNATTENDED_PASSWORD_RESULT.RATE_LIMITED });
    stages.push(currentStages);
    expect(timing.now() - firstStarted).toBe(275);
    currentStages = [];
    const secondStarted = timing.now();
    await expect(service.verify({ publicNodeId: '5000000001', password: 'wrong', source: 'ip-a' }))
      .resolves.toEqual({ result: UNATTENDED_PASSWORD_RESULT.RATE_LIMITED });
    stages.push(currentStages);
    expect(timing.now() - secondStarted).toBe(275);
    expect(kdf.verifyCalls - before).toBe(1);
    expect(stages[0]).toContain(UNATTENDED_PASSWORD_WORK_STAGE.RATE_LIMITED_DUMMY_KDF);
    expect(stages[1]).toContain(UNATTENDED_PASSWORD_WORK_STAGE.RATE_LIMITED_DUMMY_COOLDOWN);
  });

  it('keeps metric labels closed and excludes password and routing identifiers', async () => {
    const timing = new FakeTiming();
    const { kdf, dummy } = await fakeMaterials(timing);
    const metrics: unknown[] = [];
    const service = new RemoteDesktopUnattendedPasswordService({
      targets: { resolve: async () => unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.UNKNOWN) },
      rateLimiter: allowedRateLimiter(),
      peppers,
      dummyVerifier: dummy,
      kdf,
      timing,
      observeMetrics: (value) => metrics.push(value),
    });
    await service.verify({ publicNodeId: '5000000001', password: 'raw-password-value', source: '203.0.113.7' });
    expect(metrics).toHaveLength(1);
    expect(Object.keys(metrics[0] as object).sort()).toEqual(['elapsedMs', 'result', 'stages', 'targetState']);
    const serialized = JSON.stringify(metrics);
    expect(serialized).not.toContain('raw-password-value');
    expect(serialized).not.toContain('5000000001');
    expect(serialized).not.toContain('203.0.113.7');
  });

  it('pins the production policy and distribution comparator', () => {
    expect(DEFAULT_UNATTENDED_PASSWORD_RATE_LIMIT_POLICY.budgets.map((budget) => budget.scope))
      .toEqual(['source', 'target', 'pair', 'host', 'global']);
    expect(summarizeTimingDistribution([4, 1, 3, 2, 5])).toEqual({ median: 3, p95: 5 });
    expect(timingDistributionWithinBaseline({
      baseline: [250, 251, 252, 253, 254],
      candidate: [251, 252, 253, 254, 255],
    })).toBe(true);
    expect(timingDistributionWithinBaseline({
      baseline: [250, 251, 252, 253, 254],
      candidate: [400, 401, 402, 403, 404],
    })).toBe(false);
  });
});

describe('unattended password migration', () => {
  it('stores one constrained verifier per host and HMAC-only distributed budget keys', () => {
    const sql = readFileSync(
      new URL('../src/db/migrations/073_remote_desktop_guest_authority.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toMatch(/remote_desktop_unattended_passwords[\s\S]*host_id\s+TEXT PRIMARY KEY/u);
    expect(sql).toMatch(/verifier_version\s+TEXT NOT NULL CHECK \(verifier_version = 'scrypt-v1'\)/u);
    expect(sql).toMatch(/verifier ~ '\^\[0-9a-f\]\{128\}\$'/u);
    expect(sql).toMatch(/salt ~ '\^\[0-9a-f\]\{64\}\$'/u);
    expect(sql).toMatch(/generation\s+BIGINT NOT NULL DEFAULT 1 CHECK \(generation > 0\)/u);
    expect(sql).toContain('remote_desktop_password_rate_limits');
    expect(sql).toContain("'source', 'target', 'pair', 'host', 'global', 'dummy_work'");
    expect(sql).toMatch(/budget_key_hash\s+TEXT NOT NULL CHECK \(budget_key_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/u);
  });
});
