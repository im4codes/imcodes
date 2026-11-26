import {
  formatCloudDocCitation,
  type CloudDocFolder,
  type CloudDocItem,
  type SharedCloudDocItem,
  type SharedCloudFolderItem,
} from '@shared/cloud-docs.js';

export interface CloudDocReferenceItem {
  id: string;
  name: string;
  updatedAt: number;
  folderName?: string;
  shared?: boolean;
  ownerLabel?: string;
  mimeType?: string;
}

const INLINE_CLOUD_DOC_PREFIX = String.raw`(?:^|[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF])`;
const INLINE_CLOUD_DOC_TRIGGER_RE = new RegExp(`${INLINE_CLOUD_DOC_PREFIX}&([^\\s&]*)$`, 'u');
const INLINE_CLOUD_DOC_REPLACE_RE = new RegExp(`(${INLINE_CLOUD_DOC_PREFIX})&[^\\s&]*$`, 'u');

/**
 * Match a trailing inline `&query` trigger at start of text, after whitespace,
 * or after CJK / fullwidth punctuation. Rejects `&&`, ASCII-adjacent `&`
 * (`R&D`, `?a=1&b=2`), and queries followed by whitespace.
 */
export function matchInlineCloudDocTrigger(text: string): string | null {
  const match = INLINE_CLOUD_DOC_TRIGGER_RE.exec(text);
  return match ? (match[1] ?? '') : null;
}

export interface NormalizeCloudDocReferencesInput {
  folders?: readonly CloudDocFolder[];
  docs?: readonly CloudDocItem[];
  sharedFolders?: readonly SharedCloudFolderItem[];
  sharedDocs?: readonly SharedCloudDocItem[];
}

function sortCloudDocReferences(items: CloudDocReferenceItem[]): CloudDocReferenceItem[] {
  return items.sort(
    (a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/**
 * Merge personal and shared Cloud Docs, deduplicate by id (preferring personal
 * docs when both appear), attach folder names when known, and sort newest first.
 */
export function normalizeCloudDocReferences(
  response: NormalizeCloudDocReferencesInput | null | undefined,
): CloudDocReferenceItem[] {
  if (!response) return [];
  const folderNames = new Map<string, string>();
  for (const folder of response.folders ?? []) {
    if (folder?.id && folder.name) folderNames.set(folder.id, folder.name);
  }
  for (const folder of response.sharedFolders ?? []) {
    if (folder?.id && folder.name && !folderNames.has(folder.id)) {
      folderNames.set(folder.id, folder.name);
    }
  }

  const byId = new Map<string, CloudDocReferenceItem>();
  for (const doc of response.docs ?? []) {
    if (!doc?.id || !doc.name || byId.has(doc.id)) continue;
    const folderName = doc.folderId ? folderNames.get(doc.folderId) : undefined;
    byId.set(doc.id, {
      id: doc.id,
      name: doc.name,
      updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : 0,
      ...(folderName ? { folderName } : {}),
      ...(doc.mimeType ? { mimeType: doc.mimeType } : {}),
    });
  }

  for (const doc of response.sharedDocs ?? []) {
    if (!doc?.id || !doc.name || byId.has(doc.id)) continue;
    const folderName = doc.folderName?.trim()
      || (doc.folderId ? folderNames.get(doc.folderId) : undefined)
      || undefined;
    const ownerLabel = doc.ownerName?.trim()
      || doc.ownerUsername?.trim()
      || doc.sharedTeamName?.trim()
      || undefined;
    byId.set(doc.id, {
      id: doc.id,
      name: doc.name,
      updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : 0,
      ...(folderName ? { folderName } : {}),
      shared: true,
      ...(ownerLabel ? { ownerLabel } : {}),
      ...(doc.mimeType ? { mimeType: doc.mimeType } : {}),
    });
  }

  return sortCloudDocReferences(Array.from(byId.values()));
}

/** Merge cached unfiltered references with fresh search hits by id. */
export function mergeCloudDocReferences(
  cached: readonly CloudDocReferenceItem[],
  incoming: readonly CloudDocReferenceItem[],
): CloudDocReferenceItem[] {
  const byId = new Map<string, CloudDocReferenceItem>();
  for (const item of cached) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return sortCloudDocReferences(Array.from(byId.values()));
}

export function filterCloudDocReferences(
  items: readonly CloudDocReferenceItem[],
  query: string,
): CloudDocReferenceItem[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...items];
  return items.filter((item) => (
    item.name.toLocaleLowerCase().includes(normalized)
    || item.id.toLocaleLowerCase().includes(normalized)
    || (item.folderName?.toLocaleLowerCase().includes(normalized) ?? false)
  ));
}

/**
 * Replace the trailing `&query` trigger with a canonical `[CloudDoc: <name> | id=<docId>] `
 * citation while preserving any character before `&` (CJK or whitespace).
 */
export function replaceInlineCloudDocTrigger(
  text: string,
  doc: { id: string; name: string },
): string {
  const citation = `${formatCloudDocCitation(doc.name, doc.id)} `;
  if (INLINE_CLOUD_DOC_REPLACE_RE.test(text)) {
    return text.replace(INLINE_CLOUD_DOC_REPLACE_RE, (_m, lead: string) => `${lead}${citation}`);
  }
  return `${text}${text && !/\s$/.test(text) ? ' ' : ''}${citation}`;
}
