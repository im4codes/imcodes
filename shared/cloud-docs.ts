import { sanitizeUploadFilename } from './upload-filename.js';

export const CLOUD_DOCS_API_PATH = '/api/cloud-docs';
export const RECENT_DOCUMENTS_API_PATH = '/api/recent-documents';
export const CLOUD_DOCS_MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB
export const CLOUD_DOCS_FOLDER_NAME_MAX_LENGTH = 120;
export const CLOUD_DOCS_RECENT_DEFAULT_LIMIT = 50;
export const CLOUD_DOCS_RECENT_MAX_LIMIT = 100;
export const CLOUD_DOCS_DEFAULT_DIR = '/var/lib/imcodes/cloud-docs';

export const CLOUD_DOC_CONTENT_MAX_CHARS = 512 * 1024; // 512 KiB readable text limit
export const CLOUD_DOC_ZIP_MAX_ENTRIES = 256;
export const CLOUD_DOC_ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES = 10 * 1024 * 1024; // 10 MiB
export const CLOUD_DOC_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024; // 32 MiB
export const CLOUD_DOC_OOXML_MAX_COL_INDEX = 16_383; // Excel XFD (3 letters max)
export const CLOUD_DOC_OOXML_MAX_ROW_COLS = 1024;
export const CLOUD_DOC_OOXML_MAX_CELLS = 50_000;
export const CLOUD_DOC_OOXML_MAX_PARAGRAPHS = 50_000;

export const CLOUD_DOC_BLANK_TYPES = ['docx', 'xlsx', 'pptx'] as const;
export type CloudDocBlankType = (typeof CLOUD_DOC_BLANK_TYPES)[number];

export const CLOUD_DOC_CREATE_TYPES = ['docx', 'xlsx', 'pptx', 'md', 'txt'] as const;
export type CloudDocCreateType = (typeof CLOUD_DOC_CREATE_TYPES)[number];

export const CLOUD_DOC_EDIT_MODES = ['replace', 'append'] as const;
export type CloudDocEditMode = (typeof CLOUD_DOC_EDIT_MODES)[number];

export const CLOUD_DOC_READABLE_TEXT_EXTS = ['.md', '.txt', '.csv', '.json', '.log'] as const;
export const CLOUD_DOC_EDITABLE_EXTS = ['.docx', '.xlsx', '.pptx', '.md', '.txt', '.csv', '.json', '.log'] as const;

export function isCreateCloudDocType(value: unknown): value is CloudDocCreateType {
  return typeof value === 'string' && (CLOUD_DOC_CREATE_TYPES as readonly string[]).includes(value);
}

export const RECENT_DOCUMENT_SOURCE_KINDS = ['server_file', 'cloud_doc'] as const;
export type RecentDocumentSourceKind = (typeof RECENT_DOCUMENT_SOURCE_KINDS)[number];

export const CLOUD_DOC_ERROR_CODES = {
  INVALID_NAME: 'invalid_name',
  UNSUPPORTED_FORMAT: 'unsupported_document_type',
  FILE_TOO_LARGE: 'file_too_large',
  NOT_FOUND: 'not_found',
  FOLDER_NOT_FOUND: 'folder_not_found',
  INVALID_MOVE: 'invalid_move',
  STORAGE_ERROR: 'cloud_doc_storage_error',
  ACCESS_DENIED: 'access_denied',
  SERVER_NOT_FOUND: 'server_not_found',
  SERVER_OFFLINE: 'server_offline',
  MISSING_FILE: 'cloud_doc_file_missing',
  DOWNLOAD_FORBIDDEN: 'download_forbidden',
  CONTENT_TOO_LARGE: 'content_too_large',
  UNSUPPORTED_CONTENT_EDIT: 'unsupported_content_edit',
  INVALID_ARCHIVE: 'invalid_archive',
} as const;

export type CloudDocShareRole = 'viewer' | 'editor';
export type CloudDocShareTargetKind = 'doc' | 'folder';
export type CloudDocShareMode = 'team' | 'user';

export interface CloudDocMimeMeta {
  ext: string;
  mimeType: string;
  documentType: 'word' | 'cell' | 'slide' | 'pdf';
}

export const CLOUD_DOC_EXTENSION_META: Record<string, Omit<CloudDocMimeMeta, 'ext'>> = {
  '.docx': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    documentType: 'word',
  },
  '.doc': {
    mimeType: 'application/msword',
    documentType: 'word',
  },
  '.odt': {
    mimeType: 'application/vnd.oasis.opendocument.text',
    documentType: 'word',
  },
  '.rtf': {
    mimeType: 'application/rtf',
    documentType: 'word',
  },
  '.txt': {
    mimeType: 'text/plain; charset=utf-8',
    documentType: 'word',
  },
  '.md': {
    mimeType: 'text/markdown; charset=utf-8',
    documentType: 'word',
  },
  '.xlsx': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    documentType: 'cell',
  },
  '.xls': {
    mimeType: 'application/vnd.ms-excel',
    documentType: 'cell',
  },
  '.ods': {
    mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
    documentType: 'cell',
  },
  '.csv': {
    mimeType: 'text/csv; charset=utf-8',
    documentType: 'cell',
  },
  '.pptx': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    documentType: 'slide',
  },
  '.ppt': {
    mimeType: 'application/vnd.ms-powerpoint',
    documentType: 'slide',
  },
  '.odp': {
    mimeType: 'application/vnd.oasis.opendocument.presentation',
    documentType: 'slide',
  },
  '.pdf': {
    mimeType: 'application/pdf',
    documentType: 'pdf',
  },
};

export const CLOUD_DOC_SUPPORTED_EXTENSIONS = Object.keys(CLOUD_DOC_EXTENSION_META) as ReadonlyArray<string>;

export interface CloudDocFolder {
  id: string;
  userId: string;
  parentId: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface CloudDocItem {
  id: string;
  userId: string;
  folderId: string | null;
  name: string;
  ext: string;
  mimeType: string;
  sizeBytes: number;
  docVersion: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
}

export interface CloudDocShareRecord {
  id: string;
  targetKind: CloudDocShareTargetKind;
  targetId: string;
  shareMode: CloudDocShareMode;
  targetTeamId: string | null;
  targetTeamName: string | null;
  targetUserId: string | null;
  targetUserName: string | null;
  targetUserUsername: string | null;
  role: CloudDocShareRole;
  allowDownload: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CloudDocTeamOption {
  id: string;
  name: string;
  role: string;
}

export interface SharedCloudDocItem extends CloudDocItem {
  role: CloudDocShareRole;
  allowDownload: boolean;
  ownerName: string;
  ownerUsername: string | null;
  sharedVia: 'doc' | 'folder';
  sharedTeamName: string | null;
  folderName: string | null;
}

export interface SharedCloudFolderItem extends CloudDocFolder {
  role: CloudDocShareRole;
  allowDownload: boolean;
  ownerName: string;
  ownerUsername: string | null;
  sharedTeamName: string | null;
}

export type RecentDocumentAccessReason =
  | 'server_not_found'
  | 'access_denied'
  | 'server_offline'
  | 'cloud_doc_missing'
  | null;

export interface RecentDocumentItem {
  id: string;
  userId: string;
  sourceKind: RecentDocumentSourceKind;
  sourceKey: string;
  serverId: string | null;
  serverName: string | null;
  sessionName: string | null;
  filePath: string | null;
  cloudDocId: string | null;
  title: string;
  mimeType: string;
  openMode: 'view' | 'edit';
  openCount: number;
  lastOpenedAt: number;
  createdAt: number;
  accessible: boolean;
  serverOnline: boolean;
  accessReason: RecentDocumentAccessReason;
  role?: CloudDocShareRole;
  allowDownload?: boolean;
}

export interface RecordRecentDocumentInput {
  sourceKind: RecentDocumentSourceKind;
  serverId?: string;
  sessionName?: string | null;
  filePath?: string;
  cloudDocId?: string;
  title?: string;
  mimeType?: string;
  openMode?: 'view' | 'edit';
}

export type CloudDocContentPayload = {
  doc: CloudDocItem;
  role: CloudDocShareRole | 'owner';
  allowDownload: boolean;
  ext: string;
  format: 'docx' | 'xlsx' | 'pptx' | 'text';
  editable: boolean;
  content: string;
  truncated: boolean;
  totalChars: number;
  byteLength: number;
  maxChars: number;
  sheets?: Array<{ name: string; rows: string[][] }>;
  slides?: Array<{ index: number; title?: string; texts: string[] }>;
};

export function isBlankCloudDocType(value: unknown): value is CloudDocBlankType {
  return value === 'docx' || value === 'xlsx' || value === 'pptx';
}

export function getCloudDocExt(filename: string): string {
  const trimmed = filename.trim();
  const slashIdx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return base.slice(dotIdx).toLowerCase();
}

export function getCloudDocMeta(filenameOrExt: string): CloudDocMimeMeta | null {
  const normalized = filenameOrExt.startsWith('.')
    ? filenameOrExt.trim().toLowerCase()
    : getCloudDocExt(filenameOrExt);
  const entry = CLOUD_DOC_EXTENSION_META[normalized];
  if (!entry) return null;
  return { ext: normalized, ...entry };
}

export function isSupportedCloudDocFilename(filename: string): boolean {
  return getCloudDocMeta(filename) !== null;
}

export function getCloudDocMimeType(filenameOrExt: string): string {
  return getCloudDocMeta(filenameOrExt)?.mimeType ?? 'application/octet-stream';
}

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const DISALLOWED_FOLDER_CHARS_RE = /[<>:"/\\|?*]/;

export function normalizeCloudDocFolderName(raw: string | undefined | null): string | null {
  const trimmed = String(raw ?? '').normalize('NFC').trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.length > CLOUD_DOCS_FOLDER_NAME_MAX_LENGTH) return null;
  if (CONTROL_CHARS_RE.test(trimmed) || DISALLOWED_FOLDER_CHARS_RE.test(trimmed)) return null;
  return trimmed;
}

export function normalizeCloudDocName(
  raw: string | undefined | null,
  requiredExt?: string,
): string | null {
  const rawStr = String(raw ?? '').normalize('NFC').trim();
  if (!rawStr) return null;
  if (rawStr.includes('/') || rawStr.includes('\\') || rawStr === '.' || rawStr === '..') {
    return null;
  }
  const normalizedExt = requiredExt
    ? (requiredExt.startsWith('.') ? requiredExt.toLowerCase() : `.${requiredExt.toLowerCase()}`)
    : '';
  let candidate = sanitizeUploadFilename(rawStr);
  if (normalizedExt) {
    const existingExt = getCloudDocExt(candidate);
    if (existingExt !== normalizedExt) {
      const base = existingExt ? candidate.slice(0, -existingExt.length) : candidate;
      candidate = sanitizeUploadFilename(`${base || 'Untitled'}${normalizedExt}`);
    }
  }
  if (!candidate || candidate === '.' || candidate === '..') return null;
  if (!getCloudDocMeta(candidate)) return null;
  return candidate;
}

export function normalizeRecentFilePath(rawPath: string | undefined | null): string | null {
  if (!rawPath) return null;
  let normalized = rawPath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('\0')) return null;
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..')) return null;
  return normalized;
}

export function buildRecentDocumentSourceKey(params: {
  sourceKind: RecentDocumentSourceKind;
  serverId?: string | null;
  filePath?: string | null;
  cloudDocId?: string | null;
}): string | null {
  if (params.sourceKind === 'cloud_doc') {
    const id = params.cloudDocId?.trim();
    return id ? `cloud:${id}` : null;
  }
  const serverId = params.serverId?.trim();
  const normPath = normalizeRecentFilePath(params.filePath);
  if (!serverId || !normPath) return null;
  return `server:${serverId}:${normPath}`;
}
