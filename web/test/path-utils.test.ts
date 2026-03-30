import { describe, it, expect } from 'vitest';
import { pathBasename, isAbsolutePath, detectSeparator, pathDirname } from '../src/util/path-utils.js';

describe('pathBasename', () => {
  // Unix paths
  it('extracts filename from Unix absolute path', () => {
    expect(pathBasename('/home/user/project/file.ts')).toBe('file.ts');
  });
  it('extracts filename from Unix root file', () => {
    expect(pathBasename('/file.ts')).toBe('file.ts');
  });
  it('extracts last segment from Unix directory', () => {
    expect(pathBasename('/home/user/project')).toBe('project');
  });
  it('handles trailing slash', () => {
    expect(pathBasename('/home/user/project/')).toBe('');
  });
  it('handles root path', () => {
    expect(pathBasename('/')).toBe('');
  });
  it('handles tilde path', () => {
    expect(pathBasename('~/projects/app/main.go')).toBe('main.go');
  });
  it('handles relative path', () => {
    expect(pathBasename('src/index.ts')).toBe('index.ts');
  });
  it('handles bare filename', () => {
    expect(pathBasename('file.txt')).toBe('file.txt');
  });

  // Windows paths
  it('extracts filename from Windows absolute path', () => {
    expect(pathBasename('C:\\Users\\user\\project\\file.ts')).toBe('file.ts');
  });
  it('extracts filename from Windows drive root file', () => {
    expect(pathBasename('C:\\file.ts')).toBe('file.ts');
  });
  it('handles Windows path with forward slashes', () => {
    expect(pathBasename('C:/Users/user/file.ts')).toBe('file.ts');
  });
  it('handles mixed separators', () => {
    expect(pathBasename('C:\\Users/user\\project/file.ts')).toBe('file.ts');
  });
  it('extracts shell binary name from Windows path', () => {
    expect(pathBasename('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell.exe');
  });
  it('handles UNC path', () => {
    expect(pathBasename('\\\\server\\share\\file.txt')).toBe('file.txt');
  });
});

describe('isAbsolutePath', () => {
  // Unix
  it('detects Unix absolute path', () => {
    expect(isAbsolutePath('/home/user')).toBe(true);
  });
  it('detects Unix root', () => {
    expect(isAbsolutePath('/')).toBe(true);
  });
  it('detects tilde path', () => {
    expect(isAbsolutePath('~/projects')).toBe(true);
  });
  it('detects bare tilde', () => {
    expect(isAbsolutePath('~')).toBe(true);
  });
  it('rejects relative path', () => {
    expect(isAbsolutePath('src/index.ts')).toBe(false);
  });
  it('rejects bare filename', () => {
    expect(isAbsolutePath('file.txt')).toBe(false);
  });
  it('rejects dot-relative path', () => {
    expect(isAbsolutePath('./src/index.ts')).toBe(false);
  });

  // Windows
  it('detects Windows drive letter with backslash', () => {
    expect(isAbsolutePath('C:\\Users\\user')).toBe(true);
  });
  it('detects Windows drive letter with forward slash', () => {
    expect(isAbsolutePath('C:/Users/user')).toBe(true);
  });
  it('detects lowercase drive letter', () => {
    expect(isAbsolutePath('d:\\projects')).toBe(true);
  });
  it('detects UNC path', () => {
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
  });
  it('rejects bare drive letter without separator', () => {
    expect(isAbsolutePath('C:')).toBe(false);
  });
});

describe('detectSeparator', () => {
  it('detects forward slash for Unix paths', () => {
    expect(detectSeparator('/home/user/project')).toBe('/');
  });
  it('detects backslash for Windows paths', () => {
    expect(detectSeparator('C:\\Users\\user')).toBe('\\');
  });
  it('detects backslash in mixed paths', () => {
    expect(detectSeparator('C:\\Users/user')).toBe('\\');
  });
  it('defaults to forward slash for bare names', () => {
    expect(detectSeparator('file.txt')).toBe('/');
  });
});

describe('pathDirname', () => {
  // Unix
  it('gets parent of Unix file path', () => {
    expect(pathDirname('/home/user/file.ts')).toBe('/home/user');
  });
  it('gets parent of Unix directory with trailing slash', () => {
    expect(pathDirname('/home/user/')).toBe('/home');
  });
  it('gets root for top-level file', () => {
    expect(pathDirname('/file.ts')).toBe('/');
  });

  // Windows
  it('gets parent of Windows file path', () => {
    expect(pathDirname('C:\\Users\\user\\file.ts')).toBe('C:/Users/user');
  });
  it('gets drive root for top-level Windows file', () => {
    expect(pathDirname('C:\\file.ts')).toBe('C:');
  });
});
