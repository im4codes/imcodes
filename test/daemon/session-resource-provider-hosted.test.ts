/**
 * Provider-hosted MCP reaping through the daemon's real service entry points,
 * with real processes (real signals, real `ps` start-time identity) under an
 * isolated IMCODES_HOME.
 *
 * Production incident (Cx1, 2026-09-25): relaunch child-cleanup SIGTERMed the
 * MCP server of a Codex thread that the new runtime then resumed; Codex never
 * respawns it, so every IM call failed with "Transport closed". The fix keeps a
 * hosted child alive while its thread continues -- and, per the re-audit P1,
 * must still reap it (at whatever epoch it was registered under) on every path
 * that ends this instance's use of the thread, or it leaks (~75 MB each).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_RESOURCE_LIFETIME } from '../../shared/session-resource-lifecycle.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const isWin = process.platform === 'win32';
const home = mkdtempSync(join(tmpdir(), 'imcodes-provider-hosted-'));
let service: typeof import('../../src/daemon/session-resource-service.js');
const children: ChildProcess[] = [];

beforeAll(async () => {
  vi.stubEnv('IMCODES_HOME', home);
  vi.resetModules();
  // The service's registry and lifecycle log resolve IMCODES_HOME at import.
  service = await import('../../src/daemon/session-resource-service.js');
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function exited(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

let seq = 0;
async function relaunchedSession() {
  seq += 1;
  const name = `deck_hostedtest${seq}_w1`;
  const instance = `instance-${seq}`;
  const epoch1 = { sessionName: name, sessionInstanceId: instance, runtimeEpoch: `epoch1-${seq}` };
  const epoch2 = { ...epoch1, runtimeEpoch: `epoch2-${seq}` };
  // The thread's MCP pair was registered when Codex loaded the thread (epoch1);
  // the session has since been relaunched to epoch2.
  const hostedOld = sleeper();
  const runtimeBound = sleeper();
  await service.registerMcpProcessResource(epoch1, hostedOld.pid!, false, 'mcp-bootstrap', SESSION_RESOURCE_LIFETIME.PROVIDER_HOST);
  await service.registerMcpProcessResource(epoch2, runtimeBound.pid!, false, 'mcp');
  const record = {
    name, sessionInstanceId: instance, runtimeEpoch: epoch2.runtimeEpoch, agentType: 'codex-sdk', state: 'running',
  } as unknown as SessionRecord;
  return { record, hostedOld, runtimeBound };
}

describe.skipIf(isWin)('provider-hosted MCP reaping through the daemon service (real processes)', () => {
  it('a relaunch that resumes the same loaded thread keeps its hosted MCP child alive', async () => {
    const { record, hostedOld, runtimeBound } = await relaunchedSession();
    await service.releaseSessionChildResources(record, { providerThreadContinues: true });
    expect(await exited(runtimeBound), 'runtime-bound children still die with the old runtime').toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(hostedOld), 'the still-loaded thread keeps its MCP server').toBe(true);
  });

  it('a reset / agent-switch relaunch reaps the abandoned thread\'s hosted child from the old epoch', async () => {
    const { record, hostedOld } = await relaunchedSession();
    await service.releaseSessionChildResources(record, { providerThreadContinues: false });
    expect(await exited(hostedOld)).toBe(true);
  });

  it('stop/delete reaps the old-epoch hosted child and records the kill', async () => {
    const { record, hostedOld } = await relaunchedSession();
    const summary = await service.releaseSessionResources(record);
    expect(summary.failed).toBe(0);
    expect(await exited(hostedOld)).toBe(true);
    const events = readFileSync(join(home, 'logs', 'mcp-lifecycle.log'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'resource_released',
      targetPid: hostedOld.pid,
      lifetime: 'provider_host',
      session: record.name,
      reason: 'session_completed',
      outcome: 'released',
    }));
  });
});
