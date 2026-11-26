/**
 * `imcodes send --command`: deliver the trimmed text through the daemon hook and
 * nothing else. There is no direct-tmux fallback of any kind here (see
 * SEND_COMMAND_NO_FALLBACK_NOTE): every failure exits non-zero naming its cause.
 */
import {
  SEND_COMMAND_ERRORS,
  SEND_COMMAND_FAILURE_KINDS,
  SEND_COMMAND_HOOK_PATH,
  SEND_COMMAND_HOOK_TIMEOUT_MS,
  sendCommandFailureMessage,
  type SendCommandFailureKind,
} from '../../shared/send-command-mode.js';
import { HookPostError, postToHookServer } from './hook-client.js';
import { printSendResult } from './send-output.js';

export interface RunSendCommandInput {
  /** Live hook port, or falsy when no daemon hook was found. */
  hookPort: number | null | undefined;
  /** Sender identity for the hook body (already resolved by the caller). */
  from: () => Promise<string>;
  message: string;
  all?: boolean;
  type?: string;
  target?: string;
}

function failCommandSend(kind: SendCommandFailureKind, detail?: string): never {
  console.error(`Error: ${sendCommandFailureMessage(kind, detail)}`);
  process.exit(1);
}

/** Send one command. Never returns after a failure and never touches tmux. */
export async function runSendCommand(input: RunSendCommandInput): Promise<void> {
  if (!input.hookPort) failCommandSend(SEND_COMMAND_FAILURE_KINDS.NO_HOOK);
  const to = input.all ? '*' : input.type ?? input.target;
  if (!to) {
    console.error('Error: target is required for a command send.');
    process.exit(1);
  }
  let result: Record<string, unknown>;
  try {
    result = await postToHookServer(input.hookPort, SEND_COMMAND_HOOK_PATH, {
      from: await input.from(),
      to,
      message: input.message,
      depth: 0,
    }, {}, { timeoutMs: SEND_COMMAND_HOOK_TIMEOUT_MS, strictStatus: true });
  } catch (err) {
    // An older daemon has no command path: say so, and never deliver wrapped.
    if (err instanceof HookPostError && err.statusCode === 404) {
      console.error(`Error: ${SEND_COMMAND_ERRORS.UNSUPPORTED_DAEMON}`);
      process.exit(1);
    }
    if (err instanceof HookPostError) failCommandSend(err.kind, err.message);
    failCommandSend(SEND_COMMAND_FAILURE_KINDS.UNREACHABLE, err instanceof Error ? err.message : String(err));
  }
  // Outside the try: printSendResult exits non-zero on an `ok: false` body.
  printSendResult(result);
}
