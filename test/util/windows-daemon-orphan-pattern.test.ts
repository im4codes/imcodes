import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_LIKE_PATTERN } from '../../src/util/windows-daemon.js';

/** PowerShell `-like`: `*` and `?` are wildcards, backslash is a literal character. */
function powershellLike(value: string, pattern: string): boolean {
  const regex = pattern
    .split('')
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${regex}$`, 'i').test(value);
}

describe('orphan daemon PowerShell filter', () => {
  it('matches a real Windows daemon command line (single backslashes)', () => {
    const commandLine = '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js start --foreground';
    expect(powershellLike(commandLine, DAEMON_PROCESS_LIKE_PATTERN)).toBe(true);
  });

  it('never needs doubled backslashes', () => {
    // A doubled pattern only matches command lines that literally contain `\\`,
    // which real process command lines never do.
    expect(DAEMON_PROCESS_LIKE_PATTERN).not.toContain('\\\\');
  });

  it('does not match unrelated node processes', () => {
    expect(powershellLike('node C:\\work\\app\\server.js', DAEMON_PROCESS_LIKE_PATTERN)).toBe(false);
  });
});
