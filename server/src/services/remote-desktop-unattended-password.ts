/**
 * Security foundation for public-node-ID + unattended-password proof.
 *
 * This module owns the hash-only verifier format, constant-work proof
 * schedule, Owner mutation transaction, generation checks, injectable
 * timing/work evidence and PostgreSQL-backed abuse budgets. The HTTP boundary
 * lives in the matching route module; Router bootstrap redemption remains a
 * separate integration track.
 */

import {
  createHash,
  createHmac,
  randomInt,
  randomUUID,
} from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Database } from '../db/client.js';
import { hashPassword, verifyPassword } from '../security/crypto.js';
import {
  REMOTE_DESKTOP_ACCESS_LIMITS,
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND,
  REMOTE_DESKTOP_OUTBOX_EFFECT,
  REMOTE_DESKTOP_OUTBOX_SCOPE,
  REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE,
  validateRemoteDesktopPasswordMutation,
  type RemoteDesktopPasswordMutation,
} from '../../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../../shared/remote-desktop.js';
import { MACHINE_PRESENCE_STALENESS_MS } from '../../../shared/remote-exec.js';
import {
  consumeActionBoundStepUpGrant,
  type AccountSession,
  type StepUpGrantUse,
} from './remote-desktop-account-auth.js';
import { appendGuestEffectTx } from './remote-desktop-guest-authority.js';
import {
  issueNodePasswordBootstrap,
  type ProofFailure,
  type ProofSuccess,
} from './remote-desktop-guest-bootstrap.js';
import { isRemoteDesktopBrowserKeyBindingValid } from './remote-desktop-guest-crypto.js';
import { REMOTE_DESKTOP_GUEST_EFFECT_RETENTION_MS } from './remote-desktop-guest-due-worker.js';
import {
  resolveExecutionEndpoint,
  type FullEndpointEligibility,
} from './remote-desktop-host-identity.js';
import { requireShieldedEpochTx } from './remote-desktop-management-privacy.js';

export const UNATTENDED_PASSWORD_VERIFIER_VERSION = 'scrypt-v1' as const;
export const UNATTENDED_PASSWORD_DUMMY_VERSION = 'remote-desktop-unattended-dummy-v1' as const;
export const UNATTENDED_PASSWORD_MIN_RESPONSE_MS = 250;
export const UNATTENDED_PASSWORD_JITTER_MAX_MS = 25;

export const UNATTENDED_PASSWORD_TARGET_STATE = {
  ENABLED: 'enabled',
  UNKNOWN: 'unknown',
  RETIRED: 'retired',
  DISABLED: 'disabled',
  OFFLINE: 'offline',
  UNSUPPORTED: 'unsupported',
} as const;
export type UnattendedPasswordTargetState = typeof UNATTENDED_PASSWORD_TARGET_STATE[
  keyof typeof UNATTENDED_PASSWORD_TARGET_STATE
];

export const UNATTENDED_PASSWORD_RESULT = {
  VERIFIED: 'verified',
  UNAVAILABLE: 'unavailable',
  RATE_LIMITED: 'rate_limited',
} as const;

export const UNATTENDED_PASSWORD_WORK_STAGE = {
  LOOKUP: 'lookup',
  RATE_LIMIT: 'rate_limit',
  KDF: 'kdf',
  HASH: 'hash',
  RATE_LIMITED_DUMMY_KDF: 'rate_limited_dummy_kdf',
  RATE_LIMITED_DUMMY_COOLDOWN: 'rate_limited_dummy_cooldown',
  PADDING: 'padding',
} as const;
export type UnattendedPasswordWorkStage = typeof UNATTENDED_PASSWORD_WORK_STAGE[
  keyof typeof UNATTENDED_PASSWORD_WORK_STAGE
];

export const UNATTENDED_PASSWORD_BUDGET_SCOPE = {
  SOURCE: 'source',
  TARGET: 'target',
  PAIR: 'pair',
  HOST: 'host',
  GLOBAL: 'global',
  DUMMY_WORK: 'dummy_work',
} as const;
export type UnattendedPasswordBudgetScope = typeof UNATTENDED_PASSWORD_BUDGET_SCOPE[
  keyof typeof UNATTENDED_PASSWORD_BUDGET_SCOPE
];

export const UNATTENDED_PASSWORD_POLICY_ERROR = {
  TYPE: 'invalid_type',
  TOO_SHORT: 'too_short',
  TOO_LONG: 'too_long',
  TOO_WEAK: 'too_weak',
} as const;
export type UnattendedPasswordPolicyError = typeof UNATTENDED_PASSWORD_POLICY_ERROR[
  keyof typeof UNATTENDED_PASSWORD_POLICY_ERROR
];

const PASSWORD_PEPPER_DOMAIN = 'imcodes.remote-desktop.unattended-password.v1';
const RATE_LIMIT_KEY_DOMAIN = 'imcodes.remote-desktop.password-rate-limit.v1';
const OWNER_AUDIT_HASH_DOMAIN = 'imcodes.remote-desktop.password-owner-audit.v1';
const GLOBAL_BUDGET_KEY = 'all-password-attempts';
const VERIFIER_SALT_HEX_LENGTH = 64;
const VERIFIER_HEX_LENGTH = 128;

export const UNATTENDED_PASSWORD_SERVER_PEPPER_VERSION = 'server-secret-v1' as const;

export const UNATTENDED_PASSWORD_MUTATION_ERROR = {
  INVALID: 'invalid_password_mutation',
  NOT_OWNER: 'password_mutation_not_owner',
  HOST_UNAVAILABLE: 'password_host_unavailable',
  ALREADY_ENABLED: 'password_already_enabled',
  NOT_ENABLED: 'password_not_enabled',
  INVALID_ROUTE: 'password_route_invariant_failed',
  STEP_UP: 'password_step_up_required',
} as const;

export const UNATTENDED_PASSWORD_PUBLIC_RATE_LIMITED = Object.freeze({ status: 'rate_limited' as const });

export class UnattendedPasswordMutationError extends Error {
  constructor(readonly code: typeof UNATTENDED_PASSWORD_MUTATION_ERROR[
    keyof typeof UNATTENDED_PASSWORD_MUTATION_ERROR
  ]) {
    super(code);
    this.name = 'UnattendedPasswordMutationError';
  }
}

export interface UnattendedPasswordVerifierMaterial {
  verifierVersion: typeof UNATTENDED_PASSWORD_VERIFIER_VERSION;
  verifier: string;
  salt: string;
  pepperVersion: string;
}

export interface UnattendedPasswordCredential extends UnattendedPasswordVerifierMaterial {
  generation: number;
  changedAt: number;
  disabledAt: number | null;
}

export interface VersionedDummyVerifier extends UnattendedPasswordVerifierMaterial {
  dummyVersion: typeof UNATTENDED_PASSWORD_DUMMY_VERSION;
}

export interface UnattendedPasswordPepperRing {
  currentVersion: string;
  resolve(version: string): string | null;
}

/**
 * Derive the password-only pepper from an established Server secret. The
 * source secret is never stored in the credential row and the domain-separated
 * output cannot be reused as a JWT/bot key.
 */
export function createServerUnattendedPasswordPepperRing(
  serverSecret: string,
): UnattendedPasswordPepperRing {
  if (Buffer.byteLength(serverSecret, 'utf8') < 32) throw new Error('password_server_secret_too_short');
  const pepper = createHmac('sha256', serverSecret)
    .update(PASSWORD_PEPPER_DOMAIN, 'utf8')
    .update('\0server-pepper', 'utf8')
    .digest('base64url');
  return Object.freeze({
    currentVersion: UNATTENDED_PASSWORD_SERVER_PEPPER_VERSION,
    resolve: (version: string) => (
      version === UNATTENDED_PASSWORD_SERVER_PEPPER_VERSION ? pepper : null
    ),
  });
}

/**
 * Reuse an established Server secret without silently accepting a short bot
 * key. The selected value is only fed into domain-separated password pepper
 * and rate-limit derivation; it is never stored with a credential.
 */
export function selectUnattendedPasswordServerSecret(input: {
  botEncryptionKey: string;
  jwtSigningKey: string;
}): string {
  return Buffer.byteLength(input.botEncryptionKey, 'utf8') >= 32
    ? input.botEncryptionKey
    : input.jwtSigningKey;
}

export interface UnattendedPasswordKdf {
  hash(secret: string): Promise<string>;
  verify(secret: string, stored: string): Promise<boolean>;
}

export const approvedUnattendedPasswordKdf: UnattendedPasswordKdf = {
  hash: hashPassword,
  verify: verifyPassword,
};

export interface UnattendedPasswordTiming {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  jitter(maxInclusive: number): number;
}

export const productionUnattendedPasswordTiming: UnattendedPasswordTiming = {
  now: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  jitter: (maxInclusive) => randomInt(0, maxInclusive + 1),
};

export type UnattendedPasswordWorkObserver = (stage: UnattendedPasswordWorkStage) => void;

export interface ResolvedUnattendedPasswordTarget {
  state: UnattendedPasswordTargetState;
  hostId: string | null;
  credential: UnattendedPasswordCredential | null;
}

export interface UnattendedPasswordTargetRepository {
  resolve(publicNodeId: string): Promise<ResolvedUnattendedPasswordTarget>;
}

export const UNATTENDED_PASSWORD_HOST_AVAILABILITY = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  UNSUPPORTED: 'unsupported',
} as const;

export type UnattendedPasswordHostAvailability = (
  hostId: string,
) => Promise<typeof UNATTENDED_PASSWORD_HOST_AVAILABILITY[
  keyof typeof UNATTENDED_PASSWORD_HOST_AVAILABILITY
]>;

interface PasswordTargetRow {
  public_id_status: 'active' | 'retired';
  host_id: string | null;
  merge_state: 'resolved' | 'conflict_pending' | null;
  verifier_version: string | null;
  verifier: string | null;
  salt: string | null;
  pepper_version: string | null;
  generation: number | null;
  changed_at: number | null;
  disabled_at: number | null;
}

/** One normalized database query for active, retired, disabled and unknown IDs. */
export class PostgresUnattendedPasswordTargetRepository implements UnattendedPasswordTargetRepository {
  constructor(
    private readonly db: Database,
    private readonly availability: UnattendedPasswordHostAvailability,
  ) {}

  async resolve(publicNodeId: string): Promise<ResolvedUnattendedPasswordTarget> {
    const row = await this.db.queryOne<PasswordTargetRow>(
      `SELECT p.status AS public_id_status,
              p.host_id,
              h.merge_state,
              c.verifier_version,
              c.verifier,
              c.salt,
              c.pepper_version,
              c.generation,
              c.changed_at,
              c.disabled_at
         FROM remote_desktop_public_ids p
         LEFT JOIN remote_desktop_hosts h ON h.id = p.host_id
         LEFT JOIN remote_desktop_unattended_passwords c ON c.host_id = p.host_id
        WHERE p.public_id = $1
        LIMIT 1`,
      [publicNodeId],
    );
    if (!row) return unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.UNKNOWN);
    if (row.public_id_status === 'retired') {
      return unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.RETIRED, row.host_id);
    }
    if (!row.host_id || row.merge_state !== 'resolved') {
      return unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.DISABLED, row.host_id);
    }
    const credential = credentialFromRow(row);
    if (!credential || credential.disabledAt !== null) {
      return unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.DISABLED, row.host_id);
    }
    let availability: Awaited<ReturnType<UnattendedPasswordHostAvailability>>;
    try {
      availability = await this.availability(row.host_id);
    } catch {
      availability = 'offline';
    }
    if (availability === UNATTENDED_PASSWORD_HOST_AVAILABILITY.OFFLINE) {
      return unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.OFFLINE, row.host_id);
    }
    if (availability === UNATTENDED_PASSWORD_HOST_AVAILABILITY.UNSUPPORTED) {
      return unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.UNSUPPORTED, row.host_id);
    }
    return { state: UNATTENDED_PASSWORD_TARGET_STATE.ENABLED, hostId: row.host_id, credential };
  }
}

function unavailableTarget(
  state: Exclude<UnattendedPasswordTargetState, 'enabled'>,
  hostId: string | null = null,
): ResolvedUnattendedPasswordTarget {
  return { state, hostId, credential: null };
}

function credentialFromRow(row: PasswordTargetRow): UnattendedPasswordCredential | null {
  if (row.verifier_version !== UNATTENDED_PASSWORD_VERIFIER_VERSION
    || typeof row.verifier !== 'string'
    || typeof row.salt !== 'string'
    || typeof row.pepper_version !== 'string'
    || !Number.isSafeInteger(row.generation) || (row.generation ?? 0) <= 0
    || !Number.isSafeInteger(row.changed_at) || (row.changed_at ?? -1) < 0
    || (row.disabled_at !== null && (!Number.isSafeInteger(row.disabled_at) || row.disabled_at < 0))) return null;
  const material: UnattendedPasswordVerifierMaterial = {
    verifierVersion: UNATTENDED_PASSWORD_VERIFIER_VERSION,
    verifier: row.verifier,
    salt: row.salt,
    pepperVersion: row.pepper_version,
  };
  if (!isValidVerifierMaterial(material)) return null;
  return {
    ...material,
    generation: row.generation!,
    changedAt: row.changed_at!,
    disabledAt: row.disabled_at,
  };
}

export function validateUnattendedPasswordPolicy(
  password: unknown,
): { ok: true } | { ok: false; error: UnattendedPasswordPolicyError } {
  if (typeof password !== 'string') return { ok: false, error: UNATTENDED_PASSWORD_POLICY_ERROR.TYPE };
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < REMOTE_DESKTOP_ACCESS_LIMITS.PASSWORD_MIN_BYTES) {
    return { ok: false, error: UNATTENDED_PASSWORD_POLICY_ERROR.TOO_SHORT };
  }
  if (bytes > REMOTE_DESKTOP_ACCESS_LIMITS.PASSWORD_MAX_BYTES) {
    return { ok: false, error: UNATTENDED_PASSWORD_POLICY_ERROR.TOO_LONG };
  }
  const classes = [/[a-z]/u, /[A-Z]/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u]
    .filter((pattern) => pattern.test(password)).length;
  const distinct = new Set([...password]).size;
  const strongPassphrase = bytes >= 20 && distinct >= 8;
  if ((classes < 3 || distinct < 8) && !strongPassphrase) {
    return { ok: false, error: UNATTENDED_PASSWORD_POLICY_ERROR.TOO_WEAK };
  }
  return { ok: true };
}

function pepperedPassword(password: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update(PASSWORD_PEPPER_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(password, 'utf8')
    .digest('base64url');
}

function isValidPepper(value: string | null): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 32;
}

function splitProjectPasswordHash(stored: string): { salt: string; verifier: string } | null {
  const [salt, verifier, extra] = stored.split(':');
  if (extra !== undefined || !salt || !verifier) return null;
  if (!/^[0-9a-f]+$/u.test(salt) || salt.length !== VERIFIER_SALT_HEX_LENGTH) return null;
  if (!/^[0-9a-f]+$/u.test(verifier) || verifier.length !== VERIFIER_HEX_LENGTH) return null;
  return { salt, verifier };
}

function isValidVerifierMaterial(value: UnattendedPasswordVerifierMaterial): boolean {
  return value.verifierVersion === UNATTENDED_PASSWORD_VERIFIER_VERSION
    && /^[0-9a-f]{64}$/u.test(value.salt)
    && /^[0-9a-f]{128}$/u.test(value.verifier)
    && value.pepperVersion.length > 0
    && value.pepperVersion.length <= 64;
}

export async function deriveUnattendedPasswordVerifier(input: {
  password: string;
  peppers: UnattendedPasswordPepperRing;
  kdf?: UnattendedPasswordKdf;
}): Promise<UnattendedPasswordVerifierMaterial> {
  const policy = validateUnattendedPasswordPolicy(input.password);
  if (!policy.ok) throw new Error(policy.error);
  const pepper = input.peppers.resolve(input.peppers.currentVersion);
  if (!isValidPepper(pepper)) throw new Error('pepper_unavailable');
  const stored = await (input.kdf ?? approvedUnattendedPasswordKdf).hash(
    pepperedPassword(input.password, pepper),
  );
  const parsed = splitProjectPasswordHash(stored);
  if (!parsed) throw new Error('kdf_invalid_output');
  return {
    verifierVersion: UNATTENDED_PASSWORD_VERIFIER_VERSION,
    verifier: parsed.verifier,
    salt: parsed.salt,
    pepperVersion: input.peppers.currentVersion,
  };
}

export async function createVersionedDummyVerifier(input: {
  peppers: UnattendedPasswordPepperRing;
  kdf?: UnattendedPasswordKdf;
}): Promise<VersionedDummyVerifier> {
  const material = await deriveUnattendedPasswordVerifier({
    password: 'IM.codes dummy verifier seed 2026!',
    peppers: input.peppers,
    kdf: input.kdf,
  });
  return { ...material, dummyVersion: UNATTENDED_PASSWORD_DUMMY_VERSION };
}

export interface UnattendedPasswordBudgetSpec {
  scope: Exclude<UnattendedPasswordBudgetScope, 'dummy_work'>;
  limit: number;
  windowMs: number;
}

export interface UnattendedPasswordRateLimitPolicy {
  budgets: readonly UnattendedPasswordBudgetSpec[];
  cooldownBaseMs: number;
  cooldownMaxMs: number;
  dummyWorkCooldownMs: number;
  retentionMs: number;
}

export const DEFAULT_UNATTENDED_PASSWORD_RATE_LIMIT_POLICY: UnattendedPasswordRateLimitPolicy = {
  budgets: [
    { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.SOURCE, limit: 20, windowMs: 60_000 },
    { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.TARGET, limit: 20, windowMs: 60_000 },
    { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.PAIR, limit: 5, windowMs: 60_000 },
    { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.HOST, limit: 40, windowMs: 60_000 },
    { scope: UNATTENDED_PASSWORD_BUDGET_SCOPE.GLOBAL, limit: 1_000, windowMs: 60_000 },
  ],
  cooldownBaseMs: 1_000,
  cooldownMaxMs: 60_000,
  dummyWorkCooldownMs: 1_000,
  retentionMs: 24 * 60 * 60_000,
};

export interface UnattendedPasswordBudget {
  scope: Exclude<UnattendedPasswordBudgetScope, 'dummy_work'>;
  keyHash: string;
  limit: number;
  windowMs: number;
}

export interface UnattendedPasswordBudgetState {
  windowStartedAt: number;
  attemptCount: number;
  cooldownLevel: number;
  cooldownUntil: number | null;
}

export interface LayeredBudgetTransition {
  allowed: boolean;
  cooldownUntil: number | null;
  blockedScopes: readonly UnattendedPasswordBudgetScope[];
  states: readonly UnattendedPasswordBudgetState[];
}

/** Pure transition shared by PostgreSQL and deterministic tests. */
export function transitionLayeredPasswordBudgets(input: {
  now: number;
  budgets: readonly UnattendedPasswordBudget[];
  states: readonly UnattendedPasswordBudgetState[];
  policy: UnattendedPasswordRateLimitPolicy;
}): LayeredBudgetTransition {
  if (input.budgets.length !== input.states.length) throw new Error('budget_state_mismatch');
  const normalized = input.states.map((state, index) => {
    const spec = input.budgets[index]!;
    if (state.windowStartedAt + spec.windowMs <= input.now
      && (state.cooldownUntil === null || state.cooldownUntil <= input.now)) {
      return { windowStartedAt: input.now, attemptCount: 0, cooldownLevel: 0, cooldownUntil: null };
    }
    return { ...state };
  });
  const blockedIndexes = normalized.flatMap((state, index) => (
    (state.cooldownUntil !== null && state.cooldownUntil > input.now)
      || state.attemptCount >= input.budgets[index]!.limit
      ? [index]
      : []
  ));
  if (blockedIndexes.length === 0) {
    return {
      allowed: true,
      cooldownUntil: null,
      blockedScopes: [],
      states: normalized.map((state) => ({ ...state, attemptCount: state.attemptCount + 1 })),
    };
  }
  let latestCooldown = input.now;
  const blocked = new Set(blockedIndexes);
  const states = normalized.map((state, index) => {
    if (!blocked.has(index)) return { ...state, attemptCount: state.attemptCount + 1 };
    if (state.cooldownUntil !== null && state.cooldownUntil > input.now) {
      latestCooldown = Math.max(latestCooldown, state.cooldownUntil);
      return state;
    }
    const duration = Math.min(
      input.policy.cooldownMaxMs,
      input.policy.cooldownBaseMs * (2 ** Math.min(state.cooldownLevel, 16)),
    );
    const cooldownUntil = input.now + duration;
    latestCooldown = Math.max(latestCooldown, cooldownUntil);
    return {
      ...state,
      attemptCount: state.attemptCount + 1,
      cooldownLevel: state.cooldownLevel + 1,
      cooldownUntil,
    };
  });
  return {
    allowed: false,
    cooldownUntil: latestCooldown,
    blockedScopes: blockedIndexes.map((index) => input.budgets[index]!.scope),
    states,
  };
}

export interface UnattendedPasswordRateLimitDecision {
  allowed: boolean;
  dummyWorkAllowed: boolean;
  cooldownUntil: number | null;
}

export interface UnattendedPasswordRateLimitStore {
  consume(input: {
    budgets: readonly UnattendedPasswordBudget[];
    dummyWorkKeyHash: string;
    policy: UnattendedPasswordRateLimitPolicy;
  }): Promise<UnattendedPasswordRateLimitDecision>;
}

interface PasswordBudgetRow {
  window_started_at: number;
  attempt_count: number;
  cooldown_level: number;
  cooldown_until: number | null;
}

/** PostgreSQL row locks make limits authoritative across every Server pod. */
export class PostgresUnattendedPasswordRateLimitStore implements UnattendedPasswordRateLimitStore {
  constructor(private readonly db: Database) {}

  async consume(input: {
    budgets: readonly UnattendedPasswordBudget[];
    dummyWorkKeyHash: string;
    policy: UnattendedPasswordRateLimitPolicy;
  }): Promise<UnattendedPasswordRateLimitDecision> {
    return this.db.transaction(async (tx) => {
      const insertNow = await readDatabaseNow(tx);
      const budgets = [...input.budgets].sort((a, b) => (
        a.scope.localeCompare(b.scope) || a.keyHash.localeCompare(b.keyHash)
      ));
      const states: UnattendedPasswordBudgetState[] = [];
      for (const budget of budgets) {
        await tx.execute(
          `INSERT INTO remote_desktop_password_rate_limits
             (budget_class, budget_key_hash, window_started_at, attempt_count,
              cooldown_level, cooldown_until, expires_at, updated_at)
           VALUES ($1, $2, $3, 0, 0, NULL, $4, $3)
           ON CONFLICT (budget_class, budget_key_hash) DO NOTHING`,
          [budget.scope, budget.keyHash, insertNow, insertNow + input.policy.retentionMs],
        );
        const row = await tx.queryOne<PasswordBudgetRow>(
          `SELECT window_started_at, attempt_count, cooldown_level, cooldown_until
             FROM remote_desktop_password_rate_limits
            WHERE budget_class = $1 AND budget_key_hash = $2
            FOR UPDATE`,
          [budget.scope, budget.keyHash],
        );
        if (!row) throw new Error('rate_limit_row_unavailable');
        states.push({
          windowStartedAt: row.window_started_at,
          attemptCount: row.attempt_count,
          cooldownLevel: row.cooldown_level,
          cooldownUntil: row.cooldown_until,
        });
      }
      // Row acquisition can wait behind another pod. Refresh database time
      // only after all locks are held so windows/cooldowns never use a stale
      // transaction-entry timestamp.
      const now = await readDatabaseNow(tx);
      const transition = transitionLayeredPasswordBudgets({
        now,
        budgets,
        states,
        policy: input.policy,
      });
      for (let index = 0; index < budgets.length; index += 1) {
        const budget = budgets[index]!;
        const state = transition.states[index]!;
        await tx.execute(
          `UPDATE remote_desktop_password_rate_limits
              SET window_started_at = $3,
                  attempt_count = $4,
                  cooldown_level = $5,
                  cooldown_until = $6,
                  expires_at = $7,
                  updated_at = $8
            WHERE budget_class = $1 AND budget_key_hash = $2`,
          [
            budget.scope,
            budget.keyHash,
            state.windowStartedAt,
            state.attemptCount,
            state.cooldownLevel,
            state.cooldownUntil,
            Math.max(now + input.policy.retentionMs, state.cooldownUntil ?? 0),
            now,
          ],
        );
      }
      const dummyWorkAllowed = transition.allowed
        ? false
        : await claimDistributedDummyWork(tx, {
          now,
          keyHash: input.dummyWorkKeyHash,
          cooldownMs: input.policy.dummyWorkCooldownMs,
          retentionMs: input.policy.retentionMs,
        });
      return {
        allowed: transition.allowed,
        dummyWorkAllowed,
        cooldownUntil: transition.cooldownUntil,
      };
    });
  }

  async pruneExpired(limit = 1_000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) throw new Error('invalid_prune_limit');
    const result = await this.db.execute(
      `WITH expired AS (
         SELECT budget_class, budget_key_hash
           FROM remote_desktop_password_rate_limits
          WHERE expires_at <= FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
          ORDER BY expires_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM remote_desktop_password_rate_limits r
        USING expired e
        WHERE r.budget_class = e.budget_class
          AND r.budget_key_hash = e.budget_key_hash`,
      [limit],
    );
    return result.changes;
  }
}

async function readDatabaseNow(db: Database): Promise<number> {
  const clock = await db.queryOne<{ now: number }>(
    `SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT AS now`,
  );
  if (!clock || !Number.isSafeInteger(clock.now)) throw new Error('database_clock_unavailable');
  return clock.now;
}

async function claimDistributedDummyWork(tx: Database, input: {
  now: number;
  keyHash: string;
  cooldownMs: number;
  retentionMs: number;
}): Promise<boolean> {
  await tx.execute(
    `INSERT INTO remote_desktop_password_rate_limits
       (budget_class, budget_key_hash, window_started_at, attempt_count,
        cooldown_level, cooldown_until, expires_at, updated_at)
     VALUES ($1, $2, $3, 0, 0, NULL, $4, $3)
     ON CONFLICT (budget_class, budget_key_hash) DO NOTHING`,
    [UNATTENDED_PASSWORD_BUDGET_SCOPE.DUMMY_WORK, input.keyHash, input.now, input.now + input.retentionMs],
  );
  const row = await tx.queryOne<{ cooldown_until: number | null }>(
    `SELECT cooldown_until
       FROM remote_desktop_password_rate_limits
      WHERE budget_class = $1 AND budget_key_hash = $2
      FOR UPDATE`,
    [UNATTENDED_PASSWORD_BUDGET_SCOPE.DUMMY_WORK, input.keyHash],
  );
  if (!row) throw new Error('dummy_work_row_unavailable');
  if (row.cooldown_until !== null && row.cooldown_until > input.now) return false;
  await tx.execute(
    `UPDATE remote_desktop_password_rate_limits
        SET cooldown_until = $3,
            expires_at = $4,
            updated_at = $2
      WHERE budget_class = $1 AND budget_key_hash = $5`,
    [
      UNATTENDED_PASSWORD_BUDGET_SCOPE.DUMMY_WORK,
      input.now,
      input.now + input.cooldownMs,
      input.now + input.retentionMs,
      input.keyHash,
    ],
  );
  return true;
}

export class LayeredUnattendedPasswordRateLimiter {
  constructor(
    private readonly store: UnattendedPasswordRateLimitStore,
    private readonly keySecret: string,
    private readonly policy: UnattendedPasswordRateLimitPolicy = DEFAULT_UNATTENDED_PASSWORD_RATE_LIMIT_POLICY,
  ) {
    if (Buffer.byteLength(keySecret, 'utf8') < 32) throw new Error('rate_limit_key_secret_too_short');
  }

  async admit(input: {
    source: string;
    publicNodeId: string;
    hostId: string | null;
  }): Promise<UnattendedPasswordRateLimitDecision> {
    const target = input.publicNodeId;
    const host = input.hostId ?? `unknown:${target}`;
    const values: Record<Exclude<UnattendedPasswordBudgetScope, 'dummy_work'>, string> = {
      source: input.source,
      target,
      pair: `${input.source}\0${target}`,
      host,
      global: GLOBAL_BUDGET_KEY,
    };
    const budgets = this.policy.budgets.map((spec) => ({
      ...spec,
      keyHash: this.keyHash(spec.scope, values[spec.scope]),
    }));
    return this.store.consume({
      budgets,
      dummyWorkKeyHash: this.keyHash(
        UNATTENDED_PASSWORD_BUDGET_SCOPE.DUMMY_WORK,
        GLOBAL_BUDGET_KEY,
      ),
      policy: this.policy,
    });
  }

  private keyHash(scope: UnattendedPasswordBudgetScope, value: string): string {
    return createHmac('sha256', this.keySecret)
      .update(RATE_LIMIT_KEY_DOMAIN, 'utf8')
      .update('\0', 'utf8')
      .update(scope, 'utf8')
      .update('\0', 'utf8')
      .update(value, 'utf8')
      .digest('hex');
  }
}

export interface UnattendedPasswordAttemptMetrics {
  result: typeof UNATTENDED_PASSWORD_RESULT[keyof typeof UNATTENDED_PASSWORD_RESULT];
  targetState: UnattendedPasswordTargetState;
  stages: readonly UnattendedPasswordWorkStage[];
  elapsedMs: number;
}

export type UnattendedPasswordAttemptResult =
  | { result: typeof UNATTENDED_PASSWORD_RESULT.VERIFIED; hostId: string; generation: number }
  | { result: typeof UNATTENDED_PASSWORD_RESULT.UNAVAILABLE }
  | { result: typeof UNATTENDED_PASSWORD_RESULT.RATE_LIMITED };

export class RemoteDesktopUnattendedPasswordService {
  constructor(private readonly dependencies: {
    targets: UnattendedPasswordTargetRepository;
    rateLimiter: Pick<LayeredUnattendedPasswordRateLimiter, 'admit'>;
    peppers: UnattendedPasswordPepperRing;
    dummyVerifier: VersionedDummyVerifier;
    kdf?: UnattendedPasswordKdf;
    timing?: UnattendedPasswordTiming;
    observeWork?: UnattendedPasswordWorkObserver;
    observeMetrics?: (metrics: UnattendedPasswordAttemptMetrics) => void;
  }) {
    if (dependencies.dummyVerifier.dummyVersion !== UNATTENDED_PASSWORD_DUMMY_VERSION
      || !isValidVerifierMaterial(dependencies.dummyVerifier)
      || !isValidPepper(dependencies.peppers.resolve(dependencies.dummyVerifier.pepperVersion))) {
      throw new Error('invalid_dummy_verifier');
    }
  }

  async verify(input: {
    publicNodeId: string;
    password: string;
    source: string;
  }): Promise<UnattendedPasswordAttemptResult> {
    const timing = this.dependencies.timing ?? productionUnattendedPasswordTiming;
    const startedAt = timing.now();
    const stages: UnattendedPasswordWorkStage[] = [];
    const stage = (value: UnattendedPasswordWorkStage): void => {
      stages.push(value);
      this.dependencies.observeWork?.(value);
    };
    let target: ResolvedUnattendedPasswordTarget;
    try {
      target = await this.dependencies.targets.resolve(input.publicNodeId);
    } catch {
      target = unavailableTarget(UNATTENDED_PASSWORD_TARGET_STATE.UNKNOWN);
    }
    stage(UNATTENDED_PASSWORD_WORK_STAGE.LOOKUP);

    let rate: UnattendedPasswordRateLimitDecision;
    try {
      rate = await this.dependencies.rateLimiter.admit({
        source: input.source,
        publicNodeId: input.publicNodeId,
        hostId: target.hostId,
      });
    } catch {
      rate = { allowed: false, dummyWorkAllowed: true, cooldownUntil: null };
    }
    stage(UNATTENDED_PASSWORD_WORK_STAGE.RATE_LIMIT);

    let result: UnattendedPasswordAttemptResult;
    if (!rate.allowed) {
      if (rate.dummyWorkAllowed) {
        stage(UNATTENDED_PASSWORD_WORK_STAGE.RATE_LIMITED_DUMMY_KDF);
        await this.verifyAgainst(input.password, this.dependencies.dummyVerifier);
        stage(UNATTENDED_PASSWORD_WORK_STAGE.HASH);
        uniformPostKdfHash(this.dependencies.dummyVerifier.verifier);
      } else {
        stage(UNATTENDED_PASSWORD_WORK_STAGE.RATE_LIMITED_DUMMY_COOLDOWN);
        uniformPostKdfHash(this.dependencies.dummyVerifier.verifier);
      }
      result = { result: UNATTENDED_PASSWORD_RESULT.RATE_LIMITED };
    } else {
      const credential = target.state === UNATTENDED_PASSWORD_TARGET_STATE.ENABLED && target.credential
        ? target.credential
        : this.dependencies.dummyVerifier;
      stage(UNATTENDED_PASSWORD_WORK_STAGE.KDF);
      const verified = await this.verifyAgainst(input.password, credential);
      stage(UNATTENDED_PASSWORD_WORK_STAGE.HASH);
      uniformPostKdfHash(credential.verifier);
      result = verified
        && target.state === UNATTENDED_PASSWORD_TARGET_STATE.ENABLED
        && target.hostId
        && target.credential
        ? {
          result: UNATTENDED_PASSWORD_RESULT.VERIFIED,
          hostId: target.hostId,
          generation: target.credential.generation,
        }
        : { result: UNATTENDED_PASSWORD_RESULT.UNAVAILABLE };
    }

    stage(UNATTENDED_PASSWORD_WORK_STAGE.PADDING);
    const jitter = timing.jitter(UNATTENDED_PASSWORD_JITTER_MAX_MS);
    if (!Number.isSafeInteger(jitter) || jitter < 0 || jitter > UNATTENDED_PASSWORD_JITTER_MAX_MS) {
      throw new Error('invalid_crypto_jitter');
    }
    const targetDuration = UNATTENDED_PASSWORD_MIN_RESPONSE_MS + jitter;
    const remaining = Math.max(0, targetDuration - (timing.now() - startedAt));
    if (remaining > 0) await timing.sleep(remaining);
    const elapsedMs = Math.max(0, timing.now() - startedAt);
    this.dependencies.observeMetrics?.({
      result: result.result,
      targetState: target.state,
      stages: [...stages],
      elapsedMs,
    });
    return result;
  }

  private async verifyAgainst(
    password: string,
    material: UnattendedPasswordVerifierMaterial,
  ): Promise<boolean> {
    const requestedPepper = isValidVerifierMaterial(material)
      ? this.dependencies.peppers.resolve(material.pepperVersion)
      : null;
    const effectiveMaterial = isValidPepper(requestedPepper)
      ? material
      : this.dependencies.dummyVerifier;
    const pepper = isValidPepper(requestedPepper)
      ? requestedPepper
      : this.dependencies.peppers.resolve(this.dependencies.dummyVerifier.pepperVersion);
    // Constructor validation proves the dummy pepper exists. This protects
    // against a mutable ring without silently skipping the memory-hard work.
    if (!isValidPepper(pepper)) throw new Error('dummy_pepper_unavailable');
    try {
      const verified = await (this.dependencies.kdf ?? approvedUnattendedPasswordKdf).verify(
        pepperedPassword(password, pepper),
        `${effectiveMaterial.salt}:${effectiveMaterial.verifier}`,
      );
      return isValidPepper(requestedPepper) && verified;
    } catch {
      return false;
    }
  }
}

export interface UnattendedPasswordPrivacyEpochRef {
  epochId: string;
  revision: number;
}

export interface UnattendedPasswordMutationResult {
  hostId: string;
  generation: number;
  state: 'enabled' | 'disabled';
  effectsEmitted: number;
}

interface PasswordMutationHostRow {
  id: string;
  owner_user_id: string;
  merge_state: string;
}

interface PasswordMutationCredentialRow {
  generation: number;
  disabled_at: number | null;
}

interface PasswordMutationRouteRow {
  route_id: string;
  route_generation: number;
  execution_server_id: string | null;
  actor_audit_id: string | null;
  guest_session_id: string | null;
}

/**
 * Stable step-up envelope. Password bytes are deliberately absent: they are
 * bounded and KDF-derived locally, never serialized into a challenge/grant.
 */
export function unattendedPasswordStepUpAction(
  mutation: Pick<RemoteDesktopPasswordMutation, 'hostId' | 'action' | 'requestId'>,
): Record<string, unknown> {
  return {
    type: 'remote_desktop.unattended_password.mutation.v1',
    hostId: mutation.hostId,
    action: mutation.action,
    requestId: mutation.requestId,
  };
}

export async function mutateUnattendedPassword(input: {
  db: Database;
  accountSession: AccountSession;
  stepUpGrant: string;
  privacyEpoch: UnattendedPasswordPrivacyEpochRef;
  mutation: RemoteDesktopPasswordMutation;
  peppers: UnattendedPasswordPepperRing;
  kdf?: UnattendedPasswordKdf;
  now?: number;
}): Promise<StepUpGrantUse<UnattendedPasswordMutationResult>> {
  const validated = validateRemoteDesktopPasswordMutation(input.mutation);
  if (!validated.ok) {
    throw new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.INVALID);
  }
  const now = input.now ?? Date.now();
  const mutation = validated.value;
  const material = mutation.action === 'disable'
    ? null
    : await deriveUnattendedPasswordVerifier({
      password: mutation.password ?? '',
      peppers: input.peppers,
      kdf: input.kdf,
    });
  return consumeActionBoundStepUpGrant(
    input.db,
    {
      token: input.stepUpGrant,
      accountSession: input.accountSession,
      canonicalHostId: mutation.hostId,
      action: unattendedPasswordStepUpAction(mutation),
      requestId: mutation.requestId,
    },
    (tx) => applyUnattendedPasswordMutationTx(tx, {
      accountSession: input.accountSession,
      privacyEpoch: input.privacyEpoch,
      mutation,
      material,
      now,
    }),
    now,
  );
}

/**
 * Transaction body used by the action-bound grant consumer. It intentionally
 * accepts derived material rather than plaintext so DB/outbox/audit code can
 * never accidentally retain the password.
 */
export async function applyUnattendedPasswordMutationTx(
  tx: Database,
  input: {
    accountSession: AccountSession;
    privacyEpoch: UnattendedPasswordPrivacyEpochRef;
    mutation: Pick<RemoteDesktopPasswordMutation, 'hostId' | 'action' | 'requestId'>;
    material: UnattendedPasswordVerifierMaterial | null;
    now: number;
  },
): Promise<UnattendedPasswordMutationResult> {
  const host = await tx.queryOne<PasswordMutationHostRow>(
    `SELECT id, owner_user_id, merge_state
       FROM remote_desktop_hosts
      WHERE id = $1
      FOR UPDATE`,
    [input.mutation.hostId],
  );
  if (!host || host.merge_state !== 'resolved') {
    throw new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.HOST_UNAVAILABLE);
  }
  if (host.owner_user_id !== input.accountSession.userId) {
    throw new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.NOT_OWNER);
  }
  await requireShieldedEpochTx(tx, {
    hostId: host.id,
    epochId: input.privacyEpoch.epochId,
    revision: input.privacyEpoch.revision,
  });

  const current = await tx.queryOne<PasswordMutationCredentialRow>(
    `SELECT generation, disabled_at
       FROM remote_desktop_unattended_passwords
      WHERE host_id = $1
      FOR UPDATE`,
    [host.id],
  );
  if (current && (!Number.isSafeInteger(current.generation) || current.generation <= 0)) {
    throw new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.INVALID);
  }

  if (input.mutation.action === 'set' && current?.disabled_at === null) {
    throw new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.ALREADY_ENABLED);
  }
  if (input.mutation.action !== 'set' && (!current || current.disabled_at !== null)) {
    throw new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.NOT_ENABLED);
  }
  if (input.mutation.action !== 'disable' && !input.material) {
    throw new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.INVALID);
  }

  const nextGeneration = (current?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= 0) {
    throw new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.INVALID);
  }

  if (!current) {
    const material = input.material!;
    const inserted = await tx.execute(
      `INSERT INTO remote_desktop_unattended_passwords (
         host_id, verifier_version, verifier, salt, pepper_version,
         generation, changed_at, disabled_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [
        host.id,
        material.verifierVersion,
        material.verifier,
        material.salt,
        material.pepperVersion,
        nextGeneration,
        input.now,
      ],
    );
    if (inserted.changes !== 1) throw new Error('password_insert_failed');
  } else if (input.mutation.action === 'disable') {
    const updated = await tx.execute(
      `UPDATE remote_desktop_unattended_passwords
          SET generation = $2, disabled_at = $3
        WHERE host_id = $1 AND generation = $4 AND disabled_at IS NULL`,
      [host.id, nextGeneration, input.now, current.generation],
    );
    if (updated.changes !== 1) throw new Error('password_generation_raced');
  } else {
    const material = input.material!;
    const updated = await tx.execute(
      `UPDATE remote_desktop_unattended_passwords
          SET verifier_version = $2,
              verifier = $3,
              salt = $4,
              pepper_version = $5,
              generation = $6,
              changed_at = $7,
              disabled_at = NULL
        WHERE host_id = $1 AND generation = $8`,
      [
        host.id,
        material.verifierVersion,
        material.verifier,
        material.salt,
        material.pepperVersion,
        nextGeneration,
        input.now,
        current.generation,
      ],
    );
    if (updated.changes !== 1) throw new Error('password_generation_raced');
  }

  const routes = await tx.query<PasswordMutationRouteRow>(
    `SELECT route.route_id,
            route.route_generation,
            route.execution_server_id,
            route.actor_audit_id,
            route.guest_session_id
       FROM remote_desktop_host_routes AS route
       LEFT JOIN remote_desktop_guest_sessions AS session
         ON session.id = route.guest_session_id
      WHERE route.host_id = $1
        AND route.actor_source = $2
        AND route.state <> 'closed'
        AND (session.id IS NULL OR session.state IN ('admitting', 'active'))
      ORDER BY route.route_id, route.route_generation
      FOR UPDATE OF route`,
    [host.id, REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD],
  );
  for (const route of routes) assertValidPasswordRoute(route);

  await tx.execute(
    `UPDATE remote_desktop_guest_sessions
        SET state = 'closed', closed_at = $2, updated_at = $2
      WHERE host_id = $1
        AND actor_kind = $3
        AND state IN ('admitting', 'active')`,
    [host.id, input.now, REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD],
  );

  for (const route of routes) {
    await appendGuestEffectTx(tx, {
      id: randomUUID(),
      targetRouteId: route.route_id,
      event: {
        idempotencyKey: [
          'password-terminal',
          host.id,
          nextGeneration,
          route.route_id,
          route.route_generation,
        ].join(':'),
        authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.PASSWORD,
        effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
        scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
        hostId: host.id,
        actorAuditId: route.actor_audit_id!,
        sessionAuditId: route.guest_session_id!,
        passwordGeneration: nextGeneration,
        targetServerId: route.execution_server_id!,
        routeGeneration: route.route_generation,
      },
      now: input.now,
      sloAnchorAt: input.now,
      retainUntil: input.now + REMOTE_DESKTOP_GUEST_EFFECT_RETENTION_MS,
    });
  }

  await tx.execute(
    `INSERT INTO remote_desktop_guest_audit (
       id, host_id, actor_kind, actor_reference_hash, event_type,
       mode, source, metadata, created_at
     ) VALUES ($1, $2, 'owner', $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      randomUUID(),
      host.id,
      ownerAuditHash(input.accountSession.userId),
      `remote_desktop.password.${input.mutation.action}`,
      REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      input.accountSession.kind === 'web' ? 'web_owner' : 'controlled_host',
      JSON.stringify({ generation: nextGeneration, effectsEmitted: routes.length }),
      input.now,
    ],
  );

  return {
    hostId: host.id,
    generation: nextGeneration,
    state: input.mutation.action === 'disable' ? 'disabled' : 'enabled',
    effectsEmitted: routes.length,
  };
}

function assertValidPasswordRoute(route: PasswordMutationRouteRow): void {
  if (typeof route.route_id !== 'string' || route.route_id.length === 0
    || !Number.isSafeInteger(route.route_generation) || route.route_generation < 0
    || typeof route.execution_server_id !== 'string' || route.execution_server_id.length === 0
    || typeof route.actor_audit_id !== 'string' || route.actor_audit_id.length === 0
    || typeof route.guest_session_id !== 'string' || route.guest_session_id.length === 0) {
    throw new UnattendedPasswordMutationError(UNATTENDED_PASSWORD_MUTATION_ERROR.INVALID_ROUTE);
  }
}

function ownerAuditHash(userId: string): string {
  return createHash('sha256')
    .update(OWNER_AUDIT_HASH_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(userId, 'utf8')
    .digest('hex');
}

/** Admission and every renewal must call this instead of trusting a bootstrap snapshot. */
export async function isUnattendedPasswordGenerationCurrent(input: {
  db: Database;
  hostId: string;
  generation: number;
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) return false;
  const row = await input.db.queryOne<{ generation: number; disabled_at: number | null }>(
    `SELECT generation, disabled_at
       FROM remote_desktop_unattended_passwords
      WHERE host_id = $1`,
    [input.hostId],
  );
  return row !== null
    && row.disabled_at === null
    && Number.isSafeInteger(row.generation)
    && row.generation === input.generation;
}

export interface UnattendedPasswordControlBootstrapIssuer {
  /**
   * Implementations must recheck the exact credential generation in the same
   * transaction that persists the single-use ticket. A verifier result is a
   * snapshot, not permission to issue after a concurrent password rotation.
   */
  issue(input: {
    hostId: string;
    /** Exact active public ID whose password proof produced this snapshot. */
    publicNodeId: string;
    credentialGeneration: number;
    browserPublicKeySpki: string;
    browserKeyThumbprint: string;
    now: number;
  }): Promise<ProofSuccess | null>;
}

export class PostgresUnattendedPasswordControlBootstrapIssuer
implements UnattendedPasswordControlBootstrapIssuer {
  constructor(
    private readonly db: Database,
    private readonly options: {
      hostAvailability?: UnattendedPasswordHostAvailability;
      fullEndpointEligible?: FullEndpointEligibility;
    } = {},
  ) {}

  async issue(
    input: Parameters<UnattendedPasswordControlBootstrapIssuer['issue']>[0],
  ): Promise<ProofSuccess | null> {
    try {
      if (this.options.hostAvailability
        && await this.options.hostAvailability(input.hostId) !== UNATTENDED_PASSWORD_HOST_AVAILABILITY.ONLINE) {
        return null;
      }
      const issued = await issueNodePasswordBootstrap(this.db, {
        ...input,
        fullEndpointEligible: this.options.fullEndpointEligible,
      });
      if (!issued) return null;
      // Presence can change while the bootstrap transaction is committing.
      // Fail closed instead of returning a ticket for a target already known
      // to be unavailable. The unreturned hash-only ticket expires shortly.
      if (this.options.hostAvailability
        && await this.options.hostAvailability(input.hostId) !== UNATTENDED_PASSWORD_HOST_AVAILABILITY.ONLINE) {
        return null;
      }
      return issued;
    } catch {
      return null;
    }
  }
}

export type UnattendedPasswordPublicProofResult = ProofSuccess | ProofFailure | {
  ok: false;
  rateLimited: true;
  body: typeof UNATTENDED_PASSWORD_PUBLIC_RATE_LIMITED;
};

/**
 * Converts a successful constant-work proof into one Control-only bootstrap.
 * The issuer receives host/generation plus the browser's public SPKI and its
 * verified thumbprint only; neither plaintext nor verifier material can cross
 * into Router/daemon/Worker integration.
 */
export class RemoteDesktopUnattendedPasswordProofService {
  constructor(private readonly dependencies: {
    verifier: Pick<RemoteDesktopUnattendedPasswordService, 'verify'>;
    bootstrapIssuer: UnattendedPasswordControlBootstrapIssuer;
  }) {}

  async prove(input: {
    publicNodeId: string;
    password: string;
    browserPublicKeySpki: string;
    browserKeyThumbprint: string;
    source: string;
    now: number;
  }): Promise<UnattendedPasswordPublicProofResult> {
    if (!validateRemoteDesktopBrowserPublicKeyBinding({
      browserPublicKeySpki: input.browserPublicKeySpki,
      browserKeyThumbprint: input.browserKeyThumbprint,
    })) {
      return { ok: false, body: REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE };
    }
    const verified = await this.dependencies.verifier.verify({
      publicNodeId: input.publicNodeId,
      password: input.password,
      source: input.source,
    });
    if (verified.result === UNATTENDED_PASSWORD_RESULT.RATE_LIMITED) {
      return { ok: false, rateLimited: true, body: UNATTENDED_PASSWORD_PUBLIC_RATE_LIMITED };
    }
    if (verified.result !== UNATTENDED_PASSWORD_RESULT.VERIFIED) {
      return { ok: false, body: REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE };
    }
    const issued = await this.dependencies.bootstrapIssuer.issue({
      hostId: verified.hostId,
      publicNodeId: input.publicNodeId,
      credentialGeneration: verified.generation,
      browserPublicKeySpki: input.browserPublicKeySpki,
      browserKeyThumbprint: input.browserKeyThumbprint,
      now: input.now,
    });
    if (!issued
      || issued.hostId !== verified.hostId
      || issued.source !== REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD
      || issued.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL
      || issued.expiresAt <= input.now) {
      return { ok: false, body: REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE };
    }
    return issued;
  }
}

interface UnattendedPasswordEndpointPresenceRow {
  status: string | null;
  last_heartbeat_at: number | null;
}

/**
 * Resolve the qualified endpoint through the canonical host rather than
 * trusting a public-ID row, then require both durable PostgreSQL presence and
 * the current generation-reconciled runtime authority. Bootstrap redemption
 * and the owning Router revalidate that authority again before worker prepare.
 */
export function createPostgresUnattendedPasswordHostAvailability(input: {
  db: Database;
  now?: () => number;
  runtimeAuthorityAvailable?: FullEndpointEligibility;
}): UnattendedPasswordHostAvailability {
  return async (hostId) => {
    try {
      const endpoint = await resolveExecutionEndpoint({
        db: input.db,
        hostId,
        fullEndpointEligible: input.runtimeAuthorityAvailable,
      });
      if (!endpoint) return UNATTENDED_PASSWORD_HOST_AVAILABILITY.UNSUPPORTED;
      const presence = await input.db.queryOne<UnattendedPasswordEndpointPresenceRow>(
        `SELECT status, last_heartbeat_at
           FROM servers
          WHERE id = $1`,
        [endpoint.serverId],
      );
      const now = (input.now ?? Date.now)();
      const present = presence?.status === 'online'
        && typeof presence.last_heartbeat_at === 'number'
        && now - presence.last_heartbeat_at < MACHINE_PRESENCE_STALENESS_MS;
      if (!present) return UNATTENDED_PASSWORD_HOST_AVAILABILITY.OFFLINE;
      if (input.runtimeAuthorityAvailable
        && !await input.runtimeAuthorityAvailable(endpoint.serverId)) {
        return UNATTENDED_PASSWORD_HOST_AVAILABILITY.OFFLINE;
      }
      return UNATTENDED_PASSWORD_HOST_AVAILABILITY.ONLINE;
    } catch {
      return UNATTENDED_PASSWORD_HOST_AVAILABILITY.OFFLINE;
    }
  };
}

export interface PostgresUnattendedPasswordProofServiceOptions {
  db: Database;
  serverSecret: string;
  now?: () => number;
  runtimeAuthorityAvailable: FullEndpointEligibility;
  kdf?: UnattendedPasswordKdf;
  timing?: UnattendedPasswordTiming;
}

/** Construct the complete PostgreSQL-backed proof stack exactly once. */
export async function createPostgresUnattendedPasswordProofService(
  input: PostgresUnattendedPasswordProofServiceOptions,
): Promise<RemoteDesktopUnattendedPasswordProofService> {
  const peppers = createServerUnattendedPasswordPepperRing(input.serverSecret);
  const dummyVerifier = await createVersionedDummyVerifier({
    peppers,
    kdf: input.kdf,
  });
  const hostAvailability = createPostgresUnattendedPasswordHostAvailability({
    db: input.db,
    now: input.now,
    runtimeAuthorityAvailable: input.runtimeAuthorityAvailable,
  });
  const verifier = new RemoteDesktopUnattendedPasswordService({
    targets: new PostgresUnattendedPasswordTargetRepository(input.db, hostAvailability),
    rateLimiter: new LayeredUnattendedPasswordRateLimiter(
      new PostgresUnattendedPasswordRateLimitStore(input.db),
      input.serverSecret,
    ),
    peppers,
    dummyVerifier,
    kdf: input.kdf,
    timing: input.timing,
  });
  return new RemoteDesktopUnattendedPasswordProofService({
    verifier,
    bootstrapIssuer: new PostgresUnattendedPasswordControlBootstrapIssuer(input.db, {
      hostAvailability,
      fullEndpointEligible: input.runtimeAuthorityAvailable,
    }),
  });
}

/**
 * Memory-hard dummy material is initialized on the first valid proof request,
 * shared by concurrent callers, and retried after initialization failure. This
 * keeps application startup deterministic without caching a broken runtime.
 */
export function createLazyPostgresUnattendedPasswordProofService(
  input: PostgresUnattendedPasswordProofServiceOptions,
): Pick<RemoteDesktopUnattendedPasswordProofService, 'prove'> {
  let initialization: Promise<RemoteDesktopUnattendedPasswordProofService> | null = null;
  const initialize = (): Promise<RemoteDesktopUnattendedPasswordProofService> => {
    if (!initialization) {
      initialization = createPostgresUnattendedPasswordProofService(input).catch((error) => {
        initialization = null;
        throw error;
      });
    }
    return initialization;
  };
  return {
    prove: async (request) => (await initialize()).prove(request),
  };
}

/**
 * Accept only the canonical WebCrypto P-256 SPKI and its exact SHA-256
 * thumbprint. The SPKI is public; the matching private key never leaves the
 * browser and is proved later when the single-use bootstrap is redeemed.
 */
export function validateRemoteDesktopBrowserPublicKeyBinding(input: {
  browserPublicKeySpki: string;
  browserKeyThumbprint: string;
}): boolean {
  return isRemoteDesktopBrowserKeyBindingValid(input);
}

function uniformPostKdfHash(verifier: string): string {
  return createHash('sha256')
    .update('imcodes.remote-desktop.password-post-kdf.v1\0', 'utf8')
    .update(verifier, 'utf8')
    .digest('hex');
}

export interface TimingDistributionSummary {
  median: number;
  p95: number;
}

export function summarizeTimingDistribution(samples: readonly number[]): TimingDistributionSummary {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error('invalid_timing_samples');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number): number => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return { median: percentile(0.5), p95: percentile(0.95) };
}

export function timingDistributionWithinBaseline(input: {
  baseline: readonly number[];
  candidate: readonly number[];
  tolerance?: number;
}): boolean {
  const tolerance = input.tolerance ?? 0.2;
  if (!(tolerance >= 0 && tolerance < 1)) throw new Error('invalid_timing_tolerance');
  const baseline = summarizeTimingDistribution(input.baseline);
  const candidate = summarizeTimingDistribution(input.candidate);
  const within = (value: number, reference: number): boolean => (
    value >= reference * (1 - tolerance) && value <= reference * (1 + tolerance)
  );
  return within(candidate.median, baseline.median) && within(candidate.p95, baseline.p95);
}
