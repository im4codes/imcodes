import { describe, it, expect } from 'vitest';
import { projectPathKey } from '../../src/daemon/jsonl-watcher.js';

describe('projectPathKey', () => {
  // Unix paths
  it('converts Unix absolute path', () => {
    expect(projectPathKey('/home/user/project')).toBe('-home-user-project');
  });

  it('strips trailing slash on Unix', () => {
    expect(projectPathKey('/home/user/project/')).toBe('-home-user-project');
  });

  it('handles Unix root', () => {
    expect(projectPathKey('/')).toBe('');
  });

  // Windows paths — these MUST work to match Claude Code's directory naming
  it('converts Windows drive path with backslashes', () => {
    expect(projectPathKey('C:\\Users\\admin\\Desktop')).toBe('C--Users-admin-Desktop');
  });

  it('converts Windows drive path with forward slashes', () => {
    expect(projectPathKey('C:/Users/admin/Desktop')).toBe('C--Users-admin-Desktop');
  });

  it('handles Windows drive root', () => {
    // C:\ → C (literal) + : replaced by - + \ replaced by - = C--
    expect(projectPathKey('C:\\')).toBe('C--');
  });

  it('replaces colons from drive letters', () => {
    expect(projectPathKey('D:\\code\\project')).toBe('D--code-project');
  });

  // Mixed separators (can happen in practice)
  it('handles mixed separators', () => {
    expect(projectPathKey('C:\\Users/admin\\project')).toBe('C--Users-admin-project');
  });

  // Regression: the old regex /[/\\:]/ only matched / and : but NOT backslash
  it('regression: backslash is actually replaced (not just colon)', () => {
    const result = projectPathKey('C:\\Users\\admin');
    expect(result).not.toContain('\\');
    expect(result).toBe('C--Users-admin');
  });
});
