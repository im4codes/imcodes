import { withTimeoutOutcome } from '../util/timeout-outcome.js';
import type { AgyTranscriptRow } from './agy-transcript-bridge.js';

// A failure deadline, NOT a grace period for ordering or content deduplication.
export const NATIVE_OUTPUT_DEADLINE_MS = 60_000;
const PREFIX_MIN_LENGTH = 80;
const PREFIX_PROBE_LENGTH = 160;
const USER_REQUEST_TAG_RE = /<\/?USER_REQUEST>/gi;
const TRAILING_META_RE = /^\s*(?:<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)\b[\s\S]*)?$/i;
const TRUNCATION_SUFFIX_RE = /(?:\s*\.{3,}|\s*…|\s*\[truncated\])+$/i;

interface Prompt {
  generation: number;
  text?: string;
  normText?: string;
  tagCount?: number;
  inputStep?: number;
  output?: AgyTranscriptRow;
  ready: Promise<void>;
  resolve: () => void;
}

interface ParsedInputEnvelope {
  kind: 'plain' | 'wrapped' | 'invalid';
  body: string;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countUserRequestTags(text: string): number {
  USER_REQUEST_TAG_RE.lastIndex = 0;
  return (text.match(USER_REQUEST_TAG_RE) ?? []).length;
}

function parseNativeInputEnvelope(content: string): ParsedInputEnvelope {
  const openMatch = /^\s*<USER_REQUEST>/i.exec(content);
  if (!openMatch) {
    return countUserRequestTags(content) === 0
      ? { kind: 'plain', body: content }
      : { kind: 'invalid', body: '' };
  }
  const afterOpen = content.slice(openMatch[0].length);
  USER_REQUEST_TAG_RE.lastIndex = 0;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = USER_REQUEST_TAG_RE.exec(afterOpen)) !== null) {
    if (match[0].startsWith('</')) {
      depth--;
      if (depth === 0) {
        const innerBody = afterOpen.slice(0, match.index);
        const remainder = afterOpen.slice(match.index + match[0].length);
        if (!TRAILING_META_RE.test(remainder)) {
          return { kind: 'invalid', body: '' };
        }
        return { kind: 'wrapped', body: innerBody };
      }
    } else {
      depth++;
    }
  }
  return { kind: 'invalid', body: '' };
}

function matchesTruncatedEnvelopePrefix(strippedRow: string, normPrompt: string): boolean {
  if (normPrompt.length < PREFIX_MIN_LENGTH || strippedRow.length < PREFIX_MIN_LENGTH) return false;
  return normPrompt.startsWith(strippedRow);
}

function matchesTruncatedPlainPrefix(normRow: string, normPrompt: string): boolean {
  if (normPrompt.length < PREFIX_MIN_LENGTH || normRow.length < PREFIX_MIN_LENGTH) return false;
  const probeLen = Math.min(PREFIX_PROBE_LENGTH, normPrompt.length, normRow.length);
  if (probeLen < PREFIX_MIN_LENGTH) return false;
  const probe = normPrompt.slice(0, probeLen);
  const idx = normRow.indexOf(probe);
  if (idx < 0) return false;
  return normPrompt.startsWith(normRow.slice(idx));
}

function selectUnambiguousPrefixMatch(matches: Prompt[]): Prompt | undefined {
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const distinct = new Set(matches.map(p => p.normText));
    if (distinct.size === 1) return matches[0];
  }
  return undefined;
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
    const normText = collapseWhitespace(text);
    const tagCount = countUserRequestTags(text);
    this.prompts.set(generation,{generation,text,normText,tagCount,ready,resolve});
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

    const envelope = parseNativeInputEnvelope(content);
    if (envelope.kind === 'invalid') return undefined;

    if (envelope.kind === 'wrapped') {
      const exactWrapped = unbound.find(p => envelope.body === p.text || envelope.body.trim() === p.text!.trim());
      if (exactWrapped) return exactWrapped;

      const normRow = collapseWhitespace(envelope.body);
      if (!normRow) return undefined;

      const normFull = unbound.find(p => p.normText !== undefined && p.normText.length > 0 && normRow === p.normText);
      if (normFull) return normFull;

      const trimmedBody = envelope.body.trim();
      if (!TRUNCATION_SUFFIX_RE.test(trimmedBody)) return undefined;
      const strippedRow = collapseWhitespace(trimmedBody.replace(TRUNCATION_SUFFIX_RE, ''));
      const prefixMatches = unbound.filter(p => matchesTruncatedEnvelopePrefix(strippedRow, p.normText ?? ''));
      return selectUnambiguousPrefixMatch(prefixMatches);
    }

    // envelope.kind === 'plain'
    const plainCandidates = unbound.filter(p => p.tagCount === 0);
    if (plainCandidates.length === 0) return undefined;

    const exactPlain = plainCandidates.find(p => content.includes(p.text!));
    if (exactPlain) return exactPlain;

    const normRow = collapseWhitespace(content);
    if (!normRow) return undefined;

    const normPlain = plainCandidates.find(p => p.normText !== undefined && p.normText.length > 0 && normRow.includes(p.normText));
    if (normPlain) return normPlain;

    const trimmedContent = content.trim();
    if (!TRUNCATION_SUFFIX_RE.test(trimmedContent)) return undefined;
    const strippedRow = collapseWhitespace(trimmedContent.replace(TRUNCATION_SUFFIX_RE, ''));
    const prefixMatches = plainCandidates.filter(p => matchesTruncatedPlainPrefix(strippedRow, p.normText ?? ''));
    return selectUnambiguousPrefixMatch(prefixMatches);
  }

  observe(row: AgyTranscriptRow): boolean {
    if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT') {
      // The full native log wraps but retains the exact submitted payload.
      // FIFO unbound requests distinguish repeated identical user messages.
      const prompt = this.findMatchingPrompt(row.content);
      this.lane = prompt?.generation;
      if (prompt) { prompt.inputStep = row.step_index; prompt.text = undefined; prompt.normText = undefined; prompt.tagCount = undefined; }
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
