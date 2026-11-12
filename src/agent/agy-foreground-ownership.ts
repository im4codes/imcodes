import { withTimeoutOutcome } from '../util/timeout-outcome.js';
import type { AgyTranscriptRow } from './agy-transcript-bridge.js';

// A failure deadline, NOT a grace period for ordering or content deduplication.
const NATIVE_OUTPUT_DEADLINE_MS = 10_000;
interface Prompt {
  generation: number;
  text?: string;
  inputStep?: number;
  output?: AgyTranscriptRow;
  ready: Promise<void>;
  resolve: () => void;
}

/** Captured outbound RPC -> explicit native input -> native response. ACP
 * parent text has no turn id, so async owners must not guess from body text. */
export class AgyForegroundOwnership {
  authoritative = false;
  private prompts = new Map<number, Prompt>();
  private lane?: number;
  private lastGeneration = 0;
  latest?: { generation: number; row: AgyTranscriptRow };
  constructor(private deadlineMs = NATIVE_OUTPUT_DEADLINE_MS) {}

  register(generation: number, text: string): void {
    let resolve!: () => void;
    const ready = new Promise<void>(r => { resolve = r; });
    this.lastGeneration = Math.max(this.lastGeneration,generation);
    this.prompts.set(generation,{generation,text,ready,resolve});
  }

  observe(row: AgyTranscriptRow): void {
    if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT') {
      // The full native log wraps but retains the exact submitted payload.
      // FIFO unbound requests distinguish repeated identical user messages.
      const prompt = [...this.prompts.values()].find(p => p.inputStep === undefined && p.text && row.content?.includes(p.text));
      this.lane = prompt?.generation;
      if (prompt) { prompt.inputStep = row.step_index; prompt.text = undefined; }
    } else if (row.type === 'SYSTEM_MESSAGE' && /\[Message\].*sender=/.test(row.content ?? '')) {
      this.lane = undefined;
    } else if (row.type === 'PLANNER_RESPONSE' && !row.tool_calls?.length && this.lane !== undefined) {
      const prompt = this.prompts.get(this.lane);
      if (!prompt || prompt.inputStep === undefined || row.step_index <= prompt.inputStep) return;
      prompt.output = row;
      if (!this.latest || prompt.generation >= this.latest.generation) this.latest = {generation:prompt.generation,row};
      this.lane = undefined;
      prompt.resolve();
    }
  }

  async output(generation: number): Promise<AgyTranscriptRow | undefined> {
    const prompt = this.prompts.get(generation);
    if (!prompt) return;
    if (!prompt.output) {
      const result = await withTimeoutOutcome(prompt.ready,this.deadlineMs);
      if (result.timedOut) return;
    }
    return prompt.output;
  }

  hasSuccessor(generation: number): boolean { return this.lastGeneration > generation; }

  release(generation: number): void { this.prompts.delete(generation); }
  clear(): void {
    for (const prompt of this.prompts.values()) prompt.resolve();
    this.prompts.clear(); this.lane = undefined; this.lastGeneration = 0; this.latest = undefined; this.authoritative = false;
  }
}
