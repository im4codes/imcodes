import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('command-handler memory skill query/read/delete integration', () => {
  it('auto-indexes agent skills on SKILL_QUERY, previews via SKILL_READ, and blocks external deletion with SKILL_OUTSIDE_MANAGED_ROOTS', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-cmd-skill-home-'));
    cleanup.push(homeDir);

    const extSkillPath = join(homeDir, '.claude', 'skills', 'openspec-explore', 'SKILL.md');
    await mkdir(join(homeDir, '.claude', 'skills', 'openspec-explore'), { recursive: true });
    await writeFile(
      extSkillPath,
      '---\nname: openspec-explore\ndescription: Explore code\nversion: 3\nmetadata:\n  author: test\n---\n# Openspec Explore\nBody content\n',
    );
    await mkdir(join(homeDir, '.imcodes', 'skills', 'general'), { recursive: true });
    await writeFile(
      join(homeDir, '.imcodes', 'skills', 'general', 'managed-note.md'),
      '---\nschemaVersion: 1\nname: managed-note\ncategory: general\ndescription: Managed skill\n---\nManaged body\n',
    );

    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('IMCODES_HOME', join(homeDir, '.imcodes'));
    vi.resetModules();

    const { MEMORY_WS } = await import('../../shared/memory-ws.js');
    const { MEMORY_MANAGEMENT_ERROR_CODES } = await import('../../shared/memory-management.js');
    const { MEMORY_MANAGEMENT_CONTEXT_FIELD } = await import('../../shared/memory-management-context.js');
    const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
    const { SKILL_REGISTRY_TESTING } = await import('../../src/context/skill-registry.js');
    SKILL_REGISTRY_TESTING.reset();

    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (msg: Record<string, unknown>) => sent.push(msg) } as unknown as Parameters<typeof handleWebCommand>[1];
    const mgmtContext = (requestId: string) => ({
      actorId: 'user-1',
      userId: 'user-1',
      role: 'user' as const,
      requestId,
      source: 'local_daemon' as const,
    });

    handleWebCommand({
      type: MEMORY_WS.SKILL_QUERY,
      requestId: 'req-query-1',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: mgmtContext('req-query-1'),
    }, serverLink);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === MEMORY_WS.SKILL_RESPONSE && m.requestId === 'req-query-1')).toBe(true);
    });
    const queryResp = sent.find((m) => m.type === MEMORY_WS.SKILL_RESPONSE && m.requestId === 'req-query-1') as {
      entries: Array<{ key: string; layer: string; name: string; displayPath: string }>;
    };
    const extEntry = queryResp.entries.find((e) => e.name === 'openspec-explore');
    const managedEntry = queryResp.entries.find((e) => e.name === 'managed-note');
    expect(extEntry).toBeDefined();
    expect(extEntry!.displayPath).toBe('~/.claude/skills/openspec-explore/SKILL.md');
    expect(extEntry!.displayPath).not.toContain(homeDir);
    expect(managedEntry).toBeDefined();

    // Preview reads external agent skill successfully
    handleWebCommand({
      type: MEMORY_WS.SKILL_READ,
      requestId: 'req-read-1',
      key: extEntry!.key,
      layer: extEntry!.layer,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: mgmtContext('req-read-1'),
    }, serverLink);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === MEMORY_WS.SKILL_READ_RESPONSE && m.requestId === 'req-read-1')).toBe(true);
    });
    const readResp = sent.find((m) => m.type === MEMORY_WS.SKILL_READ_RESPONSE && m.requestId === 'req-read-1') as {
      success: boolean;
      content?: string;
    };
    expect(readResp.success).toBe(true);
    expect(readResp.content).toContain('# Openspec Explore');

    // Delete blocks external agent skill and preserves file on disk
    handleWebCommand({
      type: MEMORY_WS.SKILL_DELETE,
      requestId: 'req-del-ext',
      key: extEntry!.key,
      layer: extEntry!.layer,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: mgmtContext('req-del-ext'),
    }, serverLink);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === MEMORY_WS.SKILL_DELETE_RESPONSE && m.requestId === 'req-del-ext')).toBe(true);
    });
    const delExtResp = sent.find((m) => m.type === MEMORY_WS.SKILL_DELETE_RESPONSE && m.requestId === 'req-del-ext') as {
      success: boolean;
      errorCode?: string;
    };
    expect(delExtResp.success).toBe(false);
    expect(delExtResp.errorCode).toBe(MEMORY_MANAGEMENT_ERROR_CODES.SKILL_OUTSIDE_MANAGED_ROOTS);
    expect(await readFile(extSkillPath, 'utf8')).toContain('# Openspec Explore');

    // Delete managed skill still preserves external agent entries in registry.json
    handleWebCommand({
      type: MEMORY_WS.SKILL_DELETE,
      requestId: 'req-del-managed',
      key: managedEntry!.key,
      layer: managedEntry!.layer,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: mgmtContext('req-del-managed'),
    }, serverLink);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === MEMORY_WS.SKILL_DELETE_RESPONSE && m.requestId === 'req-del-managed')).toBe(true);
    });
    const delManagedResp = sent.find((m) => m.type === MEMORY_WS.SKILL_DELETE_RESPONSE && m.requestId === 'req-del-managed') as {
      success: boolean;
    };
    expect(delManagedResp.success).toBe(true);

    // Query again: external agent skill remains indexed, managed skill is gone
    handleWebCommand({
      type: MEMORY_WS.SKILL_QUERY,
      requestId: 'req-query-2',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: mgmtContext('req-query-2'),
    }, serverLink);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === MEMORY_WS.SKILL_RESPONSE && m.requestId === 'req-query-2')).toBe(true);
    });
    const queryResp2 = sent.find((m) => m.type === MEMORY_WS.SKILL_RESPONSE && m.requestId === 'req-query-2') as {
      entries: Array<{ name: string }>;
    };
    expect(queryResp2.entries.some((e) => e.name === 'openspec-explore')).toBe(true);
    expect(queryResp2.entries.some((e) => e.name === 'managed-note')).toBe(false);
  });

  it('refuses SKILL_READ immediately after indexed symlink redirects outside homeDir and purges it on SKILL_QUERY', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-cmd-f2-home-'));
    const outside = await mkdtemp(join(tmpdir(), 'imcodes-cmd-f2-out-'));
    cleanup.push(homeDir, outside);

    await mkdir(join(homeDir, 'shared-store', 'linked'), { recursive: true });
    await writeFile(
      join(homeDir, 'shared-store', 'linked', 'SKILL.md'),
      '---\nname: linked\ndescription: Valid link target\n---\nVALID_TARGET_BODY\n',
    );
    await mkdir(join(homeDir, '.codex', 'skills', 'good'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex', 'skills', 'good', 'SKILL.md'),
      '---\nname: good\ndescription: Good skill\n---\nGOOD_BODY\n',
    );
    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    const linkDir = join(homeDir, '.claude', 'skills', 'linked');
    await symlink(join(homeDir, 'shared-store', 'linked'), linkDir, 'dir');

    await mkdir(join(outside, 'evil'), { recursive: true });
    await writeFile(
      join(outside, 'evil', 'SKILL.md'),
      '---\nname: linked\ndescription: Outside target\n---\nOUTSIDE_SCOPE_SECRET\n',
    );

    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('IMCODES_HOME', join(homeDir, '.imcodes'));
    vi.resetModules();

    const { MEMORY_WS } = await import('../../shared/memory-ws.js');
    const { MEMORY_MANAGEMENT_ERROR_CODES } = await import('../../shared/memory-management.js');
    const { MEMORY_MANAGEMENT_CONTEXT_FIELD } = await import('../../shared/memory-management-context.js');
    const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
    const { SKILL_REGISTRY_TESTING } = await import('../../src/context/skill-registry.js');
    SKILL_REGISTRY_TESTING.reset();

    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (msg: Record<string, unknown>) => sent.push(msg) } as unknown as Parameters<typeof handleWebCommand>[1];
    const mgmtContext = (requestId: string) => ({
      actorId: 'user-1',
      userId: 'user-1',
      role: 'user' as const,
      requestId,
      source: 'local_daemon' as const,
    });

    handleWebCommand({
      type: MEMORY_WS.SKILL_QUERY,
      requestId: 'req-q1',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: mgmtContext('req-q1'),
    }, serverLink);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === MEMORY_WS.SKILL_RESPONSE && m.requestId === 'req-q1')).toBe(true);
    });
    const q1 = sent.find((m) => m.type === MEMORY_WS.SKILL_RESPONSE && m.requestId === 'req-q1') as {
      entries: Array<{ key: string; name: string; layer: string }>;
    };
    const linkedEntry = q1.entries.find((e) => e.name === 'linked');
    expect(linkedEntry).toBeDefined();

    // Redirect indexed symlink outside homeDir BEFORE SKILL_READ
    await rm(linkDir, { recursive: true, force: true });
    await symlink(join(outside, 'evil'), linkDir, 'dir');

    handleWebCommand({
      type: MEMORY_WS.SKILL_READ,
      requestId: 'req-read-esc',
      key: linkedEntry!.key,
      layer: linkedEntry!.layer,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: mgmtContext('req-read-esc'),
    }, serverLink);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === MEMORY_WS.SKILL_READ_RESPONSE && m.requestId === 'req-read-esc')).toBe(true);
    });
    const readEscResp = sent.find((m) => m.type === MEMORY_WS.SKILL_READ_RESPONSE && m.requestId === 'req-read-esc') as {
      success: boolean;
      errorCode?: string;
      content?: string;
    };
    expect(readEscResp.success).toBe(false);
    expect(readEscResp.errorCode).toBe(MEMORY_MANAGEMENT_ERROR_CODES.SKILL_PATH_NOT_READABLE);
    expect(readEscResp.content ?? '').not.toContain('OUTSIDE_SCOPE_SECRET');

    handleWebCommand({
      type: MEMORY_WS.SKILL_QUERY,
      requestId: 'req-q2',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: mgmtContext('req-q2'),
    }, serverLink);

    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === MEMORY_WS.SKILL_RESPONSE && m.requestId === 'req-q2')).toBe(true);
    });
    const q2 = sent.find((m) => m.type === MEMORY_WS.SKILL_RESPONSE && m.requestId === 'req-q2') as {
      entries: Array<{ name: string }>;
    };
    expect(q2.entries.some((e) => e.name === 'linked')).toBe(false);
    expect(q2.entries.some((e) => e.name === 'good')).toBe(true);
  });
});
