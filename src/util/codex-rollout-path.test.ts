import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findCodexRolloutPathByUuid,
  extractCodexRolloutUuid,
  recentCodexSessionDirs,
  getCodexHome,
} from './codex-rollout-path.js';

let home: string;

async function writeRollout(y: string, m: string, d: string, name: string, mtimeMs?: number): Promise<string> {
  const dir = join(home, 'sessions', y, m, d);
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, '{"type":"session_meta"}\n');
  if (mtimeMs != null) await utimes(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codex-rollout-test-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('findCodexRolloutPathByUuid', () => {
  it('finds a recent thread rollout', async () => {
    const uuid = '019ea2bf-73a7-7e52-ad1f-574a690741aa';
    const p = await writeRollout('2026', '06', '07', `rollout-2026-06-07T23-41-56-${uuid}.jsonl`);
    expect(await findCodexRolloutPathByUuid(uuid, { codexHome: home })).toBe(p);
  });

  it('REGRESSION: finds a long-lived thread whose creation-date dir is far older than any recent-day window', async () => {
    // The exact Cx2 shape: thread created months ago, dir named by creation date,
    // file still actively appended (recent mtime). The old 30-day window missed this.
    const uuid = '019e7d80-c802-7263-b4e1-a0a08154fdaf';
    const recentMtime = Date.now();
    const p = await writeRollout('2024', '01', '15', `rollout-2024-01-15T18-07-32-${uuid}.jsonl`, recentMtime);
    // also drop unrelated newer dirs to ensure enumeration walks past them
    await writeRollout('2026', '06', '07', 'rollout-2026-06-07T00-00-00-11111111-1111-1111-1111-111111111111.jsonl');
    expect(await findCodexRolloutPathByUuid(uuid, { codexHome: home })).toBe(p);
  });

  it('returns null for an unknown uuid', async () => {
    await writeRollout('2026', '06', '07', 'rollout-2026-06-07T23-41-56-019ea2bf-73a7-7e52-ad1f-574a690741aa.jsonl');
    expect(await findCodexRolloutPathByUuid('ffffffff-ffff-ffff-ffff-ffffffffffff', { codexHome: home })).toBeNull();
  });

  it('returns null when the sessions root does not exist', async () => {
    expect(await findCodexRolloutPathByUuid('019ea2bf-73a7-7e52-ad1f-574a690741aa', { codexHome: home })).toBeNull();
  });

  it('prefers the newest directory when a uuid degenerately appears twice', async () => {
    const uuid = '019e0000-0000-7000-8000-000000000000';
    await writeRollout('2025', '03', '10', `rollout-2025-03-10T10-00-00-${uuid}.jsonl`, Date.now() - 86_400_000);
    const newer = await writeRollout('2026', '05', '31', `rollout-2026-05-31T10-00-00-${uuid}.jsonl`, Date.now());
    expect(await findCodexRolloutPathByUuid(uuid, { codexHome: home })).toBe(newer);
  });

  it('ignores non-rollout and non-jsonl files', async () => {
    const uuid = '019e1111-2222-7333-8444-555566667777';
    const dir = join(home, 'sessions', '2026', '06', '07');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `not-a-rollout-${uuid}.jsonl`), 'x');
    await writeFile(join(dir, `rollout-2026-06-07T00-00-00-${uuid}.txt`), 'x');
    expect(await findCodexRolloutPathByUuid(uuid, { codexHome: home })).toBeNull();
  });

  it('resolves codex home from opts.env.CODEX_HOME', async () => {
    const uuid = '019e2222-3333-7444-8555-666677778888';
    const p = await writeRollout('2026', '04', '01', `rollout-2026-04-01T12-00-00-${uuid}.jsonl`);
    expect(await findCodexRolloutPathByUuid(uuid, { env: { CODEX_HOME: home } })).toBe(p);
  });
});

describe('extractCodexRolloutUuid', () => {
  it('parses the uuid from a rollout filename', () => {
    expect(
      extractCodexRolloutUuid('/x/sessions/2026/05/31/rollout-2026-05-31T18-07-32-019e7d80-c802-7263-b4e1-a0a08154fdaf.jsonl'),
    ).toBe('019e7d80-c802-7263-b4e1-a0a08154fdaf');
  });
  it('returns null for a non-rollout path', () => {
    expect(extractCodexRolloutUuid('/x/notes.jsonl')).toBeNull();
    expect(extractCodexRolloutUuid('/x/rollout-no-uuid.jsonl')).toBeNull();
  });
});

describe('helpers', () => {
  it('recentCodexSessionDirs returns `days` dirs under <home>/sessions', () => {
    const dirs = recentCodexSessionDirs(home, 5);
    expect(dirs).toHaveLength(5);
    for (const d of dirs) expect(d.startsWith(join(home, 'sessions'))).toBe(true);
  });
  it('getCodexHome honors CODEX_HOME override', () => {
    expect(getCodexHome({ CODEX_HOME: '/tmp/custom-codex' })).toBe('/tmp/custom-codex');
  });
});
