import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  listDirectoryViaMacosApp,
  readMacosFsDelegateCapabilityFromInfoPlist,
  resetMacosFsDelegateClientForTests,
  type MacosFsDelegateClientDeps,
} from '../../src/node/macos-fs-delegate-client.js';
import {
  MACOS_FS_DELEGATE_ANSWER_MAGIC,
  MACOS_FS_DELEGATE_INFO_PLIST_OPS_KEY,
  MACOS_FS_DELEGATE_INFO_PLIST_VERSION_KEY,
  MACOS_FS_DELEGATE_LIMITS,
  MACOS_FS_DELEGATE_REASON,
  MACOS_FS_DELEGATE_REQUEST_FLAG,
  hexEncodeUtf8,
  parseMacosFsDelegateAnswer,
} from '../../shared/macos-fs-delegate.js';

const uid = process.getuid?.() ?? 0;
const user = { name: 'tester', uid: 501, gid: 20, home: '/Users/tester', tempDir: '/var/folders/x/T/' };
const APP = '/Applications/Fake aiDesk.app';
const NOW = 1_800_000_000_000;

const plistWith = (version: number | null, ops: string | null): string => [
  '<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0">', '<dict>',
  '  <key>CFBundleIdentifier</key>', '  <string>to.aidesk.app</string>',
  ...(version === null ? [] : [`  <key>${MACOS_FS_DELEGATE_INFO_PLIST_VERSION_KEY}</key>`, `  <integer>${version}</integer>`]),
  ...(ops === null ? [] : [`  <key>${MACOS_FS_DELEGATE_INFO_PLIST_OPS_KEY}</key>`, `  <string>${ops}</string>`]),
  '</dict>', '</plist>',
].join('\n');

const answerText = (...lines: string[]): string => `${[MACOS_FS_DELEGATE_ANSWER_MAGIC, ...lines].join('\n')}\n`;

let runtimeRoot = '';

function deps(overrides: Partial<MacosFsDelegateClientDeps> = {}): MacosFsDelegateClientDeps {
  return {
    platform: 'darwin',
    now: () => NOW,
    appPath: APP,
    runtimeRoot,
    resolveUser: async () => user,
    readInfoPlist: async () => plistWith(1, 'list'),
    runApp: async () => ({ stdout: answerText(`realpath ${hexEncodeUtf8('/Users/tester/Documents')}`, `entry d ${hexEncodeUtf8('proj')}`, `entry f ${hexEncodeUtf8('a.txt')}`, 'end 2 0') }),
    getuid: () => uid,
    randomHex: () => 'a1b2c3d4e5f60718a1b2c3d4e5f60718',
    ...overrides,
  };
}

describe('macOS fs delegate client', () => {
  beforeEach(() => {
    resetMacosFsDelegateClientForTests();
    runtimeRoot = join(mkdtempSync(join(tmpdir(), 'imcodes-fsd-client-')), 'fs-delegate');
  });
  afterEach(() => rmSync(join(runtimeRoot, '..'), { recursive: true, force: true }));

  it('reads the capability keys from the Info.plist; anything else is no capability', () => {
    expect(readMacosFsDelegateCapabilityFromInfoPlist(plistWith(1, 'list'))).toEqual(['list']);
    expect(readMacosFsDelegateCapabilityFromInfoPlist(plistWith(1, 'list read'))).toEqual(['list']); // an op this node does not know is ignored
    expect(readMacosFsDelegateCapabilityFromInfoPlist(plistWith(null, null))).toEqual([]);
    expect(readMacosFsDelegateCapabilityFromInfoPlist(plistWith(1, null))).toEqual([]);
    expect(readMacosFsDelegateCapabilityFromInfoPlist(plistWith(null, 'list'))).toEqual([]);
    expect(readMacosFsDelegateCapabilityFromInfoPlist(plistWith(0, 'list'))).toEqual([]);
    expect(readMacosFsDelegateCapabilityFromInfoPlist('bplist00\u0000\u0001binary')).toEqual([]);
  });

  it('delegates a listing: writes a root-style request, runs the app with the flag, returns the answer, and removes the request', async () => {
    const seen: Array<{ args: readonly string[]; body: string; mode: number }> = [];
    const result = await listDirectoryViaMacosApp('/Users/tester/Documents', deps({
      runApp: async ({ args }) => {
        const file = args[1]!;
        seen.push({ args, body: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 });
        return { stdout: answerText(`realpath ${hexEncodeUtf8('/Users/tester/Documents')}`, `entry d ${hexEncodeUtf8('proj')}`, 'end 1 0') };
      },
    }));
    expect(result).toEqual({ kind: 'ok', realPath: '/Users/tester/Documents', entries: [{ name: 'proj', kind: 'd' }], truncated: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args[0]).toBe(MACOS_FS_DELEGATE_REQUEST_FLAG);
    expect(seen[0]!.args[1]).toBe(join(runtimeRoot, String(user.uid), 'a1b2c3d4e5f60718a1b2c3d4e5f60718.req'));
    expect(seen[0]!.mode).toBe(0o644);
    expect(seen[0]!.body).toContain(`path_hex=${hexEncodeUtf8('/Users/tester/Documents')}`);
    expect(seen[0]!.body).toContain(`created_ms=${NOW}`);
    expect(seen[0]!.body).toContain(`expires_ms=${NOW + MACOS_FS_DELEGATE_LIMITS.REQUEST_TTL_MS}`);
    expect(readdirSync(join(runtimeRoot, String(user.uid)))).toEqual([]);
  });

  it('creates the request tree root-owned and not writable by others, and refuses one that is not', async () => {
    await listDirectoryViaMacosApp('/Users/tester/Documents', deps());
    expect(statSync(runtimeRoot).mode & 0o777).toBe(0o755);
    expect(statSync(join(runtimeRoot, String(user.uid))).mode & 0o777).toBe(0o755);
    chmodSync(join(runtimeRoot, String(user.uid)), 0o777);
    expect(await listDirectoryViaMacosApp('/Users/tester/Documents', deps())).toEqual({ kind: 'unavailable', reason: MACOS_FS_DELEGATE_REASON.REQUEST_DIR_UNTRUSTED });
    chmodSync(join(runtimeRoot, String(user.uid)), 0o755);
    // owned by somebody else than the node's uid
    expect(await listDirectoryViaMacosApp('/Users/tester/Documents', deps({ getuid: () => uid + 1 }))).toEqual({ kind: 'unavailable', reason: MACOS_FS_DELEGATE_REASON.REQUEST_DIR_UNTRUSTED });
  });

  it('removes request files left behind more than a minute ago and leaves fresh ones', async () => {
    await listDirectoryViaMacosApp('/Users/tester/Documents', deps());
    const dir = join(runtimeRoot, String(user.uid));
    const stale = join(dir, 'stale.req');
    const fresh = join(dir, 'fresh.req');
    writeFileSync(stale, 'x');
    writeFileSync(fresh, 'x');
    const old = new Date(NOW - 120_000);
    utimesSync(stale, old, old);
    utimesSync(fresh, new Date(NOW), new Date(NOW));
    await listDirectoryViaMacosApp('/Users/tester/Documents', deps({ now: () => NOW }));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  describe('falls back (a value, never an exception) so the node keeps its own behaviour', () => {
    it.each([
      ['not on macOS', { platform: 'linux' as const }, MACOS_FS_DELEGATE_REASON.APP_UNAVAILABLE],
      ['the app is not installed', { readInfoPlist: async () => null }, MACOS_FS_DELEGATE_REASON.APP_UNAVAILABLE],
      ['an older app without the capability keys', { readInfoPlist: async () => plistWith(null, null) }, MACOS_FS_DELEGATE_REASON.APP_TOO_OLD],
      ['an app that does not list "list"', { readInfoPlist: async () => plistWith(1, 'read') }, MACOS_FS_DELEGATE_REASON.APP_TOO_OLD],
      ['no signed-in GUI user', { resolveUser: async () => { throw new Error('computer_use_no_active_gui_session'); } }, MACOS_FS_DELEGATE_REASON.NO_USER_SESSION],
      ['the app cannot be started', { runApp: async () => { throw new Error('spawn failed'); } }, MACOS_FS_DELEGATE_REASON.SPAWN_FAILED],
      ['the run times out', { runApp: async () => { throw new Error('Command failed: killed (ETIMEDOUT)'); } }, MACOS_FS_DELEGATE_REASON.TIMEOUT],
      ['the answer is not the framing', { runApp: async () => ({ stdout: 'hello' }) }, MACOS_FS_DELEGATE_REASON.BAD_ANSWER],
      ['the answer is empty (an old app ignoring the flag)', { runApp: async () => ({ stdout: '' }) }, MACOS_FS_DELEGATE_REASON.BAD_ANSWER],
      ['the helper rejects the request', { runApp: async () => ({ stdout: answerText('error request_expired') }) }, MACOS_FS_DELEGATE_REASON.REQUEST_EXPIRED],
      ['the helper reports a symlink', { runApp: async () => ({ stdout: answerText('error symlink_refused') }) }, MACOS_FS_DELEGATE_REASON.SYMLINK_REFUSED],
      ['the helper invents an unknown reason', { runApp: async () => ({ stdout: answerText('error some_future_reason') }) }, MACOS_FS_DELEGATE_REASON.BAD_ANSWER],
    ])('%s', async (_label, override, reason) => {
      expect(await listDirectoryViaMacosApp('/Users/tester/Documents', deps(override as Partial<MacosFsDelegateClientDeps>))).toEqual({ kind: 'unavailable', reason });
    });

    it('cleans the request up when the run fails', async () => {
      await listDirectoryViaMacosApp('/Users/tester/Documents', deps({ runApp: async () => { throw new Error('boom'); } }));
      expect(readdirSync(join(runtimeRoot, String(user.uid)))).toEqual([]);
    });

    it('refuses a non-absolute or oversize path without starting anything', async () => {
      const runApp = vi.fn();
      expect(await listDirectoryViaMacosApp('relative', deps({ runApp }))).toEqual({ kind: 'refused', reason: MACOS_FS_DELEGATE_REASON.BAD_PATH });
      expect(await listDirectoryViaMacosApp(`/${'a'.repeat(MACOS_FS_DELEGATE_LIMITS.MAX_PATH_BYTES)}`, deps({ runApp }))).toEqual({ kind: 'refused', reason: MACOS_FS_DELEGATE_REASON.BAD_PATH });
      expect(runApp).not.toHaveBeenCalled();
    });
  });

  it('tells "macOS refused the app" (the app lacks Full Disk Access) from every other answer', async () => {
    expect(await listDirectoryViaMacosApp('/Users/tester/Documents', deps({ runApp: async () => ({ stdout: answerText('error permission_denied') }) }))).toEqual({ kind: 'app_denied' });
    expect(await listDirectoryViaMacosApp('/Users/tester/x', deps({ runApp: async () => ({ stdout: answerText('error not_found') }) }))).toEqual({ kind: 'refused', reason: 'not_found' });
    expect(await listDirectoryViaMacosApp('/Users/tester/x', deps({ runApp: async () => ({ stdout: answerText('error not_directory') }) }))).toEqual({ kind: 'refused', reason: 'not_directory' });
  });

  it('runs at most MAX_CONCURRENT_RUNS helpers at once; the rest fall back', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = deps({
      runApp: async () => { await gate; return { stdout: answerText(`realpath ${hexEncodeUtf8('/Users/tester/Documents')}`, 'end 0 0') }; },
      randomHex: (() => { let n = 0; return () => `${String(++n).padStart(32, '0')}`; })(),
    });
    const first = listDirectoryViaMacosApp('/Users/tester/a', slow);
    const second = listDirectoryViaMacosApp('/Users/tester/b', slow);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await listDirectoryViaMacosApp('/Users/tester/c', slow)).toEqual({ kind: 'unavailable', reason: MACOS_FS_DELEGATE_REASON.BUSY });
    release();
    expect((await first).kind).toBe('ok');
    expect((await second).kind).toBe('ok');
    expect((await listDirectoryViaMacosApp('/Users/tester/d', deps())).kind).toBe('ok');
  });

  it('answers the framing parser exactly (hex names, count check, nothing after end)', () => {
    const good = answerText(`realpath ${hexEncodeUtf8('/x')}`, `entry f ${hexEncodeUtf8('日本語 \n name')}`, 'end 1 0');
    expect(parseMacosFsDelegateAnswer(good)).toEqual({ ok: true, realPath: '/x', entries: [{ name: '日本語 \n name', kind: 'f' }], truncated: false });
    for (const bad of [
      answerText(`realpath ${hexEncodeUtf8('/x')}`, 'end 1 0'),                                   // count mismatch
      answerText(`realpath ${hexEncodeUtf8('/x')}`, 'end 0 0', 'entry f 61'),                     // data after end
      answerText('end 0 0'),                                                                        // no realpath
      answerText(`realpath ${hexEncodeUtf8('/x')}`, `entry f ${hexEncodeUtf8('a/b')}`, 'end 1 0'), // slash in a name
      answerText(`realpath ${hexEncodeUtf8('/x')}`, 'entry x 61', 'end 1 0'),                       // unknown kind
      answerText(`realpath zz`, 'end 0 0'),                                                         // bad hex
      answerText('error Bad-Reason'),
      'IMCODES-FS-V2\nerror x\n',
    ]) expect(parseMacosFsDelegateAnswer(bad)).toBeNull();
  });
});
