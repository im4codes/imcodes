import { describe, expect, it } from 'vitest';
import { FILE_KIND_IDS, FILE_KIND_LABEL_IDS, fileExtensionOf, fileKindOf, fileKindSortKey } from '../../shared/file-kind.js';

describe('file kind from the name', () => {
  it('names a folder regardless of its name', () => {
    expect(fileKindOf('photos.png', true)).toEqual({ id: FILE_KIND_IDS.FOLDER });
    expect(fileKindOf('node_modules', true)).toEqual({ id: FILE_KIND_IDS.FOLDER });
  });
  it('maps known extensions, case-insensitively', () => {
    expect(fileKindOf('Report.PDF', false).id).toBe('pdf');
    expect(fileKindOf('a.docx', false).id).toBe('word');
    expect(fileKindOf('shot.JPG', false).id).toBe('jpeg');
    expect(fileKindOf('shot.jpeg', false).id).toBe('jpeg');
    expect(fileKindOf('movie.MKV', false).id).toBe('video');
  });
  it('treats .tar.gz as one archive kind, not a ".gz file"', () => {
    expect(fileKindOf('backup.tar.gz', false).id).toBe('archive');
    expect(fileKindOf('backup.TAR.XZ', false).id).toBe('archive');
    expect(fileKindOf('backup.gz', false).id).toBe('archive');
  });
  it('shows an unknown extension as "<EXT> file" and a bare name as a plain file', () => {
    expect(fileKindOf('data.weird', false)).toEqual({ id: FILE_KIND_IDS.EXT, ext: 'WEIRD' });
    expect(fileKindOf('Makefile', false)).toEqual({ id: FILE_KIND_IDS.FILE });
    expect(fileKindOf('.gitignore', false)).toEqual({ id: FILE_KIND_IDS.FILE });
    expect(fileKindOf('trailingdot.', false)).toEqual({ id: FILE_KIND_IDS.FILE });
    expect(fileKindOf('.DS_Store', false)).toEqual({ id: FILE_KIND_IDS.FILE });
  });
  it('survives spaces, CJK, emoji and very long names', () => {
    expect(fileKindOf('我的 文件 😀.pdf', false).id).toBe('pdf');
    expect(fileKindOf(`${'a'.repeat(10_000)}.zip`, false).id).toBe('archive');
    expect(fileKindOf('.', false)).toEqual({ id: FILE_KIND_IDS.FILE });
    expect(fileKindOf('', false)).toEqual({ id: FILE_KIND_IDS.FILE });
  });
  it('reads the last extension of a dotted name', () => {
    expect(fileExtensionOf('a.b.c')).toBe('c');
    expect(fileExtensionOf('noext')).toBe('');
  });
  it('lists every id a label is needed for, including the fixed ones', () => {
    expect(FILE_KIND_LABEL_IDS).toEqual(expect.arrayContaining(['folder', 'file', 'ext', 'pdf', 'archive']));
    expect(new Set(FILE_KIND_LABEL_IDS).size).toBe(FILE_KIND_LABEL_IDS.length);
  });
  it('sorts by kind identity, grouping unknown extensions by extension', () => {
    expect(fileKindSortKey('a.pdf', false)).toBe('pdf');
    expect(fileKindSortKey('a.weird', false)).toBe('ext:WEIRD');
    expect(fileKindSortKey('dir', true)).toBe('folder');
  });
});
