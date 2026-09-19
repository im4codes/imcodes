import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  handleAgentSkillsCommand,
  listAgentSkills,
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
      { name: 'handmade', description: 'Made by hand' },
      {
        name: 'wecomcli-doc',
        // Extra frontmatter keys belong to the skill; they are not a reason to hide it.
        description: '企业微信文档',
        source: 'WeComTeam/wecom-cli',
        sourceUrl: 'https://github.com/WeComTeam/wecom-cli.git',
        installedAt: '2026-09-19T03:33:55.955Z',
        updatedAt: '2026-09-19T03:33:55.955Z',
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
    expect(await listAgentSkills(root)).toEqual([{ name: 'no-frontmatter-description', description: '' }]);
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
    expect(await first).toEqual({ ok: true, output: 'Installed 1 skill', skills: [{ name: 'fresh', description: 'fresh' }] });
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
