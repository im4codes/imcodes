// Wire contract for answering an interactive AskUserQuestion card
// (`ask.answer`), shared by the daemon, the server bridge and the web.
//
// Legacy browsers send `{ type, sessionName, answer }` fire-and-forget. A
// browser that sees ASK_ANSWER_ACK_CAPABILITY_V1 in the daemon hello adds
// `commandId` (+ `toolUseId`), and the daemon then answers with a reliable
// `command.ack` describing the outcome, so a lost / refused answer is never
// presented to the user as delivered.

export const ASK_ANSWER_COMMAND = 'ask.answer' as const;

/** Daemon advertises it acks `ask.answer` commands that carry a `commandId`. */
export const ASK_ANSWER_ACK_CAPABILITY_V1 = 'ask-answer-ack:v1' as const;

/** `command.ack.error` values for a refused `ask.answer`. */
export const ASK_ANSWER_ACK_ERRORS = {
  EMPTY_ANSWER: 'ask_answer_empty',
  SESSION_NOT_FOUND: 'ask_answer_session_not_found',
  /** The same question (toolUseId) was already answered by another command. */
  ALREADY_ANSWERED: 'ask_answer_already_answered',
  DELIVERY_FAILED: 'ask_answer_delivery_failed',
} as const;

export type AskAnswerAckError = typeof ASK_ANSWER_ACK_ERRORS[keyof typeof ASK_ANSWER_ACK_ERRORS];

/** How an accepted answer reached the model (`command.ack.delivery`). */
export const ASK_ANSWER_DELIVERY = {
  /** Resolved the paused question; the model continues the same turn. */
  IN_PLACE: 'in_place',
  /** Sent to the provider as a new user turn. */
  SENT: 'sent',
  /** Placed at the front of the provider queue; it becomes the next turn. */
  QUEUED: 'queued',
  /** Typed into the terminal of a process (tmux) session. */
  TERMINAL: 'terminal',
} as const;

export type AskAnswerDelivery = typeof ASK_ANSWER_DELIVERY[keyof typeof ASK_ANSWER_DELIVERY];

/**
 * Browser-side wait for the answer's ack before it is reported as unconfirmed.
 * Longer than the bridge's whole redispatch budget (ACK_TIMEOUT_MS ×
 * (ACK_TIMEOUT_RETRY_LIMIT + 1) = 48s) so a slow-but-real ack always wins.
 */
export const ASK_ANSWER_ACK_WAIT_MS = 60_000;
