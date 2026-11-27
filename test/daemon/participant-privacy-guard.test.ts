import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertParticipantSubtreeSafe,
  clearPreEvaluatedParticipantToolDecisions,
  evaluateParticipantToolAccess,
  findSensitivePathInToolRequest,
  getParticipantToolTurnEpoch,
  isParticipantSensitivePath,
  isParticipantSensitiveRealPath,
  isSharedParticipantActor,
  recordPreEvaluatedParticipantToolDecision,
} from '../../src/daemon/participant-privacy-guard.js';

describe('participant-privacy-guard', () => {
  describe('isSharedParticipantActor', () => {
    it('identifies both shared-tab and shared-server participants while excluding owners', () => {
      expect(isSharedParticipantActor({ origin: 'shared-tab', effectiveActorRole: 'participant' })).toBe(true);
      expect(isSharedParticipantActor({ origin: 'shared-server', effectiveActorRole: 'participant' })).toBe(true);
      expect(isSharedParticipantActor({ origin: 'shared-server', effectiveActorRole: 'owner' })).toBe(false);
      expect(isSharedParticipantActor(undefined)).toBe(false);
      expect(isSharedParticipantActor(null)).toBe(false);
      expect(isSharedParticipantActor('participant')).toBe(false);
    });
  });

  describe('isParticipantSensitivePath', () => {
    const opts = { homeDir: '/home/k', cwd: '/home/k/projects/app' };

    it.each([
      '~/.ssh/id_ed25519',
      '/home/k/.ssh',
      '../../.ssh/config',
      'src/../../.ssh/id_rsa',
      '$HOME/.ssh/authorized_keys',
      '${HOME}/.gnupg/secring.gpg',
      '~/.gnupg',
      '~/.pki/nssdb',
      '~/.aws/credentials',
      '~/.kube/config',
      '~/.imcodes',
      '~/.imcodes/sessions.json',
      '~/.imcodes/server.json',
      '~/.config/gh/hosts.yml',
      '~/.config/gcloud/credentials.db',
      '~/.azure/accessTokens.json',
      '~/.docker/config.json',
      '~/.docker',
      '~/.netrc',
      '.npmrc',
      '.pypirc',
      '~/.git-credentials',
      'id_rsa',
      'id_rsa.pub',
      'id_ed25519',
      'id_ecdsa_sk',
      'id_dsa',
      'authorized_keys',
      'known_hosts',
      'certs/private.pem',
      'certs/bundle.p12',
      'certs/client.pfx',
      '~/.bash_history',
      '~/.zsh_history',
      '~/.sh_history',
      '/proc/self/environ',
      '/proc/1234/environ',
      '../../../proc/self/environ',
      '/etc/shadow',
      '%USERPROFILE%\\.ssh\\id_ed25519',
      'C:\\Users\\k\\.ssh\\id_ed25519',
      'C:\\Users\\k\\.aws\\credentials',
    ])('blocks sensitive path %s', (candidate) => {
      expect(isParticipantSensitivePath(candidate, opts)).toBe(true);
    });

    it.each([
      'src/ssh-helper.ts',
      'src/ssh-target.ts',
      'docs/ssh.md',
      'test/keys.test.ts',
      'test/fixtures/mock.ts',
      '.env.example',
      'README.md',
      'package.json',
      '.docker/Dockerfile',
      'src/config/gcloud-notes.md',
      'src/proc/mock/environ.ts',
    ])('allows normal project file %s without false positives', (candidate) => {
      expect(isParticipantSensitivePath(candidate, opts)).toBe(false);
    });
  });

  describe('isParticipantSensitiveRealPath', () => {
    let rootDir: string;
    let fakeHome: string;
    let projectDir: string;

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), 'imcodes-privacy-guard-'));
      fakeHome = path.join(rootDir, 'home');
      projectDir = path.join(rootDir, 'project');
      await mkdir(path.join(fakeHome, '.ssh'), { recursive: true });
      await mkdir(path.join(fakeHome, '.imcodes'), { recursive: true });
      await mkdir(path.join(projectDir, 'src'), { recursive: true });
      await writeFile(path.join(fakeHome, '.ssh', 'id_ed25519'), 'PRIVATE-KEY');
      await writeFile(path.join(fakeHome, '.imcodes', 'server.json'), '{"token":"secret"}');
      await writeFile(path.join(projectDir, 'src', 'ssh-helper.ts'), 'export const helper = true;\n');
    });

    afterEach(async () => {
      await rm(rootDir, { recursive: true, force: true });
    });

    it('catches symlinks and ancestor directory symlinks pointing to sensitive paths', async () => {
      const linkFile = path.join(projectDir, 'leak-key');
      const linkDir = path.join(projectDir, 'leak-imcodes');
      const danglingLink = path.join(projectDir, 'dangling-ssh');
      await symlink(path.join(fakeHome, '.ssh', 'id_ed25519'), linkFile);
      await symlink(path.join(fakeHome, '.imcodes'), linkDir);
      await symlink(path.join(fakeHome, '.ssh', 'missing-id_rsa'), danglingLink);

      expect(await isParticipantSensitiveRealPath(linkFile, { homeDir: fakeHome, cwd: projectDir })).toBe(true);
      expect(await isParticipantSensitiveRealPath(path.join(linkDir, 'server.json'), { homeDir: fakeHome, cwd: projectDir })).toBe(true);
      expect(await isParticipantSensitiveRealPath(path.join(linkDir, 'new-file.txt'), { homeDir: fakeHome, cwd: projectDir })).toBe(true);
      expect(await isParticipantSensitiveRealPath(danglingLink, { homeDir: fakeHome, cwd: projectDir })).toBe(true);
      expect(await isParticipantSensitiveRealPath(path.join(projectDir, 'src', 'ssh-helper.ts'), { homeDir: fakeHome, cwd: projectDir })).toBe(false);
    });
  });

  describe('findSensitivePathInToolRequest', () => {
    const opts = { homeDir: '/home/k', cwd: '/home/k/projects/app' };

    it('detects sensitive paths across description, inputPreview JSON, shell commands, and raw input', () => {
      expect(findSensitivePathInToolRequest({
        tool: 'bash',
        description: 'Run command: cat ~/.ssh/id_rsa',
      }, opts)).toBe('~/.ssh/id_rsa');

      expect(findSensitivePathInToolRequest({
        tool: 'read',
        description: 'Read file',
        inputPreview: JSON.stringify({ file_path: '/home/k/.imcodes/server.json' }),
      }, opts)).toBe('/home/k/.imcodes/server.json');

      expect(findSensitivePathInToolRequest({
        tool: 'bash',
        description: 'Inspect env',
        inputPreview: 'head -n 10 /proc/self/environ && echo ok',
      }, opts)).toBe('/proc/self/environ');

      expect(findSensitivePathInToolRequest({
        tool: 'read',
        description: 'Read Windows key',
        input: { path: 'C:\\Users\\k\\.ssh\\id_ed25519' },
      }, opts)).toBe('C:\\Users\\k\\.ssh\\id_ed25519');
    });

    it('returns null for normal project tool approvals', () => {
      expect(findSensitivePathInToolRequest({
        tool: 'read',
        description: 'Read src/ssh-helper.ts',
        inputPreview: JSON.stringify({ file_path: 'src/ssh-helper.ts' }),
      }, opts)).toBeNull();

      expect(findSensitivePathInToolRequest({
        tool: 'bash',
        description: 'Run tests',
        inputPreview: 'npx vitest run test/keys.test.ts',
      }, opts)).toBeNull();
    });
  });

  describe('evaluateParticipantToolAccess (F2 canonical execution guard)', () => {
    let rootDir: string;
    let fakeHome: string;
    let projectDir: string;

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), 'imcodes-eval-tool-'));
      fakeHome = path.join(rootDir, 'home');
      projectDir = path.join(rootDir, 'project');
      await mkdir(path.join(fakeHome, '.ssh'), { recursive: true });
      await mkdir(path.join(fakeHome, '.imcodes'), { recursive: true });
      await mkdir(path.join(projectDir, 'src'), { recursive: true });
      await writeFile(path.join(fakeHome, '.ssh', 'id_ed25519'), 'PRIVATE-KEY');
      await writeFile(path.join(fakeHome, '.imcodes', 'server.json'), '{"token":"secret"}');
      await writeFile(path.join(projectDir, 'src', 'ssh-helper.ts'), 'export const helper = true;\n');
      await symlink(path.join(fakeHome, '.ssh', 'id_ed25519'), path.join(projectDir, 'leak-key'));
      await symlink(path.join(fakeHome, '.imcodes', 'server.json'), path.join(projectDir, 'leak-imcodes'));
    });

    afterEach(async () => {
      await rm(rootDir, { recursive: true, force: true });
    });

    it('resolves relative workspace symlinks canonically across structured tool inputs and patch headers', async () => {
      const opts = { homeDir: fakeHome, cwd: projectDir };
      await expect(evaluateParticipantToolAccess({
        toolName: 'Read',
        input: { file_path: 'leak-key' },
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'apply_patch',
        input: { patchText: '*** Update File: leak-imcodes\n@@\n-a\n+b' },
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'read',
        input: { uri: `file://${path.join(projectDir, 'leak-key')}` },
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Bash',
        input: { command: `bash -c "python3 -c 'print(open(\"${fakeHome}/.ssh/id_ed25519\").read())'"` },
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Read',
        input: { file_path: 'src/ssh-helper.ts' },
        cwd: projectDir,
      }, opts)).resolves.toEqual({ allow: true });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Bash',
        input: { command: 'npx vitest run test/keys.test.ts' },
        cwd: projectDir,
      }, opts)).resolves.toEqual({ allow: true });
    });

    it('fails closed on truncated inputPreview or missing target paths/commands for file/shell tools', async () => {
      const opts = { homeDir: fakeHome, cwd: projectDir };
      await expect(evaluateParticipantToolAccess({
        toolName: 'Read',
        inputPreview: `{"file_path":"${'a'.repeat(300)}...`,
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Read',
        input: {},
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Bash',
        input: {},
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });
    });

    it('separates file content/search patterns from real I/O targets while blocking sensitive targets and missing structured paths (F2-R2)', async () => {
      const opts = { homeDir: fakeHome, cwd: projectDir };
      // Write / Edit whose content mentions ~/.ssh in documentation/comments to normal project file -> ALLOWED
      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        input: {
          file_path: 'test/keys.test.ts',
          content: '// Security note: participant turns must never read ~/.ssh/id_ed25519 or ~/.imcodes/server.json\nexport const ok = true;\n',
        },
        cwd: projectDir,
      }, opts)).resolves.toEqual({ allow: true });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Edit',
        input: {
          file_path: 'src/ssh-helper.ts',
          old_string: 'helper = true',
          new_string: '// Docs: ~/.aws/credentials and /etc/shadow are protected\nexport const helper = true',
        },
        cwd: projectDir,
      }, opts)).resolves.toEqual({ allow: true });

      // Grep regex searching for `.ssh` inside `src/` -> ALLOWED
      await expect(evaluateParticipantToolAccess({
        toolName: 'Grep',
        input: { pattern: '\\.ssh|id_ed25519', path: 'src' },
        cwd: projectDir,
      }, opts)).resolves.toEqual({ allow: true });

      // Actual target is sensitive -> BLOCKED
      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        input: { file_path: '~/.ssh/authorized_keys', content: 'ssh-ed25519 AAAA' },
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        input: { file_path: 'leak-key', content: 'overwrite' },
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      // Write missing target key even when content + description exist -> FAIL CLOSED
      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        input: { content: 'no file path key' },
        description: 'Write test/keys.test.ts',
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });
    });

    it('denies targetless approval descriptions and honors bound pre-evaluated full-input allow even when inputPreview is truncated (F2-R3)', async () => {
      const opts = { homeDir: fakeHome, cwd: projectDir };
      // Targetless Read / Bash / Glob approvals with innocuous description only -> MUST fail closed
      await expect(evaluateParticipantToolAccess({
        toolName: 'Read',
        description: 'Read a document',
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Bash',
        description: 'Run diagnostics',
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Glob',
        description: 'Search workspace',
        cwd: projectDir,
      }, opts)).resolves.toMatchObject({ allow: false });

      // Full structured Write with >300-char payload passes pre-execution check cleanly
      const fullInput = { file_path: 'src/long.ts', content: 'x'.repeat(400) };
      const preDecision = await evaluateParticipantToolAccess({
        toolName: 'Write',
        input: fullInput,
        toolUseId: 'tu-r4-1',
        cwd: projectDir,
      }, { ...opts, sessionName: 'deck_r4_sess' });
      expect(preDecision).toEqual({ allow: true });

      recordPreEvaluatedParticipantToolDecision({
        sessionName: 'deck_r4_sess',
        toolUseId: 'tu-r4-1',
        toolName: 'Write',
        decision: preDecision,
      });

      const truncatedPreview = JSON.stringify(fullInput).slice(0, 300);
      // Bound session + toolUseId + toolName honors pre-evaluated allow despite >300 char truncation
      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        description: 'Write src/long.ts',
        inputPreview: truncatedPreview,
        toolUseId: 'tu-r4-1',
        cwd: projectDir,
      }, { ...opts, sessionName: 'deck_r4_sess' })).resolves.toEqual({ allow: true });

      // Different toolName / session / after clear cannot reuse the bound decision
      await expect(evaluateParticipantToolAccess({
        toolName: 'Read',
        description: 'Read a document',
        toolUseId: 'tu-r4-1',
        cwd: projectDir,
      }, { ...opts, sessionName: 'deck_r4_sess' })).resolves.toMatchObject({ allow: false });

      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        description: 'Write src/long.ts',
        inputPreview: truncatedPreview,
        toolUseId: 'tu-r4-1',
        cwd: projectDir,
      }, { ...opts, sessionName: 'deck_other_sess' })).resolves.toMatchObject({ allow: false });

      clearPreEvaluatedParticipantToolDecisions('deck_r4_sess');
      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        description: 'Write src/long.ts',
        inputPreview: truncatedPreview,
        toolUseId: 'tu-r4-1',
        cwd: projectDir,
      }, { ...opts, sessionName: 'deck_r4_sess' })).resolves.toMatchObject({ allow: false });

      // F2-R4: binding checks providerSessionId, dispatchId, and monotonic turnEpoch against stale late writes
      const epochBeforeClear = getParticipantToolTurnEpoch('deck_r5_sess');
      expect(recordPreEvaluatedParticipantToolDecision({
        sessionName: 'deck_r5_sess',
        providerSessionId: 'prov-1',
        dispatchId: 7,
        expectedTurnEpoch: epochBeforeClear,
        toolUseId: 'tu-r5-1',
        toolName: 'Write',
        decision: { allow: true },
      })).toBe(true);

      // Matching binding works for truncated preview
      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        description: 'Write src/long.ts',
        inputPreview: truncatedPreview,
        toolUseId: 'tu-r5-1',
        cwd: projectDir,
      }, {
        ...opts,
        sessionName: 'deck_r5_sess',
        providerSessionId: 'prov-1',
        dispatchId: 7,
      })).resolves.toEqual({ allow: true });

      // Different providerSessionId or dispatchId cannot reuse it
      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        description: 'Write src/long.ts',
        inputPreview: truncatedPreview,
        toolUseId: 'tu-r5-1',
        cwd: projectDir,
      }, {
        ...opts,
        sessionName: 'deck_r5_sess',
        providerSessionId: 'prov-2',
        dispatchId: 7,
      })).resolves.toMatchObject({ allow: false });
      await expect(evaluateParticipantToolAccess({
        toolName: 'Write',
        description: 'Write src/long.ts',
        inputPreview: truncatedPreview,
        toolUseId: 'tu-r5-1',
        cwd: projectDir,
      }, {
        ...opts,
        sessionName: 'deck_r5_sess',
        providerSessionId: 'prov-1',
        dispatchId: 8,
      })).resolves.toMatchObject({ allow: false });

      // Advancing turn epoch rejects delayed stale writes from an earlier epoch
      clearPreEvaluatedParticipantToolDecisions('deck_r5_sess');
      expect(recordPreEvaluatedParticipantToolDecision({
        sessionName: 'deck_r5_sess',
        providerSessionId: 'prov-1',
        dispatchId: 7,
        expectedTurnEpoch: epochBeforeClear,
        toolUseId: 'tu-r5-late',
        toolName: 'Write',
        decision: { allow: true },
      })).toBe(false);
    });
  });

  describe('assertParticipantSubtreeSafe (F3 subtree safety check)', () => {
    let rootDir: string;
    let fakeHome: string;
    let projectDir: string;

    beforeEach(async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), 'imcodes-subtree-'));
      fakeHome = path.join(rootDir, 'home');
      projectDir = path.join(rootDir, 'project');
      await mkdir(path.join(fakeHome, '.ssh'), { recursive: true });
      await writeFile(path.join(fakeHome, '.ssh', 'id_ed25519'), 'PRIVATE-KEY');
      await mkdir(path.join(projectDir, 'safe-dir', 'nested'), { recursive: true });
      await writeFile(path.join(projectDir, 'safe-dir', 'a.ts'), 'export const a = 1;\n');
      await writeFile(path.join(projectDir, 'safe-dir', 'nested', 'b.ts'), 'export const b = 2;\n');
    });

    afterEach(async () => {
      await rm(rootDir, { recursive: true, force: true });
    });

    it('allows clean files/subtrees and fails closed on nested sensitive files, nested symlinks, missing paths, and entry cap overflow', async () => {
      const opts = { homeDir: fakeHome, cwd: projectDir };
      expect(await assertParticipantSubtreeSafe(path.join(projectDir, 'safe-dir', 'a.ts'), opts)).toBe(true);
      expect(await assertParticipantSubtreeSafe(path.join(projectDir, 'safe-dir'), opts)).toBe(true);

      // Exceeding maxEntries fails closed
      expect(await assertParticipantSubtreeSafe(path.join(projectDir, 'safe-dir'), { ...opts, maxEntries: 2 })).toBe(false);

      // Missing path fails closed
      expect(await assertParticipantSubtreeSafe(path.join(projectDir, 'does-not-exist'), opts)).toBe(false);

      // Nested symlink inside directory
      await symlink(path.join(fakeHome, '.ssh', 'id_ed25519'), path.join(projectDir, 'safe-dir', 'nested', 'leak-key'));
      expect(await assertParticipantSubtreeSafe(path.join(projectDir, 'safe-dir'), opts)).toBe(false);

      // Nested .npmrc inside separate directory
      await mkdir(path.join(projectDir, 'npmrc-dir', 'sub'), { recursive: true });
      await writeFile(path.join(projectDir, 'npmrc-dir', 'sub', '.npmrc'), '//registry/:_authToken=secret\n');
      expect(await assertParticipantSubtreeSafe(path.join(projectDir, 'npmrc-dir'), opts)).toBe(false);

      // Projected destination subtree check catches two-segment sensitive combinations created by rename
      await mkdir(path.join(projectDir, 'staged-gh', 'gh'), { recursive: true });
      await writeFile(path.join(projectDir, 'staged-gh', 'gh', 'hosts.yml'), 'github.com:\n');
      expect(await assertParticipantSubtreeSafe(path.join(projectDir, 'staged-gh'), {
        ...opts,
        projectedDestinationRoot: path.join(projectDir, 'moved-safe'),
      })).toBe(true);
      expect(await assertParticipantSubtreeSafe(path.join(projectDir, 'staged-gh'), {
        ...opts,
        projectedDestinationRoot: path.join(projectDir, '.config'),
      })).toBe(false);
    });
  });
});
