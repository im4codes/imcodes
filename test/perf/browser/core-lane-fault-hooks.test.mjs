import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('main-thread fault hook always writes a completed marker without legacy timer bindings', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'core-lane-hook-'));
  const marker = join(dir, 'block.marker');
  try {
    process.env.NODE_ENV = 'test';
    const module = await import('../../../dist/src/daemon/server-link.js');
    const result = module.runCoreLaneTestBlock({ blockMs: 1, blockMarkerFile: marker, pid: 1234, logger: { warn() {}, error() {} } });
    const persisted = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(persisted.pid, 1234);
    assert.equal(persisted.blockMs, 1);
    assert.equal(persisted.startedAt, result.startedAt);
    assert.equal(persisted.endedAt, result.endedAt);
    assert.ok(persisted.endedAt >= persisted.startedAt);
  } finally {
    delete process.env.NODE_ENV;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows shim accepts only a post-spawn ServerLink connection', async () => {
  process.env.IMC_WIN_SHIM_UNIT_TEST = '1';
  try {
    const { serverLinkReadyFromLog } = await import('./windows-control-shim.mjs');
    const stale = JSON.stringify({ time: 100, msg: 'ServerLink: connected' });
    const fresh = JSON.stringify({ time: 200, msg: 'ServerLink: connected' });
    assert.equal(serverLinkReadyFromLog(stale, 150), false);
    assert.equal(serverLinkReadyFromLog(`${stale}\n${fresh}`, 150), true);
    assert.equal(serverLinkReadyFromLog('{not-json}', 0), false);
  } finally {
    delete process.env.IMC_WIN_SHIM_UNIT_TEST;
  }
});
