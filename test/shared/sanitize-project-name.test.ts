import { describe, it, expect } from 'vitest';
import { sanitizeProjectName } from '../../shared/sanitize-project-name.js';

describe('sanitizeProjectName', () => {
  it('passes through simple ASCII letter names', () => {
    expect(sanitizeProjectName('myproject')).toBe('myproject');
    expect(sanitizeProjectName('MyProject')).toBe('myproject');
    expect(sanitizeProjectName('my_project')).toBe('my_project');
  });

  it('replaces dots, hyphens, spaces, and digits with underscores', () => {
    expect(sanitizeProjectName('im.codes')).toBe('im_codes');
    expect(sanitizeProjectName('my-project')).toBe('my_project');
    expect(sanitizeProjectName('my project')).toBe('my_project');
    expect(sanitizeProjectName('v1.0')).toBe('v');
    expect(sanitizeProjectName('abc123def')).toBe('abc_def');
  });

  it('falls back to a generated slug when input has no letters', () => {
    const result = sanitizeProjectName('测试');
    expect(result).toMatch(/^proj_[a-z]+$/);
    expect(sanitizeProjectName('测试')).not.toBe('');
  });

  it('handles mixed ASCII and non-ASCII by normalizing separators', () => {
    expect(sanitizeProjectName('my测试project')).toBe('my_project');
    expect(sanitizeProjectName('café')).toBe('caf');
  });

  it('trims leading and trailing underscores', () => {
    expect(sanitizeProjectName('_test_')).toBe('test');
    expect(sanitizeProjectName('-test-')).toBe('test');
    expect(sanitizeProjectName('123test456')).toBe('test');
  });

  it('collapses repeated separators into one underscore', () => {
    expect(sanitizeProjectName('a  b')).toBe('a_b');
    expect(sanitizeProjectName('a---...999b')).toBe('a_b');
  });

  it('generates fallback for empty input', () => {
    const result = sanitizeProjectName('   ');
    expect(result).toMatch(/^proj_[a-z]+$/);
  });

  it('produces strictly tmux-safe output using only lowercase letters and underscores', () => {
    const names = ['测试', '我的项目', 'café', 'über cool', '日本語テスト', 'im.codes', 'abc123'];
    for (const name of names) {
      const slug = sanitizeProjectName(name);
      expect(slug).toMatch(/^[a-z_]+$/);
    }
  });
});
