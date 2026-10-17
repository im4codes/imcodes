import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AIDESK_AGENT_SOURCES, aideskAgentCompileArgs } from '../../scripts/build-aidesk-app.mjs';
import {
  MACOS_FS_DELEGATE_ANSWER_MAGIC,
  MACOS_FS_DELEGATE_LIMITS,
  MACOS_FS_DELEGATE_OP,
  MACOS_FS_DELEGATE_REASON,
  MACOS_FS_DELEGATE_REQUEST_FLAG,
  MACOS_FS_DELEGATE_RUNTIME_ROOT,
  MACOS_FS_DELEGATE_TRUSTED_CHAIN_START,
  hexEncodeUtf8,
  parseMacosFsDelegateAnswer,
  serializeMacosFsDelegateRequest,
  type MacosFsDelegateAnswer,
} from '../../shared/macos-fs-delegate.js';

// The request validation and the directory listing of the aiDesk.to app's one-shot filesystem helper
// (native/macos-remote-desktop/aidesk_fs_delegate.cc) are plain POSIX C++, so the real code is compiled with the host's g++ and driven
// here. Skipped where no C++ compiler exists. The macOS-only parts (TCC attribution, launchctl) are proven on a real Mac, not here.

const HAVE_COMPILER = spawnSync('g++', ['--version']).status === 0;
const SOURCE = resolve(__dirname, '../../native/macos-remote-desktop');
const uid = process.getuid?.() ?? 0;
const NOW = 1_800_000_000_000;

let work = '';
let binary = '';
let root = '';
let requestDir = '';
let fixtureDir = '';
let seq = 0;

function run(requestFile: string, options: { dir?: string; chainStart?: string; trustedUid?: number; now?: number; probe?: string; requireProbe?: boolean } = {}): MacosFsDelegateAnswer {
  const result = spawnSync(binary, [
    requestFile,
    options.dir ?? requestDir,
    options.chainStart ?? root,
    String(options.trustedUid ?? uid),
    String(options.now ?? NOW),
    ...(options.probe === undefined ? [] : [options.probe, ...(options.requireProbe ? ['require'] : [])]),
  ], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  const answer = parseMacosFsDelegateAnswer(result.stdout);
  expect(answer, `unparseable answer: ${JSON.stringify(result.stdout)}`).not.toBeNull();
  return answer!;
}

function writeRequest(overrides: Partial<Parameters<typeof serializeMacosFsDelegateRequest>[0]> = {}, name = `r${++seq}.req`, mode = 0o644): string {
  const file = join(requestDir, name);
  writeFileSync(file, serializeMacosFsDelegateRequest({
    op: MACOS_FS_DELEGATE_OP.LIST,
    path: fixtureDir,
    nonce: 'a1b2c3d4e5f60718',
    createdMs: NOW - 100,
    expiresMs: NOW + 5_000,
    ...overrides,
  }), { mode });
  chmodSync(file, mode);
  return file;
}

function expectRefused(answer: MacosFsDelegateAnswer, reason: string): void {
  expect(answer).toEqual({ ok: false, reason });
}

describe.skipIf(!HAVE_COMPILER)('aidesk fs delegate (native core)', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'imcodes-fsd-build-'));
    binary = join(work, 'fsd');
    const built = spawnSync('g++', [
      '-std=c++17', '-Wall', '-Wextra', '-Werror', `-I${SOURCE}`,
      join(SOURCE, 'aidesk_fs_delegate.cc'), join(SOURCE, 'aidesk_fs_delegate_test_main.cc'), '-o', binary,
    ], { encoding: 'utf8' });
    expect(built.stderr).toBe('');
    expect(built.status).toBe(0);
  });
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imcodes-fsd-'));
    chmodSync(root, 0o755);
    requestDir = join(root, 'fs', String(uid));
    mkdirSync(requestDir, { recursive: true, mode: 0o755 });
    chmodSync(join(root, 'fs'), 0o755);
    chmodSync(requestDir, 0o755);
    fixtureDir = join(root, 'data');
    mkdirSync(fixtureDir);
    return () => rmSync(root, { recursive: true, force: true });
  });

  it('lists a directory: real path, directories, regular files, and `other` for a symlink', () => {
    mkdirSync(join(fixtureDir, 'sub'));
    writeFileSync(join(fixtureDir, 'a.txt'), 'x');
    writeFileSync(join(fixtureDir, '.hidden'), 'x');
    symlinkSync(join(fixtureDir, 'a.txt'), join(fixtureDir, 'link'));
    const answer = run(writeRequest());
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.realPath).toBe(realpathSync(fixtureDir));
    expect(answer.truncated).toBe(false);
    expect(Object.fromEntries(answer.entries.map((entry) => [entry.name, entry.kind]))).toEqual({
      sub: 'd', 'a.txt': 'f', '.hidden': 'f', link: 'o',
    });
  });

  it('frames names that would break a line protocol (newline, spaces, unicode) through hex', () => {
    const odd = ['line\nbreak', 'two  spaces', '日本語', 'tab\there'];
    for (const name of odd) writeFileSync(join(fixtureDir, name), 'x');
    const answer = run(writeRequest());
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.entries.map((entry) => entry.name).sort()).toEqual([...odd].sort());
  });

  it('resolves a symlinked directory request to its real path (the node policy then judges that real path)', () => {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'inside.txt'), 'x');
    symlinkSync(join(root, 'real'), join(root, 'via-link'));
    const answer = run(writeRequest({ path: join(root, 'via-link') }));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.realPath).toBe(realpathSync(join(root, 'real')));
    expect(answer.entries).toEqual([{ name: 'inside.txt', kind: 'f' }]);
  });

  it('answers stable reasons for a missing path, a file, and a relative or dotted path', () => {
    expectRefused(run(writeRequest({ path: join(fixtureDir, 'nope') })), MACOS_FS_DELEGATE_REASON.NOT_FOUND);
    writeFileSync(join(fixtureDir, 'f'), 'x');
    expectRefused(run(writeRequest({ path: join(fixtureDir, 'f') })), MACOS_FS_DELEGATE_REASON.NOT_DIRECTORY);
    expectRefused(run(writeRequest({ path: 'relative/path' })), MACOS_FS_DELEGATE_REASON.BAD_PATH);
    expectRefused(run(writeRequest({ path: `${fixtureDir}/../data` })), MACOS_FS_DELEGATE_REASON.BAD_PATH);
    expectRefused(run(writeRequest({ path: `${fixtureDir}/./sub` })), MACOS_FS_DELEGATE_REASON.BAD_PATH);
    expectRefused(run(writeRequest({ path: `${fixtureDir}//x` })), MACOS_FS_DELEGATE_REASON.BAD_PATH);
  });

  describe('time', () => {
    it('refuses an expired request, a far-future expiry, a created-in-the-future (rolled back clock) one, and a longer-than-TTL window', () => {
      expectRefused(run(writeRequest({ expiresMs: NOW - 1 })), MACOS_FS_DELEGATE_REASON.REQUEST_EXPIRED);
      expectRefused(run(writeRequest({ expiresMs: NOW })), MACOS_FS_DELEGATE_REASON.REQUEST_EXPIRED);
      expectRefused(run(writeRequest({ createdMs: NOW, expiresMs: NOW + MACOS_FS_DELEGATE_LIMITS.REQUEST_TTL_MS + MACOS_FS_DELEGATE_LIMITS.MAX_CLOCK_SKEW_MS + 1 })), MACOS_FS_DELEGATE_REASON.REQUEST_EXPIRY_TOO_FAR);
      expectRefused(run(writeRequest({ createdMs: NOW + MACOS_FS_DELEGATE_LIMITS.MAX_CLOCK_SKEW_MS + 1, expiresMs: NOW + 5_000 })), MACOS_FS_DELEGATE_REASON.REQUEST_CREATED_IN_FUTURE);
      expectRefused(run(writeRequest({ createdMs: NOW - 60_000, expiresMs: NOW + 5_000 })), MACOS_FS_DELEGATE_REASON.REQUEST_EXPIRY_TOO_FAR);
    });

    it('accepts the edges: expiry exactly now+TTL, creation within the allowed skew', () => {
      expect(run(writeRequest({ createdMs: NOW, expiresMs: NOW + MACOS_FS_DELEGATE_LIMITS.REQUEST_TTL_MS })).ok).toBe(true);
      expect(run(writeRequest({ createdMs: NOW + MACOS_FS_DELEGATE_LIMITS.MAX_CLOCK_SKEW_MS, expiresMs: NOW + 5_000 })).ok).toBe(true);
    });
  });

  describe('request authenticity (a same-user process must not be able to mint a request)', () => {
    it('refuses a request directory or ancestor owned by someone else', () => {
      expectRefused(run(writeRequest(), { trustedUid: uid + 1 }), MACOS_FS_DELEGATE_REASON.REQUEST_DIR_UNTRUSTED);
    });

    it('refuses a group- or world-writable request directory, and a world-writable ancestor', () => {
      const file = writeRequest();
      chmodSync(requestDir, 0o775);
      expectRefused(run(file), MACOS_FS_DELEGATE_REASON.REQUEST_DIR_UNTRUSTED);
      chmodSync(requestDir, 0o757);
      expectRefused(run(file), MACOS_FS_DELEGATE_REASON.REQUEST_DIR_UNTRUSTED);
      chmodSync(requestDir, 0o755);
      chmodSync(join(root, 'fs'), 0o757);
      expectRefused(run(file), MACOS_FS_DELEGATE_REASON.REQUEST_DIR_UNTRUSTED);
      chmodSync(join(root, 'fs'), 0o755);
      expect(run(file).ok).toBe(true);
    });

    it('refuses a request directory that is reached through a symlink, before opening anything', () => {
      const real = join(root, 'elsewhere');
      mkdirSync(real, { mode: 0o755 });
      writeFileSync(join(real, 'r.req'), serializeMacosFsDelegateRequest({ op: MACOS_FS_DELEGATE_OP.LIST, path: fixtureDir, nonce: 'a1b2c3d4e5f60718', createdMs: NOW - 1, expiresMs: NOW + 5_000 }), { mode: 0o644 });
      const link = join(root, 'linkdir');
      symlinkSync(real, link);
      expectRefused(run(join(link, 'r.req'), { dir: link }), MACOS_FS_DELEGATE_REASON.REQUEST_DIR_UNTRUSTED);
    });

    it('refuses a request file that is group/world writable, a symlink, or hard-linked', () => {
      expectRefused(run(writeRequest({}, 'w.req', 0o664)), MACOS_FS_DELEGATE_REASON.REQUEST_OWNER_UNTRUSTED);
      expectRefused(run(writeRequest({}, 'o.req', 0o646)), MACOS_FS_DELEGATE_REASON.REQUEST_OWNER_UNTRUSTED);
      const real = writeRequest({}, 'real.req');
      symlinkSync(real, join(requestDir, 'sym.req'));
      expectRefused(run(join(requestDir, 'sym.req')), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      linkSync(real, join(requestDir, 'hard.req'));
      expectRefused(run(join(requestDir, 'hard.req')), MACOS_FS_DELEGATE_REASON.REQUEST_OWNER_UNTRUSTED);
    });

    it('refuses a file outside the request directory and names that could escape it', () => {
      const outside = join(root, 'outside.req');
      writeFileSync(outside, serializeMacosFsDelegateRequest({ op: MACOS_FS_DELEGATE_OP.LIST, path: fixtureDir, nonce: 'a1b2c3d4e5f60718', createdMs: NOW - 1, expiresMs: NOW + 5_000 }), { mode: 0o644 });
      expectRefused(run(outside), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(`${requestDir}/../outside.req`), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(join(requestDir, '.hidden.req')), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run('relative.req'), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(join(requestDir, 'missing.req')), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
    });

    it('refuses a chain start that is not an ancestor of the request directory', () => {
      expectRefused(run(writeRequest(), { chainStart: join(tmpdir(), 'not-an-ancestor') }), MACOS_FS_DELEGATE_REASON.REQUEST_DIR_UNTRUSTED);
    });
  });

  describe('list_meta (size / modified / created time per entry)', () => {
    it('answers the numbers the filesystem has, exactly, and plain `list` stays without them', () => {
      const known = new Date(1_700_000_000_123);
      writeFileSync(join(fixtureDir, 'a.txt'), 'x'.repeat(120));
      utimesSync(join(fixtureDir, 'a.txt'), known, known);
      mkdirSync(join(fixtureDir, 'sub'));
      writeFileSync(join(fixtureDir, 'empty'), '');
      const meta = run(writeRequest({ op: MACOS_FS_DELEGATE_OP.LIST_META }, 'meta.req'));
      expect(meta.ok).toBe(true);
      if (!meta.ok) return;
      const byName = Object.fromEntries(meta.entries.map((entry) => [entry.name, entry]));
      expect(byName['a.txt']!.meta!.size).toBe(120);
      expect(Math.abs(byName['a.txt']!.meta!.mtimeMs! - 1_700_000_000_123)).toBeLessThanOrEqual(1); // sub-millisecond is cut, not rounded
      expect(byName['empty']!.meta!.size).toBe(0);
      expect(byName['sub']!.kind).toBe('d');
      expect(byName['sub']!.meta!.size).toBe(0); // a directory's own byte size is not reported
      expect(byName['sub']!.meta!.mtimeMs).toBe(Math.floor(statSync(join(fixtureDir, 'sub')).mtimeMs));
      for (const entry of meta.entries) expect(entry.meta, entry.name).toBeDefined();
      const plain = run(writeRequest({ op: MACOS_FS_DELEGATE_OP.LIST }, 'plain.req'));
      expect(plain.ok && plain.entries.every((entry) => entry.meta === undefined)).toBe(true);
    });

    it('a symlink entry is `o` with metadata of the link itself, and the entry count/truncation rules are unchanged', () => {
      writeFileSync(join(fixtureDir, 'target'), 'abc');
      symlinkSync(join(fixtureDir, 'target'), join(fixtureDir, 'link'));
      const meta = run(writeRequest({ op: MACOS_FS_DELEGATE_OP.LIST_META }, 'link.req'));
      expect(meta.ok && meta.entries.find((entry) => entry.name === 'link')!.kind).toBe('o');
      expect(meta.ok && meta.entries.find((entry) => entry.name === 'target')!.meta!.size).toBe(3);
    });
  });

  describe('Full Disk Access probe (answer at once instead of stopping on a per-folder consent prompt)', () => {
    it.skipIf(uid === 0)('answers permission_denied without touching the path when the probe file cannot be read', () => {
      writeFileSync(join(fixtureDir, 'a.txt'), 'x');
      const probe = join(root, 'tcc.db');
      writeFileSync(probe, 'x');
      chmodSync(probe, 0o000);
      expectRefused(run(writeRequest(), { probe }), MACOS_FS_DELEGATE_REASON.PERMISSION_DENIED);
      chmodSync(probe, 0o644);
      expect(run(writeRequest({}, 'second.req'), { probe }).ok).toBe(true);
    });

    it('answers permission_unknown (a visible state, not a silent timeout) when the probe file is not where expected', () => {
      expectRefused(run(writeRequest(), { probe: join(root, 'no-such-tcc.db') }), MACOS_FS_DELEGATE_REASON.PERMISSION_UNKNOWN);
      writeFileSync(join(root, 'plain-file'), 'x');
      expectRefused(run(writeRequest({}, 'second.req'), { probe: join(root, 'plain-file', 'under-a-file') }), MACOS_FS_DELEGATE_REASON.PERMISSION_UNKNOWN);
    });

    it('with the probe required (production) an unusable probe path is "cannot tell", not "carry on"; unrequired it is skipped', () => {
      expectRefused(run(writeRequest(), { probe: '', requireProbe: true }), MACOS_FS_DELEGATE_REASON.PERMISSION_UNKNOWN);
      expect(run(writeRequest({}, 'second.req'), { probe: '' }).ok).toBe(true);
    });
  });

  describe('malformed requests', () => {
    const base = (extra: string[] = [], drop: string[] = []): string => {
      const lines = [
        'v=1', 'op=list', `path_hex=${hexEncodeUtf8(fixtureDir)}`, `created_ms=${NOW - 100}`, `expires_ms=${NOW + 5_000}`, 'nonce=a1b2c3d4e5f60718',
      ].filter((line) => !drop.some((key) => line.startsWith(`${key}=`)));
      return `${[...lines, ...extra].join('\n')}\n`;
    };
    const put = (body: string): string => {
      const file = join(requestDir, `m${++seq}.req`);
      writeFileSync(file, body, { mode: 0o644 });
      chmodSync(file, 0o644);
      return file;
    };

    it('refuses an unknown version or operation', () => {
      expectRefused(run(put(base().replace('v=1', 'v=2'))), MACOS_FS_DELEGATE_REASON.UNSUPPORTED_VERSION);
      expectRefused(run(put(base().replace('op=list', 'op=read'))), MACOS_FS_DELEGATE_REASON.UNSUPPORTED_OP);
    });

    it('refuses a missing, duplicated or extra key, a bad hex path, a bad nonce, a non-numeric time, and a missing final newline', () => {
      expectRefused(run(put(base([], ['nonce']))), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(put(base(['op=list']))), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(put(base(['extra=1']))), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(put(base().replace(/path_hex=[0-9a-f]+/, 'path_hex=zz'))), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(put(base().replace('nonce=a1b2c3d4e5f60718', 'nonce=short'))), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(put(base().replace(/created_ms=\d+/, 'created_ms=-5'))), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(put(base().trimEnd())), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
    });

    it('refuses an empty file and an oversize file', () => {
      expectRefused(run(put('')), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
      expectRefused(run(put(`${'x'.repeat(6_000)}\n`)), MACOS_FS_DELEGATE_REASON.BAD_REQUEST_FILE);
    });
  });
});

// The limits are written twice (TypeScript, C++) because the helper is plain C++ with no access to the shared module. This is the one
// place that keeps them from drifting: it reads the C++ header and compares.
describe('aidesk fs delegate: native constants mirror the shared protocol', () => {
  const header = readFileSync(join(SOURCE, 'aidesk_fs_delegate.h'), 'utf8');
  const num = (name: string): number => {
    const match = new RegExp(`${name}\\s*=\\s*([0-9']+);`).exec(header);
    expect(match, `${name} missing from aidesk_fs_delegate.h`).not.toBeNull();
    return Number(match![1]!.replace(/'/g, ''));
  };
  it('has the same limits', () => {
    expect(num('kRequestTtlMs')).toBe(MACOS_FS_DELEGATE_LIMITS.REQUEST_TTL_MS);
    expect(num('kMaxClockSkewMs')).toBe(MACOS_FS_DELEGATE_LIMITS.MAX_CLOCK_SKEW_MS);
    expect(num('kMaxPathBytes')).toBe(MACOS_FS_DELEGATE_LIMITS.MAX_PATH_BYTES);
    expect(num('kMaxEntries')).toBe(MACOS_FS_DELEGATE_LIMITS.MAX_ENTRIES);
    expect(num('kSelfTimeoutSeconds') * 1000).toBe(MACOS_FS_DELEGATE_LIMITS.HELPER_SELF_TIMEOUT_MS);
    expect(MACOS_FS_DELEGATE_LIMITS.HELPER_SELF_TIMEOUT_MS).toBeLessThan(MACOS_FS_DELEGATE_LIMITS.RUN_TIMEOUT_MS);
  });
  it('has the same flag, runtime root and answer magic', () => {
    expect(header).toContain(`"${MACOS_FS_DELEGATE_REQUEST_FLAG}"`);
    expect(header).toContain(`"${MACOS_FS_DELEGATE_RUNTIME_ROOT}"`);
    const source = readFileSync(join(SOURCE, 'aidesk_fs_delegate.cc'), 'utf8');
    expect(source).toContain(`"${MACOS_FS_DELEGATE_ANSWER_MAGIC}"`);
    expect(source).toContain(`"${MACOS_FS_DELEGATE_TRUSTED_CHAIN_START}"`);
  });
  it('the shipped entry point arms the self-timeout and probes Full Disk Access before reading', () => {
    const source = readFileSync(join(SOURCE, 'aidesk_fs_delegate.cc'), 'utf8');
    expect(source).toMatch(/alarm\(kSelfTimeoutSeconds\)/u);
    expect(source).toContain('/Library/Application Support/com.apple.TCC/TCC.db');
    expect(source.indexOf('FullDiskAccessProbeAllows(options.full_disk_access_probe_path)')).toBeLessThan(source.indexOf('realpath(requested.c_str()'));
  });
  it('uses every helper reason code the shared module names, spelled the same', () => {
    const source = readFileSync(join(SOURCE, 'aidesk_fs_delegate.cc'), 'utf8');
    const nativeReasons = [...source.matchAll(/constexpr char k\w+\[\] = "([a-z_]+)";/g)].map((m) => m[1]!).filter((v) => v !== 'IMCODES-FS-V1');
    const shared = new Set<string>(Object.values(MACOS_FS_DELEGATE_REASON));
    for (const reason of nativeReasons) expect(shared.has(reason), `${reason} is not in MACOS_FS_DELEGATE_REASON`).toBe(true);
    expect(nativeReasons.length).toBeGreaterThan(10);
  });
  it('is called from the agent main before anything that opens UI, and is in the app build', () => {
    const main = readFileSync(join(SOURCE, 'aidesk_agent_main.mm'), 'utf8');
    expect(main.indexOf('IsFsDelegateInvocation(argc, argv)')).toBeGreaterThan(-1);
    expect(main.indexOf('IsFsDelegateInvocation(argc, argv)')).toBeLessThan(main.indexOf('IsMacosPermissionResponsibleApplication'));
    // in the app build: the sources every agent build compiles (aidesk-agent-build.json, read by the packaging script)
    expect(AIDESK_AGENT_SOURCES).toContain('aidesk_fs_delegate.cc');
    expect(aideskAgentCompileArgs({ arch: 'arm64', minimumSystemVersion: '12.3', outPath: '/out/agent' }).some((arg) => arg.endsWith('/aidesk_fs_delegate.cc'))).toBe(true);
  });

  it('has no way to move the request directory at run time: no getenv, no argument, no define in the shipped build', () => {
    const source = readFileSync(join(SOURCE, 'aidesk_fs_delegate.cc'), 'utf8');
    expect(source).not.toMatch(/\b(?:getenv|setenv|secure_getenv)\s*\(|\benviron\b/u);
    // the only override is a compile-time constant, used by a throw-away test build and never by the packaging script
    expect(source).toContain('IMCODES_FS_DELEGATE_TEST_RUNTIME_ROOT');
    expect(readFileSync(resolve(SOURCE, '../../scripts/build-aidesk-app.mjs'), 'utf8')).not.toContain('IMCODES_FS_DELEGATE_TEST');
    for (const file of ['aidesk_agent_main.mm']) {
      expect(readFileSync(join(SOURCE, file), 'utf8')).not.toContain('IMCODES_FS_DELEGATE_TEST');
    }
  });

  it.skipIf(!HAVE_COMPILER)('the test-only build (compile-time root) still compiles warning-free', () => {
    const built = spawnSync('g++', [
      '-std=c++20', '-Wall', '-Wextra', '-Werror', '-fsyntax-only',
      '-DIMCODES_FS_DELEGATE_TEST_RUNTIME_ROOT="/private/var/run/imcodes-fsd-cc8-test/fs-delegate"',
      `-I${SOURCE}`, join(SOURCE, 'aidesk_fs_delegate.cc'),
    ], { encoding: 'utf8' });
    expect(built.stderr).toBe('');
    expect(built.status).toBe(0);
  });
});
