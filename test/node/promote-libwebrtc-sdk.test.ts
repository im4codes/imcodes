import { describe, expect, it, vi } from 'vitest';

import {
  parsePromotionArguments,
  promoteLibwebrtcSdk,
} from '../../scripts/promote-libwebrtc-sdk.mjs';

const sourceSha256 = 'a'.repeat(64);
const builtCommit = 'b'.repeat(40);
const lock = {
  sourceSha256,
  sourceCommit: builtCommit,
  releaseTag: `libwebrtc-sdk-windows-x64-${sourceSha256.slice(0, 16)}-${'c'.repeat(16)}`,
  repository: 'im4codes/imcodes',
  assetName: 'imcodes-libwebrtc-sdk-windows-x64.zip',
  libwebrtcRevision: 'd'.repeat(40),
};
const options = {
  lockPath: '/build/libwebrtc-sdk.lock.json',
  archivePath: '/build/imcodes-libwebrtc-sdk-windows-x64.zip',
  builtCommit,
  branch: 'dev',
};

function fixture(overrides: Record<string, unknown> = {}) {
  let temporaryId = 0;
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const run = vi.fn((command: string, args: string[], runOptions: { cwd?: string } = {}) => {
    calls.push({ command, args, cwd: runOptions.cwd });
    if (command === process.execPath && args.at(-1) === 'fingerprint') return sourceSha256;
    return '';
  });
  const dependencies = {
    run,
    verifyLock: vi.fn(async () => lock),
    makeTempDirectory: vi.fn(async (prefix: string) => `${prefix}${temporaryId += 1}`),
    remove: vi.fn(async () => {}),
    readText: vi.fn(async (path: string) => (path === options.lockPath ? 'next-lock\n' : '')),
    makeDirectory: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    temporaryRoot: '/tmp',
    repositoryRoot: '/repo',
    ...overrides,
  };
  return { calls, dependencies, run };
}

describe('fixed libwebrtc SDK promotion', () => {
  it('validates commit and branch arguments before promotion', () => {
    expect(parsePromotionArguments(['lock', 'archive', builtCommit, 'release/sdk'])).toMatchObject({
      builtCommit,
      branch: 'release/sdk',
    });
    expect(() => parsePromotionArguments(['lock', 'archive', 'short'])).toThrow('usage');
    expect(() => parsePromotionArguments(['lock', 'archive', builtCommit, '../dev']))
      .toThrow('invalid SDK promotion branch');
  });

  it('rejects a lock produced by a different workflow commit', async () => {
    const { dependencies, run } = fixture({
      verifyLock: vi.fn(async () => ({ ...lock, sourceCommit: 'e'.repeat(40) })),
    });
    await expect(promoteLibwebrtcSdk(options, dependencies)).rejects
      .toThrow('SDK lock commit does not match');
    expect(run).not.toHaveBeenCalled();
  });

  it('re-verifies an existing immutable release and no-ops an identical lock', async () => {
    const { dependencies, calls } = fixture({
      readText: vi.fn(async () => 'same-lock\n'),
    });
    await expect(promoteLibwebrtcSdk(options, dependencies)).resolves.toMatchObject({
      releaseTag: lock.releaseTag,
    });
    expect(calls.some(({ args }) => args[0] === 'release' && args[1] === 'view')).toBe(true);
    expect(calls.some(({ args }) => args[0] === 'release' && args[1] === 'download')).toBe(true);
    expect(calls.some(({ args }) => args.includes('commit'))).toBe(false);
    expect(calls.some(({ args }) => args[0] === 'push')).toBe(false);
    expect(dependencies.verifyLock).toHaveBeenCalledTimes(2);
  });

  it('accepts only a verified release-race winner and rejects new input drift', async () => {
    const { dependencies, calls, run } = fixture();
    run.mockImplementation((command: string, args: string[], runOptions: { cwd?: string } = {}) => {
      calls.push({ command, args, cwd: runOptions.cwd });
      if (command === 'gh' && args[1] === 'view') throw new Error('not found');
      if (command === 'gh' && args[1] === 'create') throw new Error('race');
      if (command === process.execPath && args.at(-1) === 'fingerprint') {
        return runOptions.cwd === '/repo' ? sourceSha256 : 'f'.repeat(64);
      }
      return '';
    });
    await expect(promoteLibwebrtcSdk(options, dependencies)).rejects
      .toThrow('SDK inputs changed while the SDK was building');
    expect(calls.some(({ args }) => args[0] === 'release' && args[1] === 'download')).toBe(true);
    expect(dependencies.verifyLock).toHaveBeenCalledTimes(2);
    expect(calls.some(({ args }) => args[0] === 'push')).toBe(false);
  });

  it('rebuilds a fresh worktree and retries a raced branch push', async () => {
    const { dependencies, calls, run } = fixture();
    let pushAttempts = 0;
    run.mockImplementation((command: string, args: string[], runOptions: { cwd?: string } = {}) => {
      calls.push({ command, args, cwd: runOptions.cwd });
      if (command === 'gh' && args[1] === 'view') throw new Error('not found');
      if (command === process.execPath && args.at(-1) === 'fingerprint') return sourceSha256;
      if (command === 'git' && args[0] === 'push' && (pushAttempts += 1) === 1) {
        throw new Error('non-fast-forward');
      }
      return '';
    });
    await expect(promoteLibwebrtcSdk(options, dependencies)).resolves.toMatchObject({
      archiveName: 'imcodes-libwebrtc-sdk-windows-x64.zip',
    });
    expect(pushAttempts).toBe(2);
    expect(calls.filter(({ args }) => args.includes('commit'))).toHaveLength(2);
    expect(calls.filter(({ args }) => args[0] === 'worktree' && args[1] === 'add')).toHaveLength(2);
  });

  it('fails closed after the bounded fifth branch-push race', async () => {
    const { dependencies, calls, run } = fixture();
    run.mockImplementation((command: string, args: string[], runOptions: { cwd?: string } = {}) => {
      calls.push({ command, args, cwd: runOptions.cwd });
      if (command === 'gh' && args[1] === 'view') throw new Error('not found');
      if (command === process.execPath && args.at(-1) === 'fingerprint') return sourceSha256;
      if (command === 'git' && args[0] === 'push') throw new Error('non-fast-forward');
      return '';
    });
    await expect(promoteLibwebrtcSdk(options, dependencies)).rejects.toThrow('non-fast-forward');
    expect(calls.filter(({ args }) => args[0] === 'push')).toHaveLength(5);
    expect(calls.filter(({ args }) => args[0] === 'worktree' && args[1] === 'add')).toHaveLength(5);
  });
});
