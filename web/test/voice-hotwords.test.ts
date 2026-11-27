/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import es from '../src/i18n/locales/es.json';
import ru from '../src/i18n/locales/ru.json';
import {
  getCompiledVoiceHotwordsForProject,
  getGlobalVoiceHotwordsRaw,
  getProjectVoiceHotwordsRaw,
  getShareHotwordsWithOthers,
  resolveRemoteVoiceHotwordsForProvider,
  setActiveVoiceHotwordProject,
  setGlobalVoiceHotwordsRaw,
  setProjectVoiceHotwordsRaw,
  setShareHotwordsWithOthers,
  shouldSendRemoteVoiceHotwords,
} from '../src/voice-hotwords.js';
import { VoiceHotwordsSection } from '../src/components/VoiceHotwordsSection.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts.project === 'string') return `${key}(${opts.project})`;
      if (opts && opts.count !== undefined && opts.max !== undefined) return `${opts.count}/${opts.max}`;
      return key;
    },
  }),
}));

describe('web voice hotwords store, privacy gate, UI, and i18n parity', () => {
  beforeEach(() => {
    localStorage.clear();
    setActiveVoiceHotwordProject(null);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    setActiveVoiceHotwordProject(null);
  });

  it('isolates hotwords per project, merges with global (project priority), and gates cross-account sharing by default', () => {
    setGlobalVoiceHotwordsRaw('Antigravity\nai ma => GlobalTarget');
    setProjectVoiceHotwordsRaw('proj-a', 'IM.codes\nworktree\nai ma => IM.codes');
    setProjectVoiceHotwordsRaw('proj-b', 'codex-sdk');

    const compiledA = getCompiledVoiceHotwordsForProject('proj-a');
    expect(compiledA.terms).toEqual(['IM.codes', 'worktree', 'Antigravity']);
    expect(compiledA.replacements).toEqual([{ from: 'ai ma', to: 'IM.codes' }]);

    const compiledB = getCompiledVoiceHotwordsForProject('proj-b');
    expect(compiledB.terms).toEqual(['codex-sdk', 'Antigravity', 'GlobalTarget']);
    expect(compiledB.replacements).toEqual([{ from: 'ai ma', to: 'GlobalTarget' }]);

    // Privacy default: false for others' shared devices, always true for own PC App & server HTTP ASR
    expect(getShareHotwordsWithOthers()).toBe(false);
    expect(shouldSendRemoteVoiceHotwords({ providerKind: 'http_asr', isOwnDevice: false })).toBe(true);
    expect(shouldSendRemoteVoiceHotwords({ providerKind: 'pc_app', isOwnDevice: true })).toBe(true);
    expect(shouldSendRemoteVoiceHotwords({ providerKind: 'pc_app', isOwnDevice: false })).toBe(false);
    expect(resolveRemoteVoiceHotwordsForProvider({ providerKind: 'pc_app', isOwnDevice: false }, compiledA)).toBeUndefined();
    expect(resolveRemoteVoiceHotwordsForProvider({ providerKind: 'pc_app', isOwnDevice: true }, compiledA)).toEqual(['IM.codes', 'worktree', 'Antigravity']);
    expect(resolveRemoteVoiceHotwordsForProvider({ providerKind: 'http_asr', isOwnDevice: false }, compiledA)).toEqual(['IM.codes', 'worktree', 'Antigravity']);

    setShareHotwordsWithOthers(true);
    expect(getShareHotwordsWithOthers()).toBe(true);
    expect(resolveRemoteVoiceHotwordsForProvider({ providerKind: 'pc_app', isOwnDevice: false }, compiledA)).toEqual(['IM.codes', 'worktree', 'Antigravity']);
  });

  it('renders VoiceHotwordsSection, persists project/global edits and share toggle, and switches projects', async () => {
    setProjectVoiceHotwordsRaw('other-proj', 'OtherWord');
    render(h(VoiceHotwordsSection, { currentProjectName: 'my-proj' }));

    const projectInput = screen.getByTestId('voice-hotwords-project-input') as HTMLTextAreaElement;
    const globalInput = screen.getByTestId('voice-hotwords-global-input') as HTMLTextAreaElement;
    const toggle = screen.getByTestId('voice-hotwords-share-toggle');

    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.input(projectInput, { target: { value: 'IM.codes\nworktree' } });
    fireEvent.input(globalInput, { target: { value: 'Antigravity' } });
    fireEvent.click(toggle);

    expect(getProjectVoiceHotwordsRaw('my-proj')).toBe('IM.codes\nworktree');
    expect(getGlobalVoiceHotwordsRaw()).toBe('Antigravity');
    expect(getShareHotwordsWithOthers()).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    const select = screen.getByTestId('voice-hotwords-project-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'other-proj' } });
    await waitFor(() => {
      expect((screen.getByTestId('voice-hotwords-project-input') as HTMLTextAreaElement).value).toBe('OtherWord');
    });
  });

  it('includes all voice hotword translation keys across all 7 supported locales', () => {
    const requiredKeys = [
      'voice_hotwords_title',
      'voice_hotwords_desc',
      'voice_hotwords_project_label',
      'voice_hotwords_project_empty_title',
      'voice_hotwords_project_select',
      'voice_hotwords_project_placeholder',
      'voice_hotwords_no_project',
      'voice_hotwords_global_label',
      'voice_hotwords_global_placeholder',
      'voice_hotwords_hint',
      'voice_hotwords_count',
      'voice_hotwords_share_toggle',
      'voice_hotwords_share_desc',
    ] as const;

    const locales = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, es, ru } as const;
    for (const [locale, dict] of Object.entries(locales)) {
      const settings = (dict as { settings: Record<string, unknown> }).settings;
      for (const key of requiredKeys) {
        expect(typeof settings[key], `${locale}.settings.${key}`).toBe('string');
        expect(String(settings[key]).trim().length, `${locale}.settings.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
