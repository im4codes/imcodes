import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_SYNC_MSG,
} from '../../shared/capability-management.js';
import { signJwt } from '../src/security/crypto.js';
import type { Database } from '../src/db/client.js';
import { consumeCapabilityBlobAccess } from '../src/services/capability-package-storage.js';

describe('capability package access', () => {
  it('binds a signed capability to owner/server/version/action and consumes its JTI once', async () => {
    const signingKey = 'capability-package-test-key';
    let consumed = false;
    const db = {
      queryOne: async () => {
        if (consumed) return null;
        consumed = true;
        return { jti: 'one-use-capability-jti' };
      },
    } as unknown as Database;
    const token = signJwt({
      type: CAPABILITY_SYNC_MSG.BLOB_CAPABILITY,
      jti: 'one-use-capability-jti',
      sub: 'owner-1',
      serverId: 'server-1',
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
      capabilityId: 'capability-1',
      versionId: 'version-1',
      blobDigest: 'a'.repeat(64),
      objectKey: `capability-packages/${'b'.repeat(32)}/${'a'.repeat(64)}`,
      maxBytes: 128,
    }, signingKey, 300);

    await expect(consumeCapabilityBlobAccess(db, token, signingKey, {
      ownerUserId: 'owner-2',
      serverId: 'server-1',
      versionId: 'version-1',
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
    })).resolves.toBeNull();
    expect(consumed).toBe(false);
    await expect(consumeCapabilityBlobAccess(db, token, signingKey, {
      ownerUserId: 'owner-1',
      serverId: 'server-1',
      versionId: 'version-1',
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
    })).resolves.toMatchObject({
      sub: 'owner-1',
      serverId: 'server-1',
      capabilityId: 'capability-1',
      versionId: 'version-1',
      blobDigest: 'a'.repeat(64),
    });
    await expect(consumeCapabilityBlobAccess(db, token, signingKey, {
      ownerUserId: 'owner-1',
      serverId: 'server-1',
      versionId: 'version-1',
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
    })).resolves.toBeNull();
  });
});
