import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isNonDaemonProcess,
  markDaemonProcess,
  markNonDaemonProcess,
  resetProcessRoleForTests,
} from '../../src/daemon/process-role.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(resolve(repoRoot, file), 'utf8');

afterEach(() => resetProcessRoleForTests());

describe('process role', () => {
  it('an unmarked process (tests, embedded use) is not treated as a helper', () => {
    expect(isNonDaemonProcess()).toBe(false);
  });

  it('a helper marks itself non-daemon', () => {
    markNonDaemonProcess();
    expect(isNonDaemonProcess()).toBe(true);
  });

  it('the daemon overrides the helper mark that `imcodes start` set on its way in', () => {
    markNonDaemonProcess(); // runCli()
    markDaemonProcess(); // lifecycle.startup() after the instance lock
    expect(isNonDaemonProcess()).toBe(false);
  });

  it('a running daemon can never be demoted by a late helper mark', () => {
    markDaemonProcess();
    markNonDaemonProcess();
    expect(isNonDaemonProcess()).toBe(false);
  });
});

// The helper-process guard is only as good as its wiring. These pin the three
// places that decide a process's role and the two daemon-only operations it
// protects, so a refactor cannot silently re-open the cross-process replay
// (a helper restoring the daemon's runtimes and draining its durable queue).
describe('process role wiring', () => {
  it('every CLI command marks itself a non-daemon process before running', () => {
    const cli = read('src/cli.ts');
    const body = cli.slice(cli.indexOf('export function runCli'));
    expect(body.indexOf('markNonDaemonProcess()')).toBeGreaterThan(-1);
    expect(body.indexOf('markNonDaemonProcess()')).toBeLessThan(body.indexOf('program.parseAsync'));
  });

  it('the stdio MCP entry marks itself non-daemon before starting either MCP mode', () => {
    const index = read('src/index.ts');
    const mark = index.indexOf('markNonDaemonProcess()');
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(index.indexOf('runMemoryMcpServer()'));
    expect(mark).toBeLessThan(index.indexOf('runMemoryMcpBootstrap()'));
  });

  it('the daemon marks itself right after taking the instance lock, before any runtime restore', () => {
    const lifecycle = read('src/daemon/lifecycle.ts');
    const lock = lifecycle.indexOf('configureSessionStoreWriteAuthority(lockServer.identity');
    const mark = lifecycle.indexOf('markDaemonProcess()');
    expect(lock).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(lock);
    expect(mark).toBeLessThan(lifecycle.indexOf('await restoreFromStore()'));
  });

  it('restoreTransportSessions and on-demand recovery both refuse in a non-daemon process', () => {
    const manager = read('src/agent/session-manager.ts');
    const restore = manager.slice(manager.indexOf('export async function restoreTransportSessions('));
    expect(restore.slice(0, 1200)).toContain('isNonDaemonProcess()');
    const ensure = manager.slice(manager.indexOf('export async function ensureTransportRuntimeAvailable('));
    expect(ensure.slice(0, 1200)).toContain('isNonDaemonProcess()');
  });
});
