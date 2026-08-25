import { describe, expect, it } from 'vitest';
import {
  getDefaultQuickCommands,
  getModelCommandSuggestions,
  getQuickPhraseSuggestions,
  getSlashCommandSuggestions,
  matchModelCommandTrigger,
  matchQuickPhraseTrigger,
  matchSlashCommandTrigger,
} from '../src/quick-commands.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';

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

  it('offers CodeBuddy model, compact, and fresh-conversation controls', () => {
    for (const agentType of ['codebuddy-cn', 'codebuddy-international']) {
      expect(getDefaultQuickCommands(agentType)).toEqual(expect.arrayContaining([
        '/stop',
        '/compact',
        '/clear',
        '/model',
      ]));
    }
  });

  it('offers Hermes native steering and queue controls', () => {
    expect(getDefaultQuickCommands(HERMES_AGENT_PROVIDER_ID)).toEqual(expect.arrayContaining([
      '/stop',
      '/compact',
      '/clear',
      '/model',
      '/steer',
      '/queue',
      '/tools',
      '/context',
    ]));
  });
});

describe('quick phrase suggestions', () => {
  it('opens only when a hash is the first composer character', () => {
    expect(matchQuickPhraseTrigger('#')).toBe('');
    expect(matchQuickPhraseTrigger('#err')).toBe('err');
    expect(matchQuickPhraseTrigger('please #err')).toBeNull();
    expect(matchQuickPhraseTrigger(' #err')).toBeNull();
    expect(matchQuickPhraseTrigger('#err\nnext')).toBeNull();
    expect(matchQuickPhraseTrigger('!err')).toBeNull();
  });

  it('combines built-in and custom phrases with case-insensitive filtering and deduplication', () => {
    expect(getQuickPhraseSuggestions(['check errors', 'inspect errors', 'CHECK ERRORS', ''], 'ERR'))
      .toEqual(['check errors', 'inspect errors']);
  });
});

describe('model command suggestions', () => {
  it('opens the second level only for a leading /model command with a space', () => {
    expect(matchModelCommandTrigger('/model ')).toBe('');
    expect(matchModelCommandTrigger('/MODEL gpt')).toBe('gpt');
    expect(matchModelCommandTrigger('text /model ')).toBeNull();
    expect(matchModelCommandTrigger('/model')).toBeNull();
  });

  it('filters the current supported model list without duplicates', () => {
    expect(getModelCommandSuggestions(['gpt-5.4', 'GPT-5.4', 'gpt-5.4-mini'], 'mini'))
      .toEqual(['gpt-5.4-mini']);
  });
});
