import { describe, expect, it, vi } from 'vitest';

import {
  parseArguments,
  resolveLibwebrtcSdkLock,
} from '../../scripts/resolve-libwebrtc-sdk-release.mjs';

const options = {
  lockPath: '/tmp/libwebrtc-sdk.lock.json',
  lockRepositoryPath: 'native/windows-remote-desktop/libwebrtc-sdk.lock.json',
  waitSeconds: 10,
  branch: 'dev',
};

describe('fixed libwebrtc SDK lock bootstrap', () => {
  it('allows the bounded first producer window but rejects an unbounded wait', async () => {
    expect(parseArguments(['--wait-seconds', '15000']).waitSeconds).toBe(15_000);
    expect(() => parseArguments(['--wait-seconds', '18001']))
      .toThrow('--wait-seconds must not exceed 18000');
  });

  it('waits for a matching remote lock and verifies the written lock before returning', async () => {
    const lock = { sourceSha256: 'a'.repeat(64) };
    let verified = 0;
    const verifyLocalLock = vi.fn(async () => {
      verified += 1;
      if (verified === 1) throw new Error('missing local lock');
      return lock;
    });
    const writeResolvedLock = vi.fn(async () => {});
    const fetchRemoteLock = vi.fn(async () => lock);

    await expect(resolveLibwebrtcSdkLock(options, {
      verifyLocalLock,
      computeSourceSha256: async () => 'a'.repeat(64),
      fetchRemoteLock,
      writeResolvedLock,
      now: () => 0,
      delay: async () => {},
    })).resolves.toBe(lock);

    expect(fetchRemoteLock).toHaveBeenCalledWith(
      'dev',
      'native/windows-remote-desktop/libwebrtc-sdk.lock.json',
      'a'.repeat(64),
    );
    expect(writeResolvedLock).toHaveBeenCalledWith(options.lockPath, lock);
    expect(verifyLocalLock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch when the local lock is already valid', async () => {
    const lock = { sourceSha256: 'b'.repeat(64) };
    const fetchRemoteLock = vi.fn();

    await expect(resolveLibwebrtcSdkLock(options, {
      verifyLocalLock: async () => lock,
      fetchRemoteLock,
    })).resolves.toBe(lock);
    expect(fetchRemoteLock).not.toHaveBeenCalled();
  });

  it('fails without waiting when waiting was not explicitly requested', async () => {
    await expect(resolveLibwebrtcSdkLock({ ...options, waitSeconds: 0 }, {
      verifyLocalLock: async () => { throw new Error('missing local lock'); },
      fetchRemoteLock: vi.fn(),
    })).rejects.toThrow('missing local lock');
  });
});
