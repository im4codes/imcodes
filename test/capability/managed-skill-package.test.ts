import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { c as createTar } from 'tar';
import {
  SKILL_ACQUISITION_TESTING,
  acquireSkillPackage,
} from '../../src/capability/skill-acquisition.js';
import { inventoryAgentSkillPackage } from '../../src/capability/agent-skill-package.js';
import { scanAgentSkillPackage } from '../../src/capability/skill-scanner.js';

const validSkill = (name = 'safe-skill'): string => [
  '---',
  `name: ${name}`,
  'description: A safe portable test Skill.',
  'allowed-tools: Read Write',
  '---',
  'Follow the checked instructions.',
  '',
].join('\n');

describe('managed Agent Skill package admission', () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('normalizes a portable package and inventories scripts without executing them', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-skill-home-'));
    temporary.push(homeDir);
    const acquired = acquireSkillPackage({
      kind: 'inline',
      files: {
        'SKILL.md': validSkill(),
        'scripts/check.sh': '#!/bin/sh\necho never-ran\n',
      },
    }, homeDir);
    try {
      expect(acquired.inventory.frontMatter).toMatchObject({ name: 'safe-skill', allowedTools: ['Read', 'Write'] });
      expect(acquired.inventory.files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/check.sh']);
      const scan = scanAgentSkillPackage(acquired.inventory);
      expect(scan.outcome).toBe('pass');
      expect(scan.scriptPaths).toEqual(['scripts/check.sh']);
      expect(scan.findings).toContainEqual(expect.objectContaining({ code: 'script_present', severity: 'warning' }));
      expect(await readFile(join(acquired.quarantinePath, 'scripts/check.sh'), 'utf8')).toContain('never-ran');
    } finally {
      acquired.cleanup();
    }
  });

  it('blocks secret material without copying the secret into findings', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-skill-home-'));
    temporary.push(homeDir);
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const acquired = acquireSkillPackage({
      kind: 'inline',
      files: { 'SKILL.md': `${validSkill()}\n${secret}\n` },
    }, homeDir);
    try {
      const scan = scanAgentSkillPackage(acquired.inventory);
      expect(scan.outcome).toBe('blocked');
      expect(scan.findings).toContainEqual(expect.objectContaining({ code: 'github_token', severity: 'block' }));
      expect(JSON.stringify(scan)).not.toContain(secret);
    } finally {
      acquired.cleanup();
    }
  });

  it('rejects traversal, symlinks, and name/frontmatter violations', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-skill-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-skill-source-'));
    const outside = await mkdtemp(join(tmpdir(), 'imcodes-skill-outside-'));
    temporary.push(homeDir, source, outside);
    expect(() => acquireSkillPackage({ kind: 'inline', files: { '../SKILL.md': validSkill() } }, homeDir))
      .toThrowError(expect.objectContaining({ code: 'invalid_source_path' }));
    await writeFile(join(source, 'SKILL.md'), validSkill());
    await writeFile(join(outside, 'payload.md'), 'outside');
    await symlink(join(outside, 'payload.md'), join(source, 'linked.md'));
    expect(() => acquireSkillPackage({ kind: 'local_directory', path: source }, homeDir))
      .toThrowError(expect.objectContaining({ code: 'source_link_not_allowed' }));
    await rm(join(source, 'linked.md'));
    expect(() => acquireSkillPackage({ kind: 'local_directory', path: source }, homeDir))
      .toThrowError(expect.objectContaining({ code: 'invalid_source_path' }));
    await writeFile(join(source, 'SKILL.md'), '---\nname: Invalid_Name\ndescription: no\n---\nbody\n');
    expect(() => inventoryAgentSkillPackage(source)).toThrowError(expect.objectContaining({ code: 'invalid_skill_name' }));
  });

  it('records executable bits as warnings', async () => {
    const source = await mkdtemp(join(tmpdir(), 'imcodes-skill-source-'));
    temporary.push(source);
    await writeFile(join(source, 'SKILL.md'), validSkill());
    await writeFile(join(source, 'run'), '#!/bin/sh\nexit 0\n');
    await chmod(join(source, 'run'), 0o700);
    const scan = scanAgentSkillPackage(inventoryAgentSkillPackage(source));
    expect(scan.executablePaths).toEqual(['run']);
    expect(scan.scriptPaths).toEqual(['run']);
  });

  it('fails closed when SKILL.md is replaced after its reviewed descriptor opens', async () => {
    const source = await mkdtemp(join(tmpdir(), 'imcodes-skill-race-'));
    temporary.push(source);
    const skillPath = join(source, 'SKILL.md');
    await writeFile(skillPath, validSkill('race-skill'));
    expect(() => inventoryAgentSkillPackage(source, {
      afterFileOpen(path) {
        if (path !== skillPath) return;
        renameSync(skillPath, join(source, 'SKILL.reviewed.md'));
        writeFileSync(skillPath, validSkill('forged-skill'));
      },
    })).toThrowError(expect.objectContaining({ code: 'path_escape' }));
  });

  it('downloads a bounded credential-free HTTPS tarball and rejects unsafe redirects and oversized bodies', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-skill-home-'));
    const source = await mkdtemp(join(tmpdir(), 'imcodes-skill-archive-'));
    const archive = join(tmpdir(), `imcodes-skill-${Date.now()}.tgz`);
    temporary.push(homeDir, source, archive);
    await writeFile(join(source, 'SKILL.md'), validSkill('remote-skill'));
    await createTar({ gzip: true, cwd: source, file: archive }, ['SKILL.md']);
    const bytes = await readFile(archive);
    const acquired = await acquireSkillPackage({ kind: 'https_archive', url: 'https://example.test/skill.tgz' }, homeDir, {
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as typeof fetch,
      resolveHost: async () => ['93.184.216.34'],
    });
    expect(acquired.inventory.frontMatter.name).toBe('remote-skill');
    acquired.cleanup();

    await expect(acquireSkillPackage({ kind: 'https_archive', url: 'https://example.test/skill.tgz' }, homeDir, {
      fetchImpl: (async () => new Response(null, { status: 302, headers: { location: 'http://unsafe.test/archive.tgz' } })) as typeof fetch,
      resolveHost: async () => ['93.184.216.34'],
    })).rejects.toMatchObject({ code: 'invalid_source_path' });
    for (const url of [
      'https://example.test/skill.tgz?sig=raw',
      'https://example.test/skill.tgz?signature=raw',
      'https://example.test/skill.tgz?X-Amz-Credential=raw',
    ]) {
      await expect(acquireSkillPackage({ kind: 'https_archive', url }, homeDir, {
        fetchImpl: (async () => new Response(bytes, { status: 200 })) as typeof fetch,
        resolveHost: async () => ['93.184.216.34'],
      })).rejects.toMatchObject({ code: 'invalid_source_path' });
    }
    await expect(acquireSkillPackage({ kind: 'https_archive', url: 'https://example.test/skill.tgz' }, homeDir, {
      fetchImpl: (async () => new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example.test/archive.tgz?X-Amz-Signature=raw' },
      })) as typeof fetch,
      resolveHost: async () => ['93.184.216.34'],
    })).rejects.toMatchObject({ code: 'invalid_source_path' });
    await expect(acquireSkillPackage({ kind: 'https_archive', url: 'https://example.test/skill.tgz' }, homeDir, {
      fetchImpl: (async () => new Response(null, { status: 200, headers: { 'content-length': String(20 * 1024 * 1024) } })) as typeof fetch,
      resolveHost: async () => ['93.184.216.34'],
    })).rejects.toMatchObject({ code: 'source_too_large' });
  });

  it('times out a stalled HTTPS source instead of leaving admission pending', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-skill-home-'));
    temporary.push(homeDir);
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    await expect(acquireSkillPackage({ kind: 'https_archive', url: 'https://example.test/stalled.tgz' }, homeDir, {
      fetchImpl, timeoutMs: 5, resolveHost: async () => ['93.184.216.34'],
    })).rejects.toMatchObject({ code: 'source_timeout' });
  });

  it('resolves a trusted forge commit then downloads a bounded archive without invoking git', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-skill-home-'));
    const fixture = await mkdtemp(join(tmpdir(), 'imcodes-skill-forge-'));
    temporary.push(homeDir, fixture);
    const archiveRoot = join(fixture, 'repository-commit');
    await mkdir(join(archiveRoot, 'package'), { recursive: true });
    await writeFile(join(archiveRoot, 'package', 'SKILL.md'), validSkill('repository-skill'));
    const archivePath = join(fixture, 'repository.tgz');
    await createTar({ gzip: true, cwd: fixture, file: archivePath }, ['repository-commit']);
    const archive = await readFile(archivePath);
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      return url.startsWith('https://api.github.com/')
        ? new Response(JSON.stringify({ sha: commit }), { status: 200 })
        : new Response(archive, { status: 200, headers: { 'content-length': String(archive.byteLength) } });
    }) as typeof fetch;
    const acquired = await acquireSkillPackage({
      kind: 'repository', url: 'https://github.com/acme/repository.git', subdirectory: 'package',
    }, homeDir, {
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
    });
    expect(acquired.inventory.frontMatter.name).toBe('repository-skill');
    expect(acquired.sourceLabel).toBe(`https://github.com/acme/repository@${commit}`);
    expect(requested).toEqual([
      'https://api.github.com/repos/acme/repository/commits/HEAD',
      `https://codeload.github.com/acme/repository/tar.gz/${commit}`,
    ]);
    acquired.cleanup();

    await expect(acquireSkillPackage({
      kind: 'repository', url: 'https://github.com/acme/repository.git', subdirectory: '../escape',
    }, homeDir, { fetchImpl, resolveHost: async () => ['93.184.216.34'] }))
      .rejects.toMatchObject({ code: 'invalid_source_path' });
  });

  it('allows only the three supported public forge hosts for repository acquisition', async () => {
    expect(['github.com', 'gitlab.com', 'bitbucket.org'].map(SKILL_ACQUISITION_TESTING.isSupportedRepositoryHost))
      .toEqual([true, true, true]);
    expect(['example.com', 'git.corp.example', 'localhost'].map(SKILL_ACQUISITION_TESTING.isSupportedRepositoryHost))
      .toEqual([false, false, false]);

    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-skill-home-'));
    temporary.push(homeDir);
    await expect(acquireSkillPackage({ kind: 'repository', url: 'https://example.com/repository.git' }, homeDir, {
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: (async () => { throw new Error('must not fetch'); }) as typeof fetch,
    })).rejects.toMatchObject({
      code: 'unsupported_source',
      message: 'Repository host is not supported; use a bounded HTTPS tar archive',
    });
  });

  it('blocks loopback, link-local metadata, IPv6 loopback, and DNS rebinding to private space', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'imcodes-skill-home-'));
    temporary.push(homeDir);
    const fetchImpl = (async () => { throw new Error('must not fetch'); }) as typeof fetch;
    for (const url of [
      'https://127.0.0.1/skill.tgz',
      'https://169.254.169.254/latest/meta-data/skill.tgz',
      'https://[::1]/skill.tgz',
    ]) {
      await expect(acquireSkillPackage({ kind: 'https_archive', url }, homeDir, { fetchImpl }))
        .rejects.toMatchObject({ code: 'invalid_source_path' });
    }
    await expect(acquireSkillPackage({ kind: 'https_archive', url: 'https://rebind.example/skill.tgz' }, homeDir, {
      fetchImpl, resolveHost: async () => ['10.0.0.1'],
    })).rejects.toMatchObject({ code: 'invalid_source_path' });

    const redirectFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://redirected.example/skill.tgz' },
    })) as unknown as typeof fetch;
    await expect(acquireSkillPackage({ kind: 'https_archive', url: 'https://public.example/skill.tgz' }, homeDir, {
      fetchImpl: redirectFetch,
      resolveHost: async (hostname) => hostname === 'public.example' ? ['93.184.216.34'] : ['192.168.1.20'],
    })).rejects.toMatchObject({ code: 'invalid_source_path' });
    expect(redirectFetch).toHaveBeenCalledTimes(1);
  });
});
