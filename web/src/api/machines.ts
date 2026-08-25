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
  FILE_TRANSFER_DIRECTORY_MAX_ENTRIES,
  FILE_TRANSFER_PATH_MAX_BYTES,
  type FileDirectoryEntry,
} from '@shared/transport/file-transfer.js';
import {
  compareControlledNodeArtifactPairs,
  CONTROLLED_NODE_MINT_ERRORS,
  CONTROLLED_NODE_TICKET_DELIVERY,
  controlledNodeArtifactKey,
  isCanonicalControlledNodePair,
  isControlledNodeArtifactArch,
  isControlledNodeArtifactSha256,
  isControlledNodeOs,
  isControlledNodeTicketDelivery,
  type ControlledNodeArtifactArch,
  type ControlledNodeArtifactPair,
  type ControlledNodeOs,
  type ControlledNodeTicketDelivery,
} from '@shared/controlled-node-artifacts.js';
import { MACHINE_API_PATH } from '@shared/machine-reference.js';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import { isMachineAccessRole, type MachineAccessRole } from '@shared/remote-exec.js';
import {
  validateControlledNodeCapabilities,
  type ControlledNodeCapability,
} from '@shared/controlled-node-capabilities.js';
import {
  apiFetch,
  getApiBaseUrl,
  getExpectedUserId,
  type AttachmentRefResponse,
} from '../api.js';

export type { ControlledNodeArtifactArch, ControlledNodeOs };

/** One controllable machine as shown in the composer picker. */
/**
 * A synthetic machine entry for the daemon's own host.
 *
 * The daemon is not a controlled node, so it has no row in the machine list —
 * but `RemoteDesktopPanel` is keyed by `serverId` and needs a `MachineListItem`.
 * The fields the panel gates on are asserted here because the daemon already
 * proved them by advertising the remote-desktop capability, which it only does
 * on Windows x64 with a verified worker installed.
 */
export function daemonRemoteDesktopMachine(
  serverId: string,
  displayName: string | null,
): MachineListItem {
  return {
    serverId,
    refName: serverId,
    displayName: displayName ?? serverId,
    os: 'win',
    online: true,
    execEnabled: true,
    accessRole: 'owner',
    capabilities: [REMOTE_DESKTOP_CAPABILITY],
  };
}

export interface MachineListItem {
  serverId: string;
  /** Canonical physical-host identity. Required for Owner guest-access management. */
  remoteDesktopHostId?: string;
  refName: string;
  displayName: string;
  os?: string;
  online: boolean;
  execEnabled: boolean;
  accessRole?: MachineAccessRole;
  capabilities?: ControlledNodeCapability[];
  /** The node's own reported release. Absent on old Servers and unreported nodes. */
  daemonVersion?: string;
  /** Server-computed: that release is older than the Server's target. */
  updateAvailable?: boolean;
  /** The node holds a sign-in secret for auto unlock. Never the secret itself. */
  autoUnlockConfigured?: boolean;
  /**
   * The daemon this node shares a machine with, when it was enrolled to give
   * that daemon login-screen control. The remote-control button on that daemon
   * steers here rather than opening a second session on the same desktop.
   */
  hostServerId?: string;
}

/** Identifies one downloadable artifact in the canonical OS+arch matrix. */
export interface ControlledNodeArtifactSelection extends ControlledNodeArtifactPair {}

/** Per-artifact metadata returned by GET /api/enroll/v2/availability. */
export interface ControlledNodeArtifactMetadata {
  os: ControlledNodeOs;
  arch: ControlledNodeArtifactArch;
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
  arch: ControlledNodeArtifactArch;
  filename: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: number;
  /** How this ticket is meant to reach the machine; decides its lifetime. */
  delivery: ControlledNodeTicketDelivery;
  ownerUserId: string;
}

export async function createMachineFileHandle(
  serverId: string,
  path: string,
  signal?: AbortSignal,
): Promise<AttachmentRefResponse> {
  const result = await apiFetch<{ ok: boolean; attachment: AttachmentRefResponse }>(
    `/api/server/${encodeURIComponent(serverId)}/machine-file-handle`,
    { method: 'POST', body: JSON.stringify({ path }), signal },
  );
  if (!result.ok || !result.attachment) throw new Error('machine_file_handle_failed');
  return result.attachment;
}

export interface MachineDirectoryList {
  resolvedPath: string;
  entries: FileDirectoryEntry[];
}

export async function listMachineDirectories(
  serverId: string,
  path: string,
  signal?: AbortSignal,
): Promise<MachineDirectoryList> {
  const result = await apiFetch<{ ok?: boolean; resolvedPath?: unknown; entries?: unknown }>(
    `/api/server/${encodeURIComponent(serverId)}/machine-file-list`,
    { method: 'POST', body: JSON.stringify({ path }), signal },
  );
  if (result.ok !== true
    || typeof result.resolvedPath !== 'string'
    || new TextEncoder().encode(result.resolvedPath).byteLength > FILE_TRANSFER_PATH_MAX_BYTES
    || !Array.isArray(result.entries)
    || result.entries.length > FILE_TRANSFER_DIRECTORY_MAX_ENTRIES) {
    throw new Error('machine_file_list_failed');
  }
  const entries = result.entries.filter((entry): entry is FileDirectoryEntry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const candidate = entry as Partial<FileDirectoryEntry>;
    return typeof candidate.name === 'string'
      && typeof candidate.path === 'string'
      && typeof candidate.isDir === 'boolean'
      && typeof candidate.hidden === 'boolean';
  });
  if (entries.length !== result.entries.length) throw new Error('machine_file_list_failed');
  return { resolvedPath: result.resolvedPath, entries };
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
  const arch = typeof raw.arch === 'string' && isControlledNodeArtifactArch(raw.arch) ? raw.arch : null;
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

function normalizeTicket(res: unknown, expectedOwnerUserId: string): ControlledNodeExecutableTicket {
  if (!isRecord(res)) throw new Error('invalid_ticket_response');
  if (res.version !== 2) throw new Error('invalid_ticket_response');
  const ticket = typeof res.ticket === 'string' ? res.ticket : '';
  const ticketId = typeof res.ticketId === 'string'
    ? res.ticketId
    : typeof res.id === 'string'
      ? res.id
      : '';
  const os = typeof res.os === 'string' && isControlledNodeOs(res.os) ? res.os : null;
  const arch = typeof res.arch === 'string' && isControlledNodeArtifactArch(res.arch) ? res.arch : null;
  const filename = typeof res.filename === 'string' ? res.filename : '';
  const sizeBytes = typeof res.sizeBytes === 'number' && Number.isFinite(res.sizeBytes) ? res.sizeBytes : null;
  const sha256 = typeof res.sha256 === 'string' && isControlledNodeArtifactSha256(res.sha256) ? res.sha256 : null;
  const expiresAt = typeof res.expiresAt === 'number' && Number.isFinite(res.expiresAt) ? res.expiresAt : null;
  const ownerUserId = typeof res.ownerUserId === 'string' ? res.ownerUserId : '';
  // A server that predates delivery modes minted a browser-window ticket, which
  // is the safe assumption: it under-promises the lifetime rather than over.
  const delivery = isControlledNodeTicketDelivery(res.delivery)
    ? res.delivery
    : CONTROLLED_NODE_TICKET_DELIVERY.BROWSER;
  if (ownerUserId && ownerUserId !== expectedOwnerUserId) {
    throw new Error(CONTROLLED_NODE_MINT_ERRORS.AUTH_IDENTITY_CHANGED);
  }
  if (!ticket || !ticketId || !os || !arch || !filename || sizeBytes === null || !sha256 || expiresAt === null || !ownerUserId) {
    throw new Error('invalid_ticket_response');
  }
  if (!isCanonicalControlledNodePair(os, arch)) throw new Error('invalid_ticket_response');
  return {
    version: 2, ticket, ticketId, os, arch, filename, sizeBytes, sha256,
    expiresAt, delivery, ownerUserId,
  };
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
  const capabilities = validateControlledNodeCapabilities(raw.capabilities);
  return {
    serverId,
    ...(typeof raw.remoteDesktopHostId === 'string' && raw.remoteDesktopHostId
      ? { remoteDesktopHostId: raw.remoteDesktopHostId }
      : {}),
    refName,
    displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : refName,
    ...(typeof raw.os === 'string' && raw.os ? { os: raw.os } : {}),
    online: raw.online === true,
    execEnabled: raw.execEnabled === true,
    // Old Servers return owned machines only and omit this field. A present but
    // malformed role fails closed in the UI; Server-side action checks remain
    // authoritative either way.
    accessRole: raw.accessRole === undefined
      ? 'owner'
      : isMachineAccessRole(raw.accessRole) ? raw.accessRole : 'viewer',
    ...(capabilities.ok && capabilities.value.length > 0 ? { capabilities: capabilities.value } : {}),
    ...(typeof raw.daemonVersion === 'string' && raw.daemonVersion ? { daemonVersion: raw.daemonVersion } : {}),
    ...(raw.updateAvailable === true ? { updateAvailable: true } : {}),
    ...(raw.autoUnlockConfigured === true ? { autoUnlockConfigured: true } : {}),
    ...(typeof raw.hostServerId === 'string' && raw.hostServerId
      ? { hostServerId: raw.hostServerId }
      : {}),
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

/** Ask a supported, online controlled node to fetch its missing signed worker bundle. */
export async function installMachineRemoteDesktopWorker(serverId: string): Promise<void> {
  await apiFetch(`${MACHINE_API_PATH}/${encodeURIComponent(serverId)}/remote-desktop-worker`, {
    method: 'POST',
  });
}

/** Rename a controlled machine's render-only display name. */
/**
 * Store or clear the node's Windows sign-in secret. Write-only: the value is
 * sent once and can never be read back, and the response carries only whether
 * the node now holds one.
 */
export async function setMachineAutoUnlock(
  serverId: string,
  secret: string | null,
): Promise<{ autoUnlockConfigured: boolean }> {
  const response = await apiFetch(`${MACHINE_API_PATH}/${encodeURIComponent(serverId)}/auto-unlock`, {
    method: 'POST',
    body: JSON.stringify({ secret }),
  }) as { autoUnlockConfigured?: boolean };
  return { autoUnlockConfigured: response?.autoUnlockConfigured === true };
}

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
  /**
   * The daemon whose machine this install is for, when enrolling to give that
   * machine login-screen control. Recorded on the enrolment so both installs are
   * known to share a machine and the browser keeps offering one entry.
   */
  hostServerId?: string,
  /**
   * Defaults to a browser sitting at the machine. Pass `remote_link` when the
   * operator will carry the link to a different machine and open it there.
   */
  delivery: ControlledNodeTicketDelivery = CONTROLLED_NODE_TICKET_DELIVERY.BROWSER,
): Promise<ControlledNodeExecutableTicket> {
  if (!isCanonicalControlledNodePair(selection.os, selection.arch)) {
    throw new Error('controlled_node_non_canonical_pair');
  }
  const expectedOwnerUserId = getExpectedUserId();
  if (!expectedOwnerUserId) {
    throw new Error(CONTROLLED_NODE_MINT_ERRORS.AUTH_IDENTITY_EXPECTATION_REQUIRED);
  }
  const res = await apiFetch<unknown>(ENROLL_V2_TICKET_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 2,
      os: selection.os,
      arch: selection.arch,
      ...(hostServerId ? { hostServerId } : {}),
      // Omitted for the default so an older server, which rejects unknown keys
      // with its strict body schema, keeps working unchanged.
      ...(delivery === CONTROLLED_NODE_TICKET_DELIVERY.BROWSER ? {} : { delivery }),
    }),
  });
  return normalizeTicket(res, expectedOwnerUserId);
}

/**
 * Bootstrap page URL that consumes a minted ticket from the URL hash fragment.
 * The page performs the authenticated download without buffering in the SPA.
 */
export function buildControlledNodeBootstrapUrl(ticket: string): string {
  return `${getApiBaseUrl()}${ENROLL_V2_BOOTSTRAP_PATH}#ticket=${encodeURIComponent(ticket)}`;
}

/**
 * Mint a long-lived link the operator can open ON the machine being enrolled.
 *
 * This exists to break a genuine deadlock: installing on a remote machine
 * otherwise means downloading the binary here and transferring it there with
 * some other remote tool — which is the tool you are trying to install. The
 * ticket rides in the URL fragment, so it is never sent to the server as part
 * of the request line and never lands in access logs or Referer headers.
 */
export async function mintControlledNodeRemoteInstallLink(
  selection: ControlledNodeArtifactSelection,
  hostServerId?: string,
): Promise<{ url: string; expiresAt: number; ticketId: string }> {
  const minted = await mintControlledNodeExecutableTicket(
    selection, hostServerId, CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK,
  );
  return {
    url: buildControlledNodeBootstrapUrl(minted.ticket),
    expiresAt: minted.expiresAt,
    ticketId: minted.ticketId,
  };
}
