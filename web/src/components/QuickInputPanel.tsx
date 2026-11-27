import { MachineGroupTabs } from './MachineGroupTabs.js';
import { machineGroupsOf, machinesInGroup, resolveMachineGroup, useRememberedMachineGroup } from '../machine-grouping.js';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import * as apiModule from '../api.js';
import { createSharedResource, type SharedResource } from '../stores/shared-resource.js';
import { FileBrowser } from './file-browser-lazy.js';
import { useAliases } from '../hooks/useAliases.js';
import { AliasApiError } from '../api/aliases.js';
import {
  ALIAS_DESCRIPTION_MAX,
  validateAliasName,
  validateAliasValue,
  validateAliasDescription,
  validateAliasTags,
  isAliasId,
  type AliasReason,
} from '@shared/alias-types.js';
import type { WsClient } from '../ws-client.js';
import type { MachineListItem } from '../api/machines.js';
import type { JSX, RefObject } from 'preact';
import { DEFAULT_QUICK_PHRASES, getDefaultQuickCommands } from '../quick-commands.js';
import { MACHINE_IDENTITY_UNAVAILABLE } from '@shared/machine-reference.js';
import {
  VERIFICATION_MACHINE_KINDS,
  VERIFICATION_MACHINE_SCOPES,
  type VerificationMachineProfile,
  type VerificationMachineScope,
} from '@shared/verification-machine.js';
import { listVerificationMachines, setVerificationMachine } from '../api/verification-machines.js';

export interface QuickData {
  history: string[];                                                 // cross-session
  sessionHistory: Record<string, string[]>;                          // per-session, keyed by session name
  historyTimestamps?: Record<string, number>;                        // epoch ms per history text
  sessionHistoryTimestamps?: Record<string, Record<string, number>>; // epoch ms per session + text
  commands: string[];
  phrases: string[];
}

export const EMPTY_QUICK_DATA: QuickData = { history: [], sessionHistory: {}, commands: [], phrases: [] };

// ── Built-in defaults (not stored in D1, cannot be deleted) ───────────────

export const SESSION_HISTORY_MAX = 200;
export const GLOBAL_HISTORY_MAX = 200;

// ── Data helpers ──────────────────────────────────────────────────────────

function dedupPrepend(list: string[], text: string, max: number): string[] {
  return [text, ...list.filter((h) => h !== text)].slice(0, max);
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function readOwnRecordValue<V>(record: Record<string, V> | undefined, key: string): V | undefined {
  if (!record || typeof record !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function mapWithEntry<V>(record: Record<string, V> | undefined, key: string, value: V): Record<string, V> {
  const entries = new Map<string, V>(record && typeof record === 'object' ? Object.entries(record) : []);
  entries.set(key, value);
  return Object.fromEntries(entries);
}

function pruneTimestampMap(entries: readonly string[], rawMap: unknown): Record<string, number> | undefined {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return undefined;
  const allowed = new Set(entries);
  const pruned = new Map<string, number>();
  for (const [key, rawVal] of Object.entries(rawMap as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    const ts = validTimestamp(rawVal);
    if (ts !== undefined) pruned.set(key, ts);
  }
  return pruned.size > 0 ? Object.fromEntries(pruned) : undefined;
}

function pruneSessionTimestampMaps(
  sessionHistory: Record<string, string[]>,
  rawMaps: unknown,
): Record<string, Record<string, number>> | undefined {
  if (!rawMaps || typeof rawMaps !== 'object' || Array.isArray(rawMaps)) return undefined;
  const pruned = new Map<string, Record<string, number>>();
  for (const [session, rawMap] of Object.entries(rawMaps as Record<string, unknown>)) {
    const entries = readOwnRecordValue(sessionHistory, session);
    if (!entries || entries.length === 0) continue;
    const cleaned = pruneTimestampMap(entries, rawMap);
    if (cleaned) pruned.set(session, cleaned);
  }
  return pruned.size > 0 ? Object.fromEntries(pruned) : undefined;
}

function buildQuickDataWithPrunedTimestamps(
  nextHistory: string[],
  nextSessionHistory: Record<string, string[]>,
  nextHistoryTs: unknown,
  nextSessionTs: unknown,
  commands: string[],
  phrases: string[],
): QuickData {
  const historyTimestamps = pruneTimestampMap(nextHistory, nextHistoryTs);
  const sessionHistoryTimestamps = pruneSessionTimestampMaps(nextSessionHistory, nextSessionTs);
  return {
    history: nextHistory,
    sessionHistory: nextSessionHistory,
    ...(historyTimestamps ? { historyTimestamps } : {}),
    ...(sessionHistoryTimestamps ? { sessionHistoryTimestamps } : {}),
    commands,
    phrases,
  };
}

export function recordHistoryEntry(data: QuickData, text: string, sessionName?: string, now = Date.now()): QuickData {
  const trimmed = text.trim();
  if (!trimmed) return data;
  const ts = validTimestamp(now) ?? Math.trunc(Date.now());
  const nextHistory = dedupPrepend(data.history, trimmed, GLOBAL_HISTORY_MAX);
  const nextHistoryTs = mapWithEntry(data.historyTimestamps, trimmed, ts);
  let nextSessionHistory = data.sessionHistory;
  let nextSessionTs = data.sessionHistoryTimestamps;
  if (sessionName) {
    const prev = readOwnRecordValue(data.sessionHistory, sessionName) ?? [];
    nextSessionHistory = mapWithEntry(
      data.sessionHistory,
      sessionName,
      dedupPrepend(prev, trimmed, SESSION_HISTORY_MAX),
    );
    nextSessionTs = mapWithEntry(
      data.sessionHistoryTimestamps,
      sessionName,
      mapWithEntry(readOwnRecordValue(data.sessionHistoryTimestamps, sessionName), trimmed, ts),
    );
  }
  return buildQuickDataWithPrunedTimestamps(
    nextHistory,
    nextSessionHistory,
    nextHistoryTs,
    nextSessionTs,
    data.commands,
    data.phrases,
  );
}

export function getNavigableHistory(data: QuickData, sessionName?: string): string[] {
  if (!sessionName) return data.history;
  const sessionHist = readOwnRecordValue(data.sessionHistory, sessionName) ?? [];
  return sessionHist.length > 0 ? sessionHist : data.history;
}

export function getHistoryTimestamp(
  data: QuickData,
  text: string,
  scope: HistoryScope,
  sessionName?: string,
): number | undefined {
  if (scope === 'session') {
    if (!sessionName) return undefined;
    const sessionMap = readOwnRecordValue(data.sessionHistoryTimestamps, sessionName);
    return validTimestamp(readOwnRecordValue(sessionMap, text));
  }
  let latest = validTimestamp(readOwnRecordValue(data.historyTimestamps, text));
  if (data.sessionHistoryTimestamps) {
    for (const sessionMap of Object.values(data.sessionHistoryTimestamps)) {
      const candidate = validTimestamp(readOwnRecordValue(sessionMap, text));
      if (candidate !== undefined && (latest === undefined || candidate > latest)) {
        latest = candidate;
      }
    }
  }
  return latest;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatHistoryTimestamp(
  ts: number | undefined,
  now = Date.now(),
): { short: string; full: string } | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  const ref = new Date(now);
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  const datePart = yyyy === ref.getFullYear() ? `${mm}-${dd}` : `${yyyy}-${mm}-${dd}`;
  return {
    short: `${datePart} ${hh}:${mi}`,
    full: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`,
  };
}

export function getAccountHistory(data: QuickData): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const append = (items: string[]) => {
    for (const item of items) {
      if (!seen.has(item)) {
        seen.add(item);
        merged.push(item);
      }
    }
  };
  append(data.history);
  for (const items of Object.values(data.sessionHistory)) append(items);
  // Sort timestamped entries newest-first while preserving insertion order for
  // legacy untimestamped entries, then enforce the global 200-item ceiling so
  // the "All" view never exceeds GLOBAL_HISTORY_MAX.
  const hasAnyTimestamp = merged.some((item) => getHistoryTimestamp(data, item, 'global') !== undefined);
  const ordered = hasAnyTimestamp
    ? merged
        .map((item, idx) => ({ item, idx, ts: getHistoryTimestamp(data, item, 'global') ?? -1 }))
        .sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : a.idx - b.idx))
        .map((entry) => entry.item)
    : merged;
  return ordered.slice(0, GLOBAL_HISTORY_MAX);
}

// ── Hook ──────────────────────────────────────────────────────────────────

interface AuthoritativeAuthScope {
  userId: string;
  baseUrl: string;
  scopeKey: string;
  epoch: number;
}

interface AuthBinding {
  scope: AuthoritativeAuthScope | null;
  epoch: number;
  controller: AbortController;
}

interface PendingQuickDataSnapshot {
  v: 3;
  entryId: string;
  clientId: string;
  scopeKey: string;
  updatedAt: number;
  baseline: QuickData;
  target: QuickData;
  removedAllTexts?: string[];
}

interface PendingQuickDataSlot {
  storageKey: string;
  entryId: string;
  snapshot: PendingQuickDataSnapshot;
}

type PreHydrationOp =
  | { type: 'record_history'; text: string; sessionName?: string; ts: number }
  | { type: 'remove_history'; text: string }
  | { type: 'remove_session_history'; sessionName: string; text: string }
  | { type: 'clear_history' }
  | { type: 'clear_session_history'; sessionName: string }
  | { type: 'add_command'; cmd: string }
  | { type: 'remove_command'; cmd: string }
  | { type: 'add_phrase'; phrase: string }
  | { type: 'remove_phrase'; phrase: string };

let _instanceCounter = 0;
function generateClientInstanceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* ignore */ }
  return `qp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${++_instanceCounter}`;
}

interface PendingSaveTuple {
  revision: number;
  entryId: string;
  clientId: string;
  binding: AuthBinding;
  baselineSnapshot: QuickData;
  expectedVersion: string | null;
  target: QuickData;
  removedAllTexts: string[];
}

let _clientInstanceId = generateClientInstanceId();
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingSaveTuple: PendingSaveTuple | null = null;
let _hasHydratedFromServer = false;
let _mutatedBeforeHydration = false;
let _visibilityInstalled = false;
let _visibilityHandler: (() => void) | null = null;
let _pageHideHandler: (() => void) | null = null;
let _authUnsubscribe: (() => void) | null = null;
let _saveRevision = 0;
let _inFlightSaves = 0;
let _baseline: QuickData | null = null;
let _serverVersion: string | null = null;
let _boundBinding: AuthBinding | null = null;
const _inFlightControllers = new Set<AbortController>();
const _pendingRemovedAllTexts = new Set<string>();
let _preHydrationOps: PreHydrationOp[] = [];

const QUICK_DATA_PENDING_KEY_PREFIX = 'imcodes.quick_data.pending:';
const KEEPALIVE_SAFE_BODY_BYTES = 60_000;

function apiFetch<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  return opts === undefined ? apiModule.apiFetch<T>(path) : apiModule.apiFetch<T>(path, opts);
}

/**
 * Normalize an API base URL while preserving any service sub-path on the same
 * origin (e.g. `https://host.test/tenant-a/` vs `https://host.test/tenant-b`),
 * so distinct tenant/proxy paths never collide under one storage scope.
 */
function normalizeAuthBaseUrl(baseUrl: string | null | undefined): string {
  if (typeof baseUrl !== 'string') return '';
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin.toLowerCase()}${cleanPath}`;
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

function readExpectedUserIdFromApi(): string | null {
  try {
    const fn = (apiModule as { getExpectedUserId?: unknown }).getExpectedUserId;
    if (typeof fn !== 'function') return null;
    const raw = (fn as () => string | null)();
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

function readApiBaseUrlFromApi(): string {
  try {
    const fn = (apiModule as { getApiBaseUrl?: unknown }).getApiBaseUrl;
    if (typeof fn === 'function') {
      const raw = (fn as () => string)();
      if (typeof raw === 'string') return normalizeAuthBaseUrl(raw);
    }
  } catch { /* ignore */ }
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return normalizeAuthBaseUrl(origin);
}

function readAuthIdentityEpochFromApi(): number {
  try {
    const fn = (apiModule as { getAuthIdentityEpoch?: unknown }).getAuthIdentityEpoch;
    if (typeof fn === 'function') {
      const val = (fn as () => number)();
      if (typeof val === 'number' && Number.isFinite(val)) return val;
    }
  } catch { /* ignore */ }
  return 0;
}

function getAuthoritativeAuthScope(): AuthoritativeAuthScope | null {
  const userId = readExpectedUserIdFromApi();
  if (!userId) return null;
  const baseUrl = readApiBaseUrlFromApi();
  const epoch = readAuthIdentityEpochFromApi();
  return {
    userId,
    baseUrl,
    scopeKey: `${baseUrl}|${userId}`,
    epoch,
  };
}

function captureCurrentBinding(): AuthBinding {
  const scope = getAuthoritativeAuthScope();
  return {
    scope,
    epoch: scope ? scope.epoch : readAuthIdentityEpochFromApi(),
    controller: new AbortController(),
  };
}

function isBindingCurrent(binding: AuthBinding | null): boolean {
  if (!binding || binding.controller.signal.aborted) return false;
  const current = captureCurrentBinding();
  if (binding.epoch !== current.epoch) return false;
  if (!binding.scope && !current.scope) return true;
  if (!binding.scope || !current.scope) return false;
  return binding.scope.scopeKey === current.scope.scopeKey;
}

function abortBindingAndInFlightRequests(binding?: AuthBinding | null): void {
  const err = typeof DOMException !== 'undefined'
    ? new DOMException('Auth binding changed', 'AbortError')
    : new Error('Auth binding changed');
  try { binding?.controller.abort(err); } catch { /* ignore */ }
  for (const ctrl of [..._inFlightControllers]) {
    try { ctrl.abort(err); } catch { /* ignore */ }
  }
  _inFlightControllers.clear();
}

function getQuickDataPendingScopePrefix(scope: AuthoritativeAuthScope): string {
  return `${QUICK_DATA_PENDING_KEY_PREFIX}${encodeURIComponent(scope.scopeKey)}:`;
}

function getQuickDataPendingStorageKey(scope: AuthoritativeAuthScope | null, clientId = _clientInstanceId): string | null {
  if (!scope || typeof localStorage === 'undefined') return null;
  return `${getQuickDataPendingScopePrefix(scope)}${encodeURIComponent(clientId)}`;
}

function parsePendingSnapshotRecord(raw: string | null, expectedScopeKey: string): PendingQuickDataSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingQuickDataSnapshot> | null;
    if (
      !parsed
      || typeof parsed !== 'object'
      || parsed.v !== 3
      || parsed.scopeKey !== expectedScopeKey
      || typeof parsed.entryId !== 'string'
      || !parsed.entryId
      || typeof parsed.clientId !== 'string'
      || !parsed.clientId
    ) {
      return null;
    }
    return {
      v: 3,
      entryId: parsed.entryId,
      clientId: parsed.clientId,
      scopeKey: expectedScopeKey,
      updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
      baseline: normalizeQuickData(parsed.baseline),
      target: normalizeQuickData(parsed.target),
      ...(Array.isArray(parsed.removedAllTexts)
        ? { removedAllTexts: parsed.removedAllTexts.filter((item): item is string => typeof item === 'string') }
        : {}),
    };
  } catch {
    return null;
  }
}

function writePendingSnapshot(scope: AuthoritativeAuthScope | null, snapshot: PendingQuickDataSnapshot): void {
  const key = getQuickDataPendingStorageKey(scope, snapshot.clientId);
  if (!key || !scope || snapshot.scopeKey !== scope.scopeKey) return;
  try {
    localStorage.setItem(key, JSON.stringify(snapshot));
  } catch { /* ignore quota/private mode errors */ }
}

function readPendingSnapshots(scope: AuthoritativeAuthScope | null): PendingQuickDataSlot[] {
  if (!scope || typeof localStorage === 'undefined') return [];
  const prefix = getQuickDataPendingScopePrefix(scope);
  const slots: PendingQuickDataSlot[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const parsed = parsePendingSnapshotRecord(localStorage.getItem(k), scope.scopeKey);
      if (parsed) {
        slots.push({ storageKey: k, entryId: parsed.entryId, snapshot: parsed });
      }
    }
  } catch { /* ignore */ }
  slots.sort((a, b) => (a.snapshot.updatedAt !== b.snapshot.updatedAt
    ? a.snapshot.updatedAt - b.snapshot.updatedAt
    : a.entryId.localeCompare(b.entryId)));
  return slots;
}

function clearPendingSlotIfEntryId(storageKey: string, expectedScopeKey: string, expectedEntryId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const parsed = parsePendingSnapshotRecord(localStorage.getItem(storageKey), expectedScopeKey);
    if (parsed && parsed.entryId === expectedEntryId) {
      localStorage.removeItem(storageKey);
    }
  } catch { /* ignore */ }
}

function clearAllPendingSnapshotsForTests(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(QUICK_DATA_PENDING_KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

function resetInMemoryQuickDataForAuthChange(revalidateSubscribers: boolean): void {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  _pendingSaveTuple = null;
  abortBindingAndInFlightRequests(_boundBinding);
  _hasHydratedFromServer = false;
  _mutatedBeforeHydration = false;
  _saveRevision += 1;
  _baseline = null;
  _serverVersion = null;
  _boundBinding = captureCurrentBinding();
  _pendingRemovedAllTexts.clear();
  _preHydrationOps = [];
  _pendingPhraseAdds.clear();
  _pendingCommandAdds.clear();
  quickDataResource.mutate(EMPTY_QUICK_DATA);
  if (revalidateSubscribers && quickDataResource.hasSubscribers()) {
    quickDataResource.invalidate();
  }
}

function ensureAuthChangeSubscription(): void {
  if (_authUnsubscribe) return;
  try {
    const fn = (apiModule as { subscribeAuthIdentityChange?: unknown }).subscribeAuthIdentityChange;
    if (typeof fn === 'function') {
      _authUnsubscribe = (fn as (listener: () => void) => () => void)(() => {
        resetInMemoryQuickDataForAuthChange(true);
      });
    }
  } catch { /* ignore */ }
}

// ── Pending-add tracking ─────────────────────────────────────────────────
// User-added custom phrases/commands are persisted via a 2-second debounced
// PUT. In a few uncommon scenarios that window is wide enough to lose data:
//
//   1. The shared resource's `invalidate()` (e.g. tab visibility refresh)
//      triggers a re-fetch. The fetcher returned server data as-is, which
//      OVERWROTE the optimistic resource value containing the just-added
//      phrase. The phrase vanished from the UI; if the user then mutated
//      again, the new `scheduleSave` cancelled the original closure-captured
//      timer, and the phrase was never persisted.
//
//   2. The user closed/reloaded the tab inside the 2-second debounce window.
//      The timer never fired, so the addition was lost server-side.
//
// Fix: track every unsaved phrase/command addition in module-level Sets.
// `applyPendingAdds` layers them onto every server response so optimistic
// items survive `invalidate()`, and the visibility/pagehide handlers flush
// the pending PUT synchronously via fetch `keepalive`. Successful saves
// clear the in-flight snapshot from the pending sets; failures keep them
// in place so the next mutation (or next flush) will retry.
const _pendingPhraseAdds = new Set<string>();
const _pendingCommandAdds = new Set<string>();

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function normalizeQuickData(raw: unknown): QuickData {
  const data = raw && typeof raw === 'object' ? raw as Partial<QuickData> : {};
  const sessionHistoryMap = new Map<string, string[]>();
  if (data.sessionHistory && typeof data.sessionHistory === 'object' && !Array.isArray(data.sessionHistory)) {
    for (const [session, entries] of Object.entries(data.sessionHistory)) {
      sessionHistoryMap.set(session, normalizeStringList(entries).slice(0, SESSION_HISTORY_MAX));
    }
  }
  return buildQuickDataWithPrunedTimestamps(
    normalizeStringList(data.history).slice(0, GLOBAL_HISTORY_MAX),
    Object.fromEntries(sessionHistoryMap),
    data.historyTimestamps,
    data.sessionHistoryTimestamps,
    normalizeStringList(data.commands),
    normalizeStringList(data.phrases),
  );
}

function unionServerLocal(server: string[], local: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const item of [...server, ...local]) {
    if (seen.has(item)) continue;
    seen.add(item);
    merged.push(item);
  }
  return merged;
}

function mergeOrderedHistoryLists(
  baselineList: readonly string[],
  localList: readonly string[],
  serverList: readonly string[],
  baselineTsMap: Record<string, number> | undefined,
  localTsMap: Record<string, number> | undefined,
  serverTsMap: Record<string, number> | undefined,
  removedAllSet: ReadonlySet<string>,
  max: number,
): { entries: string[]; timestamps: Record<string, number> | undefined } {
  const baselineSet = new Set(baselineList);
  const localSet = new Set(localList);
  const removed = new Set<string>();
  for (const item of baselineList) {
    if (!localSet.has(item)) removed.add(item);
  }
  for (const item of removedAllSet) {
    if (!localSet.has(item)) removed.add(item);
  }

  // Extract ONLY local additions and genuine local re-sends (newer timestamp
  // than baseline). Unmodified baseline items follow the server's existence
  // and timestamp so deletes performed on another device are never revived.
  const localAddedOrUpdated: string[] = [];
  const localAddedOrUpdatedSet = new Set<string>();
  for (const item of localList) {
    const inBaseline = baselineSet.has(item);
    const baseTs = validTimestamp(readOwnRecordValue(baselineTsMap, item));
    const localTs = validTimestamp(readOwnRecordValue(localTsMap, item));
    const isAdded = !inBaseline;
    const isUpdated = inBaseline && localTs !== undefined && localTs > (baseTs ?? -1);
    if (isAdded || isUpdated) {
      localAddedOrUpdated.push(item);
      localAddedOrUpdatedSet.add(item);
    }
  }

  const survivingServer = serverList.filter((item) => !removed.has(item));
  const combined: string[] = [];
  const seen = new Set<string>();
  for (const item of [...localAddedOrUpdated, ...survivingServer]) {
    if (seen.has(item)) continue;
    seen.add(item);
    combined.push(item);
  }

  const tsMap = new Map<string, number>();
  for (const item of combined) {
    const serverTs = validTimestamp(readOwnRecordValue(serverTsMap, item));
    const localTs = localAddedOrUpdatedSet.has(item)
      ? validTimestamp(readOwnRecordValue(localTsMap, item))
      : undefined;
    const best = localTs !== undefined && serverTs !== undefined
      ? Math.max(localTs, serverTs)
      : (localTs ?? serverTs);
    if (best !== undefined) tsMap.set(item, best);
  }
  const ordered = tsMap.size > 0
    ? combined
        .map((item, idx) => ({ item, idx, ts: tsMap.get(item) ?? -1 }))
        .sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : a.idx - b.idx))
        .map((entry) => entry.item)
    : combined;
  const entries = ordered.slice(0, max);
  const timestamps = pruneTimestampMap(entries, Object.fromEntries(tsMap));
  return { entries, timestamps };
}

function mergeCustomListThreeWay(
  baselineList: readonly string[],
  localList: readonly string[],
  serverList: readonly string[],
): string[] {
  const localSet = new Set(localList);
  const removed = new Set(baselineList.filter((item) => !localSet.has(item)));
  const added = localList.filter((item) => !baselineList.includes(item));
  return unionServerLocal(serverList.filter((item) => !removed.has(item)), added);
}

export function mergeQuickDataThreeWay(
  baseline: QuickData,
  local: QuickData,
  server: QuickData,
  removedAllTexts?: readonly string[],
): QuickData {
  const removedAllSet = new Set<string>(removedAllTexts ?? []);
  const globalMerged = mergeOrderedHistoryLists(
    baseline.history,
    local.history,
    server.history,
    baseline.historyTimestamps,
    local.historyTimestamps,
    server.historyTimestamps,
    removedAllSet,
    GLOBAL_HISTORY_MAX,
  );
  const sessionNames = new Set([
    ...Object.keys(baseline.sessionHistory),
    ...Object.keys(local.sessionHistory),
    ...Object.keys(server.sessionHistory),
  ]);
  const sessionHistoryMap = new Map<string, string[]>();
  const sessionTsMap = new Map<string, Record<string, number>>();
  for (const session of sessionNames) {
    const mergedSession = mergeOrderedHistoryLists(
      readOwnRecordValue(baseline.sessionHistory, session) ?? [],
      readOwnRecordValue(local.sessionHistory, session) ?? [],
      readOwnRecordValue(server.sessionHistory, session) ?? [],
      readOwnRecordValue(baseline.sessionHistoryTimestamps, session),
      readOwnRecordValue(local.sessionHistoryTimestamps, session),
      readOwnRecordValue(server.sessionHistoryTimestamps, session),
      removedAllSet,
      SESSION_HISTORY_MAX,
    );
    sessionHistoryMap.set(session, mergedSession.entries);
    if (mergedSession.timestamps) sessionTsMap.set(session, mergedSession.timestamps);
  }
  return buildQuickDataWithPrunedTimestamps(
    globalMerged.entries,
    Object.fromEntries(sessionHistoryMap),
    globalMerged.timestamps,
    Object.fromEntries(sessionTsMap),
    mergeCustomListThreeWay(baseline.commands, local.commands, server.commands),
    mergeCustomListThreeWay(baseline.phrases, local.phrases, server.phrases),
  );
}

export function mergeQuickDataForHydration(server: QuickData, local: QuickData): QuickData {
  return mergeQuickDataThreeWay(EMPTY_QUICK_DATA, local, server);
}

function applyPreHydrationOp(data: QuickData, op: PreHydrationOp): QuickData {
  switch (op.type) {
    case 'record_history':
      return recordHistoryEntry(data, op.text, op.sessionName, op.ts);
    case 'remove_history': {
      const nextSessionHistoryMap = new Map<string, string[]>();
      for (const [session, list] of Object.entries(data.sessionHistory)) {
        nextSessionHistoryMap.set(session, list.filter((h) => h !== op.text));
      }
      return buildQuickDataWithPrunedTimestamps(
        data.history.filter((h) => h !== op.text),
        Object.fromEntries(nextSessionHistoryMap),
        data.historyTimestamps,
        data.sessionHistoryTimestamps,
        data.commands,
        data.phrases,
      );
    }
    case 'remove_session_history': {
      const sh = readOwnRecordValue(data.sessionHistory, op.sessionName) ?? [];
      return buildQuickDataWithPrunedTimestamps(
        data.history,
        mapWithEntry(data.sessionHistory, op.sessionName, sh.filter((h) => h !== op.text)),
        data.historyTimestamps,
        data.sessionHistoryTimestamps,
        data.commands,
        data.phrases,
      );
    }
    case 'clear_history':
      return buildQuickDataWithPrunedTimestamps([], {}, undefined, undefined, data.commands, data.phrases);
    case 'clear_session_history':
      return buildQuickDataWithPrunedTimestamps(
        data.history,
        mapWithEntry(data.sessionHistory, op.sessionName, []),
        data.historyTimestamps,
        data.sessionHistoryTimestamps,
        data.commands,
        data.phrases,
      );
    case 'add_command':
      return data.commands.includes(op.cmd) ? data : { ...data, commands: [...data.commands, op.cmd] };
    case 'remove_command':
      return { ...data, commands: data.commands.filter((c) => c !== op.cmd) };
    case 'add_phrase':
      return data.phrases.includes(op.phrase) ? data : { ...data, phrases: [...data.phrases, op.phrase] };
    case 'remove_phrase':
      return { ...data, phrases: data.phrases.filter((p) => p !== op.phrase) };
  }
}

function applyPreHydrationOps(base: QuickData, ops: readonly PreHydrationOp[]): QuickData {
  let acc = base;
  for (const op of ops) acc = applyPreHydrationOp(acc, op);
  return acc;
}

/**
 * Layer pending (unsaved) custom additions onto a server snapshot so an
 * `invalidate()`-triggered re-fetch never wipes optimistic state. Only
 * additions are tracked — removals fall through to the closure-captured
 * `data` payload in the in-flight PUT, which already conveys deletes
 * correctly.
 */
function applyPendingAdds(server: QuickData): QuickData {
  if (_pendingPhraseAdds.size === 0 && _pendingCommandAdds.size === 0) return server;
  const phrases = server.phrases.slice();
  for (const p of _pendingPhraseAdds) if (!phrases.includes(p)) phrases.push(p);
  const commands = server.commands.slice();
  for (const c of _pendingCommandAdds) if (!commands.includes(c)) commands.push(c);
  return { ...server, phrases, commands };
}

function utf8ByteLength(str: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).byteLength;
  return str.length * 3;
}

function makePendingEntryId(clientId: string, rev: number): string {
  return `${clientId}:${rev}`;
}

function buildPendingSnapshotRecord(
  scope: AuthoritativeAuthScope,
  rev: number,
  target: QuickData,
  extraRemovedAll?: readonly string[],
  clientId = _clientInstanceId,
  baselineOverride?: QuickData,
): PendingQuickDataSnapshot {
  const removedSet = new Set<string>(_pendingRemovedAllTexts);
  if (extraRemovedAll) {
    for (const item of extraRemovedAll) removedSet.add(item);
  }
  const targetGlobal = new Set(target.history);
  for (const item of Array.from(removedSet)) {
    if (targetGlobal.has(item)) removedSet.delete(item);
  }
  return {
    v: 3,
    entryId: makePendingEntryId(clientId, rev),
    clientId,
    scopeKey: scope.scopeKey,
    updatedAt: Date.now(),
    baseline: baselineOverride ?? _baseline ?? EMPTY_QUICK_DATA,
    target,
    ...(removedSet.size > 0 ? { removedAllTexts: Array.from(removedSet) } : {}),
  };
}

function buildPutBody(data: QuickData, expectedVersion: string | null | undefined): string {
  return expectedVersion
    ? JSON.stringify({ data, expectedVersion })
    : JSON.stringify({ data });
}

const MAX_CAS_CONFLICT_RETRIES = 4;

function isStructuredAuthIdentityError(rawBody: string): boolean {
  try {
    const fn = (apiModule as { isAuthIdentityChangedBody?: unknown }).isAuthIdentityChangedBody;
    if (typeof fn === 'function') return Boolean((fn as (b: string) => boolean)(rawBody));
  } catch { /* fallback */ }
  const trimmed = rawBody.trim();
  if (trimmed === 'auth_identity_changed' || trimmed === 'expected_user_id_mismatch') return true;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; code?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const topCode = typeof parsed.error === 'string'
      ? parsed.error
      : typeof parsed.code === 'string'
        ? parsed.code
        : '';
    return topCode === 'auth_identity_changed' || topCode === 'expected_user_id_mismatch';
  } catch {
    return false;
  }
}

async function resolveVersionConflictSnapshot(
  err: unknown,
  signal: AbortSignal,
): Promise<{ data: QuickData; version: string } | null> {
  if (!err || typeof err !== 'object') return null;
  if ((err as { status?: unknown }).status !== 409) return null;
  const rawBody = (err as { body?: unknown }).body;
  if (typeof rawBody === 'string') {
    if (isStructuredAuthIdentityError(rawBody)) return null;
    try {
      const parsed = JSON.parse(rawBody) as { error?: unknown; code?: unknown; data?: unknown; version?: unknown } | null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const topCode = typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.code === 'string'
          ? parsed.code
          : '';
      if (topCode !== 'version_conflict') return null;
      if (parsed.data && typeof parsed.version === 'string' && parsed.version) {
        return { data: normalizeQuickData(parsed.data), version: parsed.version };
      }
      const latest = await apiFetch<{ data: QuickData; version?: string }>('/api/quick-data', { signal });
      if (typeof latest?.version !== 'string' || !latest.version) return null;
      return { data: normalizeQuickData(latest.data), version: latest.version };
    } catch {
      return null;
    }
  }
  const errCode = (err as { code?: unknown }).code;
  if (errCode !== 'version_conflict') return null;
  const latest = await apiFetch<{ data: QuickData; version?: string }>('/api/quick-data', { signal });
  if (typeof latest?.version !== 'string' || !latest.version) return null;
  return { data: normalizeQuickData(latest.data), version: latest.version };
}

function scheduleSave(data: QuickData, canPersist: boolean): void {
  if (!canPersist) return;
  const binding = _pendingSaveTuple?.binding ?? _boundBinding ?? captureCurrentBinding();
  if (!isBindingCurrent(binding)) {
    abortBindingAndInFlightRequests(binding);
    return;
  }
  const rev = ++_saveRevision;
  const clientId = _clientInstanceId;
  const entryId = makePendingEntryId(clientId, rev);
  const baselineSnapshot = _pendingSaveTuple ? _pendingSaveTuple.baselineSnapshot : (_baseline ?? EMPTY_QUICK_DATA);
  const expectedVersion = _pendingSaveTuple ? _pendingSaveTuple.expectedVersion : _serverVersion;
  const removedAllTexts = Array.from(_pendingRemovedAllTexts);
  const tuple: PendingSaveTuple = {
    revision: rev,
    entryId,
    clientId,
    binding,
    baselineSnapshot,
    expectedVersion,
    target: data,
    removedAllTexts,
  };
  _pendingSaveTuple = tuple;
  if (binding.scope) {
    writePendingSnapshot(binding.scope, buildPendingSnapshotRecord(binding.scope, rev, data, removedAllTexts, clientId, baselineSnapshot));
  }
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    const activeTuple = _pendingSaveTuple;
    _pendingSaveTuple = null;
    if (!activeTuple) return;
    runSave(activeTuple.target, {
      revision: activeTuple.revision,
      entryId: activeTuple.entryId,
      clientId: activeTuple.clientId,
      binding: activeTuple.binding,
      baselineSnapshot: activeTuple.baselineSnapshot,
      expectedVersion: activeTuple.expectedVersion,
      removedAllTexts: activeTuple.removedAllTexts,
    });
  }, 2000);
}

/**
 * Fire a PUT for the supplied snapshot. Enforces optimistic CAS (`expectedVersion`)
 * when supported by the server: on 409 conflict, fetches/reads the latest server
 * snapshot, rebases this operation's 3-way delta onto it, updates local backup &
 * UI safely, and retries without overwriting newer out-of-order commits.
 */
function runSave(
  data: QuickData,
  opts: {
    keepalive?: boolean;
    revision: number;
    entryId: string;
    clientId: string;
    binding: AuthBinding;
    baselineSnapshot: QuickData;
    expectedVersion: string | null;
    removedAllTexts: readonly string[];
    consolidatedSlots?: readonly PendingQuickDataSlot[];
  },
): void {
  if (!isBindingCurrent(opts.binding)) {
    abortBindingAndInFlightRequests(opts.binding);
    return;
  }
  const snapPhraseAdds = new Set(_pendingPhraseAdds);
  const snapCommandAdds = new Set(_pendingCommandAdds);
  const snapRemovedAll = new Set(_pendingRemovedAllTexts);
  const ctrl = opts.binding.controller;
  _inFlightControllers.add(ctrl);
  _inFlightSaves += 1;

  void (async () => {
    let currTarget = data;
    let currBaseline = opts.baselineSnapshot;
    let currExpectedVersion = opts.expectedVersion;
    const currRemovedAll = opts.removedAllTexts;

    try {
      for (let attempt = 0; attempt <= MAX_CAS_CONFLICT_RETRIES; attempt += 1) {
        if (!isBindingCurrent(opts.binding)) return;
        const init: RequestInit = {
          method: 'PUT',
          body: buildPutBody(currTarget, currExpectedVersion),
          signal: ctrl.signal,
        };
        if (opts.keepalive && attempt === 0) init.keepalive = true;

        try {
          const putRes = await apiFetch<{ ok?: boolean; version?: string } | undefined>('/api/quick-data', init);
          if (!isBindingCurrent(opts.binding)) return;
          for (const p of snapPhraseAdds) _pendingPhraseAdds.delete(p);
          for (const c of snapCommandAdds) _pendingCommandAdds.delete(c);
          for (const r of snapRemovedAll) _pendingRemovedAllTexts.delete(r);
          _baseline = currTarget;
          if (typeof putRes?.version === 'string' && putRes.version) {
            _serverVersion = putRes.version;
          }
          if (attempt > 0 && _saveRevision === opts.revision) {
            quickDataResource.mutate(currTarget);
          }
          if (opts.binding.scope) {
            const ownKey = getQuickDataPendingStorageKey(opts.binding.scope, opts.clientId);
            if (ownKey) {
              clearPendingSlotIfEntryId(ownKey, opts.binding.scope.scopeKey, opts.entryId);
            }
            if (opts.consolidatedSlots) {
              for (const slot of opts.consolidatedSlots) {
                clearPendingSlotIfEntryId(slot.storageKey, opts.binding.scope.scopeKey, slot.entryId);
              }
            }
          }
          return;
        } catch (err) {
          if (ctrl.signal.aborted || !isBindingCurrent(opts.binding)) return;
          let conflict: { data: QuickData; version: string } | null = null;
          try {
            conflict = await resolveVersionConflictSnapshot(err, ctrl.signal);
          } catch {
            return;
          }
          if (!conflict) {
            console.error('[quick-data] save failed:', err);
            return;
          }
          if (ctrl.signal.aborted || !isBindingCurrent(opts.binding)) return;

          if (_saveRevision !== opts.revision) {
            // A newer local edit already superseded this save in this tab. If it
            // is still in its debounce window, rebase the active tuple + UI + backup
            // atomically onto the latest server snapshot; otherwise leave the already
            // in-flight newer request to resolve its own CAS conflict untouched.
            rebasePendingDebounceTupleOntoServer(conflict.data, conflict.version, opts.binding);
            return;
          }

          _baseline = conflict.data;
          _serverVersion = conflict.version;

          if (attempt >= MAX_CAS_CONFLICT_RETRIES) {
            console.error('[quick-data] save conflict retry budget exhausted');
            return;
          }

          const rebasedTarget = mergeQuickDataThreeWay(currBaseline, currTarget, conflict.data, currRemovedAll);
          quickDataResource.mutate(rebasedTarget);
          if (opts.binding.scope) {
            writePendingSnapshot(
              opts.binding.scope,
              buildPendingSnapshotRecord(
                opts.binding.scope,
                opts.revision,
                rebasedTarget,
                currRemovedAll,
                opts.clientId,
                conflict.data,
              ),
            );
          }
          currBaseline = conflict.data;
          currTarget = rebasedTarget;
          currExpectedVersion = conflict.version;
        }
      }
    } finally {
      _inFlightControllers.delete(ctrl);
      _inFlightSaves = Math.max(0, _inFlightSaves - 1);
    }
  })();
}

/**
 * Flush a pending debounced save during page hide / unload.
 * Stores an account-bound, per-tab-unique pending snapshot before attempting
 * network delivery; skips `keepalive` above Chromium's 64 KiB cap.
 */
function flushPendingSave(): void {
  if (!_debounceTimer || !_hasHydratedFromServer) return;
  clearTimeout(_debounceTimer);
  _debounceTimer = null;
  const tuple = _pendingSaveTuple;
  _pendingSaveTuple = null;
  if (!tuple || !isBindingCurrent(tuple.binding)) {
    abortBindingAndInFlightRequests(tuple?.binding ?? _boundBinding);
    return;
  }
  const data = tuple.target;
  if (tuple.binding.scope) {
    writePendingSnapshot(
      tuple.binding.scope,
      buildPendingSnapshotRecord(
        tuple.binding.scope,
        tuple.revision,
        data,
        tuple.removedAllTexts,
        tuple.clientId,
        tuple.baselineSnapshot,
      ),
    );
  }
  const body = buildPutBody(data, tuple.expectedVersion);
  if (utf8ByteLength(body) <= KEEPALIVE_SAFE_BODY_BYTES) {
    runSave(data, {
      keepalive: true,
      revision: tuple.revision,
      entryId: tuple.entryId,
      clientId: tuple.clientId,
      binding: tuple.binding,
      baselineSnapshot: tuple.baselineSnapshot,
      expectedVersion: tuple.expectedVersion,
      removedAllTexts: tuple.removedAllTexts,
    });
  } else {
    runSave(data, {
      revision: tuple.revision,
      entryId: tuple.entryId,
      clientId: tuple.clientId,
      binding: tuple.binding,
      baselineSnapshot: tuple.baselineSnapshot,
      expectedVersion: tuple.expectedVersion,
      removedAllTexts: tuple.removedAllTexts,
    });
  }
}

function consolidatePendingSlots(
  server: QuickData,
  slots: readonly PendingQuickDataSlot[],
): { merged: QuickData; removedAllTexts: string[] } {
  let merged = server;
  const removedAllSet = new Set<string>();
  for (const slot of slots) {
    merged = mergeQuickDataThreeWay(
      slot.snapshot.baseline,
      slot.snapshot.target,
      merged,
      slot.snapshot.removedAllTexts,
    );
    if (slot.snapshot.removedAllTexts) {
      for (const item of slot.snapshot.removedAllTexts) removedAllSet.add(item);
    }
  }
  const mergedGlobal = new Set(merged.history);
  for (const item of Array.from(removedAllSet)) {
    if (mergedGlobal.has(item)) removedAllSet.delete(item);
  }
  return { merged, removedAllTexts: Array.from(removedAllSet) };
}

function rebasePendingDebounceTupleOntoServer(
  server: QuickData,
  serverVersion: string | null,
  binding: AuthBinding,
): QuickData | null {
  const activePendingTuple = _pendingSaveTuple;
  if (activePendingTuple === null || _debounceTimer === null) return null;
  const rebasedTarget = mergeQuickDataThreeWay(
    activePendingTuple.baselineSnapshot,
    activePendingTuple.target,
    server,
    activePendingTuple.removedAllTexts,
  );
  const rebasedGlobalSet = new Set(rebasedTarget.history);
  const rebasedRemovedAll = activePendingTuple.removedAllTexts.filter((item) => !rebasedGlobalSet.has(item));
  _baseline = server;
  _serverVersion = serverVersion;
  _pendingSaveTuple = {
    ...activePendingTuple,
    baselineSnapshot: server,
    expectedVersion: serverVersion,
    target: rebasedTarget,
    removedAllTexts: rebasedRemovedAll,
  };
  if (binding.scope) {
    writePendingSnapshot(
      binding.scope,
      buildPendingSnapshotRecord(
        binding.scope,
        activePendingTuple.revision,
        rebasedTarget,
        rebasedRemovedAll,
        activePendingTuple.clientId,
        server,
      ),
    );
  }
  const rebasedView = applyPendingAdds(rebasedTarget);
  quickDataResource.mutate(rebasedView);
  return rebasedView;
}

// Explicit annotation: the fetcher closure references `quickDataResource`
// (in both the merge-on-hydrate path and the keep-current-on-error path),
// so TS needs the type up front to avoid `implicitly any` in the cycle.
let quickDataResource: SharedResource<QuickData> = createSharedResource<QuickData>({
  fetcher: async () => {
    ensureAuthChangeSubscription();
    const fetchBinding = captureCurrentBinding();
    const ctrl = fetchBinding.controller;
    _inFlightControllers.add(ctrl);
    try {
      const res = await apiFetch<{ data: QuickData; version?: string }>('/api/quick-data', { signal: ctrl.signal });
      if (!isBindingCurrent(fetchBinding)) {
        abortBindingAndInFlightRequests(fetchBinding);
        return normalizeQuickData(quickDataResource.peek().value ?? EMPTY_QUICK_DATA);
      }
      const server = normalizeQuickData(res.data);
      const serverVersion = typeof res.version === 'string' && res.version ? res.version : null;
      const hadPriorHydration = _hasHydratedFromServer;
      _hasHydratedFromServer = true;
      _boundBinding = fetchBinding;
      const rebasedView = hadPriorHydration
        ? rebasePendingDebounceTupleOntoServer(server, serverVersion, fetchBinding)
        : null;
      if (rebasedView !== null) {
        return rebasedView;
      }
      if (hadPriorHydration && _inFlightSaves > 0) {
        return normalizeQuickData(quickDataResource.peek().value ?? applyPendingAdds(server));
      }
      _serverVersion = serverVersion;
      const shouldReplayPending = _debounceTimer === null && _inFlightSaves === 0;
      const pendingSlots = shouldReplayPending ? readPendingSnapshots(fetchBinding.scope) : [];
      if (_mutatedBeforeHydration || pendingSlots.length > 0) {
        const preOps = _preHydrationOps.splice(0);
        _mutatedBeforeHydration = false;
        const consolidated = pendingSlots.length > 0
          ? consolidatePendingSlots(server, pendingSlots)
          : { merged: server, removedAllTexts: [] as string[] };
        let merged = consolidated.merged;
        if (preOps.length > 0) {
          merged = applyPreHydrationOps(merged, preOps);
        }
        _baseline = server;
        if (consolidated.removedAllTexts.length > 0) {
          const mergedGlobal = new Set(merged.history);
          for (const item of consolidated.removedAllTexts) {
            if (!mergedGlobal.has(item)) _pendingRemovedAllTexts.add(item);
          }
        }
        quickDataResource.mutate(merged);
        if (pendingSlots.length > 0 && fetchBinding.scope) {
          const rev = ++_saveRevision;
          const clientId = _clientInstanceId;
          const entryId = makePendingEntryId(clientId, rev);
          writePendingSnapshot(
            fetchBinding.scope,
            buildPendingSnapshotRecord(fetchBinding.scope, rev, merged, consolidated.removedAllTexts, clientId, server),
          );
          runSave(merged, {
            revision: rev,
            entryId,
            clientId,
            binding: fetchBinding,
            baselineSnapshot: server,
            expectedVersion: serverVersion,
            removedAllTexts: consolidated.removedAllTexts,
            consolidatedSlots: pendingSlots,
          });
        }
        return applyPendingAdds(merged);
      }
      _baseline = server;
      return applyPendingAdds(server);
    } catch {
      if (!isBindingCurrent(fetchBinding)) {
        return EMPTY_QUICK_DATA;
      }
      if (_hasHydratedFromServer) {
        return normalizeQuickData(quickDataResource.peek().value ?? EMPTY_QUICK_DATA);
      }
      const slots = readPendingSnapshots(fetchBinding.scope);
      return slots.length > 0 ? consolidatePendingSlots(EMPTY_QUICK_DATA, slots).merged : EMPTY_QUICK_DATA;
    } finally {
      _inFlightControllers.delete(ctrl);
    }
  },
});

function installQuickDataVisibilityListener(): void {
  ensureAuthChangeSubscription();
  if (_visibilityInstalled || typeof document === 'undefined') return;
  _visibilityHandler = () => {
    if (document.visibilityState === 'visible' && quickDataResource.hasSubscribers()) {
      quickDataResource.invalidate();
    } else if (document.visibilityState === 'hidden') {
      // Tab is going away (mobile background, window minimize, switch
      // tabs) — flush any pending debounced save synchronously so a
      // quick close/refresh doesn't drop the user's last edit.
      flushPendingSave();
    }
  };
  document.addEventListener('visibilitychange', _visibilityHandler);
  // `pagehide` is the most reliable unload signal across browsers
  // (especially mobile Safari, which throttles visibilitychange and
  // skips beforeunload on swipe-away). Pair it with the visibility
  // hook above for full coverage.
  if (typeof window !== 'undefined') {
    _pageHideHandler = flushPendingSave;
    window.addEventListener('pagehide', _pageHideHandler);
  }
  _visibilityInstalled = true;
}

function updateQuickData(updater: (prev: QuickData) => QuickData, preOp?: PreHydrationOp): void {
  const peeked = normalizeQuickData(quickDataResource.peek().value ?? EMPTY_QUICK_DATA);
  const prev = _pendingSaveTuple !== null && _debounceTimer !== null
    ? normalizeQuickData(_pendingSaveTuple.target)
    : peeked;
  const next = updater(prev);
  if (next === prev) return;
  if (!_hasHydratedFromServer) {
    _mutatedBeforeHydration = true;
    if (preOp) _preHydrationOps.push(preOp);
  }
  quickDataResource.set(next);
  scheduleSave(next, _hasHydratedFromServer);
}

export interface UseQuickDataResult {
  data: QuickData;
  loaded: boolean;
  recordHistory: (text: string, sessionName?: string) => void;
  addCommand: (cmd: string) => void;
  addPhrase: (phrase: string) => void;
  removeCommand: (cmd: string) => void;
  removePhrase: (phrase: string) => void;
  removeHistory: (text: string) => void;
  removeSessionHistory: (sessionName: string, text: string) => void;
  clearHistory: () => void;
  clearSessionHistory: (sessionName: string) => void;
}

// The mutators only touch module-level state, so they are module constants: the
// object useQuickData() returns must keep its identity between renders, or
// every memoized consumer (panes, windows, cards, composers) re-renders with it.
const recordHistory = (text: string, sessionName?: string) => {
  const trimmed = text.trim();
  const ts = Math.trunc(Date.now());
  if (trimmed) _pendingRemovedAllTexts.delete(trimmed);
  updateQuickData(
    (prev) => recordHistoryEntry(prev, text, sessionName, ts),
    trimmed ? { type: 'record_history', text: trimmed, sessionName, ts } : undefined,
  );
};

const addCommand = (cmd: string) => {
  const trimmed = cmd.trim();
  if (!trimmed) return;
  // Mark pending BEFORE the optimistic mutation so a racing fetcher
  // (a no-op `set` doesn't trigger one, but defensive ordering keeps
  // the invariant simple) sees the addition.
  _pendingCommandAdds.add(trimmed);
  updateQuickData(
    (prev) => prev.commands.includes(trimmed) ? prev : { ...prev, commands: [...prev.commands, trimmed] },
    { type: 'add_command', cmd: trimmed },
  );
};

const addPhrase = (phrase: string) => {
  const trimmed = phrase.trim();
  if (!trimmed) return;
  _pendingPhraseAdds.add(trimmed);
  updateQuickData(
    (prev) => prev.phrases.includes(trimmed) ? prev : { ...prev, phrases: [...prev.phrases, trimmed] },
    { type: 'add_phrase', phrase: trimmed },
  );
};

const removeCommand = (cmd: string) => {
  // If the user adds-then-removes inside the debounce window, drop the
  // pending entry — there is nothing to preserve across a refresh.
  _pendingCommandAdds.delete(cmd);
  updateQuickData(
    (prev) => prev.commands.includes(cmd) ? { ...prev, commands: prev.commands.filter((c) => c !== cmd) } : prev,
    { type: 'remove_command', cmd },
  );
};
const removePhrase = (phrase: string) => {
  _pendingPhraseAdds.delete(phrase);
  updateQuickData(
    (prev) => prev.phrases.includes(phrase) ? { ...prev, phrases: prev.phrases.filter((p) => p !== phrase) } : prev,
    { type: 'remove_phrase', phrase },
  );
};
const removeHistory = (text: string) => {
  _pendingRemovedAllTexts.add(text);
  updateQuickData((prev) => {
    const inGlobal = prev.history.includes(text);
    let inAnySession = false;
    const nextSessionHistoryMap = new Map<string, string[]>();
    for (const [session, list] of Object.entries(prev.sessionHistory)) {
      if (list.includes(text)) {
        inAnySession = true;
        nextSessionHistoryMap.set(session, list.filter((h) => h !== text));
      } else {
        nextSessionHistoryMap.set(session, list);
      }
    }
    if (!inGlobal && !inAnySession) return prev;
    return buildQuickDataWithPrunedTimestamps(
      inGlobal ? prev.history.filter((h) => h !== text) : prev.history,
      Object.fromEntries(nextSessionHistoryMap),
      prev.historyTimestamps,
      prev.sessionHistoryTimestamps,
      prev.commands,
      prev.phrases,
    );
  }, { type: 'remove_history', text });
};
const removeSessionHistory = (sessionName: string, text: string) => {
  updateQuickData((prev) => {
    const sh = readOwnRecordValue(prev.sessionHistory, sessionName) ?? [];
    if (!sh.includes(text)) return prev;
    return buildQuickDataWithPrunedTimestamps(
      prev.history,
      mapWithEntry(prev.sessionHistory, sessionName, sh.filter((h) => h !== text)),
      prev.historyTimestamps,
      prev.sessionHistoryTimestamps,
      prev.commands,
      prev.phrases,
    );
  }, { type: 'remove_session_history', sessionName, text });
};
const clearHistory = () => {
  updateQuickData((prev) => {
    const hasSessionItems = Object.values(prev.sessionHistory).some((items) => items.length > 0);
    if (prev.history.length === 0 && !hasSessionItems && !prev.historyTimestamps && !prev.sessionHistoryTimestamps) {
      return prev;
    }
    return buildQuickDataWithPrunedTimestamps([], {}, undefined, undefined, prev.commands, prev.phrases);
  }, { type: 'clear_history' });
};
const clearSessionHistory = (sessionName: string) => {
  updateQuickData((prev) => (readOwnRecordValue(prev.sessionHistory, sessionName) ?? []).length === 0
    ? prev
    : buildQuickDataWithPrunedTimestamps(
        prev.history,
        mapWithEntry(prev.sessionHistory, sessionName, []),
        prev.historyTimestamps,
        prev.sessionHistoryTimestamps,
        prev.commands,
        prev.phrases,
      ), { type: 'clear_session_history', sessionName });
};


const QUICK_DATA_ACTIONS = { recordHistory, addCommand, addPhrase, removeCommand, removePhrase, removeHistory, removeSessionHistory, clearHistory, clearSessionHistory };

export function useQuickData(): UseQuickDataResult {
  installQuickDataVisibilityListener();
  const snapshot = quickDataResource.use();
  const data = useMemo(() => normalizeQuickData(snapshot.value ?? EMPTY_QUICK_DATA), [snapshot.value]);
  return useMemo(() => ({ data, loaded: snapshot.loaded, ...QUICK_DATA_ACTIONS }), [data, snapshot.loaded]);
}

export function __simulateReloadForTests(opts?: { clientId?: string }): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = null;
  _pendingSaveTuple = null;
  abortBindingAndInFlightRequests(_boundBinding);
  _clientInstanceId = opts?.clientId ?? generateClientInstanceId();
  _hasHydratedFromServer = false;
  _mutatedBeforeHydration = false;
  _saveRevision = 0;
  _inFlightSaves = 0;
  _baseline = null;
  _serverVersion = null;
  _boundBinding = null;
  _pendingRemovedAllTexts.clear();
  _preHydrationOps = [];
  _pendingPhraseAdds.clear();
  _pendingCommandAdds.clear();
  if (_authUnsubscribe) {
    try { _authUnsubscribe(); } catch { /* ignore */ }
    _authUnsubscribe = null;
  }
  if (_visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _visibilityHandler);
  }
  _visibilityHandler = null;
  if (_pageHideHandler && typeof window !== 'undefined') {
    window.removeEventListener('pagehide', _pageHideHandler);
  }
  _pageHideHandler = null;
  _visibilityInstalled = false;
  quickDataResource.disposeForTests();
}

export function __resetQuickDataForTests(): void {
  clearAllPendingSnapshotsForTests();
  __simulateReloadForTests();
}

// ── Panel component ───────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (text: string) => void;
  onSend: (text: string) => void;
  agentType: string;
  sessionName: string;
  data: QuickData;
  loaded: boolean;
  onAddCommand: (cmd: string) => void;
  onAddPhrase: (phrase: string) => void;
  onRemoveCommand: (cmd: string) => void;
  onRemovePhrase: (phrase: string) => void;
  onRemoveHistory: (text: string) => void;
  onRemoveSessionHistory: (sessionName: string, text: string) => void;
  onClearHistory: () => void;
  onClearSessionHistory: (sessionName: string) => void;
  /** When provided, enables the Files tab for browsing and inserting paths */
  ws?: WsClient | null;
  sessionCwd?: string;
  onAppendPaths?: (paths: string[]) => void;
  /** Insert a `;;(name)` alias marker into the composer (never the value). */
  onInsertAlias?: (name: string) => void;
  /** Controlled nodes shown in the optional machine tab. */
  machines?: readonly MachineListItem[];
  /** Insert a canonical nodeId marker plus its human-readable display note. */
  onInsertMachine?: (nodeId: string, displayName: string) => void;
  /** Stable project identity used to include project-scoped verification machines. */
  projectKey?: string;
  /** Insert one long-lived verification-machine reference into the composer. */
  onInsertVerificationMachine?: (machine: VerificationMachineProfile) => void;
  anchorRef?: RefObject<HTMLElement>;
  /** Restrict the shared picker to text/history surfaces for non-chat inputs. */
  quickOnly?: boolean;
  /** Optional portal layer for callers rendered inside higher desktop windows. */
  portalZIndex?: number;
  /**
   * Optional host for the portal. Fullscreen callers must supply the active
   * fullscreen element because document.body is outside the rendered
   * fullscreen subtree.
   */
  portalContainer?: Element | null;
}

const HISTORY_PAGE_SIZE = 10;
const TRUNCATE_THRESHOLD = 40;
type AddTarget = 'command' | 'phrase' | null;
type HistoryScope = 'session' | 'global';
type QpTab = 'quick' | 'files' | 'alias' | 'machines' | 'verification';
type VerificationSourceTab = 'alias' | 'controlled_node';

/** Truncate long text: "start of text...end of text" */
function truncateMiddle(text: string, max = TRUNCATE_THRESHOLD): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 3) / 2);
  return text.slice(0, half) + '...' + text.slice(-half);
}

function formatPreviewText(text: string, max = TRUNCATE_THRESHOLD): string {
  return truncateMiddle(text.replace(/\r\n?/g, '\n').replace(/\n/g, ' ↵ '), max);
}

export function QuickInputPanel({
  open, onClose, onSelect, onSend, agentType, sessionName,
  data, loaded,
  onAddCommand, onAddPhrase, onRemoveCommand, onRemovePhrase,
  onRemoveHistory, onRemoveSessionHistory, onClearHistory, onClearSessionHistory,
  ws, sessionCwd, onAppendPaths, onInsertAlias, machines = [], onInsertMachine,
  projectKey, onInsertVerificationMachine, anchorRef, quickOnly = false, portalZIndex,
  portalContainer,
}: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [addTarget, setAddTarget] = useState<AddTarget>(null);
  const [addValue, setAddValue] = useState('');
  const [editingItem, setEditingItem] = useState<{ type: 'command' | 'phrase'; original: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyScope, setHistoryScope] = useState<HistoryScope>('session');
  const [historySearch, setHistorySearch] = useState('');
  const [activeTab, setActiveTab] = useState<QpTab>('quick');
  const [rememberedMachineGroup, setMachineGroup] = useRememberedMachineGroup(open && activeTab === 'machines');
  const machineGroup = resolveMachineGroup(rememberedMachineGroup, machines);
  // Legacy peers without groups still show every machine, just as before.
  const machineGroups = machineGroupsOf(machines);
  const visibleMachines = machineGroups.length ? machinesInGroup(machines, machineGroup) : machines;
  const [insertedPaths, setInsertedPaths] = useState<string[]>([]);
  const [layoutTick, setLayoutTick] = useState(0);
  const [verificationMachines, setVerificationMachines] = useState<VerificationMachineProfile[]>([]);
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationError, setVerificationError] = useState(false);
  const [verificationBusyTarget, setVerificationBusyTarget] = useState<string | null>(null);
  const [verificationPickerOpen, setVerificationPickerOpen] = useState(false);
  const [verificationSourceTab, setVerificationSourceTab] = useState<VerificationSourceTab>('alias');
  const [verificationScope, setVerificationScope] = useState<VerificationMachineScope>(
    projectKey ? VERIFICATION_MACHINE_SCOPES.PROJECT : VERIFICATION_MACHINE_SCOPES.USER,
  );
  const enabledVerificationMachines = useMemo(
    () => verificationMachines.filter((profile) => profile.enabled),
    [verificationMachines],
  );

  // ── Alias tab state ──
  // Server-authoritative alias data (create/remove invalidate the shared
  // resource so every alias surface updates without a reload). We do NOT reuse
  // the quick-data debounced storage path here — aliases persist immediately.
  const [aliasSearch, setAliasSearch] = useState('');
  const { aliases: allAliases, filtered: filteredAliases, create: createAlias, remove: removeAlias, refetch: refetchAliases } = useAliases(aliasSearch);
  // Alias editor: `null` = closed; `{ original: null }` = creating a new one;
  // `{ original: name }` = editing that alias by its original name.
  // `tags` is carried through the form (not yet user-editable) so that editing
  // an existing alias PRESERVES its tags instead of the upsert clearing them,
  // and so any tags we send are validated with the shared validator (Cx1-6).
  const [aliasForm, setAliasForm] = useState<{ original: string | null; name: string; value: string; description: string; tags: string } | null>(null);
  const [aliasError, setAliasError] = useState<AliasReason | 'generic' | null>(null);
  const [aliasSaving, setAliasSaving] = useState(false);
  const aliasNameInputRef = useRef<HTMLInputElement>(null);

  // Reset page when scope, session, or history search filter changes
  useEffect(() => { setHistoryPage(0); }, [historyScope, sessionName, historySearch]);

  // Refetch server aliases whenever the alias tab becomes visible (or the panel
  // opens on it), so aliases created elsewhere — e.g. by an agent via the
  // save_alias MCP tool, or on another device — show up without a manual reload.
  useEffect(() => {
    if (open && (activeTab === 'alias' || activeTab === 'verification')) refetchAliases();
  }, [open, activeTab, refetchAliases]);

  useEffect(() => {
    setVerificationScope(projectKey ? VERIFICATION_MACHINE_SCOPES.PROJECT : VERIFICATION_MACHINE_SCOPES.USER);
  }, [projectKey]);

  useEffect(() => {
    if (!open || activeTab !== 'verification') return;
    let live = true;
    setVerificationLoading(true);
    setVerificationError(false);
    void listVerificationMachines(projectKey).then((profiles) => {
      if (live) setVerificationMachines(profiles);
    }).catch(() => {
      if (live) setVerificationError(true);
    }).finally(() => {
      if (live) setVerificationLoading(false);
    });
    return () => { live = false; };
  }, [activeTab, open, projectKey]);

  const authorizeVerificationTarget = async (input: {
    alias: string;
    kind: VerificationMachineProfile['kind'];
    target: string;
  }) => {
    const existing = verificationMachines.find((profile) => (
      profile.scope === verificationScope
      && profile.kind === input.kind
      && profile.target === input.target
    ));
    setVerificationBusyTarget(`${input.kind}:${input.target}`);
    setVerificationError(false);
    try {
      await setVerificationMachine({
        ...(existing ? { id: existing.id, expectedRevision: existing.revision } : {}),
        scope: verificationScope,
        scopeKey: verificationScope === VERIFICATION_MACHINE_SCOPES.PROJECT ? projectKey ?? '' : '',
        alias: input.alias,
        kind: input.kind,
        target: input.target,
        enabled: true,
      });
      setVerificationMachines(await listVerificationMachines(projectKey));
      setVerificationPickerOpen(false);
    } catch {
      setVerificationError(true);
    } finally {
      setVerificationBusyTarget(null);
    }
  };

  // A removed/revoked last machine must not strand the panel on a hidden tab.
  useEffect(() => {
    if (activeTab === 'machines' && machines.length === 0) setActiveTab('quick');
  }, [activeTab, machines.length]);

  useEffect(() => {
    if (quickOnly && activeTab !== 'quick') setActiveTab('quick');
  }, [activeTab, quickOnly]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const refreshLayout = () => setLayoutTick((tick) => tick + 1);
    const viewport = window.visualViewport;
    window.addEventListener('resize', refreshLayout);
    viewport?.addEventListener('resize', refreshLayout);
    viewport?.addEventListener('scroll', refreshLayout);
    return () => {
      window.removeEventListener('resize', refreshLayout);
      viewport?.removeEventListener('resize', refreshLayout);
      viewport?.removeEventListener('scroll', refreshLayout);
    };
  }, [open]);

  // Close on outside click (exclude trigger button to avoid close→reopen flicker)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(target)
        && !(anchorRef?.current && anchorRef.current.contains(target))) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose, anchorRef]);

  // Keep keyboard navigation inside the open picker. In particular, the
  // trigger remains focused when the portal opens, so the first Tab must enter
  // the dialog rather than continue through the remote-desktop toolbar.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
      event.preventDefault();
      focusable[nextIndex]?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Focus add/edit input when shown
  useEffect(() => {
    if (addTarget) setTimeout(() => addInputRef.current?.focus(), 50);
  }, [addTarget]);
  useEffect(() => {
    if (editingItem) setTimeout(() => editInputRef.current?.focus(), 50);
  }, [editingItem]);
  // Focus the name input only when a form is (re)opened — NOT on every keystroke.
  // `aliasForm` is a fresh object on each field edit, so depending on it re-ran
  // this effect and stole focus back to `name` while typing value/desc/tags.
  // Key on the form IDENTITY instead (`original`; `undefined` = no form open),
  // which is stable across edits within the same form.
  const aliasFormId = aliasForm ? aliasForm.original : undefined;
  useEffect(() => {
    if (aliasFormId === undefined) return;
    const t = setTimeout(() => aliasNameInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [aliasFormId]);

  const panelStyle = useMemo(() => {
    if (!open) return undefined; // skip computation when closed
    if (typeof window === 'undefined' || window.innerWidth <= 640) return undefined;
    const trigger = anchorRef?.current;
    if (!trigger) return undefined;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const horizontalInset = 8;
    const verticalInset = 12;
    const triggerGap = 6;
    const width = Math.max(240, Math.min(Math.floor(viewportWidth * 0.75), 1050, viewportWidth - horizontalInset * 2));
    const maxLeft = Math.max(horizontalInset, viewportWidth - width - horizontalInset);
    const left = Math.min(Math.max(rect.left, horizontalInset), maxLeft);
    const rawAbove = Math.floor(rect.top - verticalInset);
    const rawBelow = Math.floor(viewportHeight - rect.bottom - verticalInset);
    const shouldOpenBelow = rawAbove < 200;
    const availableAbove = Math.max(120, rawAbove);
    const availableBelow = Math.max(120, rawBelow);

    const style: JSX.CSSProperties = {
      position: 'fixed',
      left: `${Math.round(left)}px`,
      width: `${Math.round(width)}px`,
      maxWidth: `${Math.round(width)}px`,
      maxHeight: `${shouldOpenBelow ? availableBelow : availableAbove}px`,
      zIndex: 10002,
    } as preact.JSX.CSSProperties;

    if (shouldOpenBelow) {
      style.top = `${Math.max(Math.round(rect.bottom + triggerGap), horizontalInset)}px`;
      style.bottom = 'auto'; // clear CSS default bottom: calc(100% + 6px)
    } else {
      style.bottom = `${Math.max(viewportHeight - rect.top + triggerGap, horizontalInset)}px`;
      style.top = 'auto';
    }

    return style;
  }, [anchorRef, layoutTick, open]);

  if (!open) return null;

  const defaultCmds = getDefaultQuickCommands(agentType);
  const activeHistory = historyScope === 'session'
    ? (readOwnRecordValue(data.sessionHistory, sessionName) ?? [])
    : getAccountHistory(data);
  const normalizedHistoryQuery = historySearch.trim().toLowerCase();
  const filteredHistory = normalizedHistoryQuery
    ? activeHistory.filter((item) => item.toLowerCase().includes(normalizedHistoryQuery))
    : activeHistory;
  const totalHistoryPages = Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE);
  const safeHistoryPage = totalHistoryPages > 0 ? Math.min(historyPage, totalHistoryPages - 1) : 0;
  const historySlice = filteredHistory.slice(safeHistoryPage * HISTORY_PAGE_SIZE, (safeHistoryPage + 1) * HISTORY_PAGE_SIZE);

  const handleSelect = (text: string) => { onSelect(text); onClose(); };
  const handleSend = (text: string) => { onSend(text); onClose(); };

  const handleClear = () => {
    if (historyScope === 'session') onClearSessionHistory(sessionName);
    else onClearHistory();
  };

  const handleRemoveItem = (text: string) => {
    if (historyScope === 'session') onRemoveSessionHistory(sessionName, text);
    else onRemoveHistory(text);
  };

  const commitAdd = () => {
    const v = addValue.trim();
    if (v) {
      if (addTarget === 'command') onAddCommand(v);
      else if (addTarget === 'phrase') onAddPhrase(v);
    }
    setAddValue('');
    setAddTarget(null);
  };

  const handleAddKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commitAdd(); }
    if (e.key === 'Escape') { setAddTarget(null); setAddValue(''); }
  };

  const startEdit = (type: 'command' | 'phrase', original: string) => {
    setEditingItem({ type, original });
    setEditValue(original);
  };

  const commitEdit = () => {
    if (!editingItem) return;
    const v = editValue.trim();
    const { type, original } = editingItem;
    if (v && v !== original) {
      if (type === 'command') { onRemoveCommand(original); onAddCommand(v); }
      else { onRemovePhrase(original); onAddPhrase(v); }
    }
    setEditingItem(null);
    setEditValue('');
  };

  const handleEditKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { setEditingItem(null); setEditValue(''); }
  };

  // ── Alias tab handlers ──
  const openAliasCreate = () => {
    setAliasError(null);
    setAliasForm({ original: null, name: '', value: '', description: '', tags: '' });
  };
  const openAliasEdit = (name: string) => {
    const entry = allAliases.find((a) => a.name === name);
    if (!entry) return;
    setAliasError(null);
    setAliasForm({ original: entry.name, name: entry.name, value: entry.value, description: entry.description ?? '', tags: (entry.tags ?? []).join(' ') });
  };
  const closeAliasForm = () => {
    setAliasForm(null);
    setAliasError(null);
    setAliasSaving(false);
  };

  const commitAlias = async () => {
    if (!aliasForm || aliasSaving) return;
    const name = aliasForm.name.trim();
    const value = aliasForm.value;
    const description = aliasForm.description.trim();
    // Tags are entered as a free-text, space-separated string; split into the
    // wire array (whitespace-collapsed, empties dropped). The server + shared
    // validateAliasTags remain authoritative on count/length/control chars.
    const tags = aliasForm.tags.trim().split(/\s+/).filter(Boolean);
    // Client-side validation with the shared validators gives instant, localized
    // feedback via the same reason codes the server enforces (server remains
    // authoritative — its AliasApiError reason overrides on any mismatch).
    const nameErr = validateAliasName(name);
    if (nameErr) { setAliasError(nameErr); return; }
    const valueErr = validateAliasValue(value);
    if (valueErr) { setAliasError(valueErr); return; }
    const descErr = validateAliasDescription(description || undefined);
    if (descErr) { setAliasError(descErr); return; }
    // Validate the space-separated tags before sending (Cx1-6); the server is
    // authoritative and also rejects invalid ones — surface `alias_tags_invalid`.
    const tagsErr = validateAliasTags(tags.length > 0 ? tags : undefined);
    if (tagsErr) { setAliasError(tagsErr); return; }

    setAliasSaving(true);
    setAliasError(null);
    try {
      const existing = aliasForm.original
        ? allAliases.find((entry) => entry.name === aliasForm.original)
        : undefined;
      // Preserve the server row id on rename so durable verification-machine
      // associations follow the alias automatically.
      await createAlias({
        ...(existing?.id ? { id: existing.id } : {}),
        name,
        value,
        ...(description ? { description } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      });
      closeAliasForm();
    } catch (err) {
      setAliasSaving(false);
      const reason = err instanceof AliasApiError ? err.reason : null;
      setAliasError(reason ?? 'generic');
    }
  };

  const deleteAliasEntry = async (name: string) => {
    if (!confirm(t('alias.delete_confirm'))) return;
    try {
      await removeAlias(name);
    } catch {
      // Removal failures are non-fatal for the UI; surface a generic notice.
      setAliasError('generic');
    }
  };

  const aliasErrorText = aliasError
    // The limits are passed in rather than restated in each locale string, so a
    // change to the shared constant cannot leave seven translations claiming a
    // number the server no longer enforces.
    ? (aliasError === 'generic'
      ? t('alias.error.generic')
      : t(`alias.error.${aliasError}`, { max: ALIAS_DESCRIPTION_MAX }))
    : null;

  const panel = (
    <>
      <div
        class="qp-backdrop"
        style={portalZIndex === undefined ? undefined : { zIndex: portalZIndex - 1 }}
        onClick={onClose}
      />
      <div
        class="qp"
        ref={panelRef}
        style={portalZIndex === undefined ? panelStyle : { ...panelStyle, zIndex: portalZIndex }}
        role="dialog"
        aria-label={t('quick_input.title')}
      >
        {/* Machine tab is present only when the account has controlled nodes. */}
        {!quickOnly && <div class="qp-tabs">
          <button class={`qp-tab${activeTab === 'quick' ? ' active' : ''}`} onClick={() => setActiveTab('quick')}>
            ⚡ {t('quick_input.tab_quick')}
          </button>
          {ws && (
            <button class={`qp-tab${activeTab === 'files' ? ' active' : ''}`} onClick={() => setActiveTab('files')}>
              📁 {t('quick_input.tab_files')}
            </button>
          )}
          <button class={`qp-tab${activeTab === 'alias' ? ' active' : ''}`} onClick={() => setActiveTab('alias')}>
            🔖 {t('alias.tab')}
          </button>
          {machines.length > 0 && (
            <button class={`qp-tab${activeTab === 'machines' ? ' active' : ''}`} onClick={() => setActiveTab('machines')}>
              🖥 {t('quick_input.tab_machines')}
            </button>
          )}
          <button class={`qp-tab${activeTab === 'verification' ? ' active' : ''}`} onClick={() => setActiveTab('verification')}>
            🧪 {t('quick_input.tab_verification')}
          </button>
        </div>}

        {/* Controlled-node tab — display names are mutable, canonical node IDs
            are stable. Connectivity is informational: an offline node can still
            be referenced in a task and resolve once it reconnects. */}
        {activeTab === 'machines' && machines.length > 0 && (
          <div class="qp-machine-items" role="listbox" aria-label={t('quick_input.tab_machines')}>
            <div class="qp-alias-hint">{t('machine.usage_hint')}</div>
            {machineGroups.length > 0 && (
              <div class="controlled-nodes-group-filter" role="tablist" aria-label={t('controlled_nodes.group_filter_label')}>
                <MachineGroupTabs machines={machines} group={machineGroup} onSelect={setMachineGroup} testIdPrefix="qp-machine-group" />
              </div>
            )}
            {visibleMachines.length === 0 && <div class="qp-history-empty">{t('controlled_nodes.empty')}</div>}
            {visibleMachines.map((machine) => (
              <button
                key={machine.serverId}
                type="button"
                class={`qp-machine-item${machine.online ? '' : ' is-offline'}`}
                disabled={!onInsertMachine || !machine.nodeId}
                title={machine.online ? machine.displayName : t('machine.offline_hint')}
                onClick={() => {
                  if (machine.nodeId) onInsertMachine?.(machine.nodeId, machine.displayName);
                  onClose();
                }}
              >
                <span class="qp-machine-item-main">
                  <strong>{machine.displayName}</strong>
                  <code>^^({machine.nodeId ?? MACHINE_IDENTITY_UNAVAILABLE})</code>
                </span>
                <span class={`qp-machine-status ${machine.online ? 'is-online' : 'is-offline'}`}>
                  {machine.online ? t('machine.online') : t('machine.offline')}
                </span>
              </button>
            ))}
          </div>
        )}

        {activeTab === 'verification' && (
          <div class="qp-machine-items" role="listbox" aria-label={t('quick_input.tab_verification')}>
            <div class="qp-alias-hint">{t('quick_input.verification_hint')}</div>
            {verificationLoading && <div class="qp-history-empty">{t('quick_input.loading')}</div>}
            {verificationError && <div class="qp-alias-error" role="alert">{t('quick_input.verification_error')}</div>}
            {!verificationLoading && !verificationError && enabledVerificationMachines.length === 0 && (
              <div class="qp-history-empty">{t('quick_input.verification_empty')}</div>
            )}
            {!verificationLoading && enabledVerificationMachines.map((machine) => (
              <button
                key={machine.id}
                type="button"
                class="qp-machine-item"
                title={machine.target}
                disabled={!onInsertVerificationMachine}
                onClick={() => {
                  if (!onInsertVerificationMachine) return;
                  onInsertVerificationMachine(machine);
                  onClose();
                }}
              >
                <span class="qp-machine-item-main">
                  <strong>{machine.alias}</strong>
                  <code>{machine.target}</code>
                </span>
                <span class={`qp-machine-status is-${machine.lastVerificationStatus}`}>
                  {t(`controlled_nodes.verification.status_${machine.lastVerificationStatus}`)}
                </span>
              </button>
            ))}
            <button
              type="button"
              class="qp-toolbar-btn"
              aria-expanded={verificationPickerOpen}
              onClick={() => setVerificationPickerOpen((current) => !current)}
            >
              ＋ {t('quick_input.verification_add')}
            </button>
            {verificationPickerOpen && <div class="qp-verification-authorize">
              <div class="qp-verification-authorize-header">
                <strong>{t('quick_input.verification_add')}</strong>
                <select
                  aria-label={t('controlled_nodes.verification.scope')}
                  value={verificationScope}
                  onChange={(event) => setVerificationScope(
                    (event.target as HTMLSelectElement).value as VerificationMachineScope,
                  )}
                >
                  {projectKey && (
                    <option value={VERIFICATION_MACHINE_SCOPES.PROJECT}>
                      {t('controlled_nodes.verification.project_scope')}
                    </option>
                  )}
                  <option value={VERIFICATION_MACHINE_SCOPES.USER}>
                    {t('controlled_nodes.verification.user_scope')}
                  </option>
                </select>
              </div>
              <div class="qp-verification-source-tabs" role="tablist" aria-label={t('quick_input.verification_source')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={verificationSourceTab === 'alias'}
                  class={verificationSourceTab === 'alias' ? 'active' : ''}
                  onClick={() => setVerificationSourceTab('alias')}
                >
                  🔖 {t('alias.tab')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={verificationSourceTab === 'controlled_node'}
                  class={verificationSourceTab === 'controlled_node' ? 'active' : ''}
                  onClick={() => setVerificationSourceTab('controlled_node')}
                >
                  🖥 {t('quick_input.tab_machines')}
                </button>
              </div>
              <div class="qp-verification-source-list">
                {verificationSourceTab === 'alias' && allAliases.map((entry) => {
                  if (!isAliasId(entry.id)) return null;
                  const aliasId = entry.id;
                  const busyKey = `${VERIFICATION_MACHINE_KINDS.SSH}:${aliasId}`;
                  return (
                    <button
                      type="button"
                      key={`alias:${aliasId}`}
                      disabled={verificationBusyTarget !== null}
                      onClick={() => { void authorizeVerificationTarget({
                        alias: entry.name,
                        kind: VERIFICATION_MACHINE_KINDS.SSH,
                        target: aliasId,
                      }); }}
                    >
                      🔖 {t('quick_input.verification_authorize_alias', { name: entry.name })}
                      {verificationBusyTarget === busyKey ? '…' : ''}
                    </button>
                  );
                })}
                {verificationSourceTab === 'controlled_node' && machines.filter((machine) => machine.nodeId).map((machine) => {
                  const busyKey = `${VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE}:${machine.nodeId}`;
                  return (
                    <button
                      type="button"
                      key={`node:${machine.nodeId}`}
                      disabled={verificationBusyTarget !== null}
                      onClick={() => { void authorizeVerificationTarget({
                        alias: machine.displayName,
                        kind: VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE,
                        target: machine.nodeId!,
                      }); }}
                    >
                      🖥 {t('quick_input.verification_authorize_node', { name: machine.displayName })}
                      {verificationBusyTarget === busyKey ? '…' : ''}
                    </button>
                  );
                })}
              </div>
            </div>}
          </div>
        )}

        {/* Files tab */}
        {activeTab === 'files' && ws && (
          <FileBrowser
            ws={ws}
            sessionName={sessionName}
            mode="file-multi"
            layout="panel"
            initialPath={sessionCwd ?? '~'}
            alreadyInserted={insertedPaths}
            onConfirm={(paths) => {
              setInsertedPaths((prev) => [...new Set([...prev, ...paths])]);
              const cwd = sessionCwd;
              const rel = cwd
                ? paths.map((p) => '@' + (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p) + ' ')
                : paths.map((p) => '@' + p + ' ');
              onAppendPaths?.(rel);
              onClose();
            }}
          />
        )}

        {/* Alias tab — browse + create/edit/delete user aliases. Selecting one
            inserts its `;;(name)` marker (never the value). */}
        {activeTab === 'alias' && <div class={`qp-alias-panel${aliasForm ? ' is-editing' : ''}`}>
          <div class="qp-add-row qp-alias-search-row">
            <input
              class="qp-add-input"
              value={aliasSearch}
              onInput={(e) => setAliasSearch((e.target as HTMLInputElement).value)}
              placeholder={t('alias.search_placeholder')}
            />
            {aliasSearch && (
              <button
                type="button"
                class="qp-add-cancel qp-search-clear"
                title={t('alias.cancel')}
                onClick={() => setAliasSearch('')}
              >✕</button>
            )}
            <span class="qp-alias-count">{filteredAliases.length}</span>
            <button class="qp-add-confirm" title={t('alias.add')} onClick={openAliasCreate}>＋</button>
          </div>

          <div class="qp-alias-hint">{t('alias.usage_hint')}</div>

          {aliasForm && (
            <div class="qp-alias-form">
              <div class="qp-alias-form-fields">
                <input
                  ref={aliasNameInputRef}
                  class="qp-add-input"
                  value={aliasForm.name}
                  onInput={(e) => setAliasForm((f) => f ? { ...f, name: (e.target as HTMLInputElement).value } : f)}
                  placeholder={t('alias.name_placeholder')}
                />
                <textarea
                  class="qp-add-input qp-alias-value"
                  value={aliasForm.value}
                  onInput={(e) => setAliasForm((f) => f ? { ...f, value: (e.target as HTMLTextAreaElement).value } : f)}
                  placeholder={t('alias.value_placeholder')}
                  rows={3}
                />
                <input
                  class="qp-add-input"
                  value={aliasForm.description}
                  onInput={(e) => setAliasForm((f) => f ? { ...f, description: (e.target as HTMLInputElement).value } : f)}
                  placeholder={t('alias.description_placeholder')}
                />
                <input
                  class="qp-add-input"
                  value={aliasForm.tags}
                  onInput={(e) => setAliasForm((f) => f ? { ...f, tags: (e.target as HTMLInputElement).value } : f)}
                  placeholder={t('alias.tags_placeholder')}
                />
                {aliasErrorText && <div class="qp-alias-error" role="alert">{aliasErrorText}</div>}
              </div>
              <div class="qp-alias-form-actions">
                <button class="qp-toolbar-btn qp-toolbar-btn-primary" disabled={aliasSaving} onClick={() => { void commitAlias(); }}>{t('alias.save')}</button>
                <button class="qp-toolbar-btn" onClick={closeAliasForm}>{t('alias.cancel')}</button>
              </div>
            </div>
          )}

          <div class="qp-list">
            {filteredAliases.length === 0 ? (
              <div class="qp-history-empty">
                {aliasSearch ? t('alias.no_results') : t('alias.empty')}
              </div>
            ) : (
              <div class="qp-alias-items">
                {filteredAliases.map((a) => (
                  <span key={a.name} class="qp-pill qp-pill-custom qp-alias-item" title={a.description || a.name}>
                    <span class="qp-alias-item-row">
                      <span class="qp-pill-text" onClick={() => { onInsertAlias?.(a.name); onClose(); }}>{a.name}</span>
                      <span class="qp-alias-item-meta">
                        <span class="qp-alias-item-value">{a.value}</span>
                        {a.description ? <span class="qp-alias-item-desc">{a.description}</span> : null}
                        {a.tags && a.tags.length > 0 ? (
                          <span class="qp-alias-item-tags">
                            {a.tags.map((tg) => <span key={tg} class="qp-alias-tag">{tg}</span>)}
                          </span>
                        ) : null}
                      </span>
                      <span class="qp-alias-item-actions">
                        <button class="qp-pill-edit" title={t('alias.edit')} onClick={() => openAliasEdit(a.name)}>✎</button>
                        <button class="qp-pill-del" title={t('alias.delete')} onClick={() => { void deleteAliasEntry(a.name); }}>✕</button>
                      </span>
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>}

        {/* Quick tab content */}
        {activeTab === 'quick' && <>
        {/* Toolbar */}
        {addTarget ? (
          <div class="qp-add-row">
            <span class="qp-add-label">{addTarget === 'command' ? t('quick_input.label_command') : t('quick_input.label_phrase')}</span>
            <input
              ref={addInputRef}
              class="qp-add-input"
              value={addValue}
              onInput={(e) => setAddValue((e.target as HTMLInputElement).value)}
              onKeyDown={handleAddKeyDown}
              placeholder={addTarget === 'command' ? '/compact' : t('quick_input.placeholder_phrase')}
            />
            <button class="qp-add-confirm" onClick={commitAdd}>＋</button>
            <button class="qp-add-cancel" onClick={() => { setAddTarget(null); setAddValue(''); }}>✕</button>
          </div>
        ) : (
          <div class="qp-toolbar">
            <button class="qp-toolbar-btn" onClick={() => setAddTarget('command')}>{t('quick_input.add_command')}</button>
            <button class="qp-toolbar-btn" onClick={() => setAddTarget('phrase')}>{t('quick_input.add_phrase')}</button>
            {activeHistory.length > 0 && (
              <button class="qp-toolbar-btn qp-toolbar-btn-danger" onClick={handleClear}>{t('quick_input.clear_history')}</button>
            )}
          </div>
        )}

        <div class="qp-list">
          {!loaded && <div class="qp-empty">{t('quick_input.loading')}</div>}

          {/* Commands — pill wrap */}
          {loaded && (
            <>
              <div class="qp-section-header">
                <span>{t('quick_input.commands')}</span>
                <span class="qp-section-count">{defaultCmds.length + data.commands.length}</span>
              </div>
              <div class="qp-pills">
                {defaultCmds.map((cmd) => (
                  <button key={cmd} class="qp-pill qp-pill-default" onClick={() => handleSend(cmd)}>{cmd}</button>
                ))}
                {data.commands.map((cmd) => (
                  editingItem?.type === 'command' && editingItem.original === cmd ? (
                    <span key={cmd} class="qp-pill qp-pill-editing">
                      <input
                        ref={editInputRef}
                        class="qp-edit-input"
                        value={editValue}
                        onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                      />
                    </span>
                  ) : (
                    <span key={cmd} class="qp-pill qp-pill-custom" title={cmd.length > TRUNCATE_THRESHOLD ? cmd : undefined}>
                      <button type="button" class="qp-pill-text" onClick={() => handleSend(cmd)}>{formatPreviewText(cmd)}</button>
                      <button class="qp-pill-edit" onClick={() => startEdit('command', cmd)}>✎</button>
                      <button class="qp-pill-del" onClick={() => { if (confirm(t('quick_input.confirm_delete'))) onRemoveCommand(cmd); }}>✕</button>
                    </span>
                  )
                ))}
              </div>
            </>
          )}

          {/* Phrases — pill wrap */}
          {loaded && (
            <>
              <div class="qp-section-header">
                <span>{t('quick_input.phrases')}</span>
                <span class="qp-section-count">{DEFAULT_QUICK_PHRASES.length + data.phrases.length}</span>
              </div>
              <div class="qp-pills">
                {DEFAULT_QUICK_PHRASES.map((phrase) => (
                  <button key={phrase} class="qp-pill qp-pill-default" onClick={() => handleSend(phrase)}>{phrase}</button>
                ))}
                {data.phrases.map((phrase) => (
                  editingItem?.type === 'phrase' && editingItem.original === phrase ? (
                    <span key={phrase} class="qp-pill qp-pill-editing">
                      <input
                        ref={editInputRef}
                        class="qp-edit-input"
                        value={editValue}
                        onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                        onKeyDown={handleEditKeyDown}
                        onBlur={commitEdit}
                      />
                    </span>
                  ) : (
                    <span key={phrase} class="qp-pill qp-pill-custom" title={phrase.length > TRUNCATE_THRESHOLD ? phrase : undefined}>
                      <button type="button" class="qp-pill-text" onClick={() => handleSend(phrase)}>{formatPreviewText(phrase)}</button>
                      <button class="qp-pill-edit" onClick={() => startEdit('phrase', phrase)}>✎</button>
                      <button class="qp-pill-del" onClick={() => { if (confirm(t('quick_input.confirm_delete'))) onRemovePhrase(phrase); }}>✕</button>
                    </span>
                  )
                ))}
              </div>
            </>
          )}

          {/* History — scope toggle + search + rows with last-sent timestamp */}
          {loaded && (
            <>
              <div class="qp-section-header qp-history-header">
                <span class="qp-history-title-wrap">
                  <span>{t('quick_input.history')}</span>
                  <span class="qp-section-count">
                    {normalizedHistoryQuery
                      ? `${filteredHistory.length}/${activeHistory.length}`
                      : historyScope === 'session'
                        ? `${activeHistory.length}/${SESSION_HISTORY_MAX}`
                        : `${activeHistory.length}`}
                  </span>
                </span>
                <div class="qp-scope-toggle">
                  <button
                    class={`qp-scope-btn${historyScope === 'session' ? ' active' : ''}`}
                    onClick={() => setHistoryScope('session')}
                  >{t('quick_input.this_session')}</button>
                  <button
                    class={`qp-scope-btn${historyScope === 'global' ? ' active' : ''}`}
                    onClick={() => setHistoryScope('global')}
                  >{t('quick_input.all')}</button>
                </div>
              </div>
              {activeHistory.length > 0 && (
                <div class="qp-history-search-row">
                  <input
                    class="qp-add-input qp-history-search-input"
                    value={historySearch}
                    onInput={(e) => setHistorySearch((e.target as HTMLInputElement).value)}
                    placeholder={t('quick_input.search_history_placeholder')}
                  />
                  {historySearch && (
                    <button
                      type="button"
                      class="qp-add-cancel qp-search-clear"
                      onClick={() => setHistorySearch('')}
                    >✕</button>
                  )}
                </div>
              )}
              {historySlice.length > 0 ? historySlice.map((text, i) => {
                const rawTs = getHistoryTimestamp(data, text, historyScope, sessionName);
                const formattedTs = formatHistoryTimestamp(rawTs);
                return (
                  <div
                    key={`${safeHistoryPage * HISTORY_PAGE_SIZE + i}:${text}`}
                    class="qp-item qp-item-history"
                    onClick={() => handleSelect(text)}
                    title={text.length > 80 ? text : undefined}
                  >
                    <span class="qp-item-text">{formatPreviewText(text, 80)}</span>
                    <span class="qp-item-meta">
                      {formattedTs && (
                        <time
                          class="qp-item-time"
                          dateTime={new Date(rawTs!).toISOString()}
                          title={formattedTs.full}
                        >
                          {formattedTs.short}
                        </time>
                      )}
                      <button
                        type="button"
                        class="qp-item-del"
                        onClick={(e) => { e.stopPropagation(); handleRemoveItem(text); }}
                      >✕</button>
                    </span>
                  </div>
                );
              }) : (
                <div class="qp-history-empty">
                  {normalizedHistoryQuery
                    ? t('quick_input.no_history_matches')
                    : historyScope === 'session'
                      ? t('quick_input.no_history_session')
                      : t('quick_input.no_history')}
                </div>
              )}
            </>
          )}
        </div>

        {/* Pagination */}
        {loaded && totalHistoryPages > 1 && (
          <div class="qp-pagination">
            <button class="qp-page-btn" disabled={safeHistoryPage === 0} onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}>{t('quick_input.newer')}</button>
            <span class="qp-page-info">{safeHistoryPage + 1} / {totalHistoryPages}</span>
            <button class="qp-page-btn" disabled={safeHistoryPage >= totalHistoryPages - 1} onClick={() => setHistoryPage((p) => Math.min(totalHistoryPages - 1, p + 1))}>{t('quick_input.older')}</button>
          </div>
        )}
        </>}
      </div>
    </>
  );

  if (typeof document === 'undefined') return panel;
  return createPortal(panel, portalContainer ?? document.body);
}
