/**
 * Parse chat text into typed ChatCommand objects.
 * Commands arrive as slash commands (/start, /stop, ...) or plain text.
 */

export type CommandName =
  | 'start'
  | 'stop'
  | 'send'
  | 'status'
  | 'list'
  | 'screen'
  | 'bind'
  | 'register'
  | 'cron'
  | 'team'
  | 'help'
  | 'autofix';

export interface ChatCommand {
  name: CommandName;
  args: string[];
  /** Full raw text after the command name */
  rawArgs: string;
  /** Original input */
  raw: string;
}

export interface ParseResult {
  isCommand: boolean;
  command?: ChatCommand;
  /** Plain text content if not a command */
  text?: string;
}

const KNOWN_COMMANDS = new Set<CommandName>([
  'start', 'stop', 'send', 'status', 'list', 'screen',
  'bind', 'register', 'cron', 'team', 'help', 'autofix',
]);

/**
 * Parse a chat message. Returns a ParseResult.
 *
 * Supported formats:
 *   /command arg1 arg2
 *   /command@botname arg1 arg2  (Telegram style)
 */
export function parseCommand(text: string): ParseResult {
  const trimmed = text.trim();

  if (!trimmed.startsWith('/')) {
    return { isCommand: false, text: trimmed };
  }

  // Strip leading slash, optional @botname suffix
  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const cmdPart = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);

  // Handle @botname suffix (Telegram)
  const atIdx = cmdPart.indexOf('@');
  const cmdName = (atIdx === -1 ? cmdPart : cmdPart.slice(0, atIdx)).toLowerCase() as CommandName;

  if (!KNOWN_COMMANDS.has(cmdName)) {
    return { isCommand: false, text: trimmed };
  }

  const rawArgs = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx).trim();
  const args = rawArgs ? rawArgs.split(/\s+/) : [];

  return {
    isCommand: true,
    command: {
      name: cmdName,
      args,
      rawArgs,
      raw: trimmed,
    },
  };
}

/**
 * Parse when platform already identified it as a command (isCommand=true from InboundMessage).
 * Constructs a ChatCommand from pre-parsed command name and args.
 */
export function fromPlatformCommand(
  commandName: string,
  args: string[],
  rawText: string,
): ParseResult {
  const name = commandName.toLowerCase() as CommandName;
  if (!KNOWN_COMMANDS.has(name)) {
    return { isCommand: false, text: rawText };
  }

  return {
    isCommand: true,
    command: {
      name,
      args,
      rawArgs: args.join(' '),
      raw: rawText,
    },
  };
}
