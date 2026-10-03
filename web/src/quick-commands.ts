import {
  SESSION_CLEAR_COMMAND,
  SESSION_COMPACT_COMMAND,
  SESSION_MODEL_COMMAND,
  SESSION_STOP_COMMAND,
} from '@shared/session-control-commands.js';
import {
  CODEX_FAST_OFF_COMMAND,
  CODEX_FAST_ON_COMMAND,
  CODEX_FAST_STATUS_COMMAND,
} from '@shared/codex-service-tier.js';
import { CODEBUDDY_PROVIDER_IDS } from '@shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '@shared/hermes-agent.js';

const DEFAULT_QUICK_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  'claude-code': [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, '/usage', '/cost', '/status', '/help'],
  'claude-code-sdk': [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND, '/thinking'],
  'copilot-sdk': [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND, '/thinking'],
  codex: [SESSION_COMPACT_COMMAND, '/help', SESSION_MODEL_COMMAND, '/approval', SESSION_CLEAR_COMMAND],
  'codex-sdk': [
    SESSION_COMPACT_COMMAND,
    SESSION_CLEAR_COMMAND,
    SESSION_MODEL_COMMAND,
    '/thinking',
    CODEX_FAST_ON_COMMAND,
    CODEX_FAST_OFF_COMMAND,
    CODEX_FAST_STATUS_COMMAND,
  ],
  'cursor-headless': [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND],
  'opencode-sdk': [SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND],
  opencode: [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND, '/help'],
  qwen: [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND, '/thinking'],
  'grok-sdk': [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND],
  'kimi-sdk': [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND],
  [HERMES_AGENT_PROVIDER_ID]: [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND, '/steer', '/queue', '/tools', '/context'],
  'deepseek-harness': [SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND],
  pi: [SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND, '/thinking'],
  [CODEBUDDY_PROVIDER_IDS.CHINA]: [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND],
  [CODEBUDDY_PROVIDER_IDS.INTERNATIONAL]: [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, SESSION_MODEL_COMMAND],
  openclaw: [SESSION_COMPACT_COMMAND, SESSION_CLEAR_COMMAND, '/thinking'],
};

export const DEFAULT_QUICK_PHRASES = [
  'continue',
  'fix',
  'explain',
  'refactor this',
  'write tests',
  'check errors',
  'pull',
  'commit&push',
  'CI failed, fix',
  'test & push',
  'yes',
] as const;

function uniqueCommands(commands: readonly string[]): string[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = command.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getDefaultQuickCommands(agentType: string): string[] {
  const providerCommands = DEFAULT_QUICK_COMMANDS[agentType] ?? DEFAULT_QUICK_COMMANDS['claude-code'] ?? [];
  return uniqueCommands([SESSION_STOP_COMMAND, ...providerCommands]);
}

/**
 * Match a slash command being typed as the entire composer value. Arguments
 * close the picker; commands that include arguments (for example `/fast on`)
 * are selected from the candidate list as one complete value.
 */
export function matchSlashCommandTrigger(text: string): string | null {
  const match = /^\/([^\s/]*)$/u.exec(text);
  return match ? match[1] : null;
}

/** Match a quick phrase query only when `#` is the first composer character. */
export function matchQuickPhraseTrigger(text: string): string | null {
  const match = /^#([^\r\n]*)$/u.exec(text);
  if (!match) return null;
  const query = match[1];
  // Composer attachments use `#<sequence>:(<path>)`. A colon-bearing partial
  // or complete attachment reference is data, not a quick-phrase trigger.
  if (/^\d+:/u.test(query)) return null;
  return query;
}

/** Match the second level of `/model`, including its initial trailing space. */
export function matchModelCommandTrigger(text: string): string | null {
  const match = /^\/model\s+([^\r\n]*)$/iu.exec(text);
  return match ? match[1] : null;
}

export function getSlashCommandSuggestions(
  agentType: string,
  customCommands: readonly string[],
  query: string,
): string[] {
  const prefix = `/${query}`.toLocaleLowerCase();
  return uniqueCommands([...getDefaultQuickCommands(agentType), ...customCommands])
    .filter((command) => command.startsWith('/') && !/[\r\n]/u.test(command))
    .filter((command) => command.toLocaleLowerCase().startsWith(prefix));
}

export function getQuickPhraseSuggestions(
  customPhrases: readonly string[],
  query: string,
): string[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return uniqueCommands([...DEFAULT_QUICK_PHRASES, ...customPhrases])
    .filter((phrase) => phrase.length > 0 && !/[\r\n]/u.test(phrase))
    .filter((phrase) => phrase.toLocaleLowerCase().includes(normalizedQuery));
}

export function getModelCommandSuggestions(models: readonly string[], query: string): string[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return uniqueCommands(models)
    .filter((model) => model.length > 0 && !/[\r\n]/u.test(model))
    .filter((model) => model.toLocaleLowerCase().includes(normalizedQuery));
}
