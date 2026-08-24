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

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export async function sha256RemoteDesktopLinkPolicy(input: {
  hostId: string;
  kind: string;
  mode: string;
  durationMs?: number;
  label: string;
}): Promise<string> {
  const domain = new TextEncoder().encode('imcodes.remote-desktop.link-policy.v1');
  const policy = new TextEncoder().encode(JSON.stringify([
    input.hostId,
    input.kind,
    input.mode,
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
