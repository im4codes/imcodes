// Timing contract for the interactive AskUserQuestion flow, shared by the
// daemon (provider wait + relay payload) and the web (countdown + retention).
//
// Flow:
//   - The model PAUSES (via the SDK canUseTool callback) for up to
//     ASK_QUESTION_WAIT_MS waiting for the user to answer. Answering within this
//     window steers the model in the SAME turn.
//   - If unanswered, the model self-continues (canUseTool falls back to allow).
//     The question card is then RETAINED for ASK_QUESTION_RETENTION_MS more so
//     the user can still force-interrupt the model with a different choice.

/** How long the model pauses for an answer before self-continuing. */
export const ASK_QUESTION_WAIT_MS = 60_000;

/** How long the card lingers AFTER the wait elapses (force-interrupt window). */
export const ASK_QUESTION_RETENTION_MS = 120_000;
