import { DAEMON_UPGRADE_TARGET_LATEST } from '../../../shared/daemon-upgrade.js';

const NPM_TARBALL_BASE_URL = 'https://registry.npmjs.org/imcodes/-/';
const DEFAULT_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

type ProbeStatus = 'available' | 'missing' | 'error';

export interface DaemonUpgradePublicationProbeResult {
  status: ProbeStatus;
  statusCode?: number;
  error?: unknown;
}

type DaemonUpgradePublicationProbe = (targetVersion: string, tarballUrl: string) => Promise<DaemonUpgradePublicationProbeResult>;

export interface DaemonUpgradePublicationGateResult {
  status: 'available' | 'pending';
  nextProbeAt?: string;
  reason?: string;
}

interface PublicationRecord {
  status: 'available' | 'pending';
  callbacks: Set<() => void>;
  attempt: number;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  nextProbeAt: number | null;
  lastStatusCode?: number;
}

export interface DaemonUpgradePublicationGateOptions {
  probe?: DaemonUpgradePublicationProbe;
  retryDelaysMs?: readonly number[];
}

async function defaultProbe(_targetVersion: string, tarballUrl: string): Promise<DaemonUpgradePublicationProbeResult> {
  try {
    const res = await fetch(tarballUrl, {
      method: 'HEAD',
      redirect: 'follow',
    });
    if (res.status >= 200 && res.status < 300) return { status: 'available', statusCode: res.status };
    if (res.status === 404) return { status: 'missing', statusCode: res.status };
    return { status: 'error', statusCode: res.status };
  } catch (error) {
    return { status: 'error', error };
  }
}

export function daemonUpgradeTarballUrl(targetVersion: string): string {
  return `${NPM_TARBALL_BASE_URL}imcodes-${encodeURIComponent(targetVersion)}.tgz`;
}

export class DaemonUpgradePublicationGate {
  private readonly probe: DaemonUpgradePublicationProbe;
  private readonly retryDelaysMs: readonly number[];
  private readonly records = new Map<string, PublicationRecord>();

  constructor(options: DaemonUpgradePublicationGateOptions = {}) {
    this.probe = options.probe ?? defaultProbe;
    this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  }

  ensurePublished(targetVersion: string, onPublished?: () => void): DaemonUpgradePublicationGateResult {
    if (targetVersion === DAEMON_UPGRADE_TARGET_LATEST) return { status: 'available' };

    const record = this.recordFor(targetVersion);
    if (record.status === 'available') return { status: 'available' };

    if (onPublished) record.callbacks.add(onPublished);
    if (!record.inFlight && !record.timer) {
      this.startProbe(targetVersion, record);
    }
    return {
      status: 'pending',
      ...(record.nextProbeAt ? { nextProbeAt: new Date(record.nextProbeAt).toISOString() } : {}),
      reason: record.lastStatusCode === 404 ? 'target_version_not_published' : 'target_version_publication_pending',
    };
  }

  markPublishedForTest(targetVersion: string): void {
    const record = this.recordFor(targetVersion);
    this.markPublished(targetVersion, record);
  }

  clear(): void {
    for (const record of this.records.values()) {
      if (record.timer) clearTimeout(record.timer);
      record.callbacks.clear();
    }
    this.records.clear();
  }

  private recordFor(targetVersion: string): PublicationRecord {
    const existing = this.records.get(targetVersion);
    if (existing) return existing;
    const next: PublicationRecord = {
      status: 'pending',
      callbacks: new Set(),
      attempt: 0,
      inFlight: false,
      timer: null,
      nextProbeAt: null,
    };
    this.records.set(targetVersion, next);
    return next;
  }

  private startProbe(targetVersion: string, record: PublicationRecord): void {
    record.inFlight = true;
    record.nextProbeAt = null;
    this.probe(targetVersion, daemonUpgradeTarballUrl(targetVersion))
      .then((result) => {
        record.inFlight = false;
        record.lastStatusCode = result.statusCode;
        if (result.status === 'available') {
          this.markPublished(targetVersion, record);
          return;
        }
        this.scheduleRetry(targetVersion, record);
      })
      .catch(() => {
        record.inFlight = false;
        record.lastStatusCode = undefined;
        this.scheduleRetry(targetVersion, record);
      });
  }

  private scheduleRetry(targetVersion: string, record: PublicationRecord): void {
    if (record.status === 'available') return;
    const delay = this.retryDelaysMs[Math.min(record.attempt, this.retryDelaysMs.length - 1)] ?? DEFAULT_RETRY_DELAYS_MS.at(-1)!;
    record.attempt += 1;
    record.nextProbeAt = Date.now() + delay;
    record.timer = setTimeout(() => {
      record.timer = null;
      this.startProbe(targetVersion, record);
    }, delay);
  }

  private markPublished(targetVersion: string, record: PublicationRecord): void {
    if (record.timer) clearTimeout(record.timer);
    record.status = 'available';
    record.timer = null;
    record.inFlight = false;
    record.nextProbeAt = null;
    const callbacks = [...record.callbacks];
    record.callbacks.clear();
    this.records.set(targetVersion, record);
    for (const callback of callbacks) callback();
  }
}

export const daemonUpgradePublicationGate = new DaemonUpgradePublicationGate();

export function resetDaemonUpgradePublicationGateForTest(): void {
  daemonUpgradePublicationGate.clear();
}

export function markDaemonUpgradeTargetVersionPublishedForTest(targetVersion: string): void {
  daemonUpgradePublicationGate.markPublishedForTest(targetVersion);
}
