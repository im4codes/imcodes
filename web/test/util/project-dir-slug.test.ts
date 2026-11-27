import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECTS_DIR_PREFIX, sanitizeProjectName } from '@shared/sanitize-project-name.js';
import {
  buildReadableProjectDir,
  resolveUniqueProjectDirSlug,
  transliterateProjectDirSlug,
} from '../../src/util/project-dir-slug.js';

describe('project-dir-slug', () => {
  it('transliterates all 7 supported UI languages using underscores only and no random/hash suffix', () => {
    // zh-CN
    expect(transliterateProjectDirSlug('无论')).toBe('wu_lun');
    expect(buildReadableProjectDir('无论')).toBe('~/.imcodes/projects/wu_lun');
    expect(transliterateProjectDirSlug('我的项目')).toBe('wo_de_xiang_mu');
    expect(buildReadableProjectDir('我的项目')).toBe('~/.imcodes/projects/wo_de_xiang_mu');
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
    // en / ASCII (hyphens converted strictly to underscores)
    expect(transliterateProjectDirSlug('my-project')).toBe('my_project');
    expect(buildReadableProjectDir('my-project')).toBe('~/.imcodes/projects/my_project');
    expect(transliterateProjectDirSlug('MyApp')).toBe('myapp');
    expect(transliterateProjectDirSlug('im.codes')).toBe('im_codes');

    for (const sample of ['无论', '我的项目', '我的專案', '日本語テスト', '내 프로젝트', 'мой проект', 'diseño rápido', 'my-project']) {
      const slug = transliterateProjectDirSlug(sample);
      expect(slug).toMatch(/^[a-z0-9_]+$/);
      expect(slug).not.toContain('-');
      expect(slug).not.toMatch(/u[0-9a-f]{4}/);
    }
  });

  it('handles mixed ASCII + CJK names cleanly with underscores only', () => {
    expect(transliterateProjectDirSlug('IM项目v2')).toBe('im_xiang_mu_v2');
    expect(transliterateProjectDirSlug('my测试project')).toBe('my_ce_shi_project');
    expect(transliterateProjectDirSlug('café')).toBe('cafe');
    expect(transliterateProjectDirSlug('über cool')).toBe('uber_cool');
  });

  it('adds incremental _1, _2, _3 suffixes only when target directory exists (case-insensitive)', () => {
    expect(resolveUniqueProjectDirSlug('wu_lun')).toBe('wu_lun');
    expect(resolveUniqueProjectDirSlug('wu_lun', [])).toBe('wu_lun');
    expect(buildReadableProjectDir('无论', ['other_proj'])).toBe('~/.imcodes/projects/wu_lun');

    expect(buildReadableProjectDir('无论', ['wu_lun'])).toBe('~/.imcodes/projects/wu_lun_1');
    expect(buildReadableProjectDir('无论', ['wu_lun', 'wu_lun_1', 'wu_lun_2'])).toBe('~/.imcodes/projects/wu_lun_3');
    // Case-insensitive collision (macOS/Windows)
    expect(buildReadableProjectDir('无论', ['WU_LUN'])).toBe('~/.imcodes/projects/wu_lun_1');
    expect(buildReadableProjectDir('无论', ['Wu_Lun', 'WU_LUN_1'])).toBe('~/.imcodes/projects/wu_lun_2');
  });

  it('bounds overly long names to <= 64 chars cleanly on both base and incremented collisions', () => {
    const exact64 = 'a'.repeat(64);
    expect(transliterateProjectDirSlug(exact64)).toBe(exact64);
    expect(transliterateProjectDirSlug(`${'a'.repeat(65)}1`)).toBe(exact64);

    const incrementedLong = buildReadableProjectDir(exact64, [exact64]);
    expect(incrementedLong).toBe(`~/.imcodes/projects/${'a'.repeat(62)}_1`);
    expect(incrementedLong.slice(DEFAULT_PROJECTS_DIR_PREFIX.length).length).toBeLessThanOrEqual(64);

    // Avoid double underscores when prefix ends with `_` at slice boundary
    const trailingUnderscorePrefix = `${'a'.repeat(61)}_bc`;
    const slugCollision = resolveUniqueProjectDirSlug(trailingUnderscorePrefix, [trailingUnderscorePrefix]);
    expect(slugCollision).toBe(`${'a'.repeat(61)}_1`);
    expect(slugCollision).not.toContain('__');
    expect(slugCollision.length).toBeLessThanOrEqual(64);

    const longCjk = '项目'.repeat(120);
    const cjkSlug = transliterateProjectDirSlug(longCjk);
    expect(cjkSlug.length).toBeGreaterThan(0);
    expect(cjkSlug.length).toBeLessThanOrEqual(64);
    expect(cjkSlug).toMatch(/^[a-z0-9_]+$/);
    expect(cjkSlug).not.toMatch(/_$/);
    expect(cjkSlug).not.toContain('-');
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
      expect(slug).toMatch(/^[a-z0-9_]+$/);
      expect(slug).not.toContain('-');
      expect(slug).not.toContain('..');
      expect(slug).not.toContain('/');
      expect(slug).not.toContain('\\');
    }

    for (const reserved of ['CON', 'prn', 'Aux', 'NUL', 'com1', 'COM9', 'lpt1', 'LPT9']) {
      const lower = reserved.toLowerCase();
      expect(transliterateProjectDirSlug(reserved)).toBe(`${lower}_1`);
      expect(buildReadableProjectDir(reserved, [`${lower}_1`])).toBe(`${DEFAULT_PROJECTS_DIR_PREFIX}${lower}_2`);
      expect(buildReadableProjectDir(reserved, [`${lower}_1`, `${lower}_2`])).toBe(`${DEFAULT_PROJECTS_DIR_PREFIX}${lower}_3`);
    }
  });

  it('does not modify sanitizeProjectName behavior for internal session IDs', () => {
    expect(sanitizeProjectName('我的项目')).toBe('u6211_u7684_u9879_u76ee');
    expect(buildReadableProjectDir('我的项目')).toBe('~/.imcodes/projects/wo_de_xiang_mu');
  });
});
