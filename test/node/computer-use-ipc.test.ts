import { describe, expect, it } from 'vitest';
import { quoteWinArg } from '../../src/node/computer-use-ipc.js';

describe('computer use IPC Windows argv quoting', () => {
  it('preserves named pipe backslashes for CreateProcessAsUser command lines', () => {
    expect(quoteWinArg('\\\\.\\pipe\\imcodes-computer-use-123')).toBe('"\\\\.\\pipe\\imcodes-computer-use-123"');
  });

  it('escapes embedded quotes without doubling ordinary path separators', () => {
    expect(quoteWinArg('C:\\Program Files\\im "codes"\\node.exe')).toBe('"C:\\Program Files\\im \\"codes\\"\\node.exe"');
  });

  it('doubles trailing backslashes before the closing quote', () => {
    expect(quoteWinArg('C:\\Temp\\')).toBe('"C:\\Temp\\\\"');
  });
});
