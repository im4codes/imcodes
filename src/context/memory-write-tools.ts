import type { ContextNamespace } from '../../shared/context-types.js';
import { computeMemoryFingerprint } from '../../shared/memory-fingerprint.js';
import { attachMemoryMcpSourceProvenance } from '../../shared/memory-mcp-provenance.js';
import { PREFERENCE_INGEST_OBSERVATION_CLASS, PREFERENCE_INGEST_OBSERVATION_STATE, PREFERENCE_INGEST_ORIGIN, PREFERENCE_INGEST_SCOPE, PREFERENCE_MAX_BYTES } from '../../shared/preference-ingest.js';
import {
  MEMORY_MCP_CAPS,
  buildMcpErrorResult,
  pickAllowedMcpArgs,
  type MemoryMcpErrorResult,
} from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import type { CanonicalNamespaceInput } from '../../shared/memory-namespace.js';
import { serializeContextNamespace } from './context-keys.js';
import type { MemoryToolCaller } from './memory-read-tools.js';
import { ensureContextNamespace, writeContextObservation, type ContextNamespaceRow, type ContextObservationRow } from '../store/context-store.js';

export interface SaveObservationOk {
  status: 'ok';
  observationId: string;
  fingerprint: string;
  state: 'candidate';
}

export interface SavePreferenceOk {
  status: 'ok';
  observationId: string;
  fingerprint: string;
  state: typeof PREFERENCE_INGEST_OBSERVATION_STATE;
}

export type SaveObservationResult = SaveObservationOk | MemoryMcpErrorResult;
export type SavePreferenceResult = SavePreferenceOk | MemoryMcpErrorResult;

export interface MemoryWriteToolDeps {
  ensureContextNamespace?: (input: CanonicalNamespaceInput | ContextNamespace, now?: number) => ContextNamespaceRow;
  writeContextObservation?: typeof writeContextObservation;
  now?: () => number;
}

const textEncoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function observationNamespaceFor(caller: MemoryToolCaller): ContextNamespace {
  return {
    ...caller.namespace,
    scope: 'user_private',
    userId: caller.userId,
  };
}

export function saveObservation(input: unknown, caller: MemoryToolCaller, deps: MemoryWriteToolDeps = {}): SaveObservationResult {
  const args = pickAllowedMcpArgs(input, ['content', 'tags', 'turnId', 'idempotencyKey']);
  const content = readString(args, 'content')?.trim();
  if (!content) {
    return buildMcpErrorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'content is required');
  }
  const tags = normalizeTags(args.tags);
  if (
    utf8Bytes(content) > MEMORY_MCP_CAPS.OBSERVATION_CONTENT_MAX_BYTES
    || tags.length > MEMORY_MCP_CAPS.OBSERVATION_TAGS_MAX_COUNT
    || tags.some((tag) => Array.from(tag).length > MEMORY_MCP_CAPS.OBSERVATION_TAG_MAX_CHARS)
  ) {
    return buildMcpErrorResult(MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED, 'observation exceeds MCP write caps');
  }
  if (!caller.namespace.projectId?.trim()) {
    return buildMcpErrorResult(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, 'project scope is required to save observations');
  }

  const namespace = observationNamespaceFor(caller);
  const scopeKey = serializeContextNamespace(namespace);
  const fingerprint = computeMemoryFingerprint({ kind: 'note', content, scopeKey });
  const ensureNamespace = deps.ensureContextNamespace ?? ensureContextNamespace;
  const writeObservation = deps.writeContextObservation ?? writeContextObservation;
  const now = deps.now?.();
  const namespaceRow = ensureNamespace(namespace, now);
  const turnId = readString(args, 'turnId')?.trim();
  const idempotencyKey = readString(args, 'idempotencyKey')?.trim();
  const row = writeObservation({
    namespaceId: namespaceRow.id,
    scope: 'user_private',
    class: 'note',
    origin: 'agent_learned',
    fingerprint,
    content: attachMemoryMcpSourceProvenance({
      text: content,
      ...(tags.length > 0 ? { tags } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ownerUserId: caller.userId,
      createdByUserId: caller.userId,
      updatedByUserId: caller.userId,
    }, caller),
    text: content,
    sourceEventIds: turnId ? [turnId] : undefined,
    state: 'candidate',
    now,
  });
  return {
    status: 'ok',
    observationId: row.id,
    fingerprint,
    state: 'candidate',
  };
}

export function savePreference(input: unknown, caller: MemoryToolCaller, deps: MemoryWriteToolDeps = {}): SavePreferenceResult {
  const args = pickAllowedMcpArgs(input, ['text', 'idempotencyKey']);
  const text = readString(args, 'text')?.trim();
  if (!text) {
    return buildMcpErrorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'text is required');
  }
  if (utf8Bytes(text) > PREFERENCE_MAX_BYTES) {
    return buildMcpErrorResult(MCP_ERROR_REASONS.WRITE_QUOTA_EXCEEDED, 'preference exceeds MCP write caps');
  }

  const namespaceInput: CanonicalNamespaceInput = {
    scope: PREFERENCE_INGEST_SCOPE,
    userId: caller.userId,
    name: 'preferences',
  };
  const scopeKey = `${PREFERENCE_INGEST_SCOPE}:${caller.userId}`;
  const fingerprint = computeMemoryFingerprint({ kind: 'preference', content: text, scopeKey });
  const ensureNamespace = deps.ensureContextNamespace ?? ensureContextNamespace;
  const writeObservation = deps.writeContextObservation ?? writeContextObservation;
  const now = deps.now?.();
  const namespaceRow = ensureNamespace(namespaceInput, now);
  const idempotencyKey = readString(args, 'idempotencyKey')?.trim()
    ?? ['pref:mcp:v1', caller.userId, scopeKey, fingerprint].join('\u0000');
  const row: ContextObservationRow = writeObservation({
    namespaceId: namespaceRow.id,
    scope: PREFERENCE_INGEST_SCOPE,
    class: PREFERENCE_INGEST_OBSERVATION_CLASS,
    origin: PREFERENCE_INGEST_ORIGIN,
    fingerprint,
    content: attachMemoryMcpSourceProvenance({
      text,
      ownerUserId: caller.userId,
      createdByUserId: caller.userId,
      updatedByUserId: caller.userId,
      idempotencyKey,
    }, caller),
    text,
    sourceEventIds: [idempotencyKey],
    state: PREFERENCE_INGEST_OBSERVATION_STATE,
    now,
  });
  return {
    status: 'ok',
    observationId: row.id,
    fingerprint,
    state: PREFERENCE_INGEST_OBSERVATION_STATE,
  };
}
