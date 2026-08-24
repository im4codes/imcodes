import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_STATE,
  type RemoteDesktopAccessMode,
} from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_BROWSER_CLAIM,
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_LINK_KIND,
  REMOTE_DESKTOP_LINK_MUTATION,
  REMOTE_DESKTOP_LINK_TOKEN,
  type RemoteDesktopActorSource,
  type RemoteDesktopLinkKind,
} from '@shared/remote-desktop-access.js';
import {
  isRemoteDesktopId,
  isSafeNonNegativeRemoteDesktopInteger,
} from '@shared/remote-desktop-contract-primitives.js';
import { ApiError, apiFetch } from '../api.js';
import {
  generateRemoteDesktopBrowserKeyPair,
  generateRemoteDesktopRawInvite,
  remoteDesktopInviteUrl,
  sha256RemoteDesktopLinkPolicy,
  signRemoteDesktopBootstrap,
  signRemoteDesktopClaim,
  type RemoteDesktopBrowserKeyPair,
} from '../remote-desktop-access-crypto.js';
import {
  RemoteDesktopClient,
  type RemoteDesktopSnapshot,
} from '../remote-desktop-client.js';

export interface RemoteDesktopPrivacyEpochRef {
  epochId: string;
  revision: number;
}

export interface RemoteDesktopOwnerHostSummary {
  hostId: string;
  publicNodeId: string;
  mergeState: 'resolved' | 'conflict_pending';
}

export interface RemoteDesktopOwnerLinkView {
  id: string;
  hostId: string;
  label: string;
  kind: RemoteDesktopLinkKind;
  mode: RemoteDesktopAccessMode;
  expiresAt: number | null;
  authorityGeneration: number;
  expiryRevision: number;
  commitRevision: number;
  state: 'active' | 'revoked' | 'expired';
  claimed: boolean;
  createdAt: number;
  connectionAudit: {
    connectionCount: number;
    totalDurationMs: number;
    lastConnectedAt: number | null;
    recentConnections: Array<{
      ipAddress: string;
      connectedAt: number;
      disconnectedAt: number | null;
      durationMs: number;
    }>;
  };
}

export interface RemoteDesktopStepUpGrant {
  grantId?: string;
  token?: string;
  stepUpGrant?: string;
  expiresAt?: number;
}

export interface RemoteDesktopAccessApi {
  loadHost(hostId: string): Promise<RemoteDesktopOwnerHostSummary>;
  rotateHost(input: { hostId: string; requestId: string }): Promise<RemoteDesktopOwnerHostSummary>;
  listLinks(hostId: string): Promise<RemoteDesktopOwnerLinkView[]>;
  createLink(input: CreateOwnerLinkInput): Promise<RemoteDesktopOwnerLinkView>;
  mutateLink(input: MutateOwnerLinkInput): Promise<RemoteDesktopOwnerLinkView>;
  revokeLink(input: RevokeOwnerLinkInput): Promise<RemoteDesktopOwnerLinkView>;
  mutatePassword(input: OwnerPasswordMutationInput): Promise<{
    hostId: string;
    generation: number;
    state: 'enabled' | 'disabled';
    effectsEmitted: number;
    replayed?: boolean;
  }>;
  beginStepUp(input: StepUpBeginInput): Promise<unknown>;
  completeStepUp(input: { challengeId: string; response: unknown }): Promise<RemoteDesktopStepUpGrant>;
  beginPrivacy(hostId: string): Promise<RemoteDesktopPrivacyEpochRef>;
  endPrivacy(hostId: string, privacy: RemoteDesktopPrivacyEpochRef): Promise<void>;
  resolveInvite(input: { token: string; browserKey: RemoteDesktopBrowserKeyPair }): Promise<RemoteDesktopGuestProofResult>;
  provePassword(input: { publicNodeId: number; password: string; browserKey: RemoteDesktopBrowserKeyPair }): Promise<RemoteDesktopGuestProofResult>;
}

export interface CreateOwnerLinkInput {
  hostId?: string;
  kind?: RemoteDesktopLinkKind;
  mode?: RemoteDesktopAccessMode;
  label?: string;
  durationMs?: number;
  privacyEpoch: RemoteDesktopPrivacyEpochRef;
  prepared?: PreparedRemoteDesktopLink;
}

export interface PreparedRemoteDesktopLink {
  requestId: string;
  inviteUrl: string;
  action: Record<string, unknown>;
  request: {
    hostId: string;
    creationRequestId: string;
    tokenHashVersion: string;
    tokenHash: string;
    kind: RemoteDesktopLinkKind;
    mode: RemoteDesktopAccessMode;
    label: string;
    durationMs?: number;
  };
}

export interface MutateOwnerLinkInput {
  linkId: string;
  hostId: string;
  requestId?: string;
  mutation: typeof REMOTE_DESKTOP_LINK_MUTATION[keyof typeof REMOTE_DESKTOP_LINK_MUTATION];
  label?: string;
  expiresAt?: number;
  privacyEpoch: RemoteDesktopPrivacyEpochRef;
  stepUpGrant: string;
}

export interface RevokeOwnerLinkInput {
  linkId: string;
  hostId: string;
  requestId?: string;
  privacyEpoch: RemoteDesktopPrivacyEpochRef;
  stepUpGrant: string;
}

export interface OwnerPasswordMutationInput {
  hostId: string;
  requestId?: string;
  action: 'set' | 'change' | 'disable';
  password?: string;
  privacyEpoch: RemoteDesktopPrivacyEpochRef;
  stepUpGrant: string;
}

export interface StepUpBeginInput {
  canonicalHostId: string;
  requestId: string;
  deadline?: number;
  action: Record<string, unknown>;
}

export type RemoteDesktopGuestStatus =
  | 'idle'
  | 'resolving'
  | 'waiting_for_consent'
  | 'approved'
  | 'denied'
  | 'timeout'
  | 'cooldown'
  | 'unavailable';

export interface RemoteDesktopGuestReady {
  status: 'ready';
  hostId: string;
  serverId: string;
  bootstrapTicket: string;
  expiresAt: number;
  mode: RemoteDesktopAccessMode;
  source: RemoteDesktopActorSource;
  browserKey: RemoteDesktopBrowserKeyPair;
}

export type RemoteDesktopGuestProofResult = RemoteDesktopGuestReady | { status: 'unavailable' | 'rate_limited' };

export type RemoteDesktopGuestSessionState = 'waiting_for_consent' | 'approved' | 'denied' | 'timeout' | 'cancelled';

export interface RemoteDesktopGuestSessionStarter {
  start(input: {
    serverId: string;
    hostId: string;
    mode: RemoteDesktopAccessMode;
    source: RemoteDesktopActorSource;
    bootstrapProof: { ticket: string; browserKeyThumbprint: string; signature: string };
    expiresAt: number;
    onSnapshot?: (snapshot: Readonly<RemoteDesktopSnapshot>) => void;
  }, onState: (state: RemoteDesktopGuestSessionState) => void): Promise<{ stop(): void }>;
}

export const unavailableRemoteDesktopGuestSessionStarter: RemoteDesktopGuestSessionStarter = {
  async start() {
    throw new Error('remote_desktop_guest_signaling_unavailable');
  },
};

export function remoteDesktopGuestSessionStateFromSnapshot(
  snapshot: Pick<RemoteDesktopSnapshot, 'state' | 'error'>,
  source: RemoteDesktopActorSource,
): RemoteDesktopGuestSessionState | null {
  if (snapshot.state === REMOTE_DESKTOP_STATE.AUTHORIZING) {
    return source === REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
      ? 'waiting_for_consent'
      : null;
  }
  if (snapshot.state === REMOTE_DESKTOP_STATE.FAILED
    || snapshot.state === REMOTE_DESKTOP_STATE.STOPPED) {
    if (snapshot.error === REMOTE_DESKTOP_ERROR.ACCESS_DENIED) return 'denied';
    if (snapshot.error === REMOTE_DESKTOP_ERROR.NEGOTIATION_TIMEOUT) return 'timeout';
    return 'cancelled';
  }
  return 'approved';
}

/** Production anonymous signaling/media adapter. The bootstrap ticket stays out
 * of the URL and is discarded by RemoteDesktopClient after the first frame. */
export const remoteDesktopGuestSessionStarter: RemoteDesktopGuestSessionStarter = {
  async start(input, onState) {
    let lastState: RemoteDesktopGuestSessionState | null = null;
    const publishState = (state: RemoteDesktopGuestSessionState) => {
      if (lastState === state) return;
      lastState = state;
      onState(state);
    };
    const client = new RemoteDesktopClient(input.serverId, {
      onSnapshot(snapshot) {
        input.onSnapshot?.(snapshot);
        const state = remoteDesktopGuestSessionStateFromSnapshot(snapshot, input.source);
        if (state) publishState(state);
      },
    }, { guestBootstrapProof: { ...input.bootstrapProof } });
    try {
      await client.start();
    } catch (error) {
      client.stop();
      publishState('cancelled');
      throw error;
    }
    return { stop: () => client.stop() };
  },
};

export const newRemoteDesktopGuestBrowserKey = generateRemoteDesktopBrowserKeyPair;

export const newRemoteDesktopRequestId = requestId;

export interface RemoteDesktopPrivacyCoordinator {
  begin(hostId: string): Promise<RemoteDesktopPrivacyEpochRef>;
  end(hostId: string, privacy: RemoteDesktopPrivacyEpochRef): Promise<void>;
}

export const unavailableRemoteDesktopPrivacyCoordinator: RemoteDesktopPrivacyCoordinator = {
  async begin() { throw new ApiError(503, JSON.stringify({ error: 'privacy_route_unavailable' })); },
  async end() { /* no-op after failed closed begin */ },
};

/** Production management-Web coordinator. The Server still owns the route
 * snapshot/admission decision; this object carries only the opaque epoch ref. */
export const remoteDesktopManagementWebPrivacyCoordinator: RemoteDesktopPrivacyCoordinator = {
  begin(hostId) {
    return createRemoteDesktopAccessApi().beginPrivacy(hostId);
  },
  end(hostId, privacy) {
    return createRemoteDesktopAccessApi().endPrivacy(hostId, privacy);
  },
};

export async function prepareRemoteDesktopLink(input: {
  hostId: string;
  kind: RemoteDesktopLinkKind;
  mode: RemoteDesktopAccessMode;
  label: string;
  durationMs?: number;
}): Promise<PreparedRemoteDesktopLink> {
  const raw = await generateRemoteDesktopRawInvite();
  const creationRequestId = newRemoteDesktopRequestId();
  const label = input.label.trim() || 'Remote desktop invite';
  const request = {
    hostId: input.hostId,
    creationRequestId,
    tokenHashVersion: REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION,
    tokenHash: raw.tokenHash,
    kind: input.kind,
    mode: input.mode,
    label,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
  const policyHash = await sha256RemoteDesktopLinkPolicy({
    hostId: input.hostId,
    kind: input.kind,
    mode: input.mode,
    label,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  });
  return {
    requestId: creationRequestId,
    inviteUrl: remoteDesktopInviteUrl(raw.token),
    request,
    action: {
      kind: 'remote_desktop.link.create',
      hostId: input.hostId,
      creationRequestId,
      tokenHash: raw.tokenHash,
      policyHash,
    },
  };
}

export function remoteDesktopLinkMutationAction(input: { hostId: string; linkId: string; mutation: string; label?: string; expiresAt?: number }): Record<string, unknown> {
  return {
    kind: 'remote_desktop.link.mutate',
    hostId: input.hostId,
    linkId: input.linkId,
    mutation: input.mutation,
    label: input.label ?? null,
    expiresAt: input.expiresAt ?? null,
  };
}

export function remoteDesktopPasswordMutationAction(input: { hostId: string; action: string; requestId: string }): Record<string, unknown> {
  return {
    type: 'remote_desktop.unattended_password.mutation.v1',
    hostId: input.hostId,
    action: input.action,
    requestId: input.requestId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(REMOTE_DESKTOP_LINK_TOKEN.CREATION_REQUEST_ID_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeHost(value: unknown): RemoteDesktopOwnerHostSummary {
  const host = isRecord(value) && isRecord(value.host) ? value.host : value;
  if (!isRecord(host)
    || typeof host.hostId !== 'string'
    || typeof host.publicNodeId !== 'string'
    || (host.mergeState !== 'resolved' && host.mergeState !== 'conflict_pending')) {
    throw new Error('invalid_remote_desktop_host');
  }
  return {
    hostId: host.hostId,
    publicNodeId: host.publicNodeId,
    mergeState: host.mergeState,
  };
}

function decodeLink(value: unknown): RemoteDesktopOwnerLinkView {
  const audit = isRecord(value) && isRecord(value.connectionAudit) ? value.connectionAudit : null;
  const recent = audit && Array.isArray(audit.recentConnections) ? audit.recentConnections : null;
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.hostId !== 'string'
    || typeof value.label !== 'string'
    || (value.kind !== REMOTE_DESKTOP_LINK_KIND.ATTENDED && value.kind !== REMOTE_DESKTOP_LINK_KIND.UNATTENDED)
    || (value.mode !== REMOTE_DESKTOP_ACCESS_MODE.VIEW && value.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL)
    || (value.expiresAt !== null && typeof value.expiresAt !== 'number')
    || typeof value.authorityGeneration !== 'number'
    || typeof value.expiryRevision !== 'number'
    || typeof value.commitRevision !== 'number'
    || (value.state !== 'active' && value.state !== 'revoked' && value.state !== 'expired')
    || typeof value.claimed !== 'boolean'
    || typeof value.createdAt !== 'number'
    || !audit
    || !Number.isSafeInteger(audit.connectionCount) || (audit.connectionCount as number) < 0
    || typeof audit.totalDurationMs !== 'number' || audit.totalDurationMs < 0
    || (audit.lastConnectedAt !== null && typeof audit.lastConnectedAt !== 'number')
    || !recent || recent.length > 20
    || recent.some((entry) => !isRecord(entry)
      || typeof entry.ipAddress !== 'string' || entry.ipAddress.length === 0 || entry.ipAddress.length > 64
      || typeof entry.connectedAt !== 'number'
      || (entry.disconnectedAt !== null && typeof entry.disconnectedAt !== 'number')
      || typeof entry.durationMs !== 'number' || entry.durationMs < 0)) {
    throw new Error('invalid_remote_desktop_link');
  }
  return value as unknown as RemoteDesktopOwnerLinkView;
}

function decodeLinks(value: unknown): RemoteDesktopOwnerLinkView[] {
  if (!isRecord(value) || !Array.isArray(value.links)) throw new Error('invalid_remote_desktop_links');
  return value.links.map(decodeLink);
}

function decodePrivacyEpoch(value: unknown): RemoteDesktopPrivacyEpochRef {
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || !Object.prototype.hasOwnProperty.call(value, 'epochId')
    || !Object.prototype.hasOwnProperty.call(value, 'revision')
    || !isRemoteDesktopId(value.epochId)
    || !isSafeNonNegativeRemoteDesktopInteger(value.revision)
    || value.revision <= 0) {
    throw new Error('invalid_remote_desktop_privacy_epoch');
  }
  return { epochId: value.epochId, revision: value.revision };
}

function decodeGuestReady(value: unknown, browserKey: RemoteDesktopBrowserKeyPair): RemoteDesktopGuestProofResult {
  if (!isRecord(value)) return { status: 'unavailable' };
  if (value.status === 'rate_limited') return { status: 'rate_limited' };
  // Link proof normalizes success as status=ready, while the current password
  // proof route returns the underlying ProofSuccess discriminant (ok=true).
  if (value.status !== 'ready' && value.ok !== true) return { status: 'unavailable' };
  if (typeof value.hostId !== 'string'
    || typeof value.serverId !== 'string'
    || typeof value.bootstrapTicket !== 'string'
    || typeof value.expiresAt !== 'number'
    || (value.mode !== REMOTE_DESKTOP_ACCESS_MODE.VIEW && value.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL)
    || typeof value.source !== 'string') return { status: 'unavailable' };
  return {
    status: 'ready',
    hostId: value.hostId,
    serverId: value.serverId,
    bootstrapTicket: value.bootstrapTicket,
    expiresAt: value.expiresAt,
    mode: value.mode,
    source: value.source as RemoteDesktopActorSource,
    browserKey,
  };
}

function stepUpToken(grant: RemoteDesktopStepUpGrant): string {
  const token = grant.stepUpGrant ?? grant.token ?? grant.grantId;
  if (typeof token !== 'string' || token.length === 0) throw new Error('invalid_step_up_grant');
  return token;
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function arrayBufferToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function normalizeCredentialOptions(value: unknown): PublicKeyCredentialRequestOptions & { challengeId?: string } {
  if (!isRecord(value)) throw new Error('invalid_step_up_challenge');
  const { challengeId, actionDigest: _actionDigest, deadline: _deadline, ...publicKeyOptions } = value;
  const options = { ...publicKeyOptions } as unknown as PublicKeyCredentialRequestOptions & { challengeId?: string };
  if (typeof (value as { challenge?: unknown }).challenge === 'string') {
    options.challenge = base64UrlToArrayBuffer((value as { challenge: string }).challenge);
  }
  if (Array.isArray(value.allowCredentials)) {
    options.allowCredentials = value.allowCredentials.map((credential) => {
      if (!isRecord(credential)) return credential as PublicKeyCredentialDescriptor;
      return {
        ...credential,
        id: typeof credential.id === 'string' ? base64UrlToArrayBuffer(credential.id) : credential.id,
      } as PublicKeyCredentialDescriptor;
    });
  }
  if (typeof challengeId === 'string') options.challengeId = challengeId;
  return options;
}

export function credentialToJson(credential: Credential): unknown {
  const maybe = credential as unknown as { toJSON?: () => unknown };
  if (typeof maybe.toJSON === 'function') return maybe.toJSON();
  const pub = credential as PublicKeyCredential;
  const response = pub.response as AuthenticatorAssertionResponse;
  return {
    id: pub.id,
    type: pub.type,
    rawId: pub.rawId instanceof ArrayBuffer ? arrayBufferToBase64Url(pub.rawId) : pub.rawId,
    response: {
      authenticatorData: response.authenticatorData instanceof ArrayBuffer ? arrayBufferToBase64Url(response.authenticatorData) : response.authenticatorData,
      clientDataJSON: response.clientDataJSON instanceof ArrayBuffer ? arrayBufferToBase64Url(response.clientDataJSON) : response.clientDataJSON,
      signature: response.signature instanceof ArrayBuffer ? arrayBufferToBase64Url(response.signature) : response.signature,
      userHandle: response.userHandle instanceof ArrayBuffer ? arrayBufferToBase64Url(response.userHandle) : response.userHandle,
    },
  };
}

export function createRemoteDesktopAccessApi(): RemoteDesktopAccessApi {
  return {
    async loadHost(hostId) {
      return decodeHost(await apiFetch(`/api/remote-desktop/guest/host?hostId=${encodeURIComponent(hostId)}`));
    },
    async rotateHost(input) {
      return decodeHost(await apiFetch('/api/remote-desktop/guest/host/rotate', {
        method: 'POST',
        body: JSON.stringify(input),
      }));
    },
    async listLinks(hostId) {
      return decodeLinks(await apiFetch(`/api/remote-desktop/guest/links?hostId=${encodeURIComponent(hostId)}`));
    },
    async createLink(input) {
      const prepared = input.prepared ?? await prepareRemoteDesktopLink({
        hostId: input.hostId ?? '',
        kind: input.kind ?? REMOTE_DESKTOP_LINK_KIND.ATTENDED,
        mode: input.mode ?? REMOTE_DESKTOP_ACCESS_MODE.VIEW,
        label: input.label ?? '',
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      });
      const response = await apiFetch('/api/remote-desktop/guest/links', {
        method: 'POST',
        body: JSON.stringify({ request: prepared.request, privacyEpoch: input.privacyEpoch }),
      });
      return isRecord(response) && isRecord(response.link) ? decodeLink(response.link) : decodeLink(response);
    },
    async mutateLink(input) {
      const id = input.requestId ?? requestId();
      return decodeLink(await apiFetch(`/api/remote-desktop/guest/links/${encodeURIComponent(input.linkId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          hostId: input.hostId,
          requestId: id,
          mutation: input.mutation,
          privacyEpoch: input.privacyEpoch,
          stepUpGrant: input.stepUpGrant,
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        }),
      }));
    },
    async revokeLink(input) {
      const id = input.requestId ?? requestId();
      return decodeLink(await apiFetch(`/api/remote-desktop/guest/links/${encodeURIComponent(input.linkId)}`, {
        method: 'DELETE',
        body: JSON.stringify({
          hostId: input.hostId,
          requestId: id,
          privacyEpoch: input.privacyEpoch,
          stepUpGrant: input.stepUpGrant,
        }),
      }));
    },
    mutatePassword(input) {
      const mutation = {
        hostId: input.hostId,
        action: input.action,
        requestId: input.requestId ?? requestId(),
        ...(input.action === 'disable' ? {} : { password: input.password }),
      };
      return apiFetch('/api/remote-desktop/unattended-password', {
        method: 'POST',
        body: JSON.stringify({ mutation, privacyEpoch: input.privacyEpoch, stepUpGrant: input.stepUpGrant }),
      });
    },
    beginStepUp(input) {
      return apiFetch('/api/auth/remote-desktop/step-up/begin', { method: 'POST', body: JSON.stringify(input) });
    },
    completeStepUp(input) {
      return apiFetch('/api/auth/remote-desktop/step-up/complete', { method: 'POST', body: JSON.stringify(input) }) as Promise<RemoteDesktopStepUpGrant>;
    },
    async beginPrivacy(hostId) {
      return decodePrivacyEpoch(await apiFetch('/api/remote-desktop/guest/privacy/begin', {
        method: 'POST',
        body: JSON.stringify({ hostId }),
      }));
    },
    async endPrivacy(hostId, privacy) {
      await apiFetch('/api/remote-desktop/guest/privacy/end', {
        method: 'POST',
        body: JSON.stringify({ hostId, ...privacy }),
      });
    },
    async resolveInvite(input) {
      return resolveRemoteDesktopInviteProof(input);
    },
    async provePassword(input) {
      return proveRemoteDesktopPublicPassword({
        publicNodeId: input.publicNodeId,
        password: input.password,
        browserKey: input.browserKey,
      });
    },
  };
}

export async function runRemoteDesktopStepUp(api: Pick<RemoteDesktopAccessApi, 'beginStepUp' | 'completeStepUp'>, input: StepUpBeginInput): Promise<string> {
  const rawOptions = await api.beginStepUp({ ...input, deadline: input.deadline ?? Date.now() + 60_000 });
  const options = normalizeCredentialOptions(rawOptions);
  const challengeId = options.challengeId;
  delete options.challengeId;
  if (typeof navigator.credentials?.get !== 'function') throw new Error('passkey_unavailable');
  const credential = await navigator.credentials.get({ publicKey: options });
  if (!credential) throw new Error('step_up_cancelled');
  const grant = await api.completeStepUp({ challengeId: String(challengeId ?? ''), response: credentialToJson(credential) });
  return stepUpToken(grant);
}


export async function resolveRemoteDesktopInviteProof(input: {
  token: string;
  browserKey: RemoteDesktopBrowserKeyPair;
  fetchImpl?: typeof fetch;
}): Promise<RemoteDesktopGuestProofResult> {
  const request = input.fetchImpl ?? fetch;
  const requestInit = (body: unknown): RequestInit => ({
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const challengeResponse = await request('/api/remote-desktop/guest/challenge', requestInit({ token: input.token })).catch(() => null);
  if (!challengeResponse?.ok) return { status: 'unavailable' };
  const challenge = await challengeResponse.json().catch(() => null);
  if (!isRecord(challenge)
    || challenge.keyAlgorithm !== REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM
    || typeof challenge.challengeId !== 'string'
    || typeof challenge.challenge !== 'string') return { status: 'unavailable' };
  const signature = await signRemoteDesktopClaim({
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    browserKeyThumbprint: input.browserKey.thumbprint,
    privateKey: input.browserKey.privateKey,
  });
  const resolveResponse = await request('/api/remote-desktop/guest/resolve', requestInit(remoteDesktopClaimProofBody({
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    browserKey: input.browserKey,
    signature,
  }))).catch(() => null);
  if (!resolveResponse?.ok) return { status: 'unavailable' };
  return decodeGuestReady(await resolveResponse.json().catch(() => null), input.browserKey);
}

export async function createRemoteDesktopBootstrapProof(ready: RemoteDesktopGuestReady): Promise<{ ticket: string; browserKeyThumbprint: string; signature: string }> {
  return {
    ticket: ready.bootstrapTicket,
    browserKeyThumbprint: ready.browserKey.thumbprint,
    signature: await signRemoteDesktopBootstrap({
      ticket: ready.bootstrapTicket,
      browserKeyThumbprint: ready.browserKey.thumbprint,
      privateKey: ready.browserKey.privateKey,
    }),
  };
}

export async function proveRemoteDesktopPublicPassword(input: {
  publicNodeId: number;
  password: string;
  browserKey?: RemoteDesktopBrowserKeyPair;
  fetchImpl?: typeof fetch;
}): Promise<RemoteDesktopGuestProofResult> {
  const browserKey = input.browserKey ?? await generateRemoteDesktopBrowserKeyPair();
  const request = input.fetchImpl ?? fetch;
  const response = await request('/api/remote-desktop/unattended-password/proof', {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicNodeId: input.publicNodeId,
      password: input.password,
      browserPublicKeySpki: browserKey.publicKeySpki,
      browserKeyThumbprint: browserKey.thumbprint,
    }),
  }).catch(() => null);
  if (!response) return { status: 'unavailable' };
  if (response.status === 429) return { status: 'rate_limited' };
  if (!response.ok) return { status: 'unavailable' };
  return decodeGuestReady(await response.json().catch(() => null), browserKey);
}

export function remoteDesktopClaimProofBody(input: {
  challengeId: string;
  challenge: string;
  browserKey: RemoteDesktopBrowserKeyPair;
  signature: string;
}): Record<string, string> {
  return {
    keyAlgorithm: REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM,
    challengeId: input.challengeId,
    challenge: input.challenge,
    browserPublicKeySpki: input.browserKey.publicKeySpki,
    browserKeyThumbprint: input.browserKey.thumbprint,
    signature: input.signature,
  };
}

export function mapRemoteDesktopApiError(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.body) as { error?: unknown };
      if (typeof body.error === 'string') return body.error;
    } catch { /* ignore */ }
    return `http_${error.status}`;
  }
  return error instanceof Error ? error.message : 'unknown_error';
}
