import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECTS_DIR_PREFIX, sanitizeProjectName } from '@shared/sanitize-project-name.js';
import { buildReadableProjectDir, transliterateProjectDirSlug } from '../../src/util/project-dir-slug.js';

describe('project-dir-slug', () => {
  it('transliterates all 7 supported UI languages into readable ASCII slugs without uXXXX escapes', () => {
    // zh-CN
    expect(transliterateProjectDirSlug('我的项目')).toBe('wo_de_xiang_mu');
    // zh-TW
    expect(transliterateProjectDirSlug('我的專案')).toBe('wo_de_zhuan_an');
    // ja
    expect(transliterateProjectDirSlug('テストプロジェクト')).toBe('tesutopurojiekuto');
    expect(transliterateProjectDirSlug('日本語テスト')).toBe('ri_ben_yu_tesuto');
    expect(transliterateProjectDirSlug('東京プロジェクト')).toBe('dong_jing_purojiekuto');
    // ko
    expect(transliterateProjectDirSlug('내 프로젝트')).toBe('nae_peu_lo_jeg_teu');
    // ru
    expect(transliterateProjectDirSlug('мой проект')).toBe('moy_proekt');
    // es
    expect(transliterateProjectDirSlug('diseño rápido')).toBe('diseno_rapido');
    // en / ASCII
    expect(transliterateProjectDirSlug('my-project')).toBe('my-project');
    expect(transliterateProjectDirSlug('MyApp')).toBe('myapp');
    expect(transliterateProjectDirSlug('im.codes')).toBe('im_codes');

    for (const sample of ['我的项目', '我的專案', '日本語テスト', '내 프로젝트', 'мой проект', 'diseño rápido']) {
      expect(transliterateProjectDirSlug(sample)).not.toMatch(/u[0-9a-f]{4}/);
    }
  });

  it('handles mixed ASCII + CJK names without breaking ASCII segments', () => {
    expect(transliterateProjectDirSlug('IM项目v2')).toBe('im_xiang_mu_v2');
    expect(transliterateProjectDirSlug('my测试project')).toBe('my_ce_shi_project');
    expect(transliterateProjectDirSlug('café')).toBe('cafe');
    expect(transliterateProjectDirSlug('über cool')).toBe('uber_cool');
  });

  it('returns exact base prefix for empty/whitespace inputs and safe fallback for symbols/emojis', () => {
    expect(buildReadableProjectDir('')).toBe(DEFAULT_PROJECTS_DIR_PREFIX);
    expect(buildReadableProjectDir('   \t\n  ')).toBe(DEFAULT_PROJECTS_DIR_PREFIX);
    expect(buildReadableProjectDir('🚀🔥')).toBe(`${DEFAULT_PROJECTS_DIR_PREFIX}rocket_fire`);
    expect(buildReadableProjectDir('???')).toBe(`${DEFAULT_PROJECTS_DIR_PREFIX}proj`);
    expect(buildReadableProjectDir('...')).toBe(`${DEFAULT_PROJECTS_DIR_PREFIX}proj`);
  });

  it('neutralizes path traversal, separators, null bytes, and Windows reserved filenames', () => {
    for (const unsafe of ['../../etc/passwd', '../secret', 'foo/bar\\baz', 'a:b*c?d<e>f|g', 'bad\0name']) {
      const dir = buildReadableProjectDir(unsafe);
      expect(dir.startsWith(DEFAULT_PROJECTS_DIR_PREFIX)).toBe(true);
      const slug = dir.slice(DEFAULT_PROJECTS_DIR_PREFIX.length);
      expect(slug).toMatch(/^[a-z0-9_-]+$/);
      expect(slug).not.toContain('..');
      expect(slug).not.toContain('/');
      expect(slug).not.toContain('\\');
    }

    for (const reserved of ['CON', 'prn', 'Aux', 'NUL', 'com1', 'COM9', 'lpt1', 'LPT9']) {
      const slug = transliterateProjectDirSlug(reserved);
      expect(slug).toBe(`${reserved.toLowerCase()}_proj`);
    }
  });

  it('bounds overly long Unicode names cleanly without trailing separators', () => {
    const longCjk = '项目'.repeat(120);
    const slug = transliterateProjectDirSlug(longCjk);
    expect(slug.length).toBeGreaterThan(0);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).not.toMatch(/[_-]$/);
  });

  it('does not modify sanitizeProjectName behavior for internal session IDs', () => {
    expect(sanitizeProjectName('我的项目')).toBe('u6211_u7684_u9879_u76ee');
    expect(buildReadableProjectDir('我的项目')).toBe('~/.imcodes/projects/wo_de_xiang_mu');
  });
});
