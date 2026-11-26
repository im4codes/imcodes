import { createHash, createHmac } from 'node:crypto';
import {
  REMOTE_DESKTOP_PRIVACY_PHASE,
  type RemoteDesktopPresentationSource,
  type RemoteDesktopPrivacyPhase,
} from '../../shared/remote-desktop-access.js';

export type HostAvailability = 'online' | 'offline' | 'disabled' | 'unsupported';
export type PresentationSource = RemoteDesktopPresentationSource;
export type WallTransport = 'direct' | 'turn';

export interface AccessHostFixture {
  remoteDesktopHostId: string;
  ownerUserId: string;
  fullServerId: string | null;
  controlledServerId: string | null;
  executionServerId: string | null;
  publicNodeId: string | null;
  publicNodeIdState: 'active' | 'retired' | 'unknown';
  availability: HostAvailability;
  requiresMergeResolution: boolean;
}

export interface AccessAuthorityFixture {
  linkId: string;
  browserId: string;
  authorityGeneration: number;
  expiryRevision: number;
  passwordGeneration: number;
}

export interface WallNodeFixture {
  remoteDesktopHostId: string;
  transport: WallTransport;
  state: 'live' | 'paused' | 'failed';
}

export function linkedHostFixture(overrides: Partial<AccessHostFixture> = {}): AccessHostFixture {
  return {
    remoteDesktopHostId: 'rd-host-linked-1',
    ownerUserId: 'owner-1',
    fullServerId: 'full-server-1',
    controlledServerId: 'controlled-server-1',
    executionServerId: 'controlled-server-1',
    publicNodeId: '5837462190',
    publicNodeIdState: 'active',
    availability: 'online',
    requiresMergeResolution: false,
    ...overrides,
  };
}

export function principalMergeConflictFixture(): AccessHostFixture {
  return linkedHostFixture({
    remoteDesktopHostId: 'rd-host-merge-conflict',
    publicNodeId: null,
    publicNodeIdState: 'unknown',
    executionServerId: null,
    requiresMergeResolution: true,
  });
}

export function hostStateFixture(
  state: 'unknown' | 'retired' | HostAvailability,
): AccessHostFixture {
  if (state === 'unknown') {
    return linkedHostFixture({
      remoteDesktopHostId: 'rd-host-unknown',
      publicNodeId: null,
      publicNodeIdState: 'unknown',
      executionServerId: null,
      availability: 'offline',
    });
  }
  if (state === 'retired') {
    return linkedHostFixture({
      remoteDesktopHostId: 'rd-host-retired',
      publicNodeId: '5738192640',
      publicNodeIdState: 'retired',
      executionServerId: null,
      availability: 'offline',
    });
  }
  return linkedHostFixture({ availability: state });
}

export function accessAuthorityFixture(
  overrides: Partial<AccessAuthorityFixture> = {},
): AccessAuthorityFixture {
  return {
    linkId: 'link-1',
    browserId: 'browser-1',
    authorityGeneration: 3,
    expiryRevision: 5,
    passwordGeneration: 7,
    ...overrides,
  };
}

export function wallFixture(count: 1 | 4 | 16, transport: WallTransport): WallNodeFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    remoteDesktopHostId: `rd-wall-host-${String(index + 1).padStart(2, '0')}`,
    transport,
    state: 'live',
  }));
}

export class DeterministicClock {
  constructor(private value: number = 1_800_000_000_000) {}

  now = (): number => this.value;

  set(value: number): void {
    if (!Number.isSafeInteger(value)) throw new Error('invalid_clock_value');
    this.value = value;
  }

  advance(milliseconds: number): number {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error('invalid_clock_advance');
    }
    this.value += milliseconds;
    return this.value;
  }
}

export class DeterministicByteSource {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length === 0) throw new Error('empty_random_source');
  }

  read(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error('invalid_random_length');
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      result[index] = this.bytes[this.offset % this.bytes.length] ?? 0;
      this.offset += 1;
    }
    return result;
  }
}

export class BrowserKeyProofHarness {
  constructor(private readonly secret = 'browser-proof-fixture-secret') {}

  sign(browserId: string, challenge: string): string {
    return createHmac('sha256', this.secret).update(`${browserId}\0${challenge}`).digest('base64url');
  }

  verify(browserId: string, challenge: string, proof: string): boolean {
    return this.sign(browserId, challenge) === proof;
  }
}

export class KdfWorkCounter {
  readonly stages: string[] = [];

  run(stage: string, input: string): string {
    this.stages.push(stage);
    return createHash('sha256').update(`${stage}\0${input}`).digest('hex');
  }

  reset(): void {
    this.stages.length = 0;
  }
}

export class DeterministicRateLimitHarness {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly clock: DeterministicClock,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(key: string): boolean {
    const cutoff = this.clock.now() - this.windowMs;
    const current = (this.attempts.get(key) ?? []).filter((value) => value > cutoff);
    if (current.length >= this.limit) {
      this.attempts.set(key, current);
      return false;
    }
    current.push(this.clock.now());
    this.attempts.set(key, current);
    return true;
  }
}

export class PodStickyHandoffHarness {
  private readonly owners = new Map<string, string>();

  bind(serverId: string, podId: string): void {
    this.owners.set(serverId, podId);
  }

  resolve(serverId: string): string | null {
    return this.owners.get(serverId) ?? null;
  }

  assertOwningPod(serverId: string, podId: string): void {
    if (this.resolve(serverId) !== podId) throw new Error('wrong_pod');
  }
}

export interface DueRecordFixture {
  linkId: string;
  expiryRevision: number;
  expiresAt: number;
  claimedBy: string | null;
  completed: boolean;
}

export interface OutboxRecordFixture {
  idempotencyKey: string;
  scope: 'route' | 'host';
  targetPodId: string | null;
  acknowledged: boolean;
}

export class DueOutboxHarness {
  readonly due: DueRecordFixture[] = [];
  readonly outbox: OutboxRecordFixture[] = [];

  schedule(record: Omit<DueRecordFixture, 'claimedBy' | 'completed'>): void {
    this.due.push({ ...record, claimedBy: null, completed: false });
  }

  claimDue(now: number, workerId: string, limit = 32): DueRecordFixture[] {
    const claimed: DueRecordFixture[] = [];
    for (const record of this.due) {
      if (claimed.length >= limit) break;
      if (record.completed || record.claimedBy !== null || record.expiresAt > now) continue;
      record.claimedBy = workerId;
      claimed.push({ ...record });
    }
    return claimed;
  }

  complete(linkId: string, expiryRevision: number, targetPodId: string | null): void {
    const record = this.due.find((item) => (
      item.linkId === linkId && item.expiryRevision === expiryRevision
    ));
    const idempotencyKey = `expiry:${linkId}:${expiryRevision}`;
    if (!record || record.claimedBy === null) throw new Error('invalid_due_completion');
    if (record.completed) {
      if (!this.outbox.some((item) => item.idempotencyKey === idempotencyKey)) {
        throw new Error('missing_outbox_after_completion');
      }
      return;
    }
    record.completed = true;
    if (!this.outbox.some((item) => item.idempotencyKey === idempotencyKey)) {
      this.outbox.push({
        idempotencyKey,
        scope: targetPodId === null ? 'host' : 'route',
        targetPodId,
        acknowledged: false,
      });
    }
  }

  acknowledge(idempotencyKey: string, podId: string, resolvedHostPodId?: string): void {
    const record = this.outbox.find((item) => item.idempotencyKey === idempotencyKey);
    const targetPodId = record?.scope === 'host' ? resolvedHostPodId : record?.targetPodId;
    if (!record || targetPodId !== podId) throw new Error('wrong_pod');
    record.acknowledged = true;
  }
}

export type ConsentDecision = 'allow' | 'deny' | 'timeout' | 'provider_failure';

export class ConsentProviderHarness {
  private readonly decisions: ConsentDecision[] = [];

  enqueue(decision: ConsentDecision): void {
    this.decisions.push(decision);
  }

  request(): ConsentDecision {
    return this.decisions.shift() ?? 'timeout';
  }
}

export class PrivacyEpochHarness {
  phase: 'idle' | RemoteDesktopPrivacyPhase = 'idle';
  epoch = 0;
  readonly activeRoutes = new Set<string>();
  readonly acknowledgedRoutes = new Set<string>();

  begin(activeRouteIds: string[]): number {
    if (this.phase !== 'idle') throw new Error('privacy_epoch_busy');
    this.epoch += 1;
    this.phase = REMOTE_DESKTOP_PRIVACY_PHASE.STARTING;
    this.activeRoutes.clear();
    this.acknowledgedRoutes.clear();
    for (const routeId of activeRouteIds) this.activeRoutes.add(routeId);
    if (this.activeRoutes.size === 0) this.phase = REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE;
    return this.epoch;
  }

  acknowledge(epoch: number, routeId: string): void {
    if (epoch !== this.epoch
      || this.phase !== REMOTE_DESKTOP_PRIVACY_PHASE.STARTING
      || !this.activeRoutes.has(routeId)) {
      throw new Error('privacy_epoch_mismatch');
    }
    this.acknowledgedRoutes.add(routeId);
    if (this.acknowledgedRoutes.size === this.activeRoutes.size) {
      this.phase = REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE;
    }
  }

  fail(epoch: number): void {
    if (epoch !== this.epoch) throw new Error('privacy_epoch_mismatch');
    this.phase = REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED;
  }

  finish(epoch: number, freshFrameAcknowledged: boolean): void {
    if (epoch !== this.epoch
      || this.phase !== REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE
      || !freshFrameAcknowledged) {
      throw new Error('privacy_resume_forbidden');
    }
    this.phase = REMOTE_DESKTOP_PRIVACY_PHASE.ENDING;
    this.phase = 'idle';
    this.activeRoutes.clear();
    this.acknowledgedRoutes.clear();
  }
}

export class RemoteSessionHarness {
  readonly sessions = new Map<string, { hostId: string; transport: WallTransport; connected: boolean }>();

  connect(sessionId: string, hostId: string, transport: WallTransport): void {
    if (this.sessions.has(sessionId)) throw new Error('duplicate_session');
    this.sessions.set(sessionId, { hostId, transport, connected: true });
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.connected = false;
  }
}
