/**
 * @vitest-environment jsdom
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../src/components/TerminalView.js', () => ({
  TerminalView: () => null,
}));

let helpers: typeof import('../src/app.js');

beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  helpers = await import('../src/app.js');
}, 30_000);

describe('app shell pure helpers', () => {
  it('detects text-entry focus targets including nested editor controls', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const editorChild = document.createElement('span');
    editor.appendChild(editorChild);

    expect(helpers.isTextEntryElement(input)).toBe(true);
    expect(helpers.isTextEntryElement(button)).toBe(false);
    expect(helpers.isTextEntryElement(editorChild)).toBe(true);
    expect(helpers.isTextEntryElement(null)).toBe(false);
  });

  it('builds readable toast labels for main and sub sessions', () => {
    expect(helpers.buildSessionToastLabel('deck_alpha_brain', {
      project: 'Alpha',
      agentType: 'codex-sdk',
    })).toBe('Alpha(codex-sdk)');

    expect(helpers.buildSessionToastLabel('deck_sub_worker_1', {
      label: 'Reviewer',
      parentLabel: 'Alpha',
      agentType: 'qwen',
    })).toBe('Reviewer(qwen)@Alpha');

    expect(helpers.buildSessionToastLabel('deck_sub_worker_2', {
      parentLabel: 'Alpha',
      agentType: 'codex-sdk',
    })).toBe('Alpha');
  });

  it('derives stable file preview initial paths', () => {
    expect(helpers.getFilePreviewInitialPath({ path: '/repo/src/app.tsx', rootPath: '/repo' })).toBe('/repo/src');
    expect(helpers.getFilePreviewInitialPath({ path: 'README.md', rootPath: '/repo' })).toBe('/repo');
    expect(helpers.getFilePreviewInitialPath({ path: '/repo/src/app.tsx' })).toBe('/repo/src');
    expect(helpers.getFilePreviewInitialPath({ path: 'C:\\repo\\src\\app.tsx' })).toBe('C:\\repo\\src');
    expect(helpers.getFilePreviewInitialPath({ path: 'README.md' })).toBe('~');
  });

  it('updates daemon version only for the matching server', () => {
    const servers = [
      { id: 'srv-1', name: 'One', daemonVersion: 'old' },
      { id: 'srv-2', name: 'Two', daemonVersion: null },
    ];

    expect(helpers.updateServerDaemonVersion(servers, 'srv-2', '2026.5.11')).toEqual([
      { id: 'srv-1', name: 'One', daemonVersion: 'old' },
      { id: 'srv-2', name: 'Two', daemonVersion: '2026.5.11' },
    ]);
    expect(helpers.updateServerDaemonVersion(servers, 'missing', 'x')).toEqual(servers);
    expect(helpers.updateServerDaemonVersion(servers, 'srv-1', null)).toEqual(servers);
  });
});
