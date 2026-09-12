/**
 * End-to-end hook endpoint authority against a REAL listener.
 *
 * Covers what the unit suite cannot: that the server actually answers
 * `/hook-identity` with its own process identity, that a client resolves the
 * live endpoint by VERIFYING that identity, and that losing the listener
 * self-heals (rebind + republish) without restarting the daemon.
 *
 * Every test injects `authorityHome` (a temp dir). Nothing here may read or
 * write the machine-global `~/.imcodes/hook-port`; an outer regression asserts
 * that byte-for-byte.
 */
import http from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above module scope, so the doubles they close
// over must be created with vi.hoisted.
const { getSessionMock, upsertSessionMock, listSessionsMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  listSessionsMock: vi.fn(() => []),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { closeHookServer, startHookServer, HookStartupPublishError } from '../../src/daemon/hook-server.js';
import {
  fetchHookIdentity,
  probeHookPort,
  publishHookAuthority,
  readHookAuthorityState,
  resolveHookAuthority,
  hookPortFilePath,
  hookAuthoritySidecarPath,
  HOOK_BIND_RETRY_SPAN,
} from '../../src/daemon/hook-port.js';
import logger from '../../src/util/logger.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import {
  HOOK_AUTHORITY_ERROR,
  HOOK_IDENTITY_HOOK_PATH,
  isLegacyCompatibleHookPortFile,
} from '../../shared/hook-authority.js';

const homes: string[] = [];
const servers: http.Server[] = [];

/** The genuine owner-fenced publication, so a seam can fail N times and then
 *  hand over to the real production path rather than faking success. */
async function realPublish(port: number, _context: string, home?: string) {
  const result = await publishHookAuthority(port, {
    ...(home === undefined ? {} : { home, allowGlobalWriteInTests: true }),
  });
  return { published: result.published, ...(result.reason ? { reason: result.reason } : {}) };
}

/** Log MESSAGES a pino-style mock received (the message is the 2nd argument).
 *  Asserting on the message is what makes "did it claim success?" checkable. */
function loggedMessages(fn: unknown): string[] {
  const calls = (fn as { mock: { calls: unknown[][] } }).mock.calls;
  return calls
    .map((call) => call[1])
    .filter((message): message is string => typeof message === 'string');
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'imcodes-hook-endpoint-'));
  homes.push(home);
  return home;
}

async function start(home: string, extra: Parameters<typeof startHookServer>[1] = {}) {
  const result = await startHookServer(vi.fn(), { authorityHome: home, ...extra });
  servers.push(result.server);
  return result;
}

function rawPost(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { agent: false, hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Length': '2' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
}

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { agent: false, hostname: '127.0.0.1', port, path, method: 'GET' },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server?.listening) await closeHookServer(server).catch(() => {});
  }
  while (homes.length) {
    const home = homes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe('hook endpoint authority against a real listener', () => {
  it('publishes a legacy-compatible port file plus an identity sidecar', async () => {
    const home = tempHome();
    const { port } = await start(home);

    // Digits only: this is what every already-installed reader parses.
    const bytes = readFileSync(hookPortFilePath(home), 'utf8');
    expect(bytes).toBe(`${port}\n`);
    expect(isLegacyCompatibleHookPortFile(bytes)).toBe(true);

    const state = readHookAuthorityState(home);
    expect(state.kind).toBe('record');
    if (state.kind !== 'record') return;
    expect(state.record.port).toBe(port);
    expect(state.record.pid).toBe(currentDaemonProcessIdentity().pid);
  });

  it('answers /hook-identity with its own process identity', async () => {
    const home = tempHome();
    const { port } = await start(home);

    const identity = await fetchHookIdentity(port);
    expect(identity).toMatchObject({
      version: 1,
      port,
      pid: currentDaemonProcessIdentity().pid,
    });

    // The route is POST-only, like every other hook route.
    expect(await get(port, HOOK_IDENTITY_HOOK_PATH)).toBe(404);
    const direct = await rawPost(port, HOOK_IDENTITY_HOOK_PATH);
    expect(direct.status).toBe(200);
    expect(JSON.parse(direct.body)).toMatchObject({ port });
  });

  it('resolves the live endpoint by verifying the owner, with no port scan', async () => {
    const home = tempHome();
    const { port } = await start(home);

    const probeListener = vi.fn(async () => true);
    const resolution = await resolveHookAuthority({ home, probeListener });
    expect(resolution).toMatchObject({ ok: true, port });
    // Identity verification, not connect-only trust.
    expect(probeListener).not.toHaveBeenCalled();
  });

  it('reports stale_hook_authority once the owning listener is gone', async () => {
    const home = tempHome();
    const { server } = await start(home);
    await closeHookServer(server);

    // Record still names this live process, so liveness alone cannot condemn it;
    // the identity route not answering on that exact port is what does.
    const resolution = await resolveHookAuthority({ home });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect([
      HOOK_AUTHORITY_ERROR.staleHookAuthority,
      HOOK_AUTHORITY_ERROR.hookUnavailable,
    ]).toContain(resolution.reason);
    // Never a memory-worker error.
    expect(resolution.reason).not.toBe('daemon_memory_worker_unavailable');
  });

  it('a second server cannot publish over the first while it is still live', async () => {
    const home = tempHome();
    const first = await start(home);
    const published = readHookAuthorityState(home);
    expect(published.kind).toBe('record');

    // Same process, so the fence permits a republish - but the RECORD must end
    // up describing a port that is actually served, never a half-updated pair.
    const second = await start(home);
    expect(second.port).not.toBe(first.port);
    const after = readHookAuthorityState(home);
    expect(after.kind).toBe('record');
    if (after.kind !== 'record') return;
    expect([first.port, second.port]).toContain(after.record.port);
    expect(readFileSync(hookPortFilePath(home), 'utf8')).toBe(`${after.record.port}\n`);
  });

  it('does NOT rebind when the holder closes the server itself (opt-out default)', async () => {
    const home = tempHome();
    const { server, port } = await start(home);
    await closeHookServer(server);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.listening).toBe(false);
    // Nothing re-took the port, and the record was not rewritten behind us.
    const state = readHookAuthorityState(home);
    if (state.kind === 'record') expect(state.record.port).toBe(port);
  });

  it('rebinds and republishes after a REAL, unmarked listener loss', async () => {
    const home = tempHome();
    // The rebind is GATED so the "endpoint is down" window is observable.
    // Without the gate, healing can complete before the assertions run - which
    // is good behaviour but would make the down-state assertion racy, and a
    // racy assertion is how the previous version of this test became vacuous.
    let releaseRebind = (): void => {};
    const rebindGate = new Promise<void>((resolve) => { releaseRebind = resolve; });
    let initialBindDone = false;
    const bindListener = async (target: http.Server, candidate: number): Promise<void> => {
      if (initialBindDone) await rebindGate;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        target.once('error', onError);
        target.listen(candidate, '127.0.0.1', () => {
          target.removeListener('error', onError);
          resolve();
        });
      });
      initialBindDone = true;
    };

    const { server, port } = await start(home, { rebindOnListenerLoss: true, bindListener });
    const before = readHookAuthorityState(home);
    expect(before.kind).toBe('record');
    if (before.kind !== 'record') return;
    expect(await fetchHookIdentity(port)).toMatchObject({ port });

    // A RAW close is a genuine listener loss that was never requested through
    // `closeHookServer`, so it is exactly what the daemon must heal from. The
    // previous version of this test emitted a synthetic 'close' while the server
    // was still listening; the handler then hit ERR_SERVER_ALREADY_LISTEN and the
    // rebind never happened, but the assertions could not tell.
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    expect(server.listening).toBe(false);

    // The old endpoint MUST be gone before recovery, otherwise "still reachable"
    // would satisfy the test without any rebind.
    expect(await probeHookPort(port, 200)).toBe(false);
    expect(await fetchHookIdentity(port, 200)).toBeNull();
    // The record still points at the dead port at this instant.
    expect(readHookAuthorityState(home)).toEqual(before);

    // Let the daemon heal in place.
    releaseRebind();
    let healedPort: number | null = null;
    for (let attempt = 0; attempt < 80 && healedPort === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const state = readHookAuthorityState(home);
      if (state.kind !== 'record') continue;
      const identity = await fetchHookIdentity(state.record.port, 200);
      if (identity && identity.port === state.record.port) healedPort = state.record.port;
    }

    expect(healedPort, 'hook server never rebound after the listener was lost').not.toBeNull();
    expect(server.listening).toBe(true);

    // A NEW authority publication, not the stale one we captured earlier.
    const after = readHookAuthorityState(home);
    expect(after.kind).toBe('record');
    if (after.kind !== 'record') return;
    expect(after.record.publishedAt).toBeGreaterThan(before.record.publishedAt);
    expect(after.record.port).toBe(healedPort);
    // Owner-verifiable end to end, and still digits-only for old readers.
    await expect(resolveHookAuthority({ home })).resolves.toMatchObject({ ok: true, port: healedPort });
    expect(readFileSync(hookPortFilePath(home), 'utf8')).toBe(`${healedPort}\n`);
    expect(isLegacyCompatibleHookPortFile(readFileSync(hookPortFilePath(home), 'utf8'))).toBe(true);

    // A rebind that logged an error is a FAILED rebind, even if something else
    // happened to make the probes pass.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('recovers when the loss arrives as an error while the socket is STILL listening', async () => {
    // This is the case the previous test accidentally created and then hid: an
    // `'error'` event does not release the handle, so the recovery path calls
    // `listen()` on a live server and Node throws ERR_SERVER_ALREADY_LISTEN -
    // which is not EADDRINUSE, so the bind loop rethrows and the whole rebind
    // aborts. The handle must be released first.
    const home = tempHome();
    const { server, port } = await start(home, { rebindOnListenerLoss: true });
    const before = readHookAuthorityState(home);
    expect(before.kind).toBe('record');
    if (before.kind !== 'record') return;
    expect(server.listening).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    server.emit('error', new Error('simulated listener error'));

    let healedPort: number | null = null;
    for (let attempt = 0; attempt < 80 && healedPort === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const state = readHookAuthorityState(home);
      if (state.kind !== 'record') continue;
      if (state.record.publishedAt <= before.record.publishedAt) continue;
      const identity = await fetchHookIdentity(state.record.port, 200);
      if (identity && identity.port === state.record.port) healedPort = state.record.port;
    }

    expect(healedPort, 'a still-listening error must still rebind').not.toBeNull();
    expect(server.listening).toBe(true);
    await expect(resolveHookAuthority({ home })).resolves.toMatchObject({ ok: true, port: healedPort });
    // ERR_SERVER_ALREADY_LISTEN would have surfaced here.
    expect(logger.error).not.toHaveBeenCalled();
    expect(port).toBeGreaterThan(0);
  });

  it('retries the whole bind window when every candidate is temporarily occupied', async () => {
    const home = tempHome();
    // Deterministic EADDRINUSE: a real port race cannot be reproduced reliably,
    // so the listen seam is injected. The first window (HOOK_BIND_RETRY_SPAN
    // candidates) is fully occupied; the next window succeeds.
    // Counts only POST-loss attempts. The initial bind uses the real listen so
    // it can walk past a port that something else on the machine owns (the
    // default 51913 is routinely held by a live daemon); counting those real
    // EADDRINUSE walks previously made the test depend on 51913 being free.
    let startupDone = false;
    let calls = 0;
    const realBind = async (target: http.Server, port: number): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        target.once('error', onError);
        target.listen(port, '127.0.0.1', () => {
          target.removeListener('error', onError);
          resolve();
        });
      });
    };
    const bindListener = async (target: http.Server, port: number): Promise<void> => {
      if (!startupDone) {
        await realBind(target, port);
        return;
      }
      calls += 1;
      // After the loss: fail one full window, then allow a bind.
      if (calls <= HOOK_BIND_RETRY_SPAN) {
        const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
        error.code = 'EADDRINUSE';
        throw error;
      }
      await realBind(target, port);
    };

    const { server, port } = await start(home, {
      rebindOnListenerLoss: true,
      bindListener,
      rebindRetry: { maxAttempts: 4, baseDelayMs: 10, capDelayMs: 40 },
    });
    startupDone = true;
    expect(calls).toBe(0);

    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    expect(await probeHookPort(port, 200)).toBe(false);

    let healedPort: number | null = null;
    for (let attempt = 0; attempt < 80 && healedPort === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const state = readHookAuthorityState(home);
      if (state.kind !== 'record') continue;
      const identity = await fetchHookIdentity(state.record.port, 200);
      if (identity && identity.port === state.record.port) healedPort = state.record.port;
    }

    expect(healedPort, 'a retried rebind must eventually succeed').not.toBeNull();
    // It exhausted a whole window and came back on a later attempt.
    expect(calls).toBeGreaterThan(HOOK_BIND_RETRY_SPAN);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('gives up with an explicit error after the bounded retries are exhausted', async () => {
    const home = tempHome();
    let firstBindDone = false;
    const bindListener = async (target: http.Server, port: number): Promise<void> => {
      if (firstBindDone) {
        const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
        error.code = 'EADDRINUSE';
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        target.once('error', onError);
        target.listen(port, '127.0.0.1', () => {
          target.removeListener('error', onError);
          resolve();
        });
      });
      firstBindDone = true;
    };

    const { server, port } = await start(home, {
      rebindOnListenerLoss: true,
      bindListener,
      rebindRetry: { maxAttempts: 3, baseDelayMs: 5, capDelayMs: 20 },
    });
    const before = readHookAuthorityState(home);

    await new Promise<void>((resolve) => { server.close(() => resolve()); });

    // Bounded: it must stop and say so, not spin forever.
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if ((logger.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0) break;
    }
    expect(logger.error).toHaveBeenCalled();
    expect(server.listening, 'exhausted bind retries must leave no listener').toBe(false);
    expect(await probeHookPort(port, 200)).toBe(false);
    // A failed rebind MUST NOT rewrite the record to a port it never bound.
    expect(readHookAuthorityState(home)).toEqual(before);
    // And no unadvertised endpoint survives anywhere in the bind window.
    for (let candidate = port; candidate < port + HOOK_BIND_RETRY_SPAN; candidate += 1) {
      const identity = await fetchHookIdentity(candidate, 100);
      expect(identity, `an unadvertised hook endpoint survived on ${candidate}`).toBeNull();
    }
  });

  it('does NOT report recovery until the authority is actually published', async () => {
    // PRODUCTION ORDER. Recovery has two steps - bind, then publish - and
    // clients route by the published record. The publish result used to be
    // swallowed, so a rebind logged "rebound and republished authority" and
    // stopped retrying even when the record was never written, leaving every
    // client pointed at the dead endpoint.
    const home = tempHome();
    const { server, port } = await start(home, {
      rebindOnListenerLoss: true,
      rebindRetry: { maxAttempts: 8, baseDelayMs: 20, capDelayMs: 60 },
    });
    const before = readHookAuthorityState(home);
    expect(before.kind).toBe('record');
    if (before.kind !== 'record') return;

    // Make publication fail for real while binding still succeeds.
    chmodSync(home, 0o500);
    let restored = false;
    try {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });

      // RED window: the listener comes back, but the record cannot be written.
      let sawRetry = false;
      for (let attempt = 0; attempt < 60 && !sawRetry; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        sawRetry = loggedMessages(logger.warn).some((m) => m.includes('rebind attempt failed, retrying'));
      }
      expect(sawRetry, 'a publish failure must drive the bounded retry').toBe(true);
      // The invariant: no success claim, and the record is untouched.
      expect(loggedMessages(logger.info)).not.toContain('Hook server: rebound and republished authority');
      expect(readHookAuthorityState(home)).toEqual(before);
      expect(logger.error).not.toHaveBeenCalled();

      // GREEN: let publication succeed; the still-active retry must converge.
      chmodSync(home, 0o700);
      restored = true;

      let healedPort: number | null = null;
      for (let attempt = 0; attempt < 80 && healedPort === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const state = readHookAuthorityState(home);
        if (state.kind !== 'record') continue;
        if (state.record.publishedAt <= before.record.publishedAt) continue;
        healedPort = state.record.port;
      }

      expect(healedPort, 'the retry must converge once publication can succeed').not.toBeNull();
      expect(loggedMessages(logger.info)).toContain('Hook server: rebound and republished authority');
      await expect(resolveHookAuthority({ home })).resolves.toMatchObject({ ok: true, port: healedPort });
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      if (!restored) chmodSync(home, 0o700);
    }
  });

  it('fails closed after bounded retries when the authority can never be published', async () => {
    const home = tempHome();
    const { server } = await start(home, {
      rebindOnListenerLoss: true,
      rebindRetry: { maxAttempts: 3, baseDelayMs: 5, capDelayMs: 20 },
    });
    const before = readHookAuthorityState(home);
    expect(before.kind).toBe('record');

    chmodSync(home, 0o500);
    try {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });

      for (let attempt = 0; attempt < 80; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if ((logger.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0) break;
      }

      // Bounded, loud, and honest: no success claim, record untouched.
      expect(logger.error).toHaveBeenCalled();
      expect(loggedMessages(logger.error)).toContain('Hook server: rebind failed; hook endpoint is down');
      expect(loggedMessages(logger.info)).not.toContain('Hook server: rebound and republished authority');
      expect(readHookAuthorityState(home)).toEqual(before);

      // THE MISSING ASSERTION. Without this the test accepted a live listener
      // bound to a port no client can discover: the record still names the old
      // endpoint, so every client is routed at a dead port while a healthy
      // socket serves an unadvertised one. Nothing may survive a failed
      // bind+publish.
      expect(server.listening, 'a failed rebind must not leave a listener bound').toBe(false);
      const stateAfter = readHookAuthorityState(home);
      const advertised = stateAfter.kind === 'record' ? stateAfter.record.port : null;
      expect(advertised).not.toBeNull();
      // The advertised endpoint is not reachable either, so there is no split:
      // clients get a determinate failure rather than a wrong answer.
      expect(await probeHookPort(advertised as number, 200)).toBe(false);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  it('converges at STARTUP after transient publish failures, with no close/error event', async () => {
    // The startup half of the same defect. `publishAuthority(...,'start')`'s
    // result was discarded and the rebind handler only fires on a later
    // error/close, so ONE startup write failure left a live listener paired with
    // a stale/missing record forever. Nothing here closes or errors the server:
    // convergence must happen inside the start transaction itself.
    const home = tempHome();
    const FAIL_TIMES = 2;
    let attempts = 0;

    const { port } = await start(home, {
      rebindRetry: { maxAttempts: 6, baseDelayMs: 5, capDelayMs: 20 },
      publishRecord: async (target, context, authorityHome) => {
        attempts += 1;
        if (attempts <= FAIL_TIMES) {
          return { published: false, reason: 'publish_write_failed' };
        }
        return realPublish(target, context, authorityHome);
      },
    });

    // start() resolved, so the endpoint MUST be discoverable right now - no
    // listener-loss event was ever needed.
    expect(attempts).toBe(FAIL_TIMES + 1);
    expect(loggedMessages(logger.warn))
      .toContain('Hook server: startup authority publish failed, retrying');
    const state = readHookAuthorityState(home);
    expect(state.kind).toBe('record');
    if (state.kind !== 'record') return;
    expect(state.record.port).toBe(port);
    await expect(resolveHookAuthority({ home })).resolves.toMatchObject({ ok: true, port });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('fails start and leaves NO listener when startup publication never succeeds', async () => {
    const home = tempHome();
    let attempts = 0;
    let started: { server: http.Server; port: number } | null = null;
    let failure: unknown = null;
    try {
      started = await startHookServer(vi.fn(), {
        authorityHome: home,
        rebindRetry: { maxAttempts: 3, baseDelayMs: 5, capDelayMs: 20 },
        publishRecord: async () => {
          attempts += 1;
          return { published: false, reason: 'publish_write_failed' };
        },
      });
      servers.push(started.server);
    } catch (err) {
      failure = err;
    }

    // Never return a live but undiscoverable endpoint.
    expect(started, 'startHookServer must not resolve when authority cannot be published').toBeNull();
    expect(failure).toBeInstanceOf(HookStartupPublishError);
    const typed = failure as HookStartupPublishError;
    expect(typed.attempts).toBe(3);
    expect(attempts).toBe(3);
    expect(typed.port).toBeGreaterThan(0);

    // No residual listener, and nothing published.
    expect(await probeHookPort(typed.port, 200)).toBe(false);
    expect(readHookAuthorityState(home).kind).not.toBe('record');
    expect(loggedMessages(logger.error))
      .toContain('Hook server: startup authority publish exhausted; closing listener and failing start');
  });

  it('rolls back the listener on EVERY failed bind+publish attempt', async () => {
    const home = tempHome();
    // Publication always fails, so every attempt binds and must then release.
    // Observing `listening` at each attempt boundary proves the rollback is per
    // attempt, not an accident of the next attempt's cleanup.
    const listeningAtAttempt: boolean[] = [];
    let attempts = 0;

    const { server } = await start(home, {
      rebindOnListenerLoss: true,
      rebindRetry: { maxAttempts: 3, baseDelayMs: 5, capDelayMs: 20 },
      publishRecord: async (target, context) => {
        if (context === 'start') return realPublish(target, context, home);
        attempts += 1;
        // Sampled INSIDE the attempt, while its listener is still bound.
        listeningAtAttempt.push(server.listening);
        return { published: false, reason: 'publish_write_failed' };
      },
    });

    await new Promise<void>((resolve) => { server.close(() => resolve()); });

    for (let i = 0; i < 80; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if ((logger.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0) break;
    }

    expect(attempts).toBe(3);
    // Each attempt really did bind before publishing...
    expect(listeningAtAttempt).toEqual([true, true, true]);
    // ...and nothing is left serving once the retries are exhausted.
    expect(server.listening).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('never touches the machine-global authority pair', async () => {
    const home = tempHome();
    await start(home);
    expect(existsSync(join(home, 'hook-port'))).toBe(true);
    // Sanity: the injected home is genuinely not the real one.
    expect(hookPortFilePath(home)).not.toBe(hookPortFilePath());
    expect(hookAuthoritySidecarPath(home)).not.toBe(hookAuthoritySidecarPath());
  });
});
