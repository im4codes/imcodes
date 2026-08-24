import {
  REMOTE_DESKTOP_BOOTSTRAP_PROOF,
  REMOTE_DESKTOP_BROWSER_CLAIM,
  REMOTE_DESKTOP_LINK_TOKEN,
  remoteDesktopBootstrapSignaturePreimage,
  remoteDesktopBrowserClaimSignaturePreimage,
  remoteDesktopLinkTokenHashPreimage,
} from '@shared/remote-desktop-access.js';

export interface RemoteDesktopBrowserKeyPair {
  publicKeySpki: string;
  thumbprint: string;
  privateKey: CryptoKey;
}

export interface PersistedRemoteDesktopInviteBinding {
  tokenHash: string;
  token: string;
  browserKey: RemoteDesktopBrowserKeyPair;
}

export const REMOTE_DESKTOP_INVITE_HISTORY_STATE_KEY = 'remoteDesktopInviteTokenHash';
const REMOTE_DESKTOP_INVITE_KEY_DB = 'imcodes-remote-desktop-invite-keys-v1';
const REMOTE_DESKTOP_INVITE_KEY_STORE = 'invite-keys';

interface StoredRemoteDesktopInviteKey {
  tokenHash: string;
  publicKeySpki: string;
  thumbprint: string;
  privateKey: CryptoKey;
  tokenEncryptionKey: CryptoKey;
  tokenIv: Uint8Array;
  tokenCiphertext: ArrayBuffer;
  updatedAt: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBuffer(bytes)));
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('remote_desktop_invite_key_storage_failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('remote_desktop_invite_key_storage_failed'));
    transaction.onerror = () => reject(transaction.error ?? new Error('remote_desktop_invite_key_storage_failed'));
  });
}

function openInviteKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REMOTE_DESKTOP_INVITE_KEY_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(REMOTE_DESKTOP_INVITE_KEY_STORE)) {
        request.result.createObjectStore(REMOTE_DESKTOP_INVITE_KEY_STORE, { keyPath: 'tokenHash' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('remote_desktop_invite_key_storage_failed'));
  });
}

function isUint8ArrayValue(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function isArrayBufferValue(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function isStoredInviteKey(value: unknown, tokenHash: string): value is StoredRemoteDesktopInviteKey {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredRemoteDesktopInviteKey>;
  const algorithm = record.privateKey?.algorithm as EcKeyAlgorithm | undefined;
  const encryptionAlgorithm = record.tokenEncryptionKey?.algorithm;
  return record.tokenHash === tokenHash
    && typeof record.publicKeySpki === 'string'
    && typeof record.thumbprint === 'string'
    && record.privateKey instanceof CryptoKey
    && record.privateKey.type === 'private'
    && record.privateKey.extractable === false
    && algorithm?.name === 'ECDSA'
    && algorithm.namedCurve === 'P-256'
    && record.privateKey.usages.length === 1
    && record.privateKey.usages[0] === 'sign'
    && record.tokenEncryptionKey instanceof CryptoKey
    && record.tokenEncryptionKey.type === 'secret'
    && record.tokenEncryptionKey.extractable === false
    && encryptionAlgorithm?.name === 'AES-GCM'
    && record.tokenEncryptionKey.usages.length === 2
    && record.tokenEncryptionKey.usages.includes('encrypt')
    && record.tokenEncryptionKey.usages.includes('decrypt')
    && isUint8ArrayValue(record.tokenIv)
    && record.tokenIv.byteLength === 12
    && isArrayBufferValue(record.tokenCiphertext);
}

async function encryptInviteToken(token: string): Promise<{
  tokenEncryptionKey: CryptoKey;
  tokenIv: Uint8Array;
  tokenCiphertext: ArrayBuffer;
}> {
  const tokenEncryptionKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const tokenIv = crypto.getRandomValues(new Uint8Array(12));
  const tokenCiphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: tokenIv },
    tokenEncryptionKey,
    new TextEncoder().encode(token),
  );
  return { tokenEncryptionKey, tokenIv, tokenCiphertext };
}

async function decryptInviteToken(stored: StoredRemoteDesktopInviteKey): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ownedBuffer(stored.tokenIv) },
    stored.tokenEncryptionKey,
    stored.tokenCiphertext,
  );
  const token = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  if (await hashRemoteDesktopInviteToken(token) !== stored.tokenHash) {
    throw new Error('remote_desktop_invite_key_storage_failed');
  }
  return token;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export async function sha256RemoteDesktopLinkPolicy(input: {
  hostId: string;
  kind: string;
  mode: string;
  usePolicy: string;
  durationMs?: number;
  label: string;
}): Promise<string> {
  const domain = new TextEncoder().encode('imcodes.remote-desktop.link-policy.v1');
  const policy = new TextEncoder().encode(JSON.stringify([
    input.hostId,
    input.kind,
    input.mode,
    input.usePolicy,
    input.durationMs ?? null,
    input.label,
  ]));
  const preimage = new Uint8Array(domain.length + 1 + policy.length);
  preimage.set(domain);
  preimage[domain.length] = 0;
  preimage.set(policy, domain.length + 1);
  const digest = await sha256(preimage);
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function generateRemoteDesktopRawInvite(): Promise<{ token: string; tokenHash: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(REMOTE_DESKTOP_LINK_TOKEN.RAW_BYTES));
  const digest = await sha256(remoteDesktopLinkTokenHashPreimage(raw));
  return {
    token: bytesToBase64Url(raw),
    tokenHash: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

export async function hashRemoteDesktopInviteToken(token: string): Promise<string> {
  const raw = base64UrlToBytes(token);
  if (raw.byteLength !== REMOTE_DESKTOP_LINK_TOKEN.RAW_BYTES) {
    throw new Error('remote_desktop_link_token_length');
  }
  const digest = await sha256(remoteDesktopLinkTokenHashPreimage(raw));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function remoteDesktopInviteFragment(token: string): string {
  return `#${REMOTE_DESKTOP_LINK_TOKEN.FRAGMENT_KEY}=${REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION}.${token}`;
}

export function remoteDesktopInviteUrl(token: string, base = window.location.origin): string {
  const url = new URL('/', base);
  url.hash = remoteDesktopInviteFragment(token).slice(1);
  return url.toString();
}

export async function generateRemoteDesktopBrowserKeyPair(): Promise<RemoteDesktopBrowserKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const thumbprint = bytesToBase64Url(await sha256(spki));
  return {
    publicKeySpki: bytesToBase64Url(spki),
    thumbprint,
    privateKey: pair.privateKey,
  };
}

/**
 * Keep the bearer only as AES-GCM ciphertext under a non-exportable browser
 * key, alongside a non-exportable P-256 claim key and a hash used solely as
 * the local IndexedDB lookup key. The Server never accepts that hash as a
 * bearer. Reopening the same link can decrypt the original bearer locally;
 * another browser gets an independent claim key and is accepted only by a
 * reusable link.
 */
export async function getOrCreateRemoteDesktopInviteBinding(
  token: string,
): Promise<PersistedRemoteDesktopInviteBinding> {
  const tokenHash = await hashRemoteDesktopInviteToken(token);
  const database = await openInviteKeyDatabase();
  try {
    const candidate = await generateRemoteDesktopBrowserKeyPair();
    const encryptedToken = await encryptInviteToken(token);
    const transaction = database.transaction(REMOTE_DESKTOP_INVITE_KEY_STORE, 'readwrite');
    const store = transaction.objectStore(REMOTE_DESKTOP_INVITE_KEY_STORE);
    const existing = await requestResult(store.get(tokenHash));
    if (isStoredInviteKey(existing, tokenHash)) {
      await transactionDone(transaction);
      return {
        tokenHash,
        token: await decryptInviteToken(existing),
        browserKey: {
          publicKeySpki: existing.publicKeySpki,
          thumbprint: existing.thumbprint,
          privateKey: existing.privateKey,
        },
      };
    }
    if (existing !== undefined) store.delete(tokenHash);
    store.put({
      tokenHash,
      ...candidate,
      ...encryptedToken,
      updatedAt: Date.now(),
    } satisfies StoredRemoteDesktopInviteKey);
    await transactionDone(transaction);
    return { tokenHash, token, browserKey: candidate };
  } finally {
    database.close();
  }
}

export async function loadRemoteDesktopInviteBinding(
  tokenHash: string,
): Promise<PersistedRemoteDesktopInviteBinding | null> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  const database = await openInviteKeyDatabase();
  try {
    const transaction = database.transaction(REMOTE_DESKTOP_INVITE_KEY_STORE, 'readonly');
    const stored = await requestResult(transaction.objectStore(REMOTE_DESKTOP_INVITE_KEY_STORE).get(tokenHash));
    await transactionDone(transaction);
    if (!isStoredInviteKey(stored, tokenHash)) return null;
    return {
      tokenHash,
      token: await decryptInviteToken(stored),
      browserKey: {
        publicKeySpki: stored.publicKeySpki,
        thumbprint: stored.thumbprint,
        privateKey: stored.privateKey,
      },
    };
  } finally {
    database.close();
  }
}

export async function signRemoteDesktopClaim(input: {
  challengeId: string;
  challenge: string;
  browserKeyThumbprint: string;
  privateKey: CryptoKey;
}): Promise<string> {
  const preimage = remoteDesktopBrowserClaimSignaturePreimage(
    base64UrlToBytes(input.challengeId),
    base64UrlToBytes(input.challenge),
    base64UrlToBytes(input.browserKeyThumbprint),
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    input.privateKey,
    ownedBuffer(preimage),
  ));
  return bytesToBase64Url(signature);
}

export async function signRemoteDesktopBootstrap(input: {
  ticket: string;
  browserKeyThumbprint: string;
  privateKey: CryptoKey;
}): Promise<string> {
  const preimage = remoteDesktopBootstrapSignaturePreimage(
    base64UrlToBytes(input.ticket),
    base64UrlToBytes(input.browserKeyThumbprint),
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    input.privateKey,
    ownedBuffer(preimage),
  ));
  return bytesToBase64Url(signature);
}

export function isRemoteDesktopBrowserKeyNonExportable(key: CryptoKey): boolean {
  return key.extractable === false;
}

export const REMOTE_DESKTOP_BROWSER_KEY_EXPORT_LENGTHS = {
  publicSpki: REMOTE_DESKTOP_BROWSER_CLAIM.PUBLIC_KEY_SPKI_ENCODED_LENGTH,
  thumbprint: REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_ENCODED_LENGTH,
  bootstrapSignature: REMOTE_DESKTOP_BOOTSTRAP_PROOF.SIGNATURE_ENCODED_LENGTH,
} as const;
