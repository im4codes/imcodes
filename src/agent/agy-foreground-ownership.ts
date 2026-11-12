import { withTimeoutOutcome } from '../util/timeout-outcome.js';
import type { AgyTranscriptRow } from './agy-transcript-bridge.js';

// A failure deadline, NOT a grace period for ordering or content deduplication.
export const NATIVE_OUTPUT_DEADLINE_MS = 60_000;
const PREFIX_MIN_LENGTH = 80;
const PREFIX_PROBE_LENGTH = 160;

interface Prompt {
  generation: number;
  text?: string;
  inputStep?: number;
  output?: AgyTranscriptRow;
  ready: Promise<void>;
  resolve: () => void;
}

function extractUserRequestBody(text: string): string {
  const match = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/i.exec(text);
  return match ? match[1]! : text;
}

function normalizePromptText(text: string): string {
  return extractUserRequestBody(text)
    .replace(/<\/?USER_REQUEST>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:\s*\.{3,}|\s*…|\s*\[truncated\])+$/i, '')
    .trim();
}

function matchesTruncatedPrefix(normRow: string, normPrompt: string): boolean {
  if (normPrompt.length < PREFIX_MIN_LENGTH || normRow.length < PREFIX_MIN_LENGTH) return false;
  const probeLen = Math.min(PREFIX_PROBE_LENGTH, normPrompt.length, normRow.length);
  if (probeLen < PREFIX_MIN_LENGTH) return false;
  const probe = normPrompt.slice(0, probeLen);
  const idx = normRow.indexOf(probe);
  if (idx < 0) return false;
  return normPrompt.startsWith(normRow.slice(idx));
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

  hasActiveLane(): boolean {
    if (this.lane === undefined) return false;
    const prompt = this.prompts.get(this.lane);
    return Boolean(prompt && prompt.inputStep !== undefined && !prompt.output);
  }

  private findMatchingPrompt(content: string | undefined): Prompt | undefined {
    if (!content) return undefined;
    const unbound = [...this.prompts.values()].filter(p => p.inputStep === undefined && p.text);
    if (unbound.length === 0) return undefined;

    const exact = unbound.find(p => content.includes(p.text!));
    if (exact) return exact;

    const normRow = normalizePromptText(content);
    const rawNormRow = content.replace(/\s+/g, ' ').trim();
    if (!normRow) return undefined;

    const normFull = unbound.find(p => {
      const np = normalizePromptText(p.text!);
      return np.length > 0 && (normRow.includes(np) || rawNormRow.includes(np));
    });
    if (normFull) return normFull;

    const prefixMatches = unbound.filter(p => matchesTruncatedPrefix(normRow, normalizePromptText(p.text!)));
    if (prefixMatches.length === 1) return prefixMatches[0];
    if (prefixMatches.length > 1) {
      const distinct = new Set(prefixMatches.map(p => normalizePromptText(p.text!)));
      if (distinct.size === 1) return prefixMatches[0];
      return undefined;
    }

    if (unbound.length === 1 && /<USER_REQUEST>/i.test(content)) {
      const np = normalizePromptText(unbound[0]!.text!);
      if (normRow.length >= 16 && np.endsWith(normRow)) return unbound[0];
    }
    return undefined;
  }

  observe(row: AgyTranscriptRow): boolean {
    if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT') {
      // The full native log wraps but retains the exact submitted payload.
      // FIFO unbound requests distinguish repeated identical user messages.
      const prompt = this.findMatchingPrompt(row.content);
      this.lane = prompt?.generation;
      if (prompt) { prompt.inputStep = row.step_index; prompt.text = undefined; }
      return false;
    } else if (row.type === 'SYSTEM_MESSAGE' && /\[Message\].*sender=/.test(row.content ?? '')) {
      const prompt = this.lane !== undefined ? this.prompts.get(this.lane) : undefined;
      if (!prompt || prompt.output) this.lane = undefined;
      return false;
    } else if (row.type === 'PLANNER_RESPONSE' && !row.tool_calls?.length && this.lane !== undefined) {
      const prompt = this.prompts.get(this.lane);
      if (!prompt || prompt.inputStep === undefined || row.step_index <= prompt.inputStep) return false;
      prompt.output = row;
      if (!this.latest || prompt.generation >= this.latest.generation) this.latest = {generation:prompt.generation,row};
      this.lane = undefined;
      prompt.resolve();
      return true;
    }
    return false;
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

  release(generation: number): void {
    if (this.lane === generation) this.lane = undefined;
    this.prompts.delete(generation);
  }
  clear(): void {
    for (const prompt of this.prompts.values()) prompt.resolve();
    this.prompts.clear(); this.lane = undefined; this.lastGeneration = 0; this.latest = undefined; this.authoritative = false;
  }
}
