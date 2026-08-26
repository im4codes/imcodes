/**
 * One-line install command — real PostgreSQL (testcontainers via integration-global).
 *
 * Covers the short install code end to end: minting, the script the pasted
 * command fetches, the code working as a download credential, and the refusals
 * that keep a URL-borne credential from being probed or outliving its ticket.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { controlledNodeInstallCommandRoutes } from '../src/routes/controlled-node-install.js';
import {
  CONTROLLED_NODE_INSTALL_CODE_ALPHABET,
  CONTROLLED_NODE_INSTALL_CODE_LENGTH,
  CONTROLLED_NODE_TICKET_DELIVERY,
  CONTROLLED_NODE_TICKET_MAX_CONSUMES,
  CONTROLLED_NODE_TICKET_TTL_MS,
  isControlledNodeInstallCode,
  normalizeControlledNodeInstallCode,
} from '../../shared/controlled-node-artifacts.js';
import {
  controlledNodeInstallCommand,
  renderControlledNodeInstallScript,
} from '../src/services/controlled-node-install-command.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SERVER_URL = 'https://im.example.test';

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {
      DB: db, SERVER_URL, NODE_ENV: 'production',
    };
    await next();
  });
  app.route('/i', controlledNodeInstallCommandRoutes);
  return app;
}

/** Seed an enrolment addressable by a known install code. */
async function seedInstallCode(opts: {
  code: string; os?: string; arch?: string; expiresInMs?: number; revoked?: boolean;
}): Promise<void> {
  const now = Date.now();
  const ownerUserId = `u_${hex(4)}`;
  await createUser(db, ownerUserId);
  await db.execute(
    `INSERT INTO controlled_node_enrollments_v2
       (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256,
        encrypted_code, consumed_count, max_consumes, ticket_expires_at,
        expires_at, reusable, created_at, install_code_hash, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'test-only', 0, $7, $8, NULL, TRUE, $9, $10, $11)`,
    [
      sha256(hex(16)), sha256(hex(16)), ownerUserId,
      opts.os ?? 'linux', opts.arch ?? 'x64', sha256(hex(32)),
      CONTROLLED_NODE_TICKET_MAX_CONSUMES[CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND],
      now + (opts.expiresInMs ?? 60_000), now,
      sha256(opts.code), opts.revoked ? now : null,
    ],
  );
}

function freshCode(): string {
  let out = '';
  for (let i = 0; i < CONTROLLED_NODE_INSTALL_CODE_LENGTH; i++) {
    out += CONTROLLED_NODE_INSTALL_CODE_ALPHABET[i % CONTROLLED_NODE_INSTALL_CODE_ALPHABET.length];
  }
  // Vary the tail so parallel cases cannot collide on the unique index.
  return out.slice(0, -4) + hex(2).toUpperCase().replace(/[ILOU]/g, '2');
}

describe('install code shape', () => {
  it('omits the characters that are misread when dictated or retyped', () => {
    for (const ambiguous of ['I', 'L', 'O', 'U']) {
      expect(CONTROLLED_NODE_INSTALL_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('folds the mistakes those omissions invite', () => {
    const code = freshCode();
    expect(normalizeControlledNodeInstallCode(code.toLowerCase())).toBe(code);
    // l→1, O→0 and a stray separator are all recoverable rather than fatal.
    const typo = code.replace(/1/g, 'l').replace(/0/g, 'O');
    expect(normalizeControlledNodeInstallCode(typo)).toBe(code);
    expect(normalizeControlledNodeInstallCode(` ${code} `)).toBe(code);
  });

  it('rejects anything that is not exactly a code', () => {
    expect(isControlledNodeInstallCode('')).toBe(false);
    expect(isControlledNodeInstallCode('SHORT')).toBe(false);
    expect(normalizeControlledNodeInstallCode('../../etc/passwd')).toBeNull();
    expect(normalizeControlledNodeInstallCode(`${freshCode()}X`)).toBeNull();
  });
});

describe('rendered installer script', () => {
  const code = freshCode();

  it('survives a truncated pipe by invoking on the last line', () => {
    for (const os of ['linux', 'mac', 'win'] as const) {
      const { body } = renderControlledNodeInstallScript({
        serverUrl: SERVER_URL, installCode: code, os, arch: 'x64',
      });
      const invocation = os === 'win' ? 'Invoke-ImcodesInstall' : 'imcodes_install';
      const lines = body.trimEnd().split('\n');
      expect(lines[lines.length - 1]!.trim()).toBe(invocation);
      // Defined before it is called: a cut-off download never reaches the call.
      expect(body.indexOf(`function ${invocation}`) >= 0 || body.indexOf(`${invocation}() {`) >= 0).toBe(true);
    }
  });

  it('elevates rather than telling the operator to start over', () => {
    const posix = renderControlledNodeInstallScript({
      serverUrl: SERVER_URL, installCode: code, os: 'linux', arch: 'x64',
    }).body;
    expect(posix).toContain('id -u');
    expect(posix).toContain('sudo sh');

    const win = renderControlledNodeInstallScript({
      serverUrl: SERVER_URL, installCode: code, os: 'win', arch: 'x64',
    }).body;
    expect(win).toContain('-Verb RunAs');
    // The new console must not close over the result before it can be read.
    expect(win).toContain('-NoExit');
    // A freshly downloaded exe is blocked by the Mark of the Web otherwise.
    expect(win).toContain('Unblock-File');
  });

  /**
   * The curl protocol flag must follow the scheme the URL policy allowed.
   *
   * `server-url.ts` deliberately admits loopback HTTP for development, but the
   * script hardcoded `--proto '=https'`, which makes curl refuse outright with
   * `Protocol "http" disabled`. The mint→download integration test cannot catch
   * this: it calls the endpoints directly and never executes the shell.
   */
  it('pins curl to the scheme the origin actually uses', () => {
    const https = renderControlledNodeInstallScript({
      serverUrl: 'https://im.example.test', installCode: code, os: 'linux', arch: 'x64',
    }).body;
    expect(https).toContain("--proto '=https' --proto-redir '=https' --tlsv1.2");
    expect(https).not.toContain("--proto '=http'");
    // wget is the fallback when curl is absent and follows redirects too.
    // `--https-only` only constrains recursive link following (no `-r` here),
    // so it must NOT be relied on; `--max-redirect=0` is the real guarantee and
    // applies to loopback HTTP as well, since our routes never redirect.
    expect(https).not.toContain('--https-only');
    expect(https).toContain('--max-redirect=0');
    expect(https).toContain("grep -q -- '--max-redirect'");

    for (const loopback of ['http://localhost', 'http://127.0.0.1:8787']) {
      const body = renderControlledNodeInstallScript({
        serverUrl: loopback, installCode: code, os: 'linux', arch: 'x64',
      }).body;
      // Would abort with `Protocol "http" disabled` before any request.
      expect(body).not.toContain("--proto '=https'");
      expect(body).not.toContain('--tlsv1.2');
      expect(body).toContain("--proto '=http' --proto-redir '=http'");
      // The redirect pin is scheme-independent: our routes never redirect.
      expect(body).not.toContain('--https-only');
      expect(body).toContain('--max-redirect=0');
      expect(body).toContain(loopback);
    }
  });

  it('refuses to render anything it has not validated', () => {
    expect(() => renderControlledNodeInstallScript({
      serverUrl: SERVER_URL, installCode: "X'; rm -rf /", os: 'linux', arch: 'x64',
    })).toThrow('invalid_controlled_node_install_code');
    expect(() => renderControlledNodeInstallScript({
      serverUrl: 'https://evil.test/x?a=1', installCode: code, os: 'linux', arch: 'x64',
    })).toThrow('invalid_controlled_node_install_server_url');
    expect(() => controlledNodeInstallCommand('http://plain.test', code, 'linux'))
      .toThrow('invalid_controlled_node_install_server_url');
  });

  it('names the platform it was minted for, so a wrong paste is caught', () => {
    const linux = renderControlledNodeInstallScript({
      serverUrl: SERVER_URL, installCode: code, os: 'linux', arch: 'x64',
    }).body;
    expect(linux).toContain("imcodes_expect_os='linux'");
    const win = renderControlledNodeInstallScript({
      serverUrl: SERVER_URL, installCode: code, os: 'win', arch: 'arm64',
    }).body;
    expect(win).toContain("$expectArch = 'ARM64'");
  });
});

describe('GET /i/:code', () => {
  it('serves a shell script for a live posix code', async () => {
    const app = buildApp();
    const code = freshCode();
    await seedInstallCode({ code, os: 'linux' });

    const res = await app.request(`/i/${code}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('imcodes_install');
    expect(body).toContain(code);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('serves PowerShell for a windows code', async () => {
    const app = buildApp();
    const code = freshCode();
    await seedInstallCode({ code, os: 'win' });
    const body = await (await app.request(`/i/${code}`)).text();
    expect(body).toContain('Invoke-ImcodesInstall');
  });

  it('accepts the code as it would be retyped', async () => {
    const app = buildApp();
    const code = freshCode();
    await seedInstallCode({ code, os: 'linux' });
    const res = await app.request(`/i/${code.toLowerCase()}`);
    expect(res.status).toBe(200);
  });

  it('answers unknown, expired and revoked identically', async () => {
    const app = buildApp();
    const expired = freshCode();
    const revoked = freshCode();
    await seedInstallCode({ code: expired, expiresInMs: -1_000 });
    await seedInstallCode({ code: revoked, revoked: true });

    for (const code of [freshCode(), expired, revoked, 'not-a-code']) {
      const res = await app.request(`/i/${code}`);
      expect(res.status, `${code} must be indistinguishable`).toBe(404);
      expect(await res.text()).toBe('not found\n');
    }
  });

  it('does not consume the ticket, so probing cannot exhaust it', async () => {
    const app = buildApp();
    const code = freshCode();
    await seedInstallCode({ code });
    for (let i = 0; i < 5; i++) expect((await app.request(`/i/${code}`)).status).toBe(200);
    const row = await db.queryOne<{ consumed_count: number }>(
      'SELECT consumed_count FROM controlled_node_enrollments_v2 WHERE install_code_hash = $1',
      [sha256(code)],
    );
    expect(row?.consumed_count).toBe(0);
  });
});

describe('delivery budget', () => {
  it('gives the pasted command a lifetime and budget matching a fleet', () => {
    const oneLiner = CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND;
    const browser = CONTROLLED_NODE_TICKET_DELIVERY.BROWSER;
    expect(CONTROLLED_NODE_TICKET_TTL_MS[oneLiner])
      .toBeGreaterThan(CONTROLLED_NODE_TICKET_TTL_MS[browser]);
    expect(CONTROLLED_NODE_TICKET_MAX_CONSUMES[oneLiner])
      .toBeGreaterThan(CONTROLLED_NODE_TICKET_MAX_CONSUMES[browser]);
    // Bounded, not unlimited: a leaked command cannot mint entries without end.
    expect(Number.isFinite(CONTROLLED_NODE_TICKET_MAX_CONSUMES[oneLiner])).toBe(true);
  });
});


/**
 * Execute the generated installer for real against a loopback HTTP origin.
 *
 * The script-contract test above asserts which curl flags are emitted. This one
 * asserts the flags actually work, which is the property that broke: the
 * renderer emitted `--proto '=https'` for an origin the URL policy explicitly
 * admits over plain HTTP, and curl aborts such a request with
 * `Protocol "http" disabled` before it is ever sent. Neither the unit tests nor
 * the mint→download integration test can see that, because both call the
 * endpoints directly and never run the shell.
 *
 * `id` and `uname` are shimmed so a non-root macOS runner can exercise the
 * download path; nothing else about the script is altered.
 */
/**
 * The COPIED command is executed by a root shell, so its transport is part of
 * the security boundary. `-L` without a protocol restriction follows an
 * HTTPS→HTTP redirect and pipes cleartext into `sudo sh`; the inner download
 * was pinned while this outer command was not, so the two drifted apart.
 *
 * The redirect refusal is proven executably here using an HTTP origin
 * redirecting to HTTPS. That exercises the exact mechanism (`--proto-redir`
 * rejecting a cross-scheme redirect) with no TLS server to stand up, and the
 * scheme-specific values are pinned by contract alongside it.
 */
/**
 * wget is a production fallback, so its redirect behaviour is part of the same
 * security contract as curl's — and a string assertion cannot establish it.
 * `--https-only` was accepted for a while precisely because only its presence
 * was checked.
 *
 * Skipped where wget is absent (this developer host) and executed where it is
 * present (CI's ubuntu runner), rather than asserting a behaviour nobody runs.
 */
function gnuWgetAvailable(): boolean {
  try {
    return execFileSync('sh', ['-c', "command -v wget >/dev/null 2>&1 && wget --help 2>&1 | grep -q -- '--max-redirect'"],
      { timeout: 10_000 }) !== undefined;
  } catch { return false; }
}

describe.skipIf(!gnuWgetAvailable())('wget fallback refuses redirects', () => {
  let redirector: Server;
  let origin: string;

  beforeAll(async () => {
    redirector = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere', connection: 'close' });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const a = redirector.address();
    origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
  });

  it('does not follow a redirect when pinned, and would without the pin', async () => {
    const run = (cmd: string) => new Promise<number>((resolve) => {
      execFile('sh', ['-c', cmd], { timeout: 20_000 }, (error) => resolve(error ? 1 : 0));
    });
    // Pinned: refuses at the 302 itself.
    expect(await run(`wget -q --max-redirect=0 -O /dev/null ${origin}/start`)).toBe(1);
    // Unpinned: follows the 302 and fails only at the unreachable target, which
    // is a different failure — proving the pin is what stops it above.
    const unpinnedStderr = await new Promise<string>((resolve) => {
      execFile('sh', ['-c', `wget -O /dev/null ${origin}/start 2>&1 || true`], { timeout: 20_000 },
        (_e, out) => resolve(String(out)));
    });
    expect(unpinnedStderr).toContain('127.0.0.1:1');
  }, 40_000);
});

describe('the copied one-liner pins its own transport', () => {
  let redirector: Server;
  let httpOrigin: string;
  let redirectTargetPort = 0;

  beforeAll(async () => {
    // Redirects cross-scheme, to https on this same plain-HTTP listener.
    //
    // The unpinned counterfactual therefore does NOT retrieve a payload — it
    // dies in the TLS handshake. That is deliberate and the assertions below
    // claim only what it proves: the two cases fail for DIFFERENT reasons, so
    // the pinned failure is attributable to the protocol pin rather than to the
    // redirect being broken. Proving retrieval would need a trusted TLS
    // fixture, and adding `-k` to accept a self-signed certificate would change
    // the very command under test.
    redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `https://127.0.0.1:${redirectTargetPort}/followed`, connection: 'close' });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const address = redirector.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    httpOrigin = `http://127.0.0.1:${port}`;
    // Same server, http scheme — so an unpinned fetch reaches the payload while
    // a scheme-pinned one still sees a cross-scheme (https) redirect and stops.
    redirectTargetPort = port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
  });

  it('carries the same protocol pin as the download inside the script', () => {
    const code = freshCode();
    const https = controlledNodeInstallCommand('https://im.example.test', code, 'linux');
    expect(https).toContain("--proto '=https'");
    expect(https).toContain("--proto-redir '=https'");
    expect(https).toContain('--tlsv1.2');
    // The command and the script must not drift: both come from one helper.
    const script = renderControlledNodeInstallScript({
      serverUrl: 'https://im.example.test', installCode: code, os: 'linux', arch: 'x64',
    }).body;
    expect(script).toContain("--proto '=https' --proto-redir '=https' --tlsv1.2");

    const loopback = controlledNodeInstallCommand('http://localhost', code, 'linux');
    expect(loopback).toContain("--proto '=http'");
    expect(loopback).not.toContain('https');

    // PowerShell has no scheme switch, and /i/:code never redirects, so any 3xx
    // is illegitimate and refused outright.
    expect(controlledNodeInstallCommand('https://im.example.test', code, 'win'))
      .toContain('-MaximumRedirection 0');
  });

  it('refuses a cross-scheme redirect instead of following it', async () => {
    const code = freshCode();
    const command = controlledNodeInstallCommand(httpOrigin, code, 'linux');
    // Strip the `| sudo sh` tail: we are testing the fetch, not installing.
    const fetchOnly = command.replace(/\s*\|\s*sudo sh\s*$/, '');
    const pinnedOutput = await new Promise<string>((resolve) => {
      execFile('sh', ['-c', `${fetchOnly} 2>&1 || true`], { timeout: 20_000 },
        (_e, out) => resolve(String(out)));
    });
    // Not merely "it failed": the failure must be the protocol refusal itself.
    expect(pinnedOutput).toContain('Protocol "https" disabled');

    // Counterfactual: the same fetch WITHOUT the pin follows the redirect, so
    // the assertion above is testing the pin and not some unrelated failure.
    const unpinned = fetchOnly.replace(/--proto '=http' --proto-redir '=http' /, '');
    expect(unpinned).not.toBe(fetchOnly);
    const unpinnedOutput = await new Promise<string>((resolve) => {
      execFile('sh', ['-c', `${unpinned} 2>&1 || true`], { timeout: 20_000 },
        (_e, out) => resolve(String(out)));
    });
    // The counterfactual's whole job is to show the pinned failure above is
    // caused by the pin. Without it curl accepts the cross-scheme redirect and
    // proceeds to the target, failing later and differently (TLS, because the
    // target is https on a plain listener) — never with a protocol refusal.
    expect(unpinnedOutput).not.toContain('Protocol "https" disabled');
    expect(unpinnedOutput).toMatch(/SSL|TLS|handshake|error:/i);
  }, 40_000);
});

describe('generated installer runs against a loopback HTTP origin', () => {
  const PAYLOAD = '#!/bin/sh\necho INSTALLED-OK\n';
  let server: Server;
  let origin: string;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'imcodes-installer-exec-'));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const ok = req.method === 'POST'
          && (req.url ?? '').startsWith('/api/enroll/v2/download')
          && body.includes('ticket=');
        res.writeHead(ok ? 200 : 401, {
          'content-type': 'application/octet-stream',
          'content-length': String(ok ? PAYLOAD.length : 4),
          connection: 'close',
        });
        res.end(ok ? PAYLOAD : 'nope');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /** Bounded run: a hang fails the test rather than stalling the suite. */
  function runScript(script: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const path = join(dir, 'installer.sh');
      void writeFile(path, `id() { echo 0; }\nuname() { echo Linux; }\n${script}`).then(() => {
        execFile('sh', [path], { timeout: 20_000, encoding: 'utf8' }, (error, stdout, stderr) => {
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            code: error ? Number((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          });
        });
      });
    });
  }

  it('downloads and executes the artifact over plain loopback HTTP', async () => {
    const code = freshCode();
    const { body } = renderControlledNodeInstallScript({
      serverUrl: origin, installCode: code, os: 'linux', arch: 'x64',
    });
    const run = await runScript(body);
    expect(run.stderr).not.toContain('Protocol "http" disabled');
    expect(run.stdout).toContain('INSTALLED-OK');
    expect(run.code).toBe(0);
  }, 40_000);

  it('would have aborted before the request with the HTTPS-only flag', async () => {
    const code = freshCode();
    const { body } = renderControlledNodeInstallScript({
      serverUrl: origin, installCode: code, os: 'linux', arch: 'x64',
    });
    // Reintroduce exactly the defect and confirm this harness detects it.
    // replaceAll, not replace: the flag string also appears in the non-root
    // hint line, so a single-occurrence replace patched the echo and left the
    // real curl call pinned — the script then still succeeded and this test
    // silently stopped reintroducing anything.
    const broken = body.replaceAll(
      "--proto '=http' --proto-redir '=http'",
      "--proto '=https' --proto-redir '=https' --tlsv1.2",
    );
    // Guard the guard, on the invocation that actually performs the download
    // rather than on the script as a whole.
    const curlLine = (text: string): string =>
      text.split('\n').find((line) => line.trimStart().startsWith('curl -fsSL')) ?? '';
    expect(curlLine(broken)).not.toBe(curlLine(body));
    expect(curlLine(broken)).toContain("--proto '=https'");
    const run = await runScript(broken);
    expect(run.stdout).not.toContain('INSTALLED-OK');
    expect(run.code).not.toBe(0);
  }, 40_000);
});
