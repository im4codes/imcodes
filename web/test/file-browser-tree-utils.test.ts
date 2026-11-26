import { describe, expect, it } from 'vitest';
import { resolveFileIconSpec } from '../src/components/FileTypeIcon.js';
import {
  buildChildFsPath,
  canDropPathIntoDir,
  collectVisibleTreeEntries,
  computeDirGitStatus,
  getParentDirPath,
  getRenameSelectionRange,
  isPathEqualOrDescendant,
  isValidEntryName,
  toRelativeDisplayPath,
} from '../src/components/file-browser-tree-utils.js';

describe('FileTypeIcon resolveFileIconSpec', () => {
  it('distinguishes open and closed folders and common file extensions/special names', () => {
    expect(resolveFileIconSpec('src', true, false).kind).toBe('folder-closed');
    expect(resolveFileIconSpec('src', true, true).kind).toBe('folder-open');
    expect(resolveFileIconSpec('app.ts', false).kind).toBe('ts');
    expect(resolveFileIconSpec('Panel.tsx', false).kind).toBe('tsx');
    expect(resolveFileIconSpec('index.js', false).kind).toBe('js');
    expect(resolveFileIconSpec('App.jsx', false).kind).toBe('jsx');
    expect(resolveFileIconSpec('package.json', false).kind).toBe('npm');
    expect(resolveFileIconSpec('tsconfig.base.json', false).kind).toBe('tsconfig');
    expect(resolveFileIconSpec('README.md', false).kind).toBe('markdown');
    expect(resolveFileIconSpec('styles.css', false).kind).toBe('css');
    expect(resolveFileIconSpec('main.py', false).kind).toBe('python');
    expect(resolveFileIconSpec('lib.rs', false).kind).toBe('rust');
    expect(resolveFileIconSpec('server.go', false).kind).toBe('go');
    expect(resolveFileIconSpec('deploy.sh', false).kind).toBe('shell');
    expect(resolveFileIconSpec('Dockerfile', false).kind).toBe('docker');
    expect(resolveFileIconSpec('.gitignore', false).kind).toBe('git');
    expect(resolveFileIconSpec('.env.local', false).kind).toBe('env');
    expect(resolveFileIconSpec('report.docx', false).kind).toBe('word');
    expect(resolveFileIconSpec('budget.xlsx', false).kind).toBe('excel');
    expect(resolveFileIconSpec('deck.pptx', false).kind).toBe('ppt');
    expect(resolveFileIconSpec('logo.png', false).kind).toBe('image');
    expect(resolveFileIconSpec('unknown.customext', false).kind).toBe('file');
  });
});

describe('file-browser-tree-utils path and git helpers', () => {
  it('handles Unix, Windows, and :session-root: paths in getParentDirPath and buildChildFsPath', () => {
    expect(getParentDirPath('/home/user/src/app.ts')).toBe('/home/user/src');
    expect(getParentDirPath('/home')).toBe('/');
    expect(getParentDirPath('/')).toBeNull();
    expect(getParentDirPath('C:\\Users\\dev\\repo\\src\\a.ts')).toBe('C:\\Users\\dev\\repo\\src');
    expect(getParentDirPath('C:\\Users')).toBe('C:\\');
    expect(getParentDirPath('C:\\')).toBeNull();
    expect(getParentDirPath(':session-root:/src/a.ts')).toBe(':session-root:/src');
    expect(getParentDirPath(':session-root:')).toBeNull();
    expect(getParentDirPath('~')).toBeNull();

    expect(buildChildFsPath('/home/user', 'file.ts')).toBe('/home/user/file.ts');
    expect(buildChildFsPath('/', 'file.ts')).toBe('/file.ts');
    expect(buildChildFsPath('C:\\repo', 'file.ts')).toBe('C:\\repo\\file.ts');
    expect(buildChildFsPath('C:\\', 'file.ts')).toBe('C:\\file.ts');
    expect(buildChildFsPath(':session-root:', 'src')).toBe(':session-root:/src');
  });

  it('computes relative paths safely without prefix collisions', () => {
    expect(toRelativeDisplayPath('/home/user/repo/src/a.ts', '/home/user/repo')).toBe('src/a.ts');
    expect(toRelativeDisplayPath('/home/user/repo', '/home/user/repo')).toBe('.');
    expect(toRelativeDisplayPath('/home/user/repo2/a.ts', '/home/user/repo')).toBe('/home/user/repo2/a.ts');
    expect(toRelativeDisplayPath('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe('src\\a.ts');
    expect(toRelativeDisplayPath(':session-root:/docs/spec.md', ':session-root:')).toBe('docs/spec.md');
  });

  it('checks descendant boundaries accurately across Unix and Windows paths', () => {
    expect(isPathEqualOrDescendant('/repo/src/a.ts', '/repo/src')).toBe(true);
    expect(isPathEqualOrDescendant('/repo/src2/a.ts', '/repo/src')).toBe(false);
    expect(isPathEqualOrDescendant('C:\\Repo\\Sub\\a.ts', 'c:\\repo\\sub')).toBe(true);
    expect(isPathEqualOrDescendant(':session-root:/sub/a.ts', ':session-root:')).toBe(true);
  });

  it('propagates git status to ancestor folders with severity priority and ignores gitignored files', () => {
    const map = new Map<string, string>([
      ['/repo/src/utils/a.ts', '??'],
      ['/repo/src/components/b.ts', 'M'],
      ['/repo/dist/bundle.js', '!!'],
      ['C:\\winrepo\\pkg\\index.ts', 'A'],
      [':session-root:/notes/todo.md', 'D'],
    ]);
    const dirGit = computeDirGitStatus(map);
    expect(dirGit.get('/repo/src/utils')).toBe('untracked');
    expect(dirGit.get('/repo/src/components')).toBe('modified');
    expect(dirGit.get('/repo/src')).toBe('modified');
    expect(dirGit.has('/repo/dist')).toBe(false);
    expect(dirGit.get('C:\\winrepo\\pkg')).toBe('added');
    expect(dirGit.get(':session-root:/notes')).toBe('deleted');
    expect(dirGit.get(':session-root:')).toBe('deleted');
  });

  it('validates entry names and computes inline rename stem selection ranges', () => {
    expect(isValidEntryName('good.ts')).toBe(true);
    expect(isValidEntryName('')).toBe(false);
    expect(isValidEntryName('   ')).toBe(false);
    expect(isValidEntryName('.')).toBe(false);
    expect(isValidEntryName('..')).toBe(false);
    expect(isValidEntryName('a/b')).toBe(false);
    expect(isValidEntryName('a\\b')).toBe(false);

    expect(getRenameSelectionRange('foo.ts', false)).toEqual({ start: 0, end: 3 });
    expect(getRenameSelectionRange('archive.tar.gz', false)).toEqual({ start: 0, end: 11 });
    expect(getRenameSelectionRange('.gitignore', false)).toEqual({ start: 0, end: 10 });
    expect(getRenameSelectionRange('v1.0.0', true)).toEqual({ start: 0, end: 6 });
  });

  it('guards drag-and-drop moves against self, same-parent, and descendant targets', () => {
    expect(canDropPathIntoDir('/repo/src/a.ts', '/repo/lib')).toBe(true);
    expect(canDropPathIntoDir('/repo/src/a.ts', '/repo/src')).toBe(false);
    expect(canDropPathIntoDir('/repo/src', '/repo/src')).toBe(false);
    expect(canDropPathIntoDir('/repo/src', '/repo/src/nested')).toBe(false);
    expect(canDropPathIntoDir('/repo/src', '/repo/src2')).toBe(true);
    expect(canDropPathIntoDir('C:\\repo\\src', 'C:\\repo\\src\\child')).toBe(false);
    expect(canDropPathIntoDir('C:\\repo\\src\\a.ts', 'C:\\repo\\other')).toBe(true);
  });

  it('collects visible tree entries in visual order respecting expanded and hidden flags', () => {
    const roots = [
      {
        id: '/repo',
        name: '/repo',
        isDir: true,
        children: [
          {
            id: '/repo/src',
            name: 'src',
            isDir: true,
            children: [{ id: '/repo/src/a.ts', name: 'a.ts', isDir: false }],
          },
          { id: '/repo/.env', name: '.env', isDir: false, hidden: true },
          {
            id: '/repo/collapsed',
            name: 'collapsed',
            isDir: true,
            children: [{ id: '/repo/collapsed/hidden.ts', name: 'hidden.ts', isDir: false }],
          },
        ],
      },
    ];
    const entries = collectVisibleTreeEntries(roots, new Set(['/repo', '/repo/src']), false);
    expect(entries.map((e) => e.node.id)).toEqual(['/repo', '/repo/src', '/repo/src/a.ts', '/repo/collapsed']);
    const withHidden = collectVisibleTreeEntries(roots, new Set(['/repo', '/repo/src']), true);
    expect(withHidden.map((e) => e.node.id)).toContain('/repo/.env');
  });
});
