/**
 * What kind of thing a file list row is ("PDF Document", "Folder"), decided
 * from the name alone: no MIME probing, so a controlled node pays nothing for
 * it and the browser and node agree on the answer.
 *
 * `id` is stable and locale-independent. The browser turns it into text with
 * the i18n key `file_browser.kind.<id>`; an extension the table does not know
 * is shown as "<EXT> file" (key `file_browser.kind.ext`) and a name without
 * an extension as a plain "file".
 */

export const FILE_KIND_IDS = {
  FOLDER: 'folder',
  FILE: 'file',
  /** An extension the table does not know; the label is built from `ext`. */
  EXT: 'ext',
} as const;

/** Extension (lower-case, without the dot) → kind id. Compound extensions are looked up first. */
const KIND_BY_EXTENSION: Readonly<Record<string, string>> = {
  'tar.gz': 'archive', 'tar.bz2': 'archive', 'tar.xz': 'archive', 'tar.zst': 'archive',
  pdf: 'pdf',
  doc: 'word', docx: 'word', odt: 'word', rtf: 'word', pages: 'word',
  xls: 'excel', xlsx: 'excel', ods: 'excel', numbers: 'excel',
  ppt: 'powerpoint', pptx: 'powerpoint', odp: 'powerpoint', key: 'powerpoint',
  txt: 'text', text: 'text', log: 'log',
  md: 'markdown', markdown: 'markdown',
  csv: 'csv', tsv: 'csv',
  json: 'json', jsonl: 'json',
  xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'config', ini: 'config', conf: 'config', cfg: 'config', env: 'config',
  html: 'html', htm: 'html',
  png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', svg: 'svg',
  webp: 'image', bmp: 'image', ico: 'image', heic: 'image', heif: 'image', tif: 'image', tiff: 'image', raw: 'image', psd: 'image', ai: 'image',
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', opus: 'audio', wma: 'audio', aiff: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', webm: 'video', wmv: 'video', flv: 'video', m4v: 'video',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', zst: 'archive',
  dmg: 'disk_image', iso: 'disk_image', img: 'disk_image', vhd: 'disk_image', vhdx: 'disk_image',
  exe: 'installer', msi: 'installer', pkg: 'installer', deb: 'installer', rpm: 'installer', apk: 'installer', appimage: 'installer', msix: 'installer',
  app: 'application',
  sh: 'script', bash: 'script', zsh: 'script', bat: 'script', cmd: 'script', ps1: 'script',
  js: 'source', mjs: 'source', cjs: 'source', ts: 'source', tsx: 'source', jsx: 'source', py: 'source', rb: 'source', go: 'source', rs: 'source',
  java: 'source', kt: 'source', swift: 'source', c: 'source', h: 'source', cpp: 'source', hpp: 'source', cs: 'source', php: 'source', lua: 'source',
  sql: 'source', css: 'source', scss: 'source', vue: 'source',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  sqlite: 'database', db: 'database', sqlite3: 'database',
  torrent: 'torrent',
  lnk: 'shortcut',
  crdownload: 'partial_download', part: 'partial_download', download: 'partial_download',
};

/** Every kind id the table can produce, plus the three fixed ones: the i18n keys a locale must carry. */
export const FILE_KIND_LABEL_IDS: readonly string[] = [
  ...new Set([FILE_KIND_IDS.FOLDER, FILE_KIND_IDS.FILE, FILE_KIND_IDS.EXT, ...Object.values(KIND_BY_EXTENSION)]),
];

export interface FileKind {
  id: string;
  /** Upper-case extension, only for `FILE_KIND_IDS.EXT`. */
  ext?: string;
}

/** The extension of a file name, lower-case without the dot; hidden files like `.gitignore` have none. */
export function fileExtensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function fileKindOf(name: string, isDir: boolean): FileKind {
  if (isDir) return { id: FILE_KIND_IDS.FOLDER };
  const lower = name.toLowerCase();
  // `archive.tar.gz` is a tar archive, not a ".gz file".
  const secondDot = lower.lastIndexOf('.', lower.lastIndexOf('.') - 1);
  if (secondDot > 0) {
    const compound = KIND_BY_EXTENSION[lower.slice(secondDot + 1)];
    if (compound) return { id: compound };
  }
  const ext = fileExtensionOf(name);
  if (!ext) return { id: FILE_KIND_IDS.FILE };
  const known = KIND_BY_EXTENSION[ext];
  return known ? { id: known } : { id: FILE_KIND_IDS.EXT, ext: ext.toUpperCase() };
}

/**
 * What a Kind sort orders by: the kind's identity, so files of one kind sit
 * together. It does not depend on the UI language, which a controlled node
 * cannot know; the browser and the node therefore order a listing the same way.
 */
export function fileKindSortKey(name: string, isDir: boolean): string {
  const kind = fileKindOf(name, isDir);
  return kind.id === FILE_KIND_IDS.EXT ? `${FILE_KIND_IDS.EXT}:${kind.ext}` : kind.id;
}
