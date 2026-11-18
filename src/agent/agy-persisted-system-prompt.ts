import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sessionSystemContractKey } from './session-system-contract.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';

const ACP_SYSTEM_PROMPT_MARKER = Buffer.from('\x0a\x11acp_system_prompt\x12', 'latin1');
const AGENT_IDENTITY_BLOCK_RE = /<imcodes-agent-identity>[\s\S]*?<\/imcodes-agent-identity>/;
const EMPTY_AGENT_IDENTITY_BLOCK = '<imcodes-agent-identity>\n</imcodes-agent-identity>';

function isSafeSessionFilename(acpSessionId: string): boolean {
  return Boolean(
    acpSessionId
    && acpSessionId !== '.'
    && acpSessionId !== '..'
    && !/[/\\\0]/.test(acpSessionId),
  );
}

/**
 * Extracts the `<imcodes-agent-identity>...</imcodes-agent-identity>` block
 * from an assembled system contract when present.
 */
export function extractAgentIdentityBlock(text?: string): string | undefined {
  return text?.match(AGENT_IDENTITY_BLOCK_RE)?.[0];
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
    suppressSqliteExperimentalWarning();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
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

export interface AgyResumeSystemPromptPlan {
  shouldSendMeta: boolean;
  metaToSend: string | undefined;
  nextInjectedKey: string | undefined;
  nextMetaDelivered: boolean;
}

/**
 * Decides what `_meta.antigravity.systemPrompt.append` (if any) to send on `session/resume`.
 * When SQLite already persisted `acp_system_prompt` (Slot A), regular resumes omit `_meta`
 * so `agy acp` does not stack a second Slot B system prompt; only mid-session
 * `<imcodes-agent-identity>` changes emit the compact identity block delta.
 */
export function resolveAgyResumeSystemPromptMeta(params: {
  persistedPrompt: string | null;
  trimmedSystemText: string | undefined;
  hasDeliveredMeta: boolean;
}): AgyResumeSystemPromptPlan {
  const { persistedPrompt, trimmedSystemText, hasDeliveredMeta } = params;
  if (!trimmedSystemText) {
    return {
      shouldSendMeta: hasDeliveredMeta,
      metaToSend: hasDeliveredMeta ? '' : undefined,
      nextInjectedKey: undefined,
      nextMetaDelivered: false,
    };
  }

  const nextInjectedKey = sessionSystemContractKey(trimmedSystemText);
  if (persistedPrompt === null) {
    return {
      shouldSendMeta: true,
      metaToSend: trimmedSystemText,
      nextInjectedKey,
      nextMetaDelivered: true,
    };
  }

  if (persistedPrompt === trimmedSystemText) {
    return {
      shouldSendMeta: false,
      metaToSend: undefined,
      nextInjectedKey,
      nextMetaDelivered: true,
    };
  }

  const persistedIdentity = extractAgentIdentityBlock(persistedPrompt);
  const nextIdentity = extractAgentIdentityBlock(trimmedSystemText);
  if ((persistedIdentity !== undefined || nextIdentity !== undefined) && persistedIdentity !== nextIdentity) {
    return {
      shouldSendMeta: true,
      metaToSend: nextIdentity ?? EMPTY_AGENT_IDENTITY_BLOCK,
      nextInjectedKey,
      nextMetaDelivered: true,
    };
  }

  return {
    shouldSendMeta: false,
    metaToSend: undefined,
    nextInjectedKey,
    nextMetaDelivered: true,
  };
}
