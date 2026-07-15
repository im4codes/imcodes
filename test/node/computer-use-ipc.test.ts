import { describe, expect, it } from 'vitest';
import { computerUseIpcDeadlineMs, quoteWinArg, windowsPipeClientAclCommand } from '../../src/node/computer-use-ipc.js';

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

describe('computer use IPC Windows pipe ACL', () => {
  it('grants the random per-call pipe to authenticated local users', () => {
    expect(windowsPipeClientAclCommand('\\\\.\\pipe\\imcodes-computer-use-123')).toEqual([
      '\\\\.\\pipe\\imcodes-computer-use-123',
      '/grant',
      '*S-1-5-11:F',
    ]);
  });
});

describe('computer use IPC deadline', () => {
  it('keeps the full 900 second shell timeout plus transport cleanup buffer', () => {
    expect(computerUseIpcDeadlineMs({ tool: 'shell_session1', timeoutMs: 900_000 })).toBe(905_000);
    expect(computerUseIpcDeadlineMs({ tool: 'list_apps', timeoutMs: 120_000 })).toBe(125_000);
  });
});
