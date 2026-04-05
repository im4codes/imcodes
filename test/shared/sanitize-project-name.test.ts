import { describe, it, expect } from 'vitest';
import { sanitizeProjectName } from '../../shared/sanitize-project-name.js';

describe('sanitizeProjectName', () => {
  it('passes through simple ASCII names', () => {
    expect(sanitizeProjectName('myproject')).toBe('myproject');
    expect(sanitizeProjectName('my-project')).toBe('my-project');
    expect(sanitizeProjectName('my_project')).toBe('my_project');
  });

  it('lowercases ASCII', () => {
    expect(sanitizeProjectName('MyProject')).toBe('myproject');
  });

  it('converts spaces to underscores', () => {
    expect(sanitizeProjectName('my project')).toBe('my_project');
  });

  it('converts Chinese characters to hex codepoints', () => {
    const result = sanitizeProjectName('测试');
    expect(result).toBe('6d4b-8bd5');
    // Verify it's deterministic
    expect(sanitizeProjectName('测试')).toBe(result);
  });

  it('handles mixed ASCII and Chinese', () => {
    const result = sanitizeProjectName('my测试project');
    expect(result).toMatch(/^my-?6d4b-8bd5-?project$/);
  });

  it('trims leading/trailing underscores and hyphens', () => {
    expect(sanitizeProjectName('_test_')).toBe('test');
    expect(sanitizeProjectName('-test-')).toBe('test');
  });

  it('generates fallback for empty input', () => {
    const result = sanitizeProjectName('   ');
    expect(result).toMatch(/^proj_/);
  });

  it('collapses consecutive underscores', () => {
    expect(sanitizeProjectName('a  b')).toBe('a_b');
  });

  it('preserves dots', () => {
    expect(sanitizeProjectName('v1.0')).toBe('v1.0');
  });

  it('produces tmux-safe output (no special chars)', () => {
    const names = ['测试', '我的项目', 'café', 'über cool', '日本語テスト'];
    for (const name of names) {
      const slug = sanitizeProjectName(name);
      expect(slug).toMatch(/^[a-z0-9._-]+$/);
    }
  });
});
