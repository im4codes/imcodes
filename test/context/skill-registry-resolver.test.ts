import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUserSkillPath } from '../../shared/skill-store.js';
import { SKILL_REGISTRY_FILE_NAME } from '../../shared/skill-registry-types.js';
import { buildProjectSkillRegistry, buildUserSkillRegistry, ensureFreshSkillRegistries } from '../../src/context/skill-registry-builder.js';
import { assertManagedSkillPathSync, assertReadableSkillPathSync } from '../../src/context/managed-skill-path.js';
import { getSkillRegistrySnapshot, SKILL_REGISTRY_TESTING, writeSkillRegistryManagementSnapshot } from '../../src/context/skill-registry.js';
import { buildTransportStartupMemory } from '../../src/agent/runtime-context-bootstrap.js';
import { resolveSkillByKey, resolveSkillsForTurn } from '../../src/context/skill-resolver.js';
import { MEMORY_DEFAULTS } from '../../shared/memory-defaults.js';

const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/repo', userId: 'user-1' };

describe('skill registry and on-demand resolver', () => {
  let homeDir: string | undefined;

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    homeDir = undefined;
    SKILL_REGISTRY_TESTING.reset();
    vi.unstubAllEnvs();
  });

  it('uses registry metadata at startup and reads full skill content only on demand', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'skill-registry-home-'));
    const skillPath = getUserSkillPath({ homeDir, category: 'testing', skillName: 'test-first' });
    await mkdir(join(homeDir, '.imcodes', 'skills', 'testing'), { recursive: true });
    await writeFile(skillPath, [
      '---',
      'schemaVersion: 1',
      'name: test-first',
      'category: testing',
      'description: "Run tests before handoff."',
      'project:',
      '  canonicalRepoId: github.com/acme/repo',
      '---',
      'Run tests before final handoff.',
      '',
    ].join('\n'));

    buildUserSkillRegistry({ homeDir, context: { canonicalRepoId: 'github.com/acme/repo' } });
    await rm(skillPath);

    const startup = await buildTransportStartupMemory(namespace, { homeDir, skillsFeatureEnabled: true });
    expect(startup?.injectedText).toContain('testing/test-first');
    expect(startup?.injectedText).not.toContain('Run tests before final handoff.');

    expect(resolveSkillByKey({ namespace, key: 'testing/test-first', homeDir })).toMatchObject({ ok: false, reason: 'stale_registry' });

    await writeFile(skillPath, [
      '---',
      'schemaVersion: 1',
      'name: test-first',
      'category: testing',
      'description: "Run tests before handoff."',
      'project:',
      '  canonicalRepoId: github.com/acme/repo',
      '---',
      'Run tests before final handoff.',
      '',
    ].join('\n'));
    const resolved = resolveSkillByKey({ namespace, key: 'testing/test-first', homeDir });
    expect(resolved).toMatchObject({ ok: true, key: 'testing/test-first' });
    expect(resolved.ok && resolved.text).toContain('<<<imcodes-skill v1>>>');
    expect(resolved.ok && resolved.text).toContain('Run tests before final handoff.');
  });

  it('does not resolve unrelated turns and resolves only matching skill metadata', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'skill-registry-home-'));
    const skillPath = getUserSkillPath({ homeDir, category: 'deploy', skillName: 'release-checklist' });
    await mkdir(join(homeDir, '.imcodes', 'skills', 'deploy'), { recursive: true });
    await writeFile(skillPath, '---\nschemaVersion: 1\nname: release-checklist\ncategory: deploy\ndescription: "Release deployment checklist"\n---\nShip safely.\n');
    buildUserSkillRegistry({ homeDir });

    expect(resolveSkillsForTurn({ namespace, prompt: 'Please explain TypeScript variance.', homeDir })).toEqual([]);
    const results = resolveSkillsForTurn({ namespace, prompt: 'Run the deployment checklist.', homeDir });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, key: 'deploy/release-checklist' });
  });

  it('invalidates runtime registry cache after management writes', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'skill-registry-home-'));
    const skillPath = getUserSkillPath({ homeDir, category: 'deploy', skillName: 'release-checklist' });
    await mkdir(join(homeDir, '.imcodes', 'skills', 'deploy'), { recursive: true });
    await writeFile(skillPath, '---\nschemaVersion: 1\nname: release-checklist\ncategory: deploy\n---\nShip safely.\n');
    buildUserSkillRegistry({ homeDir });

    const initial = getSkillRegistrySnapshot({ namespace, homeDir });
    expect(initial.entries).toHaveLength(1);

    writeSkillRegistryManagementSnapshot(join(homeDir, '.imcodes', 'skills', SKILL_REGISTRY_FILE_NAME), []);

    const afterManagementWrite = getSkillRegistrySnapshot({ namespace, homeDir });
    expect(afterManagementWrite.entries).toHaveLength(0);
  });

  it('rejects registry paths that escape through a symlink directory', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'skill-registry-home-'));
    const outside = await mkdtemp(join(tmpdir(), 'skill-registry-outside-'));
    await mkdir(join(homeDir, '.imcodes', 'skills'), { recursive: true });
    await writeFile(join(outside, 'escape.md'), '---\nschemaVersion: 1\nname: escape\ncategory: danger\n---\nDo not read me.\n');
    await symlink(outside, join(homeDir, '.imcodes', 'skills', 'linked'), 'dir');

    writeSkillRegistryManagementSnapshot(join(homeDir, '.imcodes', 'skills', SKILL_REGISTRY_FILE_NAME), [{
      schemaVersion: 1,
      key: 'danger/escape',
      layer: 'user_default',
      metadata: { schemaVersion: 1, name: 'escape', category: 'danger' },
      path: join(homeDir, '.imcodes', 'skills', 'linked', 'escape.md'),
      displayPath: '~/.imcodes/skills/linked/escape.md',
      uri: 'skill://user_default/danger/escape',
      fingerprint: 'fp-symlink',
      updatedAt: Date.now(),
    }]);

    expect(resolveSkillByKey({ namespace, key: 'danger/escape', homeDir })).toMatchObject({ ok: false, reason: 'unauthorized' });
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses oversized registry files before parsing', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'skill-registry-home-'));
    await mkdir(join(homeDir, '.imcodes', 'skills'), { recursive: true });
    await writeFile(
      join(homeDir, '.imcodes', 'skills', SKILL_REGISTRY_FILE_NAME),
      JSON.stringify({ schemaVersion: 1, entries: [], padding: 'x'.repeat(MEMORY_DEFAULTS.skillRegistryMaxBytes + 1) }),
    );

    expect(getSkillRegistrySnapshot({ namespace, homeDir }).entries).toEqual([]);
  });

  it('fails closed for registry entry-count overflow instead of truncating by JSON order', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'skill-registry-home-'));
    await mkdir(join(homeDir, '.imcodes', 'skills'), { recursive: true });
    const entries = Array.from({ length: MEMORY_DEFAULTS.skillRegistryMaxEntries + 1 }, (_, index) => ({
      schemaVersion: 1,
      key: `general/skill-${index}`,
      layer: 'user_default',
      metadata: { schemaVersion: 1, name: `skill-${index}`, category: 'general' },
      displayPath: `~/.imcodes/skills/general/skill-${index}.md`,
      uri: `skill://user_default/general%2Fskill-${index}`,
      fingerprint: `fp-${index}`,
      updatedAt: index,
    }));
    await writeFile(
      join(homeDir, '.imcodes', 'skills', SKILL_REGISTRY_FILE_NAME),
      JSON.stringify({ schemaVersion: 1, entries }),
    );

    expect(getSkillRegistrySnapshot({ namespace, homeDir }).entries).toEqual([]);
  });

  it('does not render polluted absolute registry display paths in startup hints', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'skill-registry-home-'));
    await mkdir(join(homeDir, '.imcodes', 'skills'), { recursive: true });
    writeSkillRegistryManagementSnapshot(join(homeDir, '.imcodes', 'skills', SKILL_REGISTRY_FILE_NAME), [{
      schemaVersion: 1,
      key: 'danger/leaky',
      layer: 'user_default',
      metadata: { schemaVersion: 1, name: 'leaky', category: 'danger', description: 'Do not leak absolute paths.' },
      path: join(homeDir, '.imcodes', 'skills', 'danger', 'leaky.md'),
      displayPath: '/home/alice/.imcodes/skills/danger/leaky.md',
      uri: 'skill://user_default/danger/leaky',
      fingerprint: 'fp-leaky',
      updatedAt: Date.now(),
    }]);

    const startup = await buildTransportStartupMemory(namespace, { homeDir, skillsFeatureEnabled: true });
    expect(startup?.injectedText).toContain('skill://');
    expect(startup?.injectedText).not.toContain('/home/alice');
  });

  it('indexes third-party agent skills, allows cross-agent symlinks within home/project, rejects escapes, and auto-rebuilds stale registries cleanly', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'skill-registry-home-'));
    const projectDir = join(homeDir, 'workspace');
    const cleanProjectDir = join(homeDir, 'clean-workspace');
    const outside = await mkdtemp(join(tmpdir(), 'skill-registry-outside-'));
    await mkdir(projectDir, { recursive: true });
    await mkdir(cleanProjectDir, { recursive: true });

    try {
      // Third-party frontmatter with version: 3, nested metadata, license, no schemaVersion/category
      const thirdPartyMd = [
        '---',
        'name: openspec-apply',
        'description: Apply OpenSpec tasks',
        'license: MIT',
        'compatibility: claude, codex',
        'metadata:',
        '  author: openspec',
        '  version: "3.0"',
        'version: 3',
        '---',
        '# Apply Instructions',
        'Follow tasks.',
      ].join('\n');

      for (const dir of ['.claude', '.codex', '.gemini']) {
        await mkdir(join(homeDir, dir, 'skills', 'openspec-apply'), { recursive: true });
        await writeFile(join(homeDir, dir, 'skills', 'openspec-apply', 'SKILL.md'), thirdPartyMd);
      }

      // Cross-agent symlink inside homeDir -> readable and resolvable
      await mkdir(join(homeDir, '.agents', 'skills', 'linked-agent-skill'), { recursive: true });
      await writeFile(
        join(homeDir, '.agents', 'skills', 'linked-agent-skill', 'SKILL.md'),
        '---\ndescription: Linked skill\n---\n# Linked Agent Skill\n',
      );
      await symlink(
        join(homeDir, '.agents', 'skills', 'linked-agent-skill'),
        join(homeDir, '.claude', 'skills', 'linked-alias'),
      );

      // Escape symlink outside homeDir -> must be rejected
      await mkdir(join(outside, 'escape-skill'), { recursive: true });
      await writeFile(join(outside, 'escape-skill', 'SKILL.md'), '---\ndescription: bad\n---\nsecret');
      await symlink(join(outside, 'escape-skill'), join(homeDir, '.claude', 'skills', 'escape-skill'));

      // Project skill
      await mkdir(join(projectDir, '.claude', 'skills', 'repo-local'), { recursive: true });
      await writeFile(join(projectDir, '.claude', 'skills', 'repo-local', 'SKILL.md'), '---\ndescription: Project scoped\n---\n# Repo Local\n');

      // Auto-build when registry does not exist yet
      const firstRefresh = ensureFreshSkillRegistries({ homeDir, projectDir: cleanProjectDir });
      expect(firstRefresh.rebuiltUser).toBe(true);
      expect(firstRefresh.rebuiltProject).toBe(false);
      // Clean project must never receive an empty .imc/skills/registry.json
      expect(() => assertManagedSkillPathSync({ path: join(cleanProjectDir, '.imc', 'skills', 'registry.json'), projectDir: cleanProjectDir, homeDir })).toThrow();

      // Snapshot contains deduplicated user agent skills + no escape skill + no host path in displayPath
      const snapshot = getSkillRegistrySnapshot({ namespace, homeDir, projectDir });
      const applyEntries = snapshot.entries.filter((entry) => entry.metadata.name === 'openspec-apply');
      expect(applyEntries).toHaveLength(1);
      expect(applyEntries[0]?.displayPath).toBe('~/.claude/skills/openspec-apply/SKILL.md');
      expect(applyEntries[0]?.displayPath).not.toContain(homeDir);
      expect(snapshot.entries.some((entry) => entry.metadata.name === 'escape-skill')).toBe(false);

      // Resolving indexed third-party skill succeeds despite version: 3 & nested YAML
      const resolved = resolveSkillByKey({ namespace, key: applyEntries[0]!.key, homeDir, projectDir });
      expect(resolved).toMatchObject({ ok: true, key: applyEntries[0]!.key });
      if (resolved.ok) expect(resolved.text).toContain('# Apply Instructions');

      // Project auto-build succeeds when project skills exist
      const projRefresh = ensureFreshSkillRegistries({ homeDir, projectDir });
      expect(projRefresh.rebuiltProject).toBe(true);
      const withProject = getSkillRegistrySnapshot({ namespace, homeDir, projectDir });
      expect(withProject.entries.some((entry) => entry.metadata.name === 'repo-local')).toBe(true);

      // Preview validator allows agent root + safe symlink, rejects escape, and delete guard rejects external root
      const validAgentPath = join(homeDir, '.claude', 'skills', 'openspec-apply', 'SKILL.md');
      expect(assertReadableSkillPathSync({ path: validAgentPath, homeDir, projectDir }).externalAgentRoot).toBe(true);
      expect(assertReadableSkillPathSync({ path: join(homeDir, '.claude', 'skills', 'linked-alias', 'SKILL.md'), homeDir }).externalAgentRoot).toBe(true);
      expect(() => assertReadableSkillPathSync({ path: join(homeDir, '.claude', 'skills', 'escape-skill', 'SKILL.md'), homeDir })).toThrow();
      expect(() => assertManagedSkillPathSync({ path: validAgentPath, homeDir, projectDir })).toThrow();

      // Explicit rebuild preserves project + user counts
      const rebuiltProj = buildProjectSkillRegistry({ projectDir });
      expect(rebuiltProj.entries.some((entry) => entry.metadata.name === 'repo-local')).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
