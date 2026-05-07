import { describe, expect, it } from 'vitest';
import {
  expandFilePreviewPath,
  getDeniedSensitivePathPrefixes,
  getValidatedRealPath,
  isCaseInsensitiveFilePreviewPlatform,
  isFilePreviewPathAllowed,
  resolveCanonical,
  validateCanonicalRealPath,
} from '../../src/daemon/file-preview-path-policy.js';

describe('file preview path policy', () => {
  it('expands home paths and returns a validated real path in strict mode', async () => {
    const result = await resolveCanonical('~/project/file.txt', 'strict', {
      platform: 'linux',
      homedir: () => '/home/ada',
      cwd: '/tmp',
      realpath: async (targetPath) => targetPath,
    });

    expect(result).toMatchObject({
      expandedPath: '/home/ada/project/file.txt',
      resolvedPath: '/home/ada/project/file.txt',
      realPath: '/home/ada/project/file.txt',
      usedFallback: false,
    });
    expect(getValidatedRealPath(result)).toBe('/home/ada/project/file.txt');
  });

  it.each(['.ssh', '.gnupg', '.pki'] as const)('rejects denied home directory %s', async (deniedDir) => {
    const result = await resolveCanonical(`/home/ada/${deniedDir}/secret.txt`, 'strict', {
      platform: 'linux',
      homedir: () => '/home/ada',
      realpath: async () => `/home/ada/${deniedDir}/secret.txt`,
    });

    expect(result).toBeNull();
  });

  it('rejects symlinks that canonicalize into denied paths', async () => {
    const result = await resolveCanonical('/home/ada/link-to-key', 'strict', {
      platform: 'linux',
      homedir: () => '/home/ada',
      realpath: async () => '/home/ada/.ssh/id_rsa',
    });

    expect(result).toBeNull();
  });

  it.each([
    ['C:\\Users\\Ada\\.SSH\\id_rsa'],
    ['C:\\Users\\Ada\\.GnuPG\\pubring.kbx'],
    ['C:\\Users\\Ada\\.PKI\\cert.pem'],
  ])('uses case-insensitive deny-list matching on Windows for %s', (targetPath) => {
    expect(isCaseInsensitiveFilePreviewPlatform('win32')).toBe(true);
    expect(isFilePreviewPathAllowed(targetPath, {
      platform: 'win32',
      homedir: () => 'C:\\Users\\Ada',
    })).toBe(false);
  });

  it('uses case-insensitive deny-list matching on macOS by default', () => {
    expect(isCaseInsensitiveFilePreviewPlatform('darwin')).toBe(true);
    expect(isFilePreviewPathAllowed('/Users/ada/.SSH/id_rsa', {
      platform: 'darwin',
      homedir: () => '/Users/ada',
    })).toBe(false);
  });

  it('keeps Linux deny-list matching case-sensitive', () => {
    expect(isCaseInsensitiveFilePreviewPlatform('linux')).toBe(false);
    expect(isFilePreviewPathAllowed('/home/ada/.SSH/id_rsa', {
      platform: 'linux',
      homedir: () => '/home/ada',
    })).toBe(true);
    expect(isFilePreviewPathAllowed('/home/ada/.ssh/id_rsa', {
      platform: 'linux',
      homedir: () => '/home/ada',
    })).toBe(false);
  });

  it('fails closed in strict mode when realpath rejects', async () => {
    const result = await resolveCanonical('/home/ada/project/file.txt', 'strict', {
      platform: 'linux',
      homedir: () => '/home/ada',
      realpath: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });

    expect(result).toBeNull();
  });

  it('allows documented Windows lenient fallback and marks it non-downloadable', async () => {
    const result = await resolveCanonical('C:\\Users\\Ada\\junction\\file.txt', 'lenient', {
      platform: 'win32',
      homedir: () => 'C:\\Users\\Ada',
      cwd: 'C:\\Users\\Ada',
      realpath: async () => {
        throw Object.assign(new Error('EINVAL: reparse point failed'), { code: 'EINVAL' });
      },
    });

    expect(result).toMatchObject({
      realPath: 'C:\\Users\\Ada\\junction\\file.txt',
      usedFallback: true,
      validatedRealPath: null,
    });
    expect(getValidatedRealPath(result)).toBeNull();
  });

  it.each([
    ['EPERM'],
    ['UNKNOWN'],
  ])('fails closed for generic Windows %s realpath errors without reparse evidence', async (code) => {
    const result = await resolveCanonical('C:\\Users\\Ada\\locked\\file.txt', 'lenient', {
      platform: 'win32',
      homedir: () => 'C:\\Users\\Ada',
      cwd: 'C:\\Users\\Ada',
      realpath: async () => {
        throw Object.assign(new Error('access denied'), { code });
      },
    });

    expect(result).toBeNull();
  });

  it('allows UNKNOWN Windows fallback only when the error identifies a reparse path', async () => {
    const result = await resolveCanonical('C:\\Users\\Ada\\junction\\file.txt', 'lenient', {
      platform: 'win32',
      homedir: () => 'C:\\Users\\Ada',
      cwd: 'C:\\Users\\Ada',
      realpath: async () => {
        throw Object.assign(new Error('UNKNOWN: reparse point failed'), { code: 'UNKNOWN' });
      },
    });

    expect(result).toMatchObject({
      realPath: 'C:\\Users\\Ada\\junction\\file.txt',
      usedFallback: true,
      validatedRealPath: null,
    });
  });

  it('does not use lenient fallback on non-Windows platforms', async () => {
    const result = await resolveCanonical('/home/ada/link/file.txt', 'lenient', {
      platform: 'linux',
      homedir: () => '/home/ada',
      realpath: async () => {
        throw Object.assign(new Error('EINVAL: reparse point failed'), { code: 'EINVAL' });
      },
    });

    expect(result).toBeNull();
  });

  it('reads home directory sources at call time', async () => {
    let home = '/home/one';
    const homedir = () => home;

    const denied = await resolveCanonical('/home/one/.ssh/key', 'strict', {
      platform: 'linux',
      homedir,
      realpath: async (targetPath) => targetPath,
    });

    home = '/home/two';
    const allowedAfterHomeChange = await resolveCanonical('/home/one/.ssh/key', 'strict', {
      platform: 'linux',
      homedir,
      realpath: async (targetPath) => targetPath,
    });

    expect(denied).toBeNull();
    expect(allowedAfterHomeChange?.realPath).toBe('/home/one/.ssh/key');
    expect(getDeniedSensitivePathPrefixes({ platform: 'linux', homedir })).toEqual([
      '/home/two/.ssh',
      '/home/two/.gnupg',
      '/home/two/.pki',
    ]);
  });

  it('validates already canonical paths without branding denied paths', () => {
    expect(validateCanonicalRealPath('/home/ada/project/file.txt', {
      platform: 'linux',
      homedir: () => '/home/ada',
    })).toBe('/home/ada/project/file.txt');
    expect(validateCanonicalRealPath('/home/ada/.ssh/id_rsa', {
      platform: 'linux',
      homedir: () => '/home/ada',
    })).toBeNull();
  });

  it('expands both slash styles after tilde', () => {
    expect(expandFilePreviewPath('~/project', '/home/ada', 'linux')).toBe('/home/ada/project');
    expect(expandFilePreviewPath('~\\project', 'C:\\Users\\Ada', 'win32')).toBe('C:\\Users\\Ada\\project');
  });
});
