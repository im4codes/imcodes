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
  hasCompactHijackField,
  hasInvalidCompactHijackSetting,
  isValidCompactHijackGlobalPrefPayload,
  normalizeCompactHijackGlobalConfig,
  normalizeCompactHijackMode,
  parseCompactHijackGlobalConfigJson,
  resolveCompactHijackEnabled,
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

    setPersistedCompactHijackGlobalConfig({ enabled: true });
    expect(isGlobalCompactHijackEnabled()).toBe(true);

    resetCompactHijackConfigStoreForTests();
    expect(isGlobalCompactHijackEnabled()).toBe(true);

    setPersistedCompactHijackGlobalConfig({ enabled: false });
    resetCompactHijackConfigStoreForTests();
    expect(isGlobalCompactHijackEnabled()).toBe(false);
  });

  it('falls back to disabled when persisted file is corrupt JSON', () => {
    writeFileSync(configPath, '{broken-json', 'utf8');
    resetCompactHijackConfigStoreForTests();
    expect(getPersistedCompactHijackGlobalConfig()).toEqual({ enabled: false });
  });
});
