import { describe, expect, it } from 'vitest';
import { readSourceAsync } from '../helpers/read-source.js';

const root = new URL('../../', import.meta.url);

describe('process shared machine authority: wiring', () => {
  it('releases the participant window on the daemon-wide session.state idle edge (not on a resync replay)', async () => {
    const lifecycle = await readSourceAsync(new URL('src/daemon/lifecycle.ts', root));
    const idleBranch = lifecycle.slice(lifecycle.indexOf('Wire timeline idle events'));
    const resyncGuard = idleBranch.indexOf('isServerLinkResyncStatePayload(e.payload)');
    const release = idleBranch.indexOf('releaseProcessSharedMachineAuthority(e.sessionId)');
    expect(resyncGuard).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(resyncGuard);
    expect(idleBranch.slice(resyncGuard, release)).toContain("state === 'idle'");
  });

  it('the hook answers from the live process window using the session running state', async () => {
    const hook = await readSourceAsync(new URL('src/daemon/hook-server.ts', root));
    expect(hook).toMatch(/readProcessSharedMachineAuthority\(session\.name,[\s\S]{0,200}session\.state === 'running'/);
  });

  it('both process input paths bind through the same function', async () => {
    const handler = await readSourceAsync(new URL('src/daemon/command-handler.ts', root));
    expect(handler.match(/bindProcessSharedMachineCommand\(/g)?.length).toBe(2);
    expect(handler).not.toContain('bindProcessSharedMachineAuthority');
  });
});
