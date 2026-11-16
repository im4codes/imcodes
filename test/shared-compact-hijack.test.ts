import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPACT_HIJACK_CONTINUATION_PROMPT,
  COMPACT_HIJACK_COOLDOWN_MS,
  COMPACT_HIJACK_GLOBAL_PREF_KEY,
  COMPACT_HIJACK_MODE,
  buildTransportConfigWithCompactHijack,
  encodeCompactHijackGlobalConfigJson,
  extractSessionCompactHijackMode,
  extractSessionHandoffLimits,
  hasCompactHijackField,
  hasInvalidCompactHijackSetting,
  isValidCompactHijackGlobalPrefPayload,
  normalizeCompactHijackGlobalConfig,
  normalizeCompactHijackMode,
  parseCompactHijackGlobalConfigJson,
  resolveCompactHijackEnabled,
  resolveEffectiveHandoffLimits,
  sanitizeShareTransportConfigRow,
  stripCompactHijackFromTransportConfig,
} from '../shared/compact-hijack.js';
import {
  getPersistedCompactHijackGlobalConfig,
  isGlobalCompactHijackEnabled,
  resetCompactHijackConfigStoreForTests,
  setPersistedCompactHijackGlobalConfig,
} from '../src/store/compact-hijack-config-store.js';

describe('shared compact hijack contract', () => {
  it('defines expected constants and exact continuation prompt', () => {
    expect(COMPACT_HIJACK_GLOBAL_PREF_KEY).toBe('compact_hijack.global.v1');
    expect(COMPACT_HIJACK_COOLDOWN_MS).toBe(30_000);
    expect(COMPACT_HIJACK_CONTINUATION_PROMPT).toBe(
      'Continue the unfinished Next Steps from the handoff context. Check running subagents/task pairs and current workspace state first; do not redo completed steps.',
    );
  });

  it('validates and normalizes global preference payloads', () => {
    expect(isValidCompactHijackGlobalPrefPayload({ enabled: true })).toBe(true);
    expect(isValidCompactHijackGlobalPrefPayload({ enabled: false })).toBe(true);
    expect(isValidCompactHijackGlobalPrefPayload(true)).toBe(true);
    expect(isValidCompactHijackGlobalPrefPayload(null)).toBe(true);
    expect(isValidCompactHijackGlobalPrefPayload({ enabled: 'yes' })).toBe(false);
    expect(isValidCompactHijackGlobalPrefPayload('true')).toBe(false);
    expect(isValidCompactHijackGlobalPrefPayload([])).toBe(false);

    expect(normalizeCompactHijackGlobalConfig(undefined)).toEqual({ enabled: false });
    expect(normalizeCompactHijackGlobalConfig(true)).toEqual({ enabled: true });
    expect(normalizeCompactHijackGlobalConfig({ enabled: true })).toEqual({ enabled: true });
    expect(parseCompactHijackGlobalConfigJson(encodeCompactHijackGlobalConfigJson({ enabled: true }))).toEqual({
      enabled: true,
    });
    expect(parseCompactHijackGlobalConfigJson('not-json')).toEqual({ enabled: false });
  });

  it('resolves effective compact hijack state across global default and per-session modes', () => {
    expect(resolveCompactHijackEnabled(COMPACT_HIJACK_MODE.INHERIT, false)).toBe(false);
    expect(resolveCompactHijackEnabled(COMPACT_HIJACK_MODE.INHERIT, true)).toBe(true);
    expect(resolveCompactHijackEnabled(COMPACT_HIJACK_MODE.ON, false)).toBe(true);
    expect(resolveCompactHijackEnabled(COMPACT_HIJACK_MODE.OFF, true)).toBe(false);
    expect(normalizeCompactHijackMode('invalid')).toBe('inherit');
  });

  it('builds, validates, and strips compactHijack in transportConfig without losing sibling keys', () => {
    expect(hasInvalidCompactHijackSetting({ compactHijack: 'bad' })).toBe(true);
    expect(hasInvalidCompactHijackSetting({ compactHijack: 'on' })).toBe(false);
    expect(hasCompactHijackField({ compactHijack: 'off' })).toBe(true);
    expect(hasCompactHijackField({ uiLocale: 'zh-CN' })).toBe(false);

    const updated = buildTransportConfigWithCompactHijack({ uiLocale: 'en', supervision: { mode: 'off' } }, 'on');
    expect(updated).toEqual({ uiLocale: 'en', supervision: { mode: 'off' }, compactHijack: 'on' });
    expect(extractSessionCompactHijackMode(updated)).toBe('on');

    const clearedToInherit = buildTransportConfigWithCompactHijack(updated, 'inherit');
    expect(clearedToInherit).toEqual({ uiLocale: 'en', supervision: { mode: 'off' } });

    expect(buildTransportConfigWithCompactHijack({ compactHijack: 'on' }, 'inherit')).toBeNull();
    expect(stripCompactHijackFromTransportConfig({ compactHijack: 'off', a: 1 })).toEqual({ a: 1 });
    expect(stripCompactHijackFromTransportConfig({ compactHijack: 'off' })).toBeNull();
  });

  it('validates, normalizes, resolves precedence, and sanitizes Handoff limits', () => {
    expect(isValidCompactHijackGlobalPrefPayload({
      enabled: true,
      handoffTextLimit: 0,
      handoffSummaryLimit: 200,
      handoffMaxChars: 500_000,
    })).toBe(true);
    expect(isValidCompactHijackGlobalPrefPayload({ enabled: true, handoffTextLimit: -1 })).toBe(false);
    expect(isValidCompactHijackGlobalPrefPayload({ enabled: true, handoffTextLimit: 201 })).toBe(false);
    expect(isValidCompactHijackGlobalPrefPayload({ enabled: true, handoffSummaryLimit: 1.5 })).toBe(false);
    expect(isValidCompactHijackGlobalPrefPayload({ enabled: true, handoffMaxChars: 499 })).toBe(false);
    expect(isValidCompactHijackGlobalPrefPayload({ enabled: true, handoffMaxChars: 500_001 })).toBe(false);

    expect(resolveEffectiveHandoffLimits(null, null)).toEqual({
      recentTurns: 100,
      summaryLimit: 20,
      maxChars: 128_000,
    });
    expect(resolveEffectiveHandoffLimits(
      { handoffTextLimit: 0, handoffMaxChars: 64_000 },
      { enabled: true, handoffTextLimit: 80, handoffSummaryLimit: 15, handoffMaxChars: 200_000 },
    )).toEqual({
      recentTurns: 0,
      summaryLimit: 15,
      maxChars: 64_000,
    });

    expect(hasCompactHijackField({ handoffTextLimit: 10 })).toBe(true);
    expect(hasCompactHijackField({ handoffSummaryLimit: 0 })).toBe(true);
    expect(hasCompactHijackField({ handoffMaxChars: 500 })).toBe(true);
    expect(hasInvalidCompactHijackSetting({ handoffTextLimit: 201 })).toBe(true);
    expect(hasInvalidCompactHijackSetting({ handoffMaxChars: '5000' })).toBe(true);
    expect(hasInvalidCompactHijackSetting({ handoffSummaryLimit: 0, handoffMaxChars: 500 })).toBe(false);

    const built = buildTransportConfigWithCompactHijack({ uiLocale: 'en' }, 'on', {
      handoffTextLimit: 0,
      handoffSummaryLimit: 12,
      handoffMaxChars: 40_000,
    });
    expect(built).toEqual({
      uiLocale: 'en',
      compactHijack: 'on',
      handoffTextLimit: 0,
      handoffSummaryLimit: 12,
      handoffMaxChars: 40_000,
    });
    expect(extractSessionHandoffLimits(built)).toEqual({
      handoffTextLimit: 0,
      handoffSummaryLimit: 12,
      handoffMaxChars: 40_000,
    });

    const clearedText = buildTransportConfigWithCompactHijack(built, 'on', { handoffTextLimit: null });
    expect(clearedText).toEqual({
      uiLocale: 'en',
      compactHijack: 'on',
      handoffSummaryLimit: 12,
      handoffMaxChars: 40_000,
    });
    expect(stripCompactHijackFromTransportConfig(clearedText)).toEqual({ uiLocale: 'en' });
    expect(sanitizeShareTransportConfigRow({
      id: 's1',
      transport_config: JSON.stringify(built),
    })).toEqual({
      id: 's1',
      transport_config: JSON.stringify({ uiLocale: 'en' }),
    });
  });
});

describe('compact-hijack-config-store', () => {
  let tmpDir: string;
  let configPath: string;
  const prevEnv = process.env.IMCODES_COMPACT_HIJACK_CONFIG_PATH;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'imc-ch-store-'));
    configPath = join(tmpDir, 'compact-hijack-config.json');
    process.env.IMCODES_COMPACT_HIJACK_CONFIG_PATH = configPath;
    resetCompactHijackConfigStoreForTests();
  });

  afterEach(() => {
    resetCompactHijackConfigStoreForTests();
    if (prevEnv === undefined) delete process.env.IMCODES_COMPACT_HIJACK_CONFIG_PATH;
    else process.env.IMCODES_COMPACT_HIJACK_CONFIG_PATH = prevEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to disabled and persists atomically across resets', () => {
    expect(isGlobalCompactHijackEnabled()).toBe(false);
    expect(getPersistedCompactHijackGlobalConfig()).toEqual({ enabled: false });

    setPersistedCompactHijackGlobalConfig({
      enabled: true,
      handoffTextLimit: 50,
      handoffSummaryLimit: 10,
      handoffMaxChars: 90_000,
    });
    expect(isGlobalCompactHijackEnabled()).toBe(true);
    expect(getPersistedCompactHijackGlobalConfig()).toEqual({
      enabled: true,
      handoffTextLimit: 50,
      handoffSummaryLimit: 10,
      handoffMaxChars: 90_000,
    });

    resetCompactHijackConfigStoreForTests();
    expect(getPersistedCompactHijackGlobalConfig()).toEqual({
      enabled: true,
      handoffTextLimit: 50,
      handoffSummaryLimit: 10,
      handoffMaxChars: 90_000,
    });

    setPersistedCompactHijackGlobalConfig({ enabled: false });
    resetCompactHijackConfigStoreForTests();
    expect(isGlobalCompactHijackEnabled()).toBe(false);
    expect(getPersistedCompactHijackGlobalConfig()).toEqual({ enabled: false });
  });

  it('falls back to disabled when persisted file is corrupt JSON', () => {
    writeFileSync(configPath, '{broken-json', 'utf8');
    resetCompactHijackConfigStoreForTests();
    expect(getPersistedCompactHijackGlobalConfig()).toEqual({ enabled: false });
  });
});
