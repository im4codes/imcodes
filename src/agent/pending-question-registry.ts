/**
 * Provider-agnostic registry for interactive AskUserQuestion pauses.
 *
 * Different transport SDKs expose a "the model is asking the user something"
 * hook differently (claude-code-sdk: `canUseTool`; others: elicitation/approval
 * callbacks). What they share is the SHAPE of the interaction:
 *
 *   1. The hook is awaited — return a promise to PAUSE the model.
 *   2. The promise resolves when the user answers, or falls back after a wait
 *      window (so the model never hangs forever).
 *   3. The answer is delivered out-of-band (the daemon's `ask.answer` →
 *      `answerPendingQuestion`).
 *
 * This class owns that lifecycle (per session): pending promise, timeout, abort,
 * idempotent settle, and teardown release. The provider only supplies its own
 * result type `R` and the concrete result values (e.g. an SDK PermissionResult).
 *
 * To add interactive questions to a new provider:
 *   private questions = new PendingQuestionRegistry<MyResult>();
 *   // in the ask/permission hook:
 *   return this.questions.wait(sessionId, { timeoutMs, fallback, signal });
 *   // expose the daemon-facing answer entrypoint:
 *   answerPendingQuestion(sessionId, answer) {
 *     return this.questions.resolve(sessionId, mapAnswerToResult(answer));
 *   }
 *   // on session end / disconnect:
 *   this.questions.release(sessionId);   // or releaseAll()
 */

/** Daemon-facing contract a provider implements to receive AskUserQuestion answers. */
export interface InteractiveQuestionAnswerer {
  /**
   * Resolve the session's paused AskUserQuestion with the user's answer so the
   * model continues in the same turn. Returns false when nothing was pending
   * (already answered / timed out / never asked) — the caller then delivers the
   * answer some other way (e.g. as an ordinary message).
   */
  answerPendingQuestion(sessionId: string, answer: string): boolean;
}

interface Entry<R> {
  settle: (result: R) => void;
  timer: ReturnType<typeof setTimeout>;
  fallback: R;
}

export class PendingQuestionRegistry<R> {
  private readonly pending = new Map<string, Entry<R>>();

  /**
   * Pause for an answer. Returns a promise the SDK hook should return/await.
   * Resolves with the answered result (via {@link resolve}), or `fallback` on
   * timeout / abort / teardown.
   */
  wait(sessionId: string, opts: { timeoutMs: number; fallback: R; signal?: AbortSignal }): Promise<R> {
    // Defensively clear any stale pending for this session so its promise can't
    // leak (a session should only have one open question at a time).
    this.release(sessionId);

    return new Promise<R>((resolve) => {
      let settled = false;
      const settle = (result: R) => {
        if (settled) return;
        settled = true;
        const current = this.pending.get(sessionId);
        if (current && current.settle === settle) {
          clearTimeout(current.timer);
          this.pending.delete(sessionId);
        }
        resolve(result);
      };
      const timer = setTimeout(() => settle(opts.fallback), opts.timeoutMs);
      timer.unref?.();
      this.pending.set(sessionId, { settle, timer, fallback: opts.fallback });
      opts.signal?.addEventListener('abort', () => settle(opts.fallback), { once: true });
    });
  }

  /** True if the session currently has a paused question. */
  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** Resolve the session's pending question with a concrete result. */
  resolve(sessionId: string, result: R): boolean {
    const entry = this.pending.get(sessionId);
    if (!entry) return false;
    entry.settle(result);
    return true;
  }

  /** Resolve the session's pending question (if any) with its fallback. */
  release(sessionId: string): void {
    this.pending.get(sessionId)?.settle(this.pending.get(sessionId)!.fallback);
  }

  /** Release every pending question (e.g. on provider disconnect). */
  releaseAll(): void {
    for (const sessionId of [...this.pending.keys()]) this.release(sessionId);
  }
}
