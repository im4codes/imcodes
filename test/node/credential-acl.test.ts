import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, chmod, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateInstallIdentity,
  loadCredential,
  loadInstallIdentity,
  persistCredential,
  persistInstallIdentity,
} from '../../src/node/enrollment.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import {
  FS_RIGHTS,
  evaluateAclReport,
  parseAclJson,
  type AclReport,
} from '../../src/node/windows-security.js';

const cred = { serverId: 's1', token: 't1', serverUrl: 'https://im.example', nodeRole: NODE_ROLE.CONTROLLED } as const;
const isWin = process.platform === 'win32';

describe.skipIf(isWin)('controlled credential ACL (10.10, POSIX)', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'imcodes-cred-')); path = join(dir, 'nested', 'credential.json'); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('persists with 0600 file + 0700 dir and loads back', async () => {
    await persistCredential(cred, path);
    const fileMode = (await stat(path)).mode & 0o777;
    expect(fileMode & 0o077).toBe(0); // no group/world bits
    const loaded = await loadCredential(path);
    expect(loaded).toMatchObject({ serverId: 's1', nodeRole: NODE_ROLE.CONTROLLED });
  });

  it('refuses to load a group/world-readable credential', async () => {
    await persistCredential(cred, path);
    await chmod(path, 0o644); // world-readable
    await expect(loadCredential(path)).rejects.toThrow(/permissions_insecure/);
  });

  it('refuses to load a symlinked credential', async () => {
    const real = join(dir, 'real.json');
    await writeFile(real, JSON.stringify(cred), { mode: 0o600 });
    const link = join(dir, 'link.json');
    await symlink(real, link);
    await expect(loadCredential(link)).rejects.toThrow(/symlink/);
  });

  it('refuses to persist over a pre-existing symlink', async () => {
    const real = join(dir, 'real2.json');
    await writeFile(real, '{}', { mode: 0o600 });
    const link = join(dir, 'link2.json');
    await symlink(real, link);
    await expect(persistCredential(cred, link)).rejects.toThrow(/symlink/);
  });
});

const secureWindowsReport = (overrides: Partial<AclReport> = {}): AclReport => ({
  path: 'C:\\ProgramData\\imcodes-node',
  owner: 'S-1-5-18',
  protectedDacl: true,
  principals: [
    { sid: 'S-1-5-18', isAllow: true, inherited: false, rights: FS_RIGHTS.FullControl },
    { sid: 'S-1-5-32-544', isAllow: true, inherited: false, rights: FS_RIGHTS.FullControl },
  ],
  raw: '{}',
  ...overrides,
});

describe('controlled credential ACL (10.10, Windows effective rights)', () => {
  it('accepts only a protected SYSTEM + Administrators full-control DACL', () => {
    expect(evaluateAclReport(secureWindowsReport())).toMatchObject({ ok: true, reason: 'ok' });
  });

  it('rejects inheritance, extra read/list principals, missing required rights, and unexpected owner', () => {
    expect(evaluateAclReport(secureWindowsReport({ protectedDacl: false })).reason).toBe('dacl_inheritance_enabled');
    expect(evaluateAclReport(secureWindowsReport({
      principals: [...secureWindowsReport().principals, {
        sid: 'S-1-1-0', isAllow: true, inherited: true, rights: FS_RIGHTS.ReadData,
      }],
    })).reason).toBe('inherited_ace_present');
    expect(evaluateAclReport(secureWindowsReport({
      principals: [...secureWindowsReport().principals, {
        sid: 'S-1-5-32-545', isAllow: true, inherited: false, rights: FS_RIGHTS.ReadData,
      }],
    })).reason).toMatch(/^unauthorized_allow:S-1-5-32-545/);
    expect(evaluateAclReport(secureWindowsReport({
      principals: secureWindowsReport().principals.filter((p) => p.sid !== 'S-1-5-18'),
    })).reason).toBe('missing_full_control:S-1-5-18');
    expect(evaluateAclReport(secureWindowsReport({ owner: 'S-1-5-21-1000' })).reason)
      .toBe('unauthorized_owner:S-1-5-21-1000');
  });

  it('rejects malformed/unknown ACE JSON instead of coercing it', () => {
    expect(() => parseAclJson(JSON.stringify({
      path: 'C:\\ProgramData\\imcodes-node', owner: 'S-1-5-18', protectedDacl: true,
      principals: [{ sid: 'Users', isAllow: true, inherited: false, rights: 'read' }],
    }))).toThrow(/windows_acl_ace_invalid/);
  });

  it('checks the live Windows ACL before loading both credential and install identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-win-cred-'));
    const credentialPath = join(dir, 'credential.json');
    const identityPath = join(dir, 'install-identity.json');
    try {
      await persistCredential(cred, credentialPath);
      await persistInstallIdentity({ ...generateInstallIdentity(), sourceExePath: 'C:\\download\\node.exe' }, identityPath);
      let checks = 0;
      const assertCredentialDirSecured = async (checkedDir: string) => {
        expect([dir, credentialPath, identityPath]).toContain(checkedDir);
        checks += 1;
      };
      await expect(loadCredential(credentialPath, { platform: 'win32', assertCredentialDirSecured }))
        .resolves.toMatchObject({ serverId: 's1' });
      await expect(loadInstallIdentity(identityPath, { platform: 'win32', assertCredentialDirSecured }))
        .resolves.toMatchObject({ sourceExePath: 'C:\\download\\node.exe' });
      expect(checks).toBe(4);

      const rejectAcl = async () => { throw new Error('windows_credential_acl_insecure'); };
      await expect(loadCredential(credentialPath, { platform: 'win32', assertCredentialDirSecured: rejectAcl }))
        .rejects.toThrow(/acl_insecure/);
      await expect(loadInstallIdentity(identityPath, { platform: 'win32', assertCredentialDirSecured: rejectAcl }))
        .rejects.toThrow(/acl_insecure/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
