import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sessionSystemContractKey } from './session-system-contract.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';

const ACP_SYSTEM_PROMPT_MARKER = Buffer.from('\x0a\x11acp_system_prompt\x12', 'latin1');
const AGENT_IDENTITY_BLOCK_RE = /<imcodes-agent-identity>[\s\S]*?<\/imcodes-agent-identity>/;
const EMPTY_AGENT_IDENTITY_BLOCK = '<imcodes-agent-identity>\n</imcodes-agent-identity>';

function loadSqliteDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  suppressSqliteExperimentalWarning();
  return (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

function isSafeSessionFilename(acpSessionId: string): boolean {
  return Boolean(
    acpSessionId
    && acpSessionId !== '.'
    && acpSessionId !== '..'
    && !/[/\\\0]/.test(acpSessionId),
  );
}

function readSafeVarint(buf: Uint8Array, startOffset: number): { value: number; nextOffset: number } | null {
  let offset = startOffset;
  let value = 0;
  let shift = 0;
  while (offset < buf.length && shift <= 49) {
    const byte = buf[offset++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return Number.isSafeInteger(value) ? { value, nextOffset: offset } : null;
    }
    shift += 7;
  }
  return null;
}

function skipProtobufVarint(buf: Uint8Array, startOffset: number): number {
  let offset = startOffset;
  for (let count = 0; count < 10 && offset < buf.length; count++) {
    if ((buf[offset++]! & 0x80) === 0) return offset;
  }
  return -1;
}

function encodeProtobufVarint(n: number): Buffer {
  const bytes: number[] = [];
  let val = n;
  while (val >= 0x80) {
    bytes.push((val & 0x7f) | 0x80);
    val = Math.floor(val / 128);
  }
  bytes.push(val);
  return Buffer.from(bytes);
}

function encodeLenDelimited(fieldNumber: number, payload: Uint8Array): Buffer {
  return Buffer.concat([
    encodeProtobufVarint(fieldNumber * 8 + 2),
    encodeProtobufVarint(payload.length),
    payload,
  ]);
}

function normalizeFileUri(uri: string): string {
  if (uri === 'file:///') return uri;
  return uri.replace(/\/+$/, '') || 'file:///';
}

function extractWorkspaceInfoUri(subBuf: Uint8Array): { matched: true; uri: string | null } | { matched: false } {
  let offset = 0;
  let uri: string | null = null;
  while (offset < subBuf.length) {
    const tag = readSafeVarint(subBuf, offset);
    if (!tag) return { matched: false };
    offset = tag.nextOffset;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (field <= 0) return { matched: false };
    if (wireType === 0) {
      offset = skipProtobufVarint(subBuf, offset);
      if (offset < 0) return { matched: false };
    } else if (wireType === 1) {
      if (offset + 8 > subBuf.length) return { matched: false };
      offset += 8;
    } else if (wireType === 2) {
      const len = readSafeVarint(subBuf, offset);
      if (!len || len.value < 0 || len.nextOffset + len.value > subBuf.length) return { matched: false };
      offset = len.nextOffset;
      const payload = subBuf.subarray(offset, offset + len.value);
      offset += len.value;
      if (field === 1 && uri === null) {
        try {
          uri = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        } catch {
          return { matched: false };
        }
      }
    } else if (wireType === 5) {
      if (offset + 4 > subBuf.length) return { matched: false };
      offset += 4;
    } else {
      return { matched: false };
    }
  }
  return { matched: true, uri };
}

/**
 * Pure byte-slice protobuf sanitizer for AGY `trajectory_metadata_blob`.
 * Removes mismatched/duplicate top-level `field 1` (`WorkspaceInfo`) and
 * `field 7` (`workspace_uris`) entries, retains the matching project entry with
 * its git metadata untouched, or inserts minimal entries for `targetUri`, while
 * copying every other protobuf field verbatim. Returns `null` on malformed wire
 * data or an invalid/root `targetUri`.
 */
export function sanitizeAgyTrajectoryWorkspaceBlob(buf: Uint8Array, targetUri: string): Buffer | null {
  if (!buf.length || !targetUri) return null;
  const normalizedTargetUri = normalizeFileUri(targetUri);
  if (normalizedTargetUri === 'file:///') return null;

  const rawBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const parts: Buffer[] = [];
  let f1SlotIdx = -1;
  let f7SlotIdx = -1;
  let keptField1 = false;
  let keptField7 = false;
  let offset = 0;

  while (offset < rawBuf.length) {
    const sliceStart = offset;
    const tag = readSafeVarint(rawBuf, offset);
    if (!tag) return null;
    offset = tag.nextOffset;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;
    if (field <= 0) return null;

    let payload: Uint8Array | undefined;
    if (wireType === 0) {
      offset = skipProtobufVarint(rawBuf, offset);
      if (offset < 0) return null;
    } else if (wireType === 1) {
      if (offset + 8 > rawBuf.length) return null;
      offset += 8;
    } else if (wireType === 2) {
      const len = readSafeVarint(rawBuf, offset);
      if (!len || len.value < 0 || len.nextOffset + len.value > rawBuf.length) return null;
      offset = len.nextOffset;
      payload = rawBuf.subarray(offset, offset + len.value);
      offset += len.value;
    } else if (wireType === 5) {
      if (offset + 4 > rawBuf.length) return null;
      offset += 4;
    } else {
      return null;
    }

    const rawSlice = rawBuf.subarray(sliceStart, offset);
    if (field === 1) {
      if (wireType !== 2 || !payload) return null;
      if (f1SlotIdx === -1) {
        f1SlotIdx = parts.length;
        parts.push(Buffer.alloc(0));
      }
      const parsed = extractWorkspaceInfoUri(payload);
      if (!parsed.matched) return null;
      if (!keptField1 && parsed.uri !== null && normalizeFileUri(parsed.uri) === normalizedTargetUri) {
        parts[f1SlotIdx] = rawSlice;
        keptField1 = true;
      }
    } else if (field === 7) {
      if (wireType !== 2 || !payload) return null;
      if (f7SlotIdx === -1) {
        f7SlotIdx = parts.length;
        parts.push(Buffer.alloc(0));
      }
      let uriText: string;
      try {
        uriText = new TextDecoder('utf-8', { fatal: true }).decode(payload);
      } catch {
        return null;
      }
      if (!keptField7 && normalizeFileUri(uriText) === normalizedTargetUri) {
        parts[f7SlotIdx] = rawSlice;
        keptField7 = true;
      }
    } else {
      parts.push(rawSlice);
    }
  }

  const prefixParts: Buffer[] = [];
  const suffixParts: Buffer[] = [];
  const uriBytes = Buffer.from(normalizedTargetUri, 'utf8');
  if (!keptField1) {
    const minimalWorkspaceInfo = encodeLenDelimited(
      1,
      Buffer.concat([encodeLenDelimited(1, uriBytes), encodeLenDelimited(3, Buffer.alloc(0))]),
    );
    if (f1SlotIdx !== -1) parts[f1SlotIdx] = minimalWorkspaceInfo;
    else prefixParts.push(minimalWorkspaceInfo);
  }
  if (!keptField7) {
    const workspaceUriEntry = encodeLenDelimited(7, uriBytes);
    if (f7SlotIdx !== -1) parts[f7SlotIdx] = workspaceUriEntry;
    else suffixParts.push(workspaceUriEntry);
  }

  return Buffer.concat([...prefixParts, ...parts, ...suffixParts]);
}

/**
 * Reconciles AGY's persisted `trajectory_metadata_blob` workspace URIs to match `cwd`
 * before `session/resume`. Uses a two-phase SQLite check so already-aligned DBs acquire
 * zero write locks. Never throws so resume is never blocked on inspection/write errors.
 */
export function reconcilePersistedAgyWorkspace(homeDir: string, acpSessionId: string, cwd: string): boolean {
  if (
    typeof homeDir !== 'string'
    || !homeDir.trim()
    || !isSafeSessionFilename(acpSessionId)
    || typeof cwd !== 'string'
    || !path.isAbsolute(cwd)
  ) {
    return false;
  }

  let resolvedCwd: string;
  try {
    resolvedCwd = existsSync(cwd) ? realpathSync(cwd) : path.resolve(cwd);
  } catch {
    resolvedCwd = path.resolve(cwd);
  }
  const targetUri = normalizeFileUri(pathToFileURL(resolvedCwd).href);
  if (!targetUri || targetUri === 'file:///') return false;

  const dbPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations', `${acpSessionId}.db`);
  if (!existsSync(dbPath)) return false;

  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try {
    DatabaseSync = loadSqliteDatabaseSync();
  } catch {
    return false;
  }

  let needsWrite = false;
  let roDb: import('node:sqlite').DatabaseSync | undefined;
  try {
    roDb = new DatabaseSync(dbPath, { readOnly: true });
    roDb.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
    const row = roDb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data?: unknown } | undefined;
    const raw = row?.data;
    if (!(raw instanceof Uint8Array)) return false;
    const origBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const nextBuf = sanitizeAgyTrajectoryWorkspaceBlob(origBuf, targetUri);
    if (!nextBuf || nextBuf.equals(origBuf)) return false;
    needsWrite = true;
  } catch {
    return false;
  } finally {
    try {
      roDb?.close();
    } catch {
      // Ignore close error on read-only inspection handle.
    }
  }
  if (!needsWrite) return false;

  let rwDb: import('node:sqlite').DatabaseSync | undefined;
  try {
    rwDb = new DatabaseSync(dbPath);
    rwDb.exec('PRAGMA busy_timeout=250; BEGIN IMMEDIATE;');
    const row = rwDb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data?: unknown } | undefined;
    const raw = row?.data;
    if (!(raw instanceof Uint8Array)) {
      rwDb.exec('ROLLBACK;');
      return false;
    }
    const origBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const nextBuf = sanitizeAgyTrajectoryWorkspaceBlob(origBuf, targetUri);
    if (!nextBuf || nextBuf.equals(origBuf)) {
      rwDb.exec('ROLLBACK;');
      return false;
    }
    rwDb.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(nextBuf);
    rwDb.exec('COMMIT;');
    return true;
  } catch {
    try {
      rwDb?.exec('ROLLBACK;');
    } catch {
      // Ignore rollback error if transaction never started.
    }
    return false;
  } finally {
    try {
      rwDb?.close();
    } catch {
      // Ignore SQLite close error.
    }
  }
}

/**
 * Extracts the `<imcodes-agent-identity>...</imcodes-agent-identity>` block
 * from an assembled system contract when present.
 */
export function extractAgentIdentityBlock(text?: string): string | undefined {
  return text?.match(AGENT_IDENTITY_BLOCK_RE)?.[0];
}

/**
 * Removes `<imcodes-agent-identity>...</imcodes-agent-identity>` blocks and
 * normalizes surrounding blank lines so the non-identity base contract can be
 * compared reliably across persisted Slot A prompts and live contracts.
 */
export function stripAgentIdentityBlock(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(new RegExp(AGENT_IDENTITY_BLOCK_RE.source, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Reads AGY's persisted `acp_system_prompt` from `trajectory_metadata_blob`
 * (read-only, zero busy wait) so resume can avoid stacking a second Slot B prompt.
 */
export function readPersistedAgySystemPrompt(homeDir: string, acpSessionId: string): string | null {
  if (typeof homeDir !== 'string' || !homeDir.trim() || !isSafeSessionFilename(acpSessionId)) {
    return null;
  }
  const dbPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations', `${acpSessionId}.db`);
  if (!existsSync(dbPath)) return null;

  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    const DatabaseSync = loadSqliteDatabaseSync();
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
    const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get() as { data?: unknown } | undefined;
    const raw = row?.data;
    if (!(raw instanceof Uint8Array)) return null;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const markerIdx = buf.indexOf(ACP_SYSTEM_PROMPT_MARKER);
    if (markerIdx === -1) return null;

    let offset = markerIdx + ACP_SYSTEM_PROMPT_MARKER.length;
    let len = 0;
    let shift = 0;
    let decodedVarint = false;
    while (offset < buf.length && shift <= 49) {
      const byte = buf[offset++]!;
      len += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        decodedVarint = Number.isSafeInteger(len);
        break;
      }
      shift += 7;
    }
    if (!decodedVarint || len < 0 || offset + len > buf.length) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(offset, offset + len));
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore SQLite close errors during best-effort read-only inspection.
    }
  }
}

export type AgySlotBOverride =
  | { kind: 'identity'; identity: string | undefined }
  | { kind: 'full'; identity: string | undefined };

export type AgySlotBIdentityOverride = AgySlotBOverride | undefined;

export interface AgyResumeSystemPromptPlan {
  shouldSendMeta: boolean;
  metaToSend: string | undefined;
  nextInjectedKey: string | undefined;
  nextMetaDelivered: boolean;
  nextSlotBOverride: AgySlotBIdentityOverride;
}

/**
 * Decides what `_meta.antigravity.systemPrompt.append` (if any) to send on `session/resume`.
 * Tracks both SQLite Slot A (`persistedPrompt`) and the live transport's current Slot B
 * dynamic override (`activeSlotBOverride`) so regular resumes omit `_meta`, mid-session
 * identity changes send only the compact identity delta, and reverting Slot B back to Slot A
 * (or clearing an added override) issues the required resume override before updating cache.
 */
export function resolveAgyResumeSystemPromptMeta(params: {
  persistedPrompt: string | null;
  trimmedSystemText: string | undefined;
  hasDeliveredMeta: boolean;
  activeSlotBOverride?: AgySlotBIdentityOverride;
}): AgyResumeSystemPromptPlan {
  const { persistedPrompt, trimmedSystemText, hasDeliveredMeta, activeSlotBOverride } = params;
  if (!trimmedSystemText) {
    const needClear = hasDeliveredMeta || activeSlotBOverride !== undefined;
    return {
      shouldSendMeta: needClear,
      metaToSend: needClear ? '' : undefined,
      nextInjectedKey: undefined,
      nextMetaDelivered: false,
      nextSlotBOverride: undefined,
    };
  }

  const nextInjectedKey = sessionSystemContractKey(trimmedSystemText);
  if (persistedPrompt === null) {
    return {
      shouldSendMeta: true,
      metaToSend: trimmedSystemText,
      nextInjectedKey,
      nextMetaDelivered: true,
      nextSlotBOverride: { kind: 'full', identity: extractAgentIdentityBlock(trimmedSystemText) },
    };
  }

  const persistedIdentity = extractAgentIdentityBlock(persistedPrompt);
  const nextIdentity = extractAgentIdentityBlock(trimmedSystemText);

  if (stripAgentIdentityBlock(persistedPrompt) !== stripAgentIdentityBlock(trimmedSystemText)) {
    // Persisted Slot A is either a partial stub (e.g. slash-control stub) or an
    // outdated base contract. Send the full contract via Slot B, and if Slot A
    // still carries an older <imcodes-agent-identity> while the new contract
    // omits one, append an empty identity block so stale Slot A rules cannot leak.
    const metaToSend = persistedIdentity !== undefined && nextIdentity === undefined
      ? `${trimmedSystemText}\n\n${EMPTY_AGENT_IDENTITY_BLOCK}`
      : trimmedSystemText;
    return {
      shouldSendMeta: true,
      metaToSend,
      nextInjectedKey,
      nextMetaDelivered: true,
      nextSlotBOverride: { kind: 'full', identity: nextIdentity },
    };
  }

  let metaToSend: string | undefined;
  if (activeSlotBOverride?.kind === 'full') {
    // Slot B holds a full-contract override; reverting to Slot A's base MUST
    // clear/replace Slot B even when nextIdentity equals persistedIdentity.
    metaToSend = nextIdentity !== undefined
      ? (nextIdentity === persistedIdentity ? '' : nextIdentity)
      : (persistedIdentity !== undefined ? EMPTY_AGENT_IDENTITY_BLOCK : '');
  } else {
    const effectiveIdentity = activeSlotBOverride === undefined
      ? persistedIdentity
      : activeSlotBOverride.identity;
    if (effectiveIdentity !== nextIdentity) {
      metaToSend = nextIdentity
        ?? (persistedIdentity !== undefined ? EMPTY_AGENT_IDENTITY_BLOCK : '');
    }
  }

  if (metaToSend !== undefined) {
    return {
      shouldSendMeta: true,
      metaToSend,
      nextInjectedKey,
      nextMetaDelivered: true,
      nextSlotBOverride: metaToSend === '' ? undefined : { kind: 'identity', identity: nextIdentity },
    };
  }

  return {
    shouldSendMeta: false,
    metaToSend: undefined,
    nextInjectedKey,
    nextMetaDelivered: true,
    nextSlotBOverride: activeSlotBOverride,
  };
}
