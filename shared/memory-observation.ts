import type { MemoryOrigin } from './memory-origin.js';
import type { MemoryScope } from './memory-scope.js';

export const OBSERVATION_CLASSES = [
  'fact',
  'decision',
  'bugfix',
  'feature',
  'refactor',
  'discovery',
  'preference',
  'skill_candidate',
  'workflow',
  'code_pattern',
  'note',
] as const;

export type ObservationClass = (typeof OBSERVATION_CLASSES)[number];

export const OBSERVATION_STATES = ['candidate', 'active', 'superseded', 'rejected', 'promoted'] as const;
export type ObservationState = (typeof OBSERVATION_STATES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ObservationContent {
  readonly [key: string]: JsonValue | undefined;
  readonly text: string;
  readonly title?: string;
  readonly tags?: readonly string[];
}

export interface ContextObservationDraft {
  namespaceId: string;
  scope: MemoryScope;
  class: ObservationClass;
  origin: MemoryOrigin;
  fingerprint: string;
  content: ObservationContent;
  sourceEventIds?: readonly string[];
  projectionId?: string;
  state?: ObservationState;
  confidence?: number;
}

export interface ContextObservationInput {
  namespaceId: string;
  scope: MemoryScope;
  class: ObservationClass;
  origin: MemoryOrigin;
  fingerprint: string;
  content: Record<string, unknown>;
  text?: string;
  textHash?: string;
  sourceEventIds?: readonly string[];
  projectionId?: string;
  state?: ObservationState;
  confidence?: number;
  id?: string;
  now?: number;
}

const OBSERVATION_CLASS_SET: ReadonlySet<string> = new Set(OBSERVATION_CLASSES);
const OBSERVATION_STATE_SET: ReadonlySet<string> = new Set(OBSERVATION_STATES);

export function isObservationClass(value: unknown): value is ObservationClass {
  return typeof value === 'string' && OBSERVATION_CLASS_SET.has(value);
}

export function isObservationState(value: unknown): value is ObservationState {
  return typeof value === 'string' && OBSERVATION_STATE_SET.has(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return valueType !== 'number' || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (valueType === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

export function validateObservationContent(
  observationClass: ObservationClass,
  content: unknown,
): { ok: true; value: ObservationContent } | { ok: false; reason: string } {
  if (!isObservationClass(observationClass)) {
    return { ok: false, reason: `Unknown observation class: ${String(observationClass)}` };
  }
  if (!isJsonValue(content) || content === null || Array.isArray(content) || typeof content !== 'object') {
    return { ok: false, reason: 'Observation content must be a JSON object' };
  }
  const record = content as Record<string, JsonValue>;
  if (record.class === 'memory_note') {
    return { ok: false, reason: 'Use canonical observation class "note" instead of "memory_note"' };
  }
  if (typeof record.text !== 'string' || record.text.trim().length === 0) {
    return { ok: false, reason: 'Observation content requires non-empty text' };
  }
  if (record.tags !== undefined && (!Array.isArray(record.tags) || !record.tags.every((tag) => typeof tag === 'string'))) {
    return { ok: false, reason: 'Observation content tags must be strings' };
  }
  return { ok: true, value: record as unknown as ObservationContent };
}

export function assertObservationContent(observationClass: ObservationClass, content: unknown): ObservationContent {
  const result = validateObservationContent(observationClass, content);
  if (result.ok) return result.value;
  throw new Error(result.reason);
}

export function normalizeObservationText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeObservationSourceIds(sourceEventIds: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of sourceEventIds ?? []) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function assertValidObservationInput(input: ContextObservationInput): void {
  if (!input.namespaceId.trim()) throw new Error('namespaceId is required');
  if (!input.fingerprint.trim()) throw new Error('fingerprint is required');
  if (!isObservationClass(input.class)) throw new Error(`invalid observation class: ${String(input.class)}`);
  if (!isObservationState(input.state ?? 'active')) throw new Error(`invalid observation state: ${String(input.state)}`);
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error('confidence must be between 0 and 1');
  }
  assertObservationContent(input.class, input.content);
}
