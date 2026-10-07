import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FILE_TRANSFER_DIRECTORY_LIST_ERROR, FILE_TRANSFER_DIRECTORY_PATH, FILE_TRANSFER_MSG } from '../../shared/transport/file-transfer.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { MACOS_FS_DELEGATE_ANSWER_MAGIC, hexEncodeUtf8 } from '../../shared/macos-fs-delegate.js';
import type { MacosFsDelegateClientDeps } from '../../src/node/macos-fs-delegate-client.js';

// The directory list as the node serves it on macOS when ITS OWN executable lacks Full Disk Access: the node retries through the
// aiDesk.to app, judges the answer with the same path policy, and otherwise behaves exactly as it did before delegation existed.

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setPlatform(value: NodeJS.Platform): void { Object.defineProperty(process, 'platform', { value, configurable: true }); }

let rootDir = '';
let fakeHome = '';
let protectedDir = '';
let appCalls: string[] = [];

const eperm = (p: string) => Object.assign(new Error(`EPERM: operation not permitted, scandir '${p}'`), { code: 'EPERM' });
const answer = (...lines: string[]) => `${[MACOS_FS_DELEGATE_ANSWER_MAGIC, ...lines].join('\n')}\n`;
const listing = (realPath: string, entries: Array<[string, 'd' | 'f' | 'o']>) => answer(
  `realpath ${hexEncodeUtf8(realPath)}`,
  ...entries.map(([name, kind]) => `entry ${kind} ${hexEncodeUtf8(name)}`),
  `end ${entries.length} 0`,
);

async function load(options: {
  platform?: NodeJS.Platform;
  sentinel?: { permissionDenied: boolean; path?: string; candidates?: string[] };
  app?: (requestedPath: string) => string | Error;
  plist?: string | null;
}) {
  setPlatform(options.platform ?? 'darwin');
  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  vi.stubEnv('IMCODES_HOME', path.join(fakeHome, '.imcodes'));
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => fakeHome }));
  vi.doMock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
      ...actual,
      // everything under the protected directory is refused to the node itself
      realpath: (async (target: string, ...rest: unknown[]) => {
        if (String(target).startsWith(protectedDir)) throw eperm(String(target));
        return (actual.realpath as (...args: unknown[]) => Promise<string>)(target, ...rest);
      }) as typeof actual.realpath,
    };
  });
  vi.doMock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
  if (options.sentinel) {
    const sentinel = options.sentinel;
    vi.doMock('../../src/daemon/well-known-directories.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/daemon/well-known-directories.js')>()),
      resolveWellKnownDirectoryDetailed: async () => ({ path: sentinel.path ?? fakeHome, permissionDenied: sentinel.permissionDenied }),
      wellKnownDirectoryCandidates: async () => sentinel.candidates ?? [],
    }));
  }
  const handler = await import('../../src/daemon/file-transfer-handler.js');
  const deps: MacosFsDelegateClientDeps = {
    platform: 'darwin',
    appPath: '/Applications/Fake aiDesk.app',
    runtimeRoot: path.join(rootDir, 'fs-delegate'),
    resolveUser: async () => ({ name: 'tester', uid: 501, gid: 20, home: fakeHome, tempDir: '/tmp/' }),
    readInfoPlist: async () => options.plist === undefined
      ? '<key>AideskFsDelegateVersion</key><integer>1</integer><key>AideskFsDelegateOps</key><string>list</string>'
      : options.plist,
    getuid: () => process.getuid?.() ?? 0,
    runApp: async ({ args }) => {
      const { readFile } = await import('node:fs/promises');
      const body = await readFile(args[1]!, 'utf8');
      const requested = Buffer.from(/path_hex=([0-9a-f]+)/.exec(body)![1]!, 'hex').toString('utf8');
      appCalls.push(requested);
      const reply = options.app ? options.app(requested) : answer('error permission_denied');
      if (reply instanceof Error) throw reply;
      return { stdout: reply };
    },
  };
  handler.setMacosFsDelegateDepsForTests(deps);
  return handler;
}

async function list(handler: Awaited<ReturnType<typeof load>>, requested: string): Promise<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  await handler.handleFileDirectoryList({ type: FILE_TRANSFER_MSG.DIRECTORY_LIST, requestId: 'req-1', path: requested }, { send: (message: unknown) => { sent.push(message as Record<string, unknown>); } } as never);
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe('directory list: macOS Full Disk Access delegation to the aiDesk.to app', () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'imcodes-fsd-handler-'));
    fakeHome = path.join(rootDir, 'home');
    protectedDir = path.join(fakeHome, 'Documents');
    await mkdir(path.join(fakeHome, 'Public'), { recursive: true });
    await writeFile(path.join(fakeHome, 'Public', 'visible.txt'), 'x');
    appCalls = [];
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('node:os');
    vi.doUnmock('../../src/daemon/well-known-directories.js');
    vi.unstubAllEnvs();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('does not involve the app when the node can read the directory itself (as before)', async () => {
    const handler = await load({});
    const reply = await list(handler, path.join(fakeHome, 'Public'));
    expect(reply.type).toBe(FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE);
    expect(appCalls).toEqual([]);
  });

  it('a typed path the node is refused is listed through the app, judged by the same policy', async () => {
    const target = path.join(protectedDir, 'proj');
    const handler = await load({ app: () => listing(target, [['b.txt', 'f'], ['sub', 'd'], ['.hid', 'f'], ['sock', 'o']]) });
    const reply = await list(handler, target);
    expect(reply).toEqual({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE,
      requestId: 'req-1',
      path: target,
      resolvedPath: target,
      entries: [
        { name: 'sub', path: path.join(target, 'sub'), isDir: true, hidden: false },
        { name: '.hid', path: path.join(target, '.hid'), isDir: false, hidden: true },
        { name: 'b.txt', path: path.join(target, 'b.txt'), isDir: false, hidden: false },
      ],
    });
    expect(appCalls).toEqual([target]);
  });

  it('expands ~ before asking the app (the app is only ever given an absolute path)', async () => {
    const target = path.join(protectedDir, 'x');
    const handler = await load({ app: () => listing(target, []) });
    await list(handler, '~/Documents/x');
    expect(appCalls).toEqual([target]);
  });

  it('the app refused by macOS (it lacks Full Disk Access) => the app-specific error, so the browser names the app', async () => {
    const handler = await load({ app: () => answer('error permission_denied') });
    expect(await list(handler, path.join(protectedDir, 'proj'))).toEqual({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_ERROR, requestId: 'req-1', error: FILE_TRANSFER_DIRECTORY_LIST_ERROR.MACOS_FULL_DISK_ACCESS_REQUIRED_APP,
    });
  });

  it.each([
    ['an app without the capability (older app)', { plist: '<key>CFBundleIdentifier</key><string>to.aidesk.app</string>' }],
    ['no app installed', { plist: null }],
    ['an app run that fails', { app: () => new Error('spawn failed') }],
    ['an unparseable answer', { app: () => 'garbage' }],
  ])('%s: a typed path is refused exactly as before delegation existed', async (_label, options) => {
    const handler = await load(options as Parameters<typeof load>[0]);
    expect(await list(handler, path.join(protectedDir, 'proj'))).toEqual({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_ERROR, requestId: 'req-1', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });

  it('a path the policy forbids is never given to the app, even when the node was refused it', async () => {
    const sshDir = path.join(fakeHome, '.ssh');
    protectedDir = sshDir; // the node is "refused" ~/.ssh as well
    const handler = await load({ app: () => listing(sshDir, [['id_rsa', 'f']]) });
    expect(await list(handler, sshDir)).toEqual({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_ERROR, requestId: 'req-1', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
    expect(appCalls).toEqual([]);
  });

  it('a real path the app reports inside a forbidden directory is refused (a symlink cannot launder it)', async () => {
    const target = path.join(protectedDir, 'innocent');
    const handler = await load({ app: () => listing(path.join(fakeHome, '.ssh'), [['id_rsa', 'f']]) });
    expect(await list(handler, target)).toEqual({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_ERROR, requestId: 'req-1', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
    expect(appCalls).toEqual([target]);
  });

  it('answers not-found and not-a-directory from the app with the node\'s own wording', async () => {
    const target = path.join(protectedDir, 'gone');
    expect(await list(await load({ app: () => answer('error not_found') }), target)).toMatchObject({ error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH });
    expect(await list(await load({ app: () => answer('error not_directory') }), target)).toMatchObject({ error: 'not_directory' });
  });

  describe('a well-known folder sentinel the node cannot even stat', () => {
    const candidates = () => [path.join(protectedDir, 'Downloads-primary'), path.join(protectedDir, 'Downloads-fallback')];

    it('asks the app for each candidate until one is a directory', async () => {
      const [first, second] = candidates();
      const handler = await load({
        sentinel: { permissionDenied: true, candidates: candidates() },
        app: (requested) => requested === first ? answer('error not_found') : listing(second!, [['dl.zip', 'f']]),
      });
      const reply = await list(handler, FILE_TRANSFER_DIRECTORY_PATH.DOWNLOADS);
      expect(reply).toMatchObject({ type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE, resolvedPath: second });
      expect(appCalls).toEqual([first, second]);
    });

    it('app refused by macOS => the app-specific error', async () => {
      const handler = await load({ sentinel: { permissionDenied: true, candidates: candidates() }, app: () => answer('error permission_denied') });
      expect(await list(handler, FILE_TRANSFER_DIRECTORY_PATH.DOWNLOADS)).toMatchObject({ error: FILE_TRANSFER_DIRECTORY_LIST_ERROR.MACOS_FULL_DISK_ACCESS_REQUIRED_APP });
    });

    it('no usable app => the long-standing node error, so an older browser still shows its prompt', async () => {
      const handler = await load({ sentinel: { permissionDenied: true, candidates: candidates() }, plist: null });
      expect(await list(handler, FILE_TRANSFER_DIRECTORY_PATH.DOWNLOADS)).toMatchObject({ error: FILE_TRANSFER_DIRECTORY_LIST_ERROR.MACOS_FULL_DISK_ACCESS_REQUIRED });
    });

    it('every candidate missing for the app => the long-standing node error', async () => {
      const handler = await load({ sentinel: { permissionDenied: true, candidates: candidates() }, app: () => answer('error not_found') });
      expect(await list(handler, FILE_TRANSFER_DIRECTORY_PATH.DOWNLOADS)).toMatchObject({ error: FILE_TRANSFER_DIRECTORY_LIST_ERROR.MACOS_FULL_DISK_ACCESS_REQUIRED });
    });

    it('a sentinel the node can resolve never reaches the app', async () => {
      const handler = await load({ sentinel: { permissionDenied: false, path: path.join(fakeHome, 'Public') } });
      expect((await list(handler, FILE_TRANSFER_DIRECTORY_PATH.DOWNLOADS)).type).toBe(FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE);
      expect(appCalls).toEqual([]);
    });
  });

  it('is macOS only: a permission refusal elsewhere never starts the app and stays the plain refusal', async () => {
    const handler = await load({ platform: 'linux', app: () => listing(protectedDir, []) });
    expect(await list(handler, path.join(protectedDir, 'proj'))).toEqual({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_ERROR, requestId: 'req-1', error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
    expect(appCalls).toEqual([]);
  });

  it('a symlink that resolves into an allowed place is judged as its real path on the direct route too (unchanged)', async () => {
    await symlink(path.join(fakeHome, 'Public'), path.join(fakeHome, 'alias'));
    const handler = await load({});
    const reply = await list(handler, path.join(fakeHome, 'alias'));
    expect(reply).toMatchObject({ type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE });
    expect(appCalls).toEqual([]);
  });
});
