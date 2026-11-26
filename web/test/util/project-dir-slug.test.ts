import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECTS_DIR_PREFIX, sanitizeProjectName } from '@shared/sanitize-project-name.js';
import { buildReadableProjectDir, transliterateProjectDirSlug } from '../../src/util/project-dir-slug.js';

describe('project-dir-slug', () => {
  it('transliterates all 7 supported UI languages into readable ASCII slugs without uXXXX escapes', () => {
    // zh-CN
    expect(transliterateProjectDirSlug('我的项目')).toMatch(/^wo_de_xiang_mu--[0-9a-z]{8}$/);
    // zh-TW
    expect(transliterateProjectDirSlug('我的專案')).toMatch(/^wo_de_zhuan_an--[0-9a-z]{8}$/);
    // ja
    expect(transliterateProjectDirSlug('テストプロジェクト')).toMatch(/^tesutopurojiekuto--[0-9a-z]{8}$/);
    expect(transliterateProjectDirSlug('日本語テスト')).toMatch(/^ri_ben_yu_tesuto--[0-9a-z]{8}$/);
    expect(transliterateProjectDirSlug('東京プロジェクト')).toMatch(/^dong_jing_purojiekuto--[0-9a-z]{8}$/);
    // ko
    expect(transliterateProjectDirSlug('내 프로젝트')).toMatch(/^nae_peu_lo_jeg_teu--[0-9a-z]{8}$/);
    // ru
    expect(transliterateProjectDirSlug('мой проект')).toMatch(/^moy_proekt--[0-9a-z]{8}$/);
    // es (NFKD preserves canonical equality, no suffix needed)
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
    expect(transliterateProjectDirSlug('IM项目v2')).toMatch(/^im_xiang_mu_v2--[0-9a-z]{8}$/);
    expect(transliterateProjectDirSlug('my测试project')).toMatch(/^my_ce_shi_project--[0-9a-z]{8}$/);
    expect(transliterateProjectDirSlug('café')).toBe('cafe');
    expect(transliterateProjectDirSlug('über cool')).toBe('uber_cool');
  });

  it('prevents silent directory collisions across homophones, transliterated vs ASCII, and truncated prefixes', () => {
    // Homophones in Chinese + matching ASCII
    const shi1 = buildReadableProjectDir('市');
    const shi2 = buildReadableProjectDir('是');
    const shiAscii = buildReadableProjectDir('shi');
    expect(shi1).toMatch(/^~\/\.imcodes\/projects\/shi--[0-9a-z]{8}$/);
    expect(shi2).toMatch(/^~\/\.imcodes\/projects\/shi--[0-9a-z]{8}$/);
    expect(shiAscii).toBe('~/.imcodes/projects/shi');
    expect(new Set([shi1, shi2, shiAscii]).size).toBe(3);

    // Chinese vs identical pinyin ASCII
    const zhProject = buildReadableProjectDir('我的项目');
    const pinyinAscii = buildReadableProjectDir('wo_de_xiang_mu');
    expect(zhProject).toMatch(/^~\/\.imcodes\/projects\/wo_de_xiang_mu--[0-9a-z]{8}$/);
    expect(pinyinAscii).toBe('~/.imcodes/projects/wo_de_xiang_mu');
    expect(zhProject).not.toBe(pinyinAscii);

    // Russian / special Latin vs ASCII lookalike
    expect(buildReadableProjectDir('мой')).not.toBe(buildReadableProjectDir('moy'));
    expect(buildReadableProjectDir('ø')).not.toBe(buildReadableProjectDir('o'));

    // Truncated 64-char same-prefix ASCII and CJK names stay distinct and <= 64 chars
    const exact64 = 'a'.repeat(64);
    const longAscii1 = `${'a'.repeat(65)}1`;
    const longAscii2 = `${'a'.repeat(65)}2`;
    expect(transliterateProjectDirSlug(exact64)).toBe(exact64);
    expect(transliterateProjectDirSlug(longAscii1).length).toBeLessThanOrEqual(64);
    expect(transliterateProjectDirSlug(longAscii2).length).toBeLessThanOrEqual(64);
    expect(new Set([
      buildReadableProjectDir(exact64),
      buildReadableProjectDir(longAscii1),
      buildReadableProjectDir(longAscii2),
    ]).size).toBe(3);

    const longCjk1 = `${'项目'.repeat(30)}甲`;
    const longCjk2 = `${'项目'.repeat(30)}乙`;
    expect(transliterateProjectDirSlug(longCjk1).length).toBeLessThanOrEqual(64);
    expect(transliterateProjectDirSlug(longCjk2).length).toBeLessThanOrEqual(64);
    expect(buildReadableProjectDir(longCjk1)).not.toBe(buildReadableProjectDir(longCjk2));

    // Invariant check: distinct sanitizeProjectName IDs map to distinct directories
    const distinctInputs = [
      '市', '是', 'shi', '事', '时',
      '我的项目', 'wo_de_xiang_mu', '我的專案',
      'мой', 'moy', 'ø', 'o',
      '🚀', 'rocket', 'CON', 'con_proj',
      exact64, longAscii1, longAscii2, longCjk1, longCjk2,
    ];
    const seenByCanonicalId = new Map<string, string>();
    const dirs = new Set<string>();
    for (const name of distinctInputs) {
      const id = sanitizeProjectName(name);
      const dir = buildReadableProjectDir(name);
      expect(seenByCanonicalId.has(id)).toBe(false);
      seenByCanonicalId.set(id, dir);
      expect(dirs.has(dir)).toBe(false);
      dirs.add(dir);
    }
  });

  it('returns exact base prefix for empty/whitespace inputs and safe fallback for symbols/emojis', () => {
    expect(buildReadableProjectDir('')).toBe(DEFAULT_PROJECTS_DIR_PREFIX);
    expect(buildReadableProjectDir('   \t\n  ')).toBe(DEFAULT_PROJECTS_DIR_PREFIX);
    expect(buildReadableProjectDir('🚀🔥')).toMatch(/^~\/\.imcodes\/projects\/rocket_fire--[0-9a-z]{8}$/);
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
      expect(slug).toMatch(new RegExp(`^${reserved.toLowerCase()}--[0-9a-z]{8}$`));
      expect(slug).not.toBe(reserved.toLowerCase());
      expect(slug).not.toBe(`${reserved.toLowerCase()}_proj`);
    }
  });

  it('bounds overly long Unicode names cleanly without trailing separators', () => {
    const longCjk = '项目'.repeat(120);
    const slug = transliterateProjectDirSlug(longCjk);
    expect(slug.length).toBeGreaterThan(0);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toMatch(/^[a-z0-9_]+--[0-9a-z]{8}$/);
    expect(slug).not.toMatch(/[_-]+--/);
    expect(slug).not.toMatch(/[_-]$/);
  });

  it('does not modify sanitizeProjectName behavior for internal session IDs', () => {
    expect(sanitizeProjectName('我的项目')).toBe('u6211_u7684_u9879_u76ee');
    expect(buildReadableProjectDir('我的项目')).toMatch(/^~\/\.imcodes\/projects\/wo_de_xiang_mu--[0-9a-z]{8}$/);
  });
});
