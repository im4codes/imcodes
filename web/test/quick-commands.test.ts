import { describe, expect, it } from 'vitest';
import {
  getDefaultQuickCommands,
  getSlashCommandSuggestions,
  matchSlashCommandTrigger,
} from '../src/quick-commands.js';

describe('slash command suggestions', () => {
  it('opens only for an argument-free slash command at the start of the composer', () => {
    expect(matchSlashCommandTrigger('/')).toBe('');
    expect(matchSlashCommandTrigger('/co')).toBe('co');
    expect(matchSlashCommandTrigger('/fast ')).toBeNull();
    expect(matchSlashCommandTrigger('please /co')).toBeNull();
  });

  it('combines provider defaults and custom commands with prefix filtering and deduplication', () => {
    expect(getSlashCommandSuggestions('codex-sdk', ['/code-review', '/COMPACT', 'not-a-command'], 'co'))
      .toEqual(['/compact', '/code-review']);
  });

  it('offers common controls and the complete Codex Fast commands', () => {
    expect(getDefaultQuickCommands('codex-sdk')).toEqual(expect.arrayContaining([
      '/stop',
      '/compact',
      '/fast on',
      '/fast off',
      '/fast status',
    ]));
  });
});
