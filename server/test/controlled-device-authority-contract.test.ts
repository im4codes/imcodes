import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { machinesRoutes } from '../src/routes/machines.js';

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

/**
 * Every controlled-device capability family must consume the same
 * owner-or-active-Participant authority. This is a contract matrix, not a
 * runtime allowlist: capability implementations remain free to add feature
 * checks after authority, while a new action route makes the route inventory
 * assertion fail until its Participant-parity case is added.
 */
const AUTHORITY_MATRIX = [
  ['command execution', '../src/routes/machine-exec.ts', 'resolveMachineOperationalAccess'],
  ['OCU / Computer Use', '../src/routes/machine-computer-use.ts', 'resolveMachineOperationalAccess'],
  ['file operations and transfers', '../src/routes/file-transfer.ts', 'resolveControlledMachineOperatorAccess'],
  ['status and device actions', '../src/routes/machines.ts', 'resolveControlledMachineOperatorAccess'],
  ['controlled-device websocket admission', '../src/security/authorization.ts', 'resolveControlledMachineOperatorAccess'],
  ['remote desktop and control', '../src/ws/remote-desktop-router.ts', 'resolveRemoteDesktopHostOperatorAccess'],
] as const;

const MACHINE_ACTION_PATHS = [
  '/:serverId/auto-unlock',
  '/:serverId/display-name',
  '/:serverId/exec-enabled',
  '/:serverId/remote-desktop-worker',
  '/:serverId/revoke',
] as const;

describe('controlled-device owner/Participant authority contract', () => {
  it.each(AUTHORITY_MATRIX)('%s consumes the centralized operator authority', (_family, file, helper) => {
    expect(source(file)).toContain(helper);
  });

  it('has no operational route using the raw controlled-device access lookup', () => {
    for (const [, file] of AUTHORITY_MATRIX) {
      if (file.endsWith('remote-desktop-router.ts')) continue;
      expect(source(file)).not.toMatch(/\bresolveControlledMachineAccess\b/);
    }
  });

  it('binds delegated session authority and exact target at one centralized action boundary', () => {
    const authority = source('../src/share/shared-machine-authority.ts');
    expect(authority).toContain('export async function resolveMachineOperationalAccess');
    expect(authority).toContain('resolveSharedMachineAuthority(db, input)');
    expect(authority).toContain('resolveControlledMachineOperatorAccess(');
    expect(authority).toContain('input.targetServerId');
  });

  it('forces every newly registered device action into the Participant-parity matrix', () => {
    expect([...new Set(machinesRoutes.routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((route) => route.includes('/:serverId/')))]
      .sort()).toEqual(MACHINE_ACTION_PATHS.map((path) => `POST ${path}`).sort());
  });

  it.each(MACHINE_ACTION_PATHS)('%s admits through the centralized authority without a downstream owner predicate', (path) => {
    const routes = source('../src/routes/machines.ts');
    const start = routes.indexOf(`machinesRoutes.post('${path}'`);
    const next = routes.indexOf('machinesRoutes.post(', start + 1);
    const handler = routes.slice(start, next < 0 ? undefined : next);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('resolveControlledMachineOperatorAccess');
    expect(handler).not.toMatch(/servers\.user_id\s*=|\bAND\s+user_id\s*=/);
  });

  it('keeps sharing management outside operator authority', () => {
    const sharing = source('../src/routes/tab-sharing.ts');
    expect(sharing).not.toContain('resolveControlledMachineOperatorAccess');
    expect(sharing).toContain('return server.user_id === userId');
  });
});
