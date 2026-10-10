import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';
import {
  PANEL_LOAD_ERROR_KINDS,
  PANEL_LOAD_SECTIONS,
  PANEL_LOAD_SECTION_TABS,
  classifyPanelLoadError,
  panelLoadErrorKey,
  panelLoadSectionKey,
} from '../src/shared-context-load-errors.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
const apiError = (status: number) => Object.assign(new Error(`API ${status}: x`), { status });

describe('classifyPanelLoadError', () => {
  it('classifies by HTTP status, the way a user can act on it', () => {
    expect(classifyPanelLoadError(apiError(404))).toMatchObject({ kind: PANEL_LOAD_ERROR_KINDS.NOT_FOUND, status: 404 });
    expect(classifyPanelLoadError(apiError(403)).kind).toBe(PANEL_LOAD_ERROR_KINDS.FORBIDDEN);
    expect(classifyPanelLoadError(apiError(401)).kind).toBe(PANEL_LOAD_ERROR_KINDS.UNAUTHORIZED);
    expect(classifyPanelLoadError(apiError(502)).kind).toBe(PANEL_LOAD_ERROR_KINDS.UNAVAILABLE);
    expect(classifyPanelLoadError(apiError(400)).kind).toBe(PANEL_LOAD_ERROR_KINDS.OTHER);
  });
  it('a rejected fetch (no status) is a network failure; anything else keeps its message', () => {
    expect(classifyPanelLoadError(new TypeError('Failed to fetch')).kind).toBe(PANEL_LOAD_ERROR_KINDS.NETWORK);
    expect(classifyPanelLoadError(new Error('boom'))).toMatchObject({ kind: PANEL_LOAD_ERROR_KINDS.OTHER, detail: 'boom', status: null });
    expect(classifyPanelLoadError('plain')).toMatchObject({ kind: PANEL_LOAD_ERROR_KINDS.OTHER, detail: 'plain' });
  });
  it('every section is assigned to at least one tab', () => {
    for (const section of Object.values(PANEL_LOAD_SECTIONS)) expect(PANEL_LOAD_SECTION_TABS[section].length).toBeGreaterThan(0);
  });
});

describe('load error translations', () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale} translates every section and error kind`, () => {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'));
      const lookup = (key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
      const keys = [
        ...Object.values(PANEL_LOAD_SECTIONS).map(panelLoadSectionKey),
        ...Object.values(PANEL_LOAD_ERROR_KINDS).map(panelLoadErrorKey),
      ];
      expect(keys.filter((key) => typeof lookup(key) !== 'string' || (lookup(key) as string).trim() === '')).toEqual([]);
    });
  }
});
