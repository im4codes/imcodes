/**
 * In-memory bookkeeping for `ask.answer` commands that carry a `commandId`.
 *
 *  - outcomes: the ack each commandId produced, so a bridge redispatch of an
 *    already-processed command re-emits the SAME ack instead of re-delivering
 *    the answer (exactly-once) or leaving the browser waiting.
 *  - answered: which question (toolUseId) already has an accepted/in-flight
 *    answer, so the same card answered from a second device (different
 *    commandId) is refused instead of steering the model twice.
 *
 * Durable cross-restart dedup of the commandId itself is handled by the caller
 * through the session command ledger; this class only needs to cover the live
 * process.
 */

export interface AskAnswerOutcome {
  status: 'accepted' | 'error';
  error?: string;
  extras?: Record<string, unknown>;
}

const MAX_TRACKED = 512;
const PENDING = 'pending' as const;

export type AskAnswerBegin =
  | { state: 'new' }
  | { state: 'pending' }
  | { state: 'done'; outcome: AskAnswerOutcome };

export class AskAnswerLedger {
  private readonly outcomes = new Map<string, AskAnswerOutcome | typeof PENDING>();
  private readonly answered = new Map<string, string>();

  private static questionKey(sessionName: string, toolUseId: string): string {
    return `${sessionName}\u0000${toolUseId}`;
  }

  /**
   * Register a command. `new` means this process has not seen the id; the
   * caller must then `settle` it. `pending` = still being delivered (a bridge
   * redispatch must wait for the ack that is coming); `done` = replay `outcome`.
   */
  begin(commandId: string): AskAnswerBegin {
    const known = this.outcomes.get(commandId);
    if (known === undefined) {
      this.outcomes.set(commandId, PENDING);
      evictOldest(this.outcomes);
      return { state: 'new' };
    }
    return known === PENDING ? { state: 'pending' } : { state: 'done', outcome: known };
  }

  /**
   * Claim the question for this command. Returns false when a DIFFERENT command
   * already holds it (accepted or still being delivered).
   */
  claimQuestion(sessionName: string, toolUseId: string, commandId: string): boolean {
    const key = AskAnswerLedger.questionKey(sessionName, toolUseId);
    const holder = this.answered.get(key);
    if (holder !== undefined && holder !== commandId) return false;
    this.answered.set(key, commandId);
    evictOldest(this.answered);
    return true;
  }

  /** Record the final outcome; a failed delivery releases the question claim. */
  settle(commandId: string, sessionName: string, toolUseId: string | undefined, outcome: AskAnswerOutcome): void {
    this.outcomes.set(commandId, outcome);
    evictOldest(this.outcomes);
    if (outcome.status !== 'accepted' && toolUseId) {
      const key = AskAnswerLedger.questionKey(sessionName, toolUseId);
      if (this.answered.get(key) === commandId) this.answered.delete(key);
    }
  }

  clear(): void {
    this.outcomes.clear();
    this.answered.clear();
  }
}

function evictOldest<V>(map: Map<string, V>): void {
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
