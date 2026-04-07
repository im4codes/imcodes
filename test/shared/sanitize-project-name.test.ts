import { describe, it, expect } from 'vitest';
import { sanitizeProjectName } from '../../shared/sanitize-project-name.js';

describe('sanitizeProjectName', () => {
  it('passes through simple ASCII names', () => {
    expect(sanitizeProjectName('myproject')).toBe('myproject');
    expect(sanitizeProjectName('MyProject')).toBe('myproject');
    expect(sanitizeProjectName('my_project')).toBe('my_project');
    expect(sanitizeProjectName('v1.0')).toBe('v1_0');
    expect(sanitizeProjectName('abc123def')).toBe('abc123def');
  });

  it('normalizes common ASCII separators', () => {
    expect(sanitizeProjectName('im.codes')).toBe('im_codes');
    expect(sanitizeProjectName('my-project')).toBe('my_project');
    expect(sanitizeProjectName('my project')).toBe('my_project');
    expect(sanitizeProjectName('a---...999b')).toBe('a_999b');
  });

  it('produces deterministic slugs for non-ASCII project names', () => {
    expect(sanitizeProjectName('测试')).toBe('u6d4b_u8bd5');
    expect(sanitizeProjectName('我的项目')).toBe('u6211_u7684_u9879_u76ee');
    expect(sanitizeProjectName('日本語テスト')).toBe('u65e5_u672c_u8a9e_u30c6_u30b9_u30c8');
    expect(sanitizeProjectName('测试')).toBe(sanitizeProjectName('测试'));
  });

  it('handles mixed ASCII and non-ASCII deterministically', () => {
    expect(sanitizeProjectName('my测试project')).toBe('my_u6d4b_u8bd5_project');
    expect(sanitizeProjectName('café')).toBe('cafe');
    expect(sanitizeProjectName('über cool')).toBe('uber_cool');
  });

  it('trims leading and trailing separators', () => {
    expect(sanitizeProjectName('_test_')).toBe('test');
    expect(sanitizeProjectName('-test-')).toBe('test');
    expect(sanitizeProjectName('123test456')).toBe('123test456');
  });

  it('returns a stable fallback for empty input', () => {
    expect(sanitizeProjectName('   ')).toBe('proj');
  });

  it('produces tmux-safe output using only lowercase letters, digits, and underscores', () => {
    const names = ['测试', '我的项目', 'café', 'über cool', '日本語テスト', 'im.codes', 'abc123'];
    for (const name of names) {
      const slug = sanitizeProjectName(name);
      expect(slug).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
