import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSkillUri } from '../../shared/skill-registry-types.js';
import { buildProjectSkillRegistry, buildUserSkillRegistry } from '../../src/context/skill-registry-builder.js';
import { getSkillRegistryManagementSnapshot, getSkillRegistryPathsForManagement, writeSkillRegistryManagementSnapshot } from '../../src/context/skill-registry.js';
import {
  AGENT_SKILLS_ACTION,
  AGENT_SKILLS_ERROR,
  AGENT_SKILLS_MSG,
  isAgentSkillSource,
  readAgentSkillsRunRequest,
} from '../../shared/agent-skills.js';
import {
  agentSkillsCliArguments,
  createAgentSkillsRunner,
  expandAgentSkillReferences,
  handleAgentSkillsCommand,
  hasCommand,
  listAgentSkills,
  resolveAgentSkillReference,
} from '../../src/daemon/agent-skills.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-agent-skills-'));
  cleanup.push(dir);
  return dir;
}

async function skill(root: string, name: string, frontMatter: string): Promise<string> {
  const dir = join(root, '.agents', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontMatter}\n---\n\n# ${name}\n`);
  return dir;
}

describe('listAgentSkills', () => {
  it('lists each skill in ~/.agents/skills with its description and recorded source', async () => {
    const root = await home();
    await skill(root, 'wecomcli-doc', 'name: wecomcli-doc\ndescription: 企业微信文档\nversion: 3\nmetadata:\n  owner: someone');
    await skill(root, 'handmade', 'name: handmade\ndescription: "Made by hand"');
    await writeFile(join(root, '.agents', '.skill-lock.json'), JSON.stringify({
      version: 3,
      skills: { 'wecomcli-doc': { source: 'WeComTeam/wecom-cli', sourceUrl: 'https://github.com/WeComTeam/wecom-cli.git', installedAt: '2026-09-19T03:33:55.955Z', updatedAt: '2026-09-19T03:33:55.955Z' } },
    }));

    expect(await listAgentSkills(root)).toEqual([
      {
        name: 'handmade',
        description: 'Made by hand',
        layer: 'user_default',
        displayPath: '~/.agents/skills/handmade',
        uri: 'skill://user_default/handmade',
      },
      {
        name: 'wecomcli-doc',
        // Extra frontmatter keys belong to the skill; they are not a reason to hide it.
        description: '企业微信文档',
        source: 'WeComTeam/wecom-cli',
        sourceUrl: 'https://github.com/WeComTeam/wecom-cli.git',
        installedAt: '2026-09-19T03:33:55.955Z',
        updatedAt: '2026-09-19T03:33:55.955Z',
        layer: 'user_default',
        displayPath: '~/.agents/skills/wecomcli-doc',
        uri: 'skill://user_default/wecomcli-doc',
      },
    ]);
  });

  it('follows a linked skill directory, as the CLI and Windows junctions produce', async () => {
    const root = await home();
    const real = join(root, 'elsewhere', 'linked-skill');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'SKILL.md'), '---\nname: linked-skill\ndescription: linked\n---\n');
    await mkdir(join(root, '.agents', 'skills'), { recursive: true });
    await symlink(real, join(root, '.agents', 'skills', 'linked-skill'), 'dir');
    expect((await listAgentSkills(root)).map((entry) => entry.name)).toEqual(['linked-skill']);
  });

  it('skips what is not a skill, and a missing directory is simply empty', async () => {
    const root = await home();
    expect(await listAgentSkills(root)).toEqual([]);
    await mkdir(join(root, '.agents', 'skills', 'no-skill-file'), { recursive: true });
    await writeFile(join(root, '.agents', 'skills', 'stray.txt'), 'x');
    await skill(root, 'Bad Name', 'description: x');
    await skill(root, 'no-frontmatter-description', 'name: x');
    expect(await listAgentSkills(root)).toEqual([{
      name: 'no-frontmatter-description',
      description: '',
      layer: 'user_default',
      displayPath: '~/.agents/skills/no-frontmatter-description',
      uri: 'skill://user_default/no-frontmatter-description',
    }]);
  });

  it('lists only top-level registry payloads while nested references remain expandable', async () => {
    const root = await home();
    const project = join(root, '项目 space');
    const projectRoot = join(project, '.imc', 'skills');
    await mkdir(join(projectRoot, 'nested'), { recursive: true });
    const topFile = join(projectRoot, 'top.md');
    const topDirectory = join(projectRoot, 'directory', 'SKILL.md');
    const nestedFile = join(projectRoot, 'nested', 'child.md');
    await mkdir(join(projectRoot, 'directory'), { recursive: true });
    await writeFile(topFile, '# Top\n');
    await writeFile(topDirectory, '# Directory\n');
    await writeFile(nestedFile, '# Child\n');
    const paths = getSkillRegistryPathsForManagement({ projectDir: project, homeDir: root });
    writeSkillRegistryManagementSnapshot(paths.project!, [
      { schemaVersion: 1, key: 'top', layer: 'project_escape_hatch', metadata: { name: 'top' }, path: topFile, displayPath: '.imc/skills/top.md', uri: makeSkillUri('project_escape_hatch', 'top'), fingerprint: 'top', updatedAt: 1 },
      { schemaVersion: 1, key: 'directory', layer: 'project_escape_hatch', metadata: { name: 'directory' }, path: topDirectory, displayPath: '.imc/skills/directory/SKILL.md', uri: makeSkillUri('project_escape_hatch', 'directory'), fingerprint: 'directory', updatedAt: 2 },
      { schemaVersion: 1, key: 'nested/child', layer: 'project_escape_hatch', metadata: { name: 'child' }, path: nestedFile, displayPath: '.imc/skills/nested/child.md', uri: makeSkillUri('project_escape_hatch', 'nested/child'), fingerprint: 'nested', updatedAt: 3 },
    ]);

    expect((await listAgentSkills(root, { projectDir: project })).map((entry) => entry.name).sort()).toEqual(['directory', 'top']);
    const marker = '$$(child@skill://project_escape_hatch/nested%2Fchild)';
    await expect(expandAgentSkillReferences(marker, root, { projectDir: project })).resolves.toMatchObject({
      expanded: ['child@skill://project_escape_hatch/nested%2Fchild'],
      text: expect.stringContaining('# Child'),
    });
  });
});

describe('required commands', () => {
  it('flags a skill whose declared command is not on this machine', async () => {
    const root = await home();
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'present-cli'), '#!/bin/sh\n', { mode: 0o755 });
    await skill(root, 'wecom-like', 'description: needs a cli\nmetadata:\n  requires:\n    bins: ["absent-cli"]');
    await skill(root, 'claw-like', 'description: claw\nmetadata:\n  openclaw:\n    requires:\n      bins: [present-cli, "also-absent"]');
    await skill(root, 'satisfied', 'description: ok\nmetadata:\n  requires:\n    bins: ["present-cli"]');
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const byName = Object.fromEntries((await listAgentSkills(root)).map((entry) => [entry.name, entry]));
      expect(byName['wecom-like']?.missingBins).toEqual(['absent-cli']);
      expect(byName['claw-like']?.missingBins).toEqual(['also-absent']);
      expect(byName.satisfied?.missingBins).toBeUndefined();
    } finally {
      process.env.PATH = previous;
    }
  });

  it('finds a Windows command through PATHEXT', async () => {
    const root = await home();
    await writeFile(join(root, 'wecom-cli.CMD'), '@echo off\r\n');
    expect(await hasCommand('wecom-cli', { PATH: root, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(true);
    expect(await hasCommand('wecom-cli', { PATH: root, PATHEXT: '.EXE' }, 'win32')).toBe(false);
  });
});

describe('agent skill requests', () => {
  it('accepts GitHub shorthand and https sources, and nothing that could be an option or a path', () => {
    for (const ok of ['WeComTeam/wecom-cli', 'vercel-labs/agent-skills/skills/foo', 'owner/repo@v1.2', 'https://github.com/owner/repo']) {
      expect(isAgentSkillSource(ok), ok).toBe(true);
    }
    for (const bad of ['--global', '-y', '/etc', '../x/y', 'owner/../y', 'http://example.com/x', 'owner/repo extra', ' owner/repo', 'file:///etc/passwd', 'https://user:pw@github.com/a/b', '']) {
      expect(isAgentSkillSource(bad), bad).toBe(false);
    }
  });

  it('builds the one global, non-interactive CLI call each action needs', () => {
    expect(agentSkillsCliArguments({ action: AGENT_SKILLS_ACTION.ADD, source: 'WeComTeam/wecom-cli' }))
      .toEqual(['add', 'WeComTeam/wecom-cli', '--global', '--yes']);
    // A directory result names one skill of a repository: install only that.
    expect(agentSkillsCliArguments({ action: AGENT_SKILLS_ACTION.ADD, source: 'anthropics/skills', names: ['pdf'] }))
      .toEqual(['add', 'anthropics/skills', '--skill', 'pdf', '--global', '--yes']);
    expect(readAgentSkillsRunRequest({ action: 'add', source: 'anthropics/skills', names: ['pdf'] }))
      .toEqual({ action: 'add', source: 'anthropics/skills', names: ['pdf'] });
    expect(agentSkillsCliArguments({ action: AGENT_SKILLS_ACTION.UPDATE }))
      .toEqual(['update', '--global', '--yes']);
    expect(agentSkillsCliArguments({ action: AGENT_SKILLS_ACTION.REMOVE, names: ['wecomcli-doc'] }))
      .toEqual(['remove', 'wecomcli-doc', '--global', '--yes']);
  });

  it('refuses malformed requests before anything runs', () => {
    expect(readAgentSkillsRunRequest({ action: 'add' })).toBeNull();
    expect(readAgentSkillsRunRequest({ action: 'add', source: '--all' })).toBeNull();
    expect(readAgentSkillsRunRequest({ action: 'remove' })).toBeNull();
    expect(readAgentSkillsRunRequest({ action: 'remove', names: ['../../x'] })).toBeNull();
    expect(readAgentSkillsRunRequest({ action: 'update', source: 'a/b' })).toBeNull();
    expect(readAgentSkillsRunRequest({ action: 'exec', source: 'a/b' })).toBeNull();
  });

  it('runs one CLI at a time on a machine and returns the skills afterwards', async () => {
    const root = await home();
    let release!: () => void;
    const runCli = vi.fn(() => new Promise<{ ok: boolean; output: string }>((resolve) => {
      release = () => resolve({ ok: true, output: 'Installed 1 skill' });
    }));
    const run = createAgentSkillsRunner({ homeDir: root, runCli });
    const first = run({ action: AGENT_SKILLS_ACTION.ADD, source: 'owner/repo' });
    expect(await run({ action: AGENT_SKILLS_ACTION.UPDATE })).toEqual({ ok: false, error: AGENT_SKILLS_ERROR.BUSY, skills: [] });
    await skill(root, 'fresh', 'description: fresh');
    release();
    expect(await first).toEqual({
      ok: true,
      output: 'Installed 1 skill',
      skills: [{
        name: 'fresh',
        description: 'fresh',
        layer: 'user_default',
        displayPath: '~/.agents/skills/fresh',
        uri: 'skill://user_default/fresh',
      }],
    });
    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it('answers an invalid run request without running anything', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const run = vi.fn();
    await handleAgentSkillsCommand(
      { type: AGENT_SKILLS_MSG.RUN_REQUEST, requestId: 'r1', action: 'add', source: '--all' },
      (message) => sent.push(message),
      run as never,
    );
    expect(run).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: AGENT_SKILLS_MSG.RUN_RESPONSE, requestId: 'r1', ok: false, error: AGENT_SKILLS_ERROR.INVALID_REQUEST }]);
  });
});

describe('composer skill references', () => {
  it('requires a source when duplicate names are present', () => {
    const entries = [
      { name: 'writer', description: '', source: 'team/a' },
      { name: 'writer', description: '', source: 'team/b' },
    ] as const;
    expect(resolveAgentSkillReference({ name: 'writer' }, entries)).toBeUndefined();
    expect(resolveAgentSkillReference({ name: 'writer', source: 'team/b' }, entries)).toEqual(entries[1]);
  });

  it('expands safe known references, disambiguates source, and removes duplicates', async () => {
    const root = await home();
    await skill(root, 'writer', 'description: writer');
    await writeFile(join(root, '.agents', 'skills', 'writer', 'SKILL.md'), '# Writer\nUse concise prose.\n');
    await writeFile(join(root, '.agents', '.skill-lock.json'), JSON.stringify({
      skills: { writer: { source: 'team/skills' } },
    }));

    const expanded = await expandAgentSkillReferences(
      'before $$(writer@team/skills) after $$(writer@team/skills) bad $$(writer@other) literal $$(unknown)',
      root,
    );
    expect(expanded.expanded).toEqual(['writer@team/skills']);
    expect(expanded.unresolved).toEqual(['writer@other', 'unknown']);
    expect(expanded.text).toContain('[skill: writer]');
    expect(expanded.text.match(/\[skill: writer\]/gu)).toHaveLength(1);
    expect(expanded.text).toContain('$$(writer@other)');
    expect(expanded.text).toContain('$$(unknown)');
  });

  it('leaves malformed and unclosed markers untouched', async () => {
    const root = await home();
    const text = 'cash $5, $$(bad name), $$(writer';
    await expect(expandAgentSkillReferences(text, root)).resolves.toEqual({ text, unresolved: [], expanded: [] });
  });

  it('expands a project registry skill only when project context is supplied', async () => {
    const root = await home();
    const project = join(root, '项目 space');
    const payload = join(project, 'skill.md');
    await mkdir(project, { recursive: true });
    await writeFile(payload, '# Project writer\n');
    const paths = getSkillRegistryPathsForManagement({ projectDir: project, homeDir: root });
    writeSkillRegistryManagementSnapshot(paths.project!, [{
      schemaVersion: 1,
      key: 'project-writer',
      layer: 'project_escape_hatch',
      metadata: { name: 'project-writer', description: 'project only' },
      path: payload,
      displayPath: 'skill://project_escape_hatch/project-writer',
      uri: makeSkillUri('project_escape_hatch', 'project-writer'),
      fingerprint: 'fingerprint',
      updatedAt: Date.now(),
    }]);
    const marker = '$$(project-writer@skill://project_escape_hatch/project-writer)';
    await expect(expandAgentSkillReferences(marker, root)).resolves.toMatchObject({ unresolved: ['project-writer@skill://project_escape_hatch/project-writer'] });
    const expanded = await expandAgentSkillReferences(marker, root, { projectDir: project });
    expect(expanded.expanded).toEqual(['project-writer@skill://project_escape_hatch/project-writer']);
    expect(expanded.text).toContain('# Project writer');
  });

  it('discovers skills across user/project agent roots, deduplicates copies and symlinks, skips dotdirs/non-skills, and rejects escapes', async () => {
    const root = await home();
    const project = join(root, 'workspace');
    const outside = await home();
    await mkdir(project, { recursive: true });

    // Multi-agent duplicate copies (different files, same skill name)
    for (const dir of ['.claude', '.codex', '.gemini']) {
      const s = join(root, dir, 'skills', 'openspec-explore');
      await mkdir(s, { recursive: true });
      await writeFile(join(s, 'SKILL.md'), '---\nname: openspec-explore\ndescription: Explore codebase\n---\n# Explore body\n');
    }
    // Additional user roots
    for (const [dir, name] of [
      ['.cursor', 'cursor-only'],
      ['.qwen', 'qwen-only'],
      ['.opencode', 'opencode-only'],
      ['.openclaw', 'openclaw-only'],
    ] as const) {
      const s = join(root, dir, 'skills', name);
      await mkdir(s, { recursive: true });
      await writeFile(join(s, 'SKILL.md'), `---\nname: ${name}\ndescription: From ${dir}\n---\n# ${name}\n`);
    }
    // Hidden dir and non-skill dir (no SKILL.md)
    await mkdir(join(root, '.codex', 'skills', '.system', 'hidden-sys'), { recursive: true });
    await writeFile(join(root, '.codex', 'skills', '.system', 'hidden-sys', 'SKILL.md'), '---\nname: hidden-sys\n---\n');
    await mkdir(join(root, '.claude', 'skills', 'synced', 'nested'), { recursive: true });
    await writeFile(join(root, '.claude', 'skills', 'synced', 'README.md'), 'not a skill');

    // Cross-agent symlink inside homeDir -> should work cleanly and deduplicate
    await mkdir(join(root, 'shared-store', 'linked-local'), { recursive: true });
    await writeFile(join(root, 'shared-store', 'linked-local', 'SKILL.md'), '---\ndescription: Linked inside home\n---\n# Linked body\n');
    await symlink(join(root, 'shared-store', 'linked-local'), join(root, '.claude', 'skills', 'linked-local'));

    // Escapes: skill dir symlink outside homeDir, and SKILL.md symlink outside skill dir
    await mkdir(join(outside, 'secret-skill'), { recursive: true });
    await writeFile(join(outside, 'secret-skill', 'SKILL.md'), '---\ndescription: escape\n---\nsecret');
    await symlink(join(outside, 'secret-skill'), join(root, '.claude', 'skills', 'escape-dir'));

    await mkdir(join(root, '.claude', 'skills', 'escape-file'), { recursive: true });
    await writeFile(join(outside, 'leak.md'), '---\ndescription: leak\n---\nsecret');
    await symlink(join(outside, 'leak.md'), join(root, '.claude', 'skills', 'escape-file', 'SKILL.md'));

    // Project root + skills-lock.json + project escape check
    const projSkill = join(project, '.claude', 'skills', 'repo-workflow');
    await mkdir(projSkill, { recursive: true });
    await writeFile(join(projSkill, 'SKILL.md'), '---\ndescription: Repo workflow\n---\n# Repo Workflow Body\n');
    await writeFile(join(project, 'skills-lock.json'), JSON.stringify({
      version: 1,
      skills: { 'repo-workflow': { source: 'acme/repo-skills' } },
    }));
    await symlink(join(outside, 'secret-skill'), join(project, '.claude', 'skills', 'proj-escape'));

    // Indexing user registry must not cause duplicate entries in listAgentSkills!
    buildUserSkillRegistry({ homeDir: root });

    const listed = await listAgentSkills(root, { projectDir: project });
    const names = listed.map((item) => item.name);

    expect(names.filter((n) => n === 'openspec-explore')).toHaveLength(1);
    expect(names).toContain('cursor-only');
    expect(names).toContain('qwen-only');
    expect(names).toContain('opencode-only');
    expect(names).toContain('openclaw-only');
    expect(names).toContain('linked-local');
    expect(names).toContain('repo-workflow');
    expect(names).not.toContain('.system');
    expect(names).not.toContain('hidden-sys');
    expect(names).not.toContain('synced');
    expect(names).not.toContain('escape-dir');
    expect(names).not.toContain('escape-file');
    expect(names).not.toContain('proj-escape');

    const projEntry = listed.find((item) => item.name === 'repo-workflow');
    expect(projEntry).toMatchObject({
      layer: 'project_escape_hatch',
      displayPath: '.claude/skills/repo-workflow',
      source: 'acme/repo-skills',
    });

    // No host absolute path leakage anywhere in browser-facing entries
    for (const item of listed) {
      expect(item.displayPath).not.toContain(root);
      expect(item.uri).not.toContain(root);
    }

    // Expanding both ~/.claude and project .claude skills works via $$(...)
    const expanded = await expandAgentSkillReferences(
      'run $$(openspec-explore) and $$(repo-workflow)',
      root,
      { projectDir: project },
    );
    expect(expanded.unresolved).toEqual([]);
    expect(expanded.expanded).toEqual(['openspec-explore', 'repo-workflow']);
    expect(expanded.text).toContain('# Explore body');
    expect(expanded.text).toContain('# Repo Workflow Body');
  });

  it('rejects redirected or tampered registry entries escaping homeDir/projectDir during list and expansion while keeping scoped links and nested managed skills', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-agent-skills-f2-'));
    const outside = await mkdtemp(join(tmpdir(), 'imcodes-agent-skills-out-'));
    cleanup.push(dir, outside);

    const homeDir = join(dir, 'home');
    const projectDir = join(dir, 'project');

    await mkdir(join(homeDir, 'shared-store', 'user-linked'), { recursive: true });
    await writeFile(join(homeDir, 'shared-store', 'user-linked', 'SKILL.md'), '---\nname: user-linked\ndescription: User link\n---\nUSER_OK\n');
    await mkdir(join(homeDir, '.claude', 'skills'), { recursive: true });
    await symlink(join(homeDir, 'shared-store', 'user-linked'), join(homeDir, '.claude', 'skills', 'user-linked'), 'dir');

    await mkdir(join(homeDir, 'shared-store', 'linked-local'), { recursive: true });
    await writeFile(join(homeDir, 'shared-store', 'linked-local', 'SKILL.md'), '---\nname: linked-local\ndescription: Scoped link\n---\nSCOPED_OK\n');
    await symlink(join(homeDir, 'shared-store', 'linked-local'), join(homeDir, '.claude', 'skills', 'linked-local'), 'dir');

    await mkdir(join(homeDir, '.codex', 'skills', 'good-user'), { recursive: true });
    await writeFile(join(homeDir, '.codex', 'skills', 'good-user', 'SKILL.md'), '---\nname: good-user\ndescription: Good user\n---\nGOOD_USER_OK\n');

    await mkdir(join(projectDir, 'proj-store', 'proj-linked'), { recursive: true });
    await writeFile(join(projectDir, 'proj-store', 'proj-linked', 'SKILL.md'), '---\nname: proj-linked\ndescription: Project link\n---\nPROJ_OK\n');
    await mkdir(join(projectDir, '.claude', 'skills'), { recursive: true });
    await symlink(join(projectDir, 'proj-store', 'proj-linked'), join(projectDir, '.claude', 'skills', 'proj-linked'), 'dir');

    await mkdir(join(projectDir, '.codex', 'skills', 'good-proj'), { recursive: true });
    await writeFile(join(projectDir, '.codex', 'skills', 'good-proj', 'SKILL.md'), '---\nname: good-proj\ndescription: Good project\n---\nGOOD_PROJ_OK\n');

    await mkdir(join(projectDir, '.imc', 'skills', 'nested'), { recursive: true });
    await writeFile(join(projectDir, '.imc', 'skills', 'nested', 'child.md'), '---\nname: child\ndescription: Nested managed\n---\nNESTED_CHILD_OK\n');

    await mkdir(join(outside, 'evil'), { recursive: true });
    const outsideSkill = join(outside, 'evil', 'SKILL.md');
    await writeFile(outsideSkill, '---\nname: evil\ndescription: Outside\n---\nOUTSIDE_SCOPE_SECRET\n');
    await mkdir(join(homeDir, 'non-agent-dir'), { recursive: true });
    await symlink(outsideSkill, join(homeDir, 'non-agent-dir', 'tampered.md'));

    buildUserSkillRegistry({ homeDir });
    buildProjectSkillRegistry({ projectDir });

    // Redirect both user and project symlinks outside scope AFTER registry was built
    await rm(join(homeDir, '.claude', 'skills', 'user-linked'), { recursive: true, force: true });
    await symlink(join(outside, 'evil'), join(homeDir, '.claude', 'skills', 'user-linked'), 'dir');
    await rm(join(projectDir, '.claude', 'skills', 'proj-linked'), { recursive: true, force: true });
    await symlink(join(outside, 'evil'), join(projectDir, '.claude', 'skills', 'proj-linked'), 'dir');

    // Also inject tampered direct + non-agent symlink entries into user registry.json
    const currentEntries = getSkillRegistryManagementSnapshot({ homeDir }).entries;
    expect(currentEntries.length).toBeGreaterThan(0);
    const template = currentEntries[0]!;
    const { user: userPath } = getSkillRegistryPathsForManagement({ homeDir });
    writeSkillRegistryManagementSnapshot(userPath, [
      ...currentEntries,
      {
        ...template,
        key: 'tampered-direct',
        uri: makeSkillUri('user', 'tampered-direct'),
        metadata: { ...template.metadata, name: 'tampered-direct', description: 'Direct outside path' },
        path: outsideSkill,
        displayPath: 'tampered-direct',
        updatedAt: Date.now(),
      },
      {
        ...template,
        key: 'tampered-non-agent-link',
        uri: makeSkillUri('user', 'tampered-non-agent-link'),
        metadata: { ...template.metadata, name: 'tampered-non-agent-link', description: 'Non-agent symlink' },
        path: join(homeDir, 'non-agent-dir', 'tampered.md'),
        displayPath: 'tampered-non-agent-link',
        updatedAt: Date.now(),
      },
    ]);

    const listed = await listAgentSkills(homeDir, { projectDir });
    const listedNames = listed.map((item) => item.name);
    expect(listedNames).toContain('good-user');
    expect(listedNames).toContain('linked-local');
    expect(listedNames).toContain('good-proj');
    expect(listedNames).not.toContain('child');
    expect(listedNames).not.toContain('user-linked');
    expect(listedNames).not.toContain('proj-linked');
    expect(listedNames).not.toContain('tampered-direct');
    expect(listedNames).not.toContain('tampered-non-agent-link');

    const expanded = await expandAgentSkillReferences(
      '$$(user-linked) $$(proj-linked) $$(tampered-direct) $$(tampered-non-agent-link) $$(linked-local) $$(child)',
      homeDir,
      { projectDir },
    );
    expect(expanded.text).not.toContain('OUTSIDE_SCOPE_SECRET');
    expect(expanded.text).toContain('SCOPED_OK');
    expect(expanded.text).toContain('NESTED_CHILD_OK');
    expect(expanded.expanded).toEqual(['linked-local', 'child']);
    expect(expanded.unresolved).toEqual(['user-linked', 'proj-linked', 'tampered-direct', 'tampered-non-agent-link']);
  });
});
