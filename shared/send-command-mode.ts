/**
 * Command mode of an inter-agent send (`send_message` MCP tool, `imcodes send`).
 *
 * A command-mode send delivers exactly `message.trim()` to the target and
 * nothing else: no sender line, recent-context tail, referenced files, reply
 * instruction, delegation/reply authority, implicit task pair or per-turn
 * memory/identity enrichment. It is the explicit form of what an
 * auto-detected session control command (/clear, /compact, /model) already gets.
 */

/** Field name on the MCP tool arguments and on the hook `/send-command` body. */
export const SEND_COMMAND_FIELD = 'command' as const;

/**
 * Published parameter description (MCP zod + JSON schema, kept short: the tool
 * surface is byte-budgeted). Wording is the contract agents read.
 */
export const SEND_COMMAND_DESCRIPTION = 'Deliver exactly message.trim(): no sender, context, files, reply or task; /stop stops the target.' as const;

/** `imcodes send` flag that selects command mode. */
export const SEND_COMMAND_CLI_FLAG = '--command' as const;

/**
 * Dedicated daemon hook path. A separate path (not a flag on `/send`) so an OLDER
 * daemon, which does not know command mode, answers 404 and the sender fails
 * closed instead of silently delivering the message wrapped with sender/reply
 * lines. Never add a code path that falls back to `/send` for a command.
 */
export const SEND_COMMAND_HOOK_PATH = '/send-command' as const;

export const SEND_COMMAND_ERRORS = {
  EMPTY: 'command requires a non-empty message',
  WITH_REPLY: 'command cannot be combined with reply: a command is delivered as-is and no reply channel is created',
  WITH_FILES: 'command cannot be combined with files: a command is delivered as-is with no file references',
  WITH_METADATA: 'command cannot be combined with task, audit, identity, clone or autoProvision metadata',
  UNSUPPORTED_DAEMON: 'the running daemon does not support command mode (upgrade the daemon); the message was NOT sent',
} as const;

export interface SendCommandModeRequest {
  message?: unknown;
  reply?: unknown;
  files?: unknown;
  /** Any of task/audit/identity/clone supplied alongside the command. */
  hasSendMetadata?: boolean;
}

/**
 * The one validator for a command-mode request, shared by the MCP tool, the
 * daemon hook and the CLI so the three ingresses can never disagree. Returns an
 * error message, or null when the combination is valid.
 *
 * Broadcast is deliberately allowed: command mode creates no per-target state
 * (no reply authority, no delegation record, no task pair), so fan-out to the
 * discoverable siblings stays bounded by the same recipient cap as any
 * broadcast and every target receives the identical raw text.
 */
export function validateSendCommandRequest(request: SendCommandModeRequest): string | null {
  if (typeof request.message !== 'string' || request.message.trim().length === 0) return SEND_COMMAND_ERRORS.EMPTY;
  if (request.reply === true) return SEND_COMMAND_ERRORS.WITH_REPLY;
  if (Array.isArray(request.files) && request.files.length > 0) return SEND_COMMAND_ERRORS.WITH_FILES;
  if (request.hasSendMetadata === true) return SEND_COMMAND_ERRORS.WITH_METADATA;
  return null;
}

/** The exact text a command-mode send delivers. */
export function sendCommandText(message: string): string {
  return message.trim();
}
