/**
 * Crisp VS Code Explorer-style SVG icons for files and folders.
 * Pure inline SVGs with zero runtime dependencies.
 */

export type FileIconShape =
  | 'folder-closed'
  | 'folder-open'
  | 'badge'
  | 'braces'
  | 'markdown'
  | 'code-html'
  | 'terminal'
  | 'config'
  | 'db'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'lock'
  | 'doc-lines'
  | 'file';

export interface FileIconSpec {
  kind: string;
  color: string;
  shape: FileIconShape;
  badge?: string;
}

const SPECIAL_FILENAME_SPECS: Record<string, FileIconSpec> = {
  'package.json': { kind: 'npm', color: '#ef4444', shape: 'braces' },
  'package-lock.json': { kind: 'lock', color: '#f59e0b', shape: 'lock' },
  'pnpm-lock.yaml': { kind: 'lock', color: '#f59e0b', shape: 'lock' },
  'yarn.lock': { kind: 'lock', color: '#38bdf8', shape: 'lock' },
  'bun.lockb': { kind: 'lock', color: '#f59e0b', shape: 'lock' },
  'cargo.lock': { kind: 'lock', color: '#fb923c', shape: 'lock' },
  'tsconfig.json': { kind: 'tsconfig', color: '#3b82f6', shape: 'braces' },
  dockerfile: { kind: 'docker', color: '#0ea5e9', shape: 'badge', badge: 'DK' },
  '.gitignore': { kind: 'git', color: '#f97316', shape: 'config' },
  '.gitattributes': { kind: 'git', color: '#f97316', shape: 'config' },
  '.gitmodules': { kind: 'git', color: '#f97316', shape: 'config' },
  '.env': { kind: 'env', color: '#eab308', shape: 'config' },
  'makefile': { kind: 'shell', color: '#4ade80', shape: 'terminal' },
  'readme.md': { kind: 'markdown', color: '#38bdf8', shape: 'markdown' },
  'license': { kind: 'text', color: '#94a3b8', shape: 'doc-lines' },
};

const EXTENSION_SPECS: Record<string, FileIconSpec> = {
  '.ts': { kind: 'ts', color: '#3178c6', shape: 'badge', badge: 'TS' },
  '.mts': { kind: 'ts', color: '#3178c6', shape: 'badge', badge: 'TS' },
  '.cts': { kind: 'ts', color: '#3178c6', shape: 'badge', badge: 'TS' },
  '.tsx': { kind: 'tsx', color: '#38bdf8', shape: 'badge', badge: 'TX' },
  '.js': { kind: 'js', color: '#facc15', shape: 'badge', badge: 'JS' },
  '.mjs': { kind: 'js', color: '#facc15', shape: 'badge', badge: 'JS' },
  '.cjs': { kind: 'js', color: '#facc15', shape: 'badge', badge: 'JS' },
  '.jsx': { kind: 'jsx', color: '#22d3ee', shape: 'badge', badge: 'JX' },
  '.json': { kind: 'json', color: '#fbbf24', shape: 'braces' },
  '.jsonc': { kind: 'json', color: '#fbbf24', shape: 'braces' },
  '.json5': { kind: 'json', color: '#fbbf24', shape: 'braces' },
  '.md': { kind: 'markdown', color: '#38bdf8', shape: 'markdown' },
  '.mdx': { kind: 'markdown', color: '#38bdf8', shape: 'markdown' },
  '.css': { kind: 'css', color: '#60a5fa', shape: 'badge', badge: '#' },
  '.scss': { kind: 'scss', color: '#f472b6', shape: 'badge', badge: 'SC' },
  '.sass': { kind: 'scss', color: '#f472b6', shape: 'badge', badge: 'SA' },
  '.less': { kind: 'css', color: '#818cf8', shape: 'badge', badge: 'LS' },
  '.html': { kind: 'html', color: '#fb923c', shape: 'code-html' },
  '.htm': { kind: 'html', color: '#fb923c', shape: 'code-html' },
  '.xml': { kind: 'html', color: '#f97316', shape: 'code-html' },
  '.py': { kind: 'python', color: '#3b82f6', shape: 'badge', badge: 'PY' },
  '.pyw': { kind: 'python', color: '#3b82f6', shape: 'badge', badge: 'PY' },
  '.rs': { kind: 'rust', color: '#fb923c', shape: 'badge', badge: 'RS' },
  '.go': { kind: 'go', color: '#22d3ee', shape: 'badge', badge: 'GO' },
  '.sh': { kind: 'shell', color: '#4ade80', shape: 'terminal' },
  '.zsh': { kind: 'shell', color: '#4ade80', shape: 'terminal' },
  '.bash': { kind: 'shell', color: '#4ade80', shape: 'terminal' },
  '.fish': { kind: 'shell', color: '#4ade80', shape: 'terminal' },
  '.ps1': { kind: 'shell', color: '#60a5fa', shape: 'terminal' },
  '.yml': { kind: 'yaml', color: '#c084fc', shape: 'config' },
  '.yaml': { kind: 'yaml', color: '#c084fc', shape: 'config' },
  '.toml': { kind: 'toml', color: '#a78bfa', shape: 'config' },
  '.ini': { kind: 'config', color: '#94a3b8', shape: 'config' },
  '.conf': { kind: 'config', color: '#94a3b8', shape: 'config' },
  '.sql': { kind: 'sql', color: '#2dd4bf', shape: 'db' },
  '.sqlite': { kind: 'sql', color: '#2dd4bf', shape: 'db' },
  '.db': { kind: 'sql', color: '#2dd4bf', shape: 'db' },
  '.svg': { kind: 'image', color: '#f59e0b', shape: 'image' },
  '.png': { kind: 'image', color: '#a78bfa', shape: 'image' },
  '.jpg': { kind: 'image', color: '#a78bfa', shape: 'image' },
  '.jpeg': { kind: 'image', color: '#a78bfa', shape: 'image' },
  '.webp': { kind: 'image', color: '#a78bfa', shape: 'image' },
  '.gif': { kind: 'image', color: '#a78bfa', shape: 'image' },
  '.ico': { kind: 'image', color: '#a78bfa', shape: 'image' },
  '.bmp': { kind: 'image', color: '#a78bfa', shape: 'image' },
  '.mp4': { kind: 'video', color: '#f43f5e', shape: 'video' },
  '.mov': { kind: 'video', color: '#f43f5e', shape: 'video' },
  '.webm': { kind: 'video', color: '#f43f5e', shape: 'video' },
  '.mkv': { kind: 'video', color: '#f43f5e', shape: 'video' },
  '.avi': { kind: 'video', color: '#f43f5e', shape: 'video' },
  '.mp3': { kind: 'audio', color: '#ec4899', shape: 'audio' },
  '.wav': { kind: 'audio', color: '#ec4899', shape: 'audio' },
  '.m4a': { kind: 'audio', color: '#ec4899', shape: 'audio' },
  '.flac': { kind: 'audio', color: '#ec4899', shape: 'audio' },
  '.ogg': { kind: 'audio', color: '#ec4899', shape: 'audio' },
  '.pdf': { kind: 'pdf', color: '#ef4444', shape: 'badge', badge: 'PD' },
  '.doc': { kind: 'word', color: '#3b82f6', shape: 'badge', badge: 'W' },
  '.docx': { kind: 'word', color: '#3b82f6', shape: 'badge', badge: 'W' },
  '.odt': { kind: 'word', color: '#3b82f6', shape: 'badge', badge: 'W' },
  '.rtf': { kind: 'word', color: '#3b82f6', shape: 'badge', badge: 'W' },
  '.xls': { kind: 'excel', color: '#22c55e', shape: 'badge', badge: 'X' },
  '.xlsx': { kind: 'excel', color: '#22c55e', shape: 'badge', badge: 'X' },
  '.ods': { kind: 'excel', color: '#22c55e', shape: 'badge', badge: 'X' },
  '.csv': { kind: 'csv', color: '#22c55e', shape: 'badge', badge: 'CS' },
  '.ppt': { kind: 'ppt', color: '#f97316', shape: 'badge', badge: 'P' },
  '.pptx': { kind: 'ppt', color: '#f97316', shape: 'badge', badge: 'P' },
  '.odp': { kind: 'ppt', color: '#f97316', shape: 'badge', badge: 'P' },
  '.zip': { kind: 'archive', color: '#eab308', shape: 'archive' },
  '.tar': { kind: 'archive', color: '#eab308', shape: 'archive' },
  '.gz': { kind: 'archive', color: '#eab308', shape: 'archive' },
  '.tgz': { kind: 'archive', color: '#eab308', shape: 'archive' },
  '.7z': { kind: 'archive', color: '#eab308', shape: 'archive' },
  '.rar': { kind: 'archive', color: '#eab308', shape: 'archive' },
  '.lock': { kind: 'lock', color: '#94a3b8', shape: 'lock' },
  '.log': { kind: 'log', color: '#94a3b8', shape: 'doc-lines' },
  '.txt': { kind: 'text', color: '#cbd5e1', shape: 'doc-lines' },
};

/** Resolve visual SVG icon metadata from a file or folder name. */
export function resolveFileIconSpec(name: string, isDir: boolean, isOpen = false): FileIconSpec {
  if (isDir) {
    return isOpen
      ? { kind: 'folder-open', color: '#fbbf24', shape: 'folder-open' }
      : { kind: 'folder-closed', color: '#eab308', shape: 'folder-closed' };
  }
  const base = name.split(/[/\\]/).pop()?.toLowerCase() ?? name.toLowerCase();
  if (SPECIAL_FILENAME_SPECS[base]) return SPECIAL_FILENAME_SPECS[base];
  if (base.startsWith('.env')) return { kind: 'env', color: '#eab308', shape: 'config' };
  if (base.startsWith('tsconfig.') && base.endsWith('.json')) {
    return { kind: 'tsconfig', color: '#3b82f6', shape: 'braces' };
  }
  if (base.startsWith('dockerfile')) return SPECIAL_FILENAME_SPECS.dockerfile;
  if (base.startsWith('docker-compose') && (base.endsWith('.yml') || base.endsWith('.yaml'))) {
    return { kind: 'docker', color: '#0ea5e9', shape: 'badge', badge: 'DK' };
  }
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = base.slice(dotIdx);
    if (EXTENSION_SPECS[ext]) return EXTENSION_SPECS[ext];
  }
  return { kind: 'file', color: '#94a3b8', shape: 'file' };
}

/** Render a crisp 16x16 inline SVG icon matching the file extension or folder state. */
export function FileTypeIcon({ name, isDir, isOpen = false }: { name: string; isDir: boolean; isOpen?: boolean }) {
  const spec = resolveFileIconSpec(name, isDir, isOpen);

  if (spec.shape === 'folder-closed') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M1.75 3.25C1.75 2.7 2.2 2.25 2.75 2.25H6.15L7.45 3.65H13.25C13.8 3.65 14.25 4.1 14.25 4.65V12.25C14.25 12.8 13.8 13.25 13.25 13.25H2.75C2.2 13.25 1.75 12.8 1.75 12.25V3.25Z"
          fill={spec.color}
          fill-opacity="0.24"
          stroke={spec.color}
          stroke-width="1.2"
          stroke-linejoin="round"
        />
      </svg>
    );
  }

  if (spec.shape === 'folder-open') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M1.75 3.5C1.75 2.95 2.2 2.5 2.75 2.5H6.05L7.25 3.8H12.75C13.3 3.8 13.75 4.25 13.75 4.8V6H3.35C2.75 6 2.24 6.42 2.12 7L1.75 8.8V3.5Z"
          fill={spec.color}
          fill-opacity="0.2"
          stroke={spec.color}
          stroke-width="1.15"
          stroke-linejoin="round"
        />
        <path
          d="M2.2 6.8C2.32 6.33 2.74 6 3.22 6H14.1C14.66 6 15.07 6.53 14.93 7.08L13.76 12.18C13.65 12.66 13.22 13 12.73 13H2.6C2.05 13 1.64 12.48 1.78 11.94L2.2 6.8Z"
          fill={spec.color}
          fill-opacity="0.32"
          stroke={spec.color}
          stroke-width="1.15"
          stroke-linejoin="round"
        />
      </svg>
    );
  }

  if (spec.shape === 'badge') {
    const label = spec.badge ?? '';
    const fontSize = label.length === 1 ? '7.5' : '6.1';
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="2" width="13" height="12" rx="2.4" fill={spec.color} fill-opacity="0.18" stroke={spec.color} stroke-width="1.1" />
        <text
          x="8"
          y="10.4"
          text-anchor="middle"
          fill={spec.color}
          font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
          font-size={fontSize}
          font-weight="700"
        >{label}</text>
      </svg>
    );
  }

  if (spec.shape === 'braces') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5.5 3C4.4 3 4 3.6 4 4.5V6.2C4 7 3.4 7.5 2.7 7.8V8.2C3.4 8.5 4 9 4 9.8V11.5C4 12.4 4.4 13 5.5 13" stroke={spec.color} stroke-width="1.4" stroke-linecap="round" />
        <path d="M10.5 3C11.6 3 12 3.6 12 4.5V6.2C12 7 12.6 7.5 13.3 7.8V8.2C12.6 8.5 12 9 12 9.8V11.5C12 12.4 11.6 13 10.5 13" stroke={spec.color} stroke-width="1.4" stroke-linecap="round" />
      </svg>
    );
  }

  if (spec.shape === 'markdown') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill={spec.color} fill-opacity="0.16" stroke={spec.color} stroke-width="1.15" />
        <path d="M4 10.5V5.5L6.2 8.2L8.4 5.5V10.5M11.6 5.5V10M11.6 10L10.1 8.5M11.6 10L13.1 8.5" stroke={spec.color} stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    );
  }

  if (spec.shape === 'code-html') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5.5 4.5L2.2 8L5.5 11.5M10.5 4.5L13.8 8L10.5 11.5M9 3.5L7 12.5" stroke={spec.color} stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    );
  }

  if (spec.shape === 'terminal') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" fill={spec.color} fill-opacity="0.14" stroke={spec.color} stroke-width="1.15" />
        <path d="M4.5 6L7 8L4.5 10M8.2 10.2H11.5" stroke={spec.color} stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    );
  }

  if (spec.shape === 'config') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 5H13.5M2.5 11H13.5" stroke={spec.color} stroke-width="1.3" stroke-linecap="round" />
        <circle cx="5.5" cy="5" r="1.6" fill="#0f172a" stroke={spec.color} stroke-width="1.25" />
        <circle cx="10.5" cy="11" r="1.6" fill="#0f172a" stroke={spec.color} stroke-width="1.25" />
      </svg>
    );
  }

  if (spec.shape === 'db') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <ellipse cx="8" cy="4.2" rx="4.7" ry="1.8" fill={spec.color} fill-opacity="0.22" stroke={spec.color} stroke-width="1.15" />
        <path d="M3.3 4.2V11.8C3.3 12.8 5.4 13.6 8 13.6C10.6 13.6 12.7 12.8 12.7 11.8V4.2M3.3 8C3.3 9 5.4 9.8 8 9.8C10.6 9.8 12.7 9 12.7 8" stroke={spec.color} stroke-width="1.15" />
      </svg>
    );
  }

  if (spec.shape === 'image') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="2.5" width="12" height="11" rx="2" fill={spec.color} fill-opacity="0.16" stroke={spec.color} stroke-width="1.15" />
        <circle cx="5.5" cy="6" r="1.1" fill={spec.color} />
        <path d="M3 11.8L6.2 8.7L8.6 11L10.7 9.2L13 11.8" stroke={spec.color} stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    );
  }

  if (spec.shape === 'video') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="2" fill={spec.color} fill-opacity="0.16" stroke={spec.color} stroke-width="1.15" />
        <path d="M6.6 5.8L10.6 8L6.6 10.2V5.8Z" fill={spec.color} />
      </svg>
    );
  }

  if (spec.shape === 'audio') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6.2 11.3V4.2L12.2 3V10.1" stroke={spec.color} stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="4.8" cy="11.5" r="1.6" fill={spec.color} />
        <circle cx="10.8" cy="10.3" r="1.6" fill={spec.color} />
      </svg>
    );
  }

  if (spec.shape === 'archive') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill={spec.color} fill-opacity="0.16" stroke={spec.color} stroke-width="1.15" />
        <path d="M8 2.8V13.2M6.8 5H9.2M6.8 7.5H9.2M6.8 10H9.2" stroke={spec.color} stroke-width="1.2" stroke-linecap="round" />
      </svg>
    );
  }

  if (spec.shape === 'lock') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="3.2" y="7" width="9.6" height="6.5" rx="1.6" fill={spec.color} fill-opacity="0.18" stroke={spec.color} stroke-width="1.15" />
        <path d="M5.4 7V5.1C5.4 3.66 6.56 2.5 8 2.5C9.44 2.5 10.6 3.66 10.6 5.1V7" stroke={spec.color} stroke-width="1.25" stroke-linecap="round" />
      </svg>
    );
  }

  if (spec.shape === 'doc-lines') {
    return (
      <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3.5 2.25H9.8L12.5 4.95V13.75H3.5V2.25Z" fill={spec.color} fill-opacity="0.12" stroke={spec.color} stroke-width="1.15" stroke-linejoin="round" />
        <path d="M5.4 7.3H10.6M5.4 9.5H10.6M5.4 11.7H8.8" stroke={spec.color} stroke-width="1.1" stroke-linecap="round" />
      </svg>
    );
  }

  return (
    <svg class="fb-file-type-svg" data-file-icon={spec.kind} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2.25H9.6L12.5 5.15V13.75H3.5V2.25Z" fill={spec.color} fill-opacity="0.1" stroke={spec.color} stroke-width="1.15" stroke-linejoin="round" />
      <path d="M9.4 2.3V5.3H12.4" stroke={spec.color} stroke-width="1.15" stroke-linejoin="round" />
    </svg>
  );
}
