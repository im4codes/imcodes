import { createHash, randomUUID } from 'node:crypto';
import {
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_LIMITS,
  CAPABILITY_SYNC_MSG,
  type CapabilityBlobAccess,
  type CapabilityBlobAction,
} from '../../../shared/capability-management.js';
import {
  consumeCapabilityBlobToken,
  getCapabilityBlob,
  getCapabilityVersionBlobMetadata,
  recordCapabilityBlobToken,
  registerCapabilityBlob,
  storeCapabilityBlobBytes,
} from '../db/capabilities.js';
import type { Database } from '../db/client.js';
import { signJwt, verifyJwt } from '../security/crypto.js';

const CAPABILITY_BLOB_TOKEN_TTL_SECONDS = 5 * 60;

export interface CapabilityObjectStore {
  put(objectKey: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<void>;
  get(objectKey: string, maxBytes: number): Promise<ReadableStream<Uint8Array> | null>;
  delete(objectKey: string): Promise<void>;
}

interface CapabilityBlobClaims {
  type: typeof CAPABILITY_SYNC_MSG.BLOB_CAPABILITY;
  jti: string;
  sub: string;
  serverId: string;
  action: CapabilityBlobAction;
  capabilityId: string;
  versionId: string;
  blobDigest: string;
  objectKey: string;
  maxBytes: number;
  exp: number;
}

export async function issueCapabilityBlobAccess(
  db: Database,
  params: {
    ownerUserId: string;
    serverId: string;
    capabilityId: string;
    versionId: string;
    action: CapabilityBlobAction;
    signingKey: string;
    now?: number;
  },
): Promise<CapabilityBlobAccess | null> {
  if (!Object.values(CAPABILITY_BLOB_ACTION).includes(params.action)) return null;
  const metadata = await getCapabilityVersionBlobMetadata(db, params);
  if (!metadata) return null;
  const record = params.action === CAPABILITY_BLOB_ACTION.UPLOAD
    ? await registerCapabilityBlob(db, {
      ownerUserId: params.ownerUserId,
      digest: metadata.blobDigest,
      byteSize: metadata.blobByteSize,
      now: params.now,
    })
    : await getCapabilityBlob(db, {
      ownerUserId: params.ownerUserId,
      digest: metadata.blobDigest,
    });
  if (!record
    || (params.action === CAPABILITY_BLOB_ACTION.UPLOAD && record.state === 'ready')
    || (params.action === CAPABILITY_BLOB_ACTION.DOWNLOAD && record.state !== 'ready')) return null;
  const expiresAt = (params.now ?? Date.now()) + CAPABILITY_BLOB_TOKEN_TTL_SECONDS * 1000;
  const jti = randomUUID();
  const singleUseToken = signJwt({
    type: CAPABILITY_SYNC_MSG.BLOB_CAPABILITY,
    jti,
    sub: params.ownerUserId,
    serverId: params.serverId,
    action: params.action,
    capabilityId: params.capabilityId,
    versionId: params.versionId,
    blobDigest: metadata.blobDigest,
    objectKey: record.objectKey,
    maxBytes: metadata.blobByteSize,
  }, params.signingKey, CAPABILITY_BLOB_TOKEN_TTL_SECONDS);
  const recorded = await recordCapabilityBlobToken(db, {
    jti,
    ownerUserId: params.ownerUserId,
    serverId: params.serverId,
    capabilityId: params.capabilityId,
    versionId: params.versionId,
    action: params.action,
    blobDigest: metadata.blobDigest,
    expiresAt,
    now: params.now,
  });
  if (!recorded) return null;
  return {
    action: params.action,
    capabilityId: params.capabilityId,
    versionId: params.versionId,
    blobDigest: metadata.blobDigest,
    maxBytes: metadata.blobByteSize,
    expiresAt,
    singleUseToken,
  };
}

export async function consumeCapabilityBlobAccess(
  db: Database,
  token: string,
  signingKey: string,
  expected: {
    ownerUserId: string;
    serverId: string;
    capabilityId?: string;
    versionId: string;
    action: CapabilityBlobAction;
  },
): Promise<CapabilityBlobClaims | null> {
  const claims = verifyJwt(token, signingKey);
  if (!claims
    || claims.type !== CAPABILITY_SYNC_MSG.BLOB_CAPABILITY
    || claims.sub !== expected.ownerUserId
    || claims.serverId !== expected.serverId
    || (expected.capabilityId !== undefined && claims.capabilityId !== expected.capabilityId)
    || claims.versionId !== expected.versionId
    || claims.action !== expected.action
    || typeof claims.jti !== 'string'
    || typeof claims.blobDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(claims.blobDigest)
    || typeof claims.objectKey !== 'string'
    || !claims.objectKey.startsWith('capability-packages/')
    || typeof claims.maxBytes !== 'number'
    || !Number.isSafeInteger(claims.maxBytes)
    || claims.maxBytes < 0
    || claims.maxBytes > CAPABILITY_LIMITS.PACKAGE_BYTES
    || typeof claims.exp !== 'number') return null;
  const typed = claims as unknown as CapabilityBlobClaims;
  const consumed = await consumeCapabilityBlobToken(db, {
    jti: typed.jti,
    ownerUserId: expected.ownerUserId,
    serverId: expected.serverId,
    capabilityId: typed.capabilityId,
    versionId: expected.versionId,
    action: expected.action,
    blobDigest: typed.blobDigest,
  });
  return consumed ? typed : null;
}

export async function persistCapabilityBlobUpload(
  db: Database,
  claims: CapabilityBlobClaims,
  content: Buffer,
): Promise<{
  stored: boolean;
  accountRevision: number;
  authorizationOperationIds: string[];
} | null> {
  if (content.byteLength !== claims.maxBytes
    || createHash('sha256').update(content).digest('hex') !== claims.blobDigest) return null;
  return storeCapabilityBlobBytes(db, {
    ownerUserId: claims.sub,
    digest: claims.blobDigest,
    byteSize: claims.maxBytes,
    content,
  });
}

export async function readCapabilityBlobDownload(
  db: Database,
  claims: CapabilityBlobClaims,
): Promise<Buffer | null> {
  const record = await getCapabilityBlob(db, {
    ownerUserId: claims.sub,
    digest: claims.blobDigest,
  });
  if (!record || record.state !== 'ready' || !record.content
    || record.byteSize !== claims.maxBytes
    || record.content.byteLength !== claims.maxBytes
    || createHash('sha256').update(record.content).digest('hex') !== claims.blobDigest) return null;
  return record.content;
}
