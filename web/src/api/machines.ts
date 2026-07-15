/**
 * Web client for the server-native, owner-scoped controllable-machine list
 * (`/api/machines`). Session-authenticated and daemon-independent: presence is
 * read from the DB (F1), so no `serverId` is sent — `apiFetch` handles cookie
 * credentials + CSRF automatically, mirroring `api/aliases.ts`.
 *
 * Returns the composer-facing machine DTO used by the `^^(name)` quick-reference
 * (ref_name key + render-only display name + online/exec-enabled flags). Offline
 * machines are included for display; the picker renders them non-selectable.
 */
import {
  compareControlledNodeArtifactPairs,
  controlledNodeArtifactKey,
  isCanonicalControlledNodePair,
  isControlledNodeArch,
  isControlledNodeArtifactSha256,
  isControlledNodeOs,
  type ControlledNodeArch,
  type ControlledNodeArtifactPair,
  type ControlledNodeOs,
} from '@shared/controlled-node-artifacts.js';
import { MACHINE_API_PATH } from '@shared/machine-reference.js';
import { apiFetch, getApiBaseUrl } from '../api.js';

export type { ControlledNodeArch, ControlledNodeOs };

/** One controllable machine as shown in the composer picker. */
export interface MachineListItem {
  serverId: string;
  refName: string;
  displayName: string;
  os?: string;
  online: boolean;
  execEnabled: boolean;
}

/** Identifies one downloadable artifact in the canonical OS+arch matrix. */
export interface ControlledNodeArtifactSelection extends ControlledNodeArtifactPair {}

/** Per-artifact metadata returned by GET /api/enroll/v2/availability. */
export interface ControlledNodeArtifactMetadata {
  os: ControlledNodeOs;
  arch: ControlledNodeArch;
  filename: string;
  sizeBytes: number;
  sha256: string;
}

/** Availability payload: empty catalog is distinct from a fetch failure (thrown). */
export interface ControlledNodeAvailability {
  available: ControlledNodeOs[];
  artifacts: ControlledNodeArtifactMetadata[];
}

/** Minted download ticket from POST /api/enroll/v2/ticket. */
export interface ControlledNodeExecutableTicket {
  version: 2;
  ticket: string;
  ticketId: string;
  os: ControlledNodeOs;
  arch: ControlledNodeArch;
  filename: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: number;
}

const ENROLL_V2_AVAILABILITY_PATH = '/api/enroll/v2/availability';
const ENROLL_V2_TICKET_PATH = '/api/enroll/v2/ticket';
const ENROLL_V2_BOOTSTRAP_PATH = '/api/enroll/v2/bootstrap';

export function artifactSelectionKey(sel: ControlledNodeArtifactSelection): string {
  return controlledNodeArtifactKey(sel.os, sel.arch);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function normalizeArtifact(raw: unknown): ControlledNodeArtifactMetadata | null {
  if (!isRecord(raw)) return null;
  const os = typeof raw.os === 'string' && isControlledNodeOs(raw.os) ? raw.os : null;
  const arch = typeof raw.arch === 'string' && isControlledNodeArch(raw.arch) ? raw.arch : null;
  const filename = typeof raw.filename === 'string' ? raw.filename : '';
  const sizeBytes = typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : null;
  const sha256 = typeof raw.sha256 === 'string' && isControlledNodeArtifactSha256(raw.sha256) ? raw.sha256 : null;
  if (!os || !arch || !filename || sizeBytes === null || sizeBytes < 0 || !sha256) return null;
  if (!isCanonicalControlledNodePair(os, arch)) return null;
  return { os, arch, filename, sizeBytes, sha256 };
}

function normalizeAvailability(res: unknown): ControlledNodeAvailability {
  if (!isRecord(res)) return { available: [], artifacts: [] };
  const available = Array.isArray(res.available)
    ? res.available.filter((o): o is ControlledNodeOs => typeof o === 'string' && isControlledNodeOs(o))
    : [];
  const artifacts = Array.isArray(res.artifacts)
    ? res.artifacts.map(normalizeArtifact).filter((a): a is ControlledNodeArtifactMetadata => a !== null)
    : [];
  return { available, artifacts };
}

function normalizeTicket(res: unknown): ControlledNodeExecutableTicket {
  if (!isRecord(res)) throw new Error('invalid_ticket_response');
  if (res.version !== 2) throw new Error('invalid_ticket_response');
  const ticket = typeof res.ticket === 'string' ? res.ticket : '';
  const ticketId = typeof res.ticketId === 'string'
    ? res.ticketId
    : typeof res.id === 'string'
      ? res.id
      : '';
  const os = typeof res.os === 'string' && isControlledNodeOs(res.os) ? res.os : null;
  const arch = typeof res.arch === 'string' && isControlledNodeArch(res.arch) ? res.arch : null;
  const filename = typeof res.filename === 'string' ? res.filename : '';
  const sizeBytes = typeof res.sizeBytes === 'number' && Number.isFinite(res.sizeBytes) ? res.sizeBytes : null;
  const sha256 = typeof res.sha256 === 'string' && isControlledNodeArtifactSha256(res.sha256) ? res.sha256 : null;
  const expiresAt = typeof res.expiresAt === 'number' && Number.isFinite(res.expiresAt) ? res.expiresAt : null;
  if (!ticket || !ticketId || !os || !arch || !filename || sizeBytes === null || !sha256 || expiresAt === null) {
    throw new Error('invalid_ticket_response');
  }
  if (!isCanonicalControlledNodePair(os, arch)) throw new Error('invalid_ticket_response');
  return { version: 2, ticket, ticketId, os, arch, filename, sizeBytes, sha256, expiresAt };
}

/** Build download targets: one per canonical (os, arch) artifact with explicit arch. */
export function buildControlledNodeDownloadTargets(res: ControlledNodeAvailability): ControlledNodeArtifactSelection[] {
  const targets = res.artifacts
    .filter((a) => isCanonicalControlledNodePair(a.os, a.arch))
    .map((a) => ({ os: a.os, arch: a.arch }));
  return [...targets].sort(compareControlledNodeArtifactPairs);
}

function normalizeMachine(raw: unknown): MachineListItem | null {
  if (!isRecord(raw)) return null;
  const serverId = typeof raw.serverId === 'string' ? raw.serverId : '';
  const refName = typeof raw.refName === 'string' ? raw.refName : '';
  if (!serverId || !refName) return null;
  return {
    serverId,
    refName,
    displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : refName,
    ...(typeof raw.os === 'string' && raw.os ? { os: raw.os } : {}),
    online: raw.online === true,
    execEnabled: raw.execEnabled === true,
  };
}

function extractMachineList(res: unknown): MachineListItem[] {
  const rawList = isRecord(res) && Array.isArray(res.machines) ? res.machines : Array.isArray(res) ? res : [];
  const out: MachineListItem[] = [];
  for (const raw of rawList) {
    const m = normalizeMachine(raw);
    if (m) out.push(m);
  }
  return out;
}

/**
 * List the caller's controllable machines with DB-backed presence. Does NOT
 * swallow errors — the send path relies on distinguishing "loaded (empty)" from
 * "load failed" before attaching a marker resolution (fail-closed).
 */
export async function listControllableMachines(): Promise<MachineListItem[]> {
  const res = await apiFetch<unknown>(MACHINE_API_PATH);
  return extractMachineList(res);
}

/** Enable/disable remote exec for a controlled machine (owner-scoped). */
export async function setMachineExecEnabled(serverId: string, enabled: boolean): Promise<void> {
  await apiFetch(`${MACHINE_API_PATH}/${encodeURIComponent(serverId)}/exec-enabled`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

/** Rename a controlled machine's render-only display name. */
export async function renameMachine(serverId: string, displayName: string): Promise<void> {
  await apiFetch(`${MACHINE_API_PATH}/${encodeURIComponent(serverId)}/display-name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
}

/** Revoke a controlled machine (owner kill-switch): drops it and terminates its connection. */
export async function revokeMachine(serverId: string): Promise<void> {
  await apiFetch(`${MACHINE_API_PATH}/${encodeURIComponent(serverId)}/revoke`, { method: 'POST' });
}

/**
 * Fetch controlled-node artifact availability + metadata. Throws on request
 * failure so callers can distinguish an empty catalog from a load error.
 */
export async function listAvailableExecutables(): Promise<ControlledNodeAvailability> {
  const res = await apiFetch<unknown>(ENROLL_V2_AVAILABILITY_PATH);
  return normalizeAvailability(res);
}

/** @deprecated Prefer {@link listAvailableExecutables} for artifact metadata. */
export async function listAvailableExecutableOses(): Promise<string[]> {
  const { artifacts } = await listAvailableExecutables();
  return [...new Set(artifacts.map((a) => a.os))];
}

/** Mint a one-time download ticket (POST /api/enroll/v2/ticket). */
export async function mintControlledNodeExecutableTicket(
  selection: ControlledNodeArtifactSelection,
): Promise<ControlledNodeExecutableTicket> {
  if (!isCanonicalControlledNodePair(selection.os, selection.arch)) {
    throw new Error('controlled_node_non_canonical_pair');
  }
  const res = await apiFetch<unknown>(ENROLL_V2_TICKET_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 2, os: selection.os, arch: selection.arch }),
  });
  return normalizeTicket(res);
}

/**
 * Bootstrap page URL that consumes a minted ticket from the URL hash fragment.
 * The page performs the authenticated download without buffering in the SPA.
 */
export function buildControlledNodeBootstrapUrl(ticket: string): string {
  return `${getApiBaseUrl()}${ENROLL_V2_BOOTSTRAP_PATH}#ticket=${encodeURIComponent(ticket)}`;
}
