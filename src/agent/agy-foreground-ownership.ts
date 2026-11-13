import { withTimeoutOutcome } from '../util/timeout-outcome.js';
import type { AgyTranscriptCursor, AgyTranscriptRow } from './agy-transcript-bridge.js';
import { isAgySubagentTool, isAgyInteractiveTool } from './agy-subagents.js';

function normalizeTranscriptCursor(cursor?: AgyTranscriptCursor | number): AgyTranscriptCursor | undefined {
  if (cursor === undefined) return undefined;
  return typeof cursor === 'number' ? { incarnation: 'unscoped', byteOffset: cursor } : cursor;
}

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
  bindSeq?: number;
  output?: AgyTranscriptRow;
  lastResponse?: AgyTranscriptRow;
  settling?: boolean;
  timedOut?: boolean;
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

export function isTerminalForegroundRow(row: AgyTranscriptRow | undefined): boolean {
  if (!row || row.type !== 'PLANNER_RESPONSE') return false;
  if (!row.tool_calls?.length) return true;
  if (row.tool_calls.some(call => typeof call?.name === 'string' && isAgySubagentTool(call.name))) {
    return false;
  }
  if (row.tool_calls.some(call => typeof call?.name === 'string' && isAgyInteractiveTool(call.name))) {
    return true;
  }
  return Boolean(row.content?.trim());
}

const CONTEXT_INSTRUCTIONS_PREFIX = 'Context instructions:';
const COMPANION_COLLAPSED_MIN_LEN = 12;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function hasContextCompanionRelation(aRaw: string, bRaw: string): boolean {
  const check = (withCtx: string, withoutCtx: string): boolean => {
    const w = normalizeNewlines(withCtx);
    const b = normalizeNewlines(withoutCtx);
    if (!w.startsWith(CONTEXT_INSTRUCTIONS_PREFIX) || !b) return false;
    if (w.endsWith(`\n\n${b}`)) return true;
    const wNorm = collapseWhitespace(w);
    const bNorm = collapseWhitespace(b);
    return bNorm.length >= COMPANION_COLLAPSED_MIN_LEN && wNorm.endsWith(` ${bNorm}`);
  };
  return check(aRaw, bRaw) || check(bRaw, aRaw);
}

function promptMatchesExplicitContent(
  prompt: Prompt,
  content: string,
  normRaw: string,
  envelope: ParsedInputEnvelope,
): boolean {
  if (!prompt.text) return false;
  if (content === prompt.text || content.trim() === prompt.text.trim()) return true;
  if (prompt.normText && normRaw === prompt.normText) return true;
  if (envelope.kind === 'invalid') return false;

  if (envelope.kind === 'wrapped') {
    if (envelope.body === prompt.text || envelope.body.trim() === prompt.text.trim()) return true;
    const normRow = collapseWhitespace(envelope.body);
    if (!normRow) return false;
    if (prompt.normText && normRow === prompt.normText) return true;
    if (hasContextCompanionRelation(prompt.text, envelope.body)) return true;
    const trimmedBody = envelope.body.trim();
    if (!TRUNCATION_SUFFIX_RE.test(trimmedBody)) return false;
    const strippedRow = collapseWhitespace(trimmedBody.replace(TRUNCATION_SUFFIX_RE, ''));
    return matchesTruncatedEnvelopePrefix(strippedRow, prompt.normText ?? '');
  }

  if (prompt.tagCount !== 0) return false;
  if (content.includes(prompt.text)) return true;
  if (prompt.normText && normRaw.includes(prompt.normText)) return true;
  if (hasContextCompanionRelation(prompt.text, content)) return true;
  const trimmedContent = content.trim();
  if (!TRUNCATION_SUFFIX_RE.test(trimmedContent)) return false;
  const strippedRow = collapseWhitespace(trimmedContent.replace(TRUNCATION_SUFFIX_RE, ''));
  return matchesTruncatedPlainPrefix(strippedRow, prompt.normText ?? '');
}

/** Captured outbound RPC -> explicit native input -> native response. ACP
 * parent text has no turn id, so async owners must not guess from body text. */
export class AgyForegroundOwnership {
  authoritative = false;
  private prompts = new Map<number, Prompt>();
  private lane?: number;
  private retainedLane?: Prompt;
  private lastBoundGeneration = 0;
  private bindSeq = 0;
  private latestBound?: { generation: number; bindSeq: number };
  private latestBindSeq = 0;
  private turnStartGeneration?: number;
  private continuationWatermark?: AgyTranscriptCursor;
  latest?: { generation: number; row: AgyTranscriptRow };
  constructor(private deadlineMs = NATIVE_OUTPUT_DEADLINE_MS) {}

  beginTurn(): void {
    this.latest = undefined;
    this.latestBound = undefined;
    this.latestBindSeq = 0;
    this.retainedLane?.resolve();
    this.retainedLane = undefined;
    this.turnStartGeneration = undefined;
    this.continuationWatermark = undefined;
  }

  register(
    generation: number,
    text: string,
    shareActiveTurn = false,
    continuationCursor?: AgyTranscriptCursor | number,
  ): void {
    let resolve!: () => void;
    const ready = new Promise<void>(r => { resolve = r; });
    const hasIncompletePrompt = [...this.prompts.values()].some(p => !p.output && !p.timedOut)
      || Boolean(this.retainedLane && !this.retainedLane.output && !this.retainedLane.timedOut);
    if ((!shareActiveTurn && !hasIncompletePrompt) || this.turnStartGeneration === undefined) {
      this.turnStartGeneration = generation;
    }
    if (shareActiveTurn) {
      // A shared-turn continuation (e.g., ask_question answer or mid-turn steer)
      // invalidates any earlier pending interactive/tool response as a terminal candidate.
      for (const existing of this.prompts.values()) {
        if (!existing.output && existing.lastResponse?.tool_calls?.length) {
          existing.lastResponse = undefined;
        }
      }
      if (this.retainedLane && !this.retainedLane.output && this.retainedLane.lastResponse?.tool_calls?.length) {
        this.retainedLane.lastResponse = undefined;
      }
      const nextWatermark = normalizeTranscriptCursor(continuationCursor);
      if (nextWatermark) {
        this.continuationWatermark = !this.continuationWatermark || this.continuationWatermark.incarnation !== nextWatermark.incarnation
          ? nextWatermark
          : {
              incarnation: nextWatermark.incarnation,
              byteOffset: Math.max(this.continuationWatermark.byteOffset, nextWatermark.byteOffset),
            };
      }
    }
    const normText = collapseWhitespace(text);
    const tagCount = countUserRequestTags(text);
    this.prompts.set(generation,{generation,text,normText,tagCount,ready,resolve});
  }

  private activeLanePrompt(): Prompt | undefined {
    if (this.lane !== undefined) return this.prompts.get(this.lane);
    return this.retainedLane;
  }

  hasActiveLane(): boolean {
    const prompt = this.activeLanePrompt();
    return Boolean(prompt && prompt.inputStep !== undefined && !prompt.output && !prompt.timedOut);
  }

  hasBoundInput(generation: number): boolean {
    return this.prompts.get(generation)?.inputStep !== undefined;
  }

  private currentTurnBoundLeader(): { generation: number; bindSeq: number } | undefined {
    if (!this.latestBound) return undefined;
    if (this.turnStartGeneration !== undefined && this.latestBound.generation < this.turnStartGeneration) {
      return undefined;
    }
    return this.latestBound;
  }

  hasBoundSuccessor(generation: number): boolean {
    const leader = this.currentTurnBoundLeader();
    if (leader) {
      if (leader.generation === generation) return false;
      const prompt = this.prompts.get(generation);
      if (prompt?.bindSeq !== undefined) {
        return leader.bindSeq > prompt.bindSeq;
      }
      return leader.generation > generation;
    }
    return this.lastBoundGeneration > generation;
  }

  resolveAggregateGeneration(fallbackGeneration: number): number {
    const leader = this.currentTurnBoundLeader();
    if (leader && this.prompts.has(leader.generation)) {
      return leader.generation;
    }
    if (this.lastBoundGeneration > 0 && this.prompts.has(this.lastBoundGeneration)) {
      return this.lastBoundGeneration;
    }
    return fallbackGeneration;
  }

  private findMatchingPrompt(content: string | undefined): Prompt | undefined {
    if (!content) return undefined;
    const unbound = [...this.prompts.values()].filter(p => p.inputStep === undefined && p.text);
    if (unbound.length === 0) return undefined;

    // 1. Direct raw payload fidelity (exact, trimmed, or whitespace-normalized full equality).
    // Preserves plain USER_EXPLICIT fixtures/inputs even when the prompt itself contains or
    // consists of literal <USER_REQUEST>...</USER_REQUEST> tags, in FIFO order.
    const exactRaw = unbound.find(p => content === p.text || content.trim() === p.text!.trim());
    if (exactRaw) return exactRaw;

    const normRaw = collapseWhitespace(content);
    if (!normRaw) return undefined;

    const normRawMatch = unbound.find(p => p.normText !== undefined && p.normText.length > 0 && normRaw === p.normText);
    if (normRawMatch) return normRawMatch;

    // 2. Native outer envelope extraction and context/prefix fallback.
    const envelope = parseNativeInputEnvelope(content);
    if (envelope.kind === 'invalid') return undefined;

    if (envelope.kind === 'wrapped') {
      const exactWrapped = unbound.find(p => envelope.body === p.text || envelope.body.trim() === p.text!.trim());
      if (exactWrapped) return exactWrapped;

      const normRow = collapseWhitespace(envelope.body);
      if (!normRow) return undefined;

      const normFull = unbound.find(p => p.normText !== undefined && p.normText.length > 0 && normRow === p.normText);
      if (normFull) return normFull;

      const companion = unbound.find(p => p.text && hasContextCompanionRelation(p.text, envelope.body));
      if (companion) return companion;

      const trimmedBody = envelope.body.trim();
      if (!TRUNCATION_SUFFIX_RE.test(trimmedBody)) return undefined;
      const strippedRow = collapseWhitespace(trimmedBody.replace(TRUNCATION_SUFFIX_RE, ''));
      const prefixMatches = unbound.filter(p => matchesTruncatedEnvelopePrefix(strippedRow, p.normText ?? ''));
      return selectUnambiguousPrefixMatch(prefixMatches);
    }

    // envelope.kind === 'plain' (no <USER_REQUEST> tags in content)
    const plainCandidates = unbound.filter(p => p.tagCount === 0);
    if (plainCandidates.length === 0) return undefined;

    const exactPlain = plainCandidates.find(p => content.includes(p.text!));
    if (exactPlain) return exactPlain;

    const normPlain = plainCandidates.find(p => p.normText !== undefined && p.normText.length > 0 && normRaw.includes(p.normText));
    if (normPlain) return normPlain;

    const companionPlain = plainCandidates.find(p => p.text && hasContextCompanionRelation(p.text, content));
    if (companionPlain) return companionPlain;

    const trimmedContent = content.trim();
    if (!TRUNCATION_SUFFIX_RE.test(trimmedContent)) return undefined;
    const strippedRow = collapseWhitespace(trimmedContent.replace(TRUNCATION_SUFFIX_RE, ''));
    const prefixMatches = plainCandidates.filter(p => matchesTruncatedPlainPrefix(strippedRow, p.normText ?? ''));
    return selectUnambiguousPrefixMatch(prefixMatches);
  }

  private findBoundCompanionPrompt(content: string | undefined): Prompt | undefined {
    if (!content) return undefined;
    const normRaw = collapseWhitespace(content);
    if (!normRaw) return undefined;
    const envelope = parseNativeInputEnvelope(content);

    const candidates: Prompt[] = [];
    const active = this.activeLanePrompt();
    if (active && active.inputStep !== undefined && !active.output && !active.timedOut && active.text) {
      candidates.push(active);
    }
    for (const p of this.prompts.values()) {
      if (p !== active && p.inputStep !== undefined && !p.output && !p.timedOut && p.text) {
        candidates.push(p);
      }
    }
    if (
      this.retainedLane
      && !candidates.includes(this.retainedLane)
      && this.retainedLane.inputStep !== undefined
      && !this.retainedLane.output
      && !this.retainedLane.timedOut
      && this.retainedLane.text
    ) {
      candidates.push(this.retainedLane);
    }
    if (candidates.length === 0) return undefined;
    return candidates.find(p => promptMatchesExplicitContent(p, content, normRaw, envelope));
  }

  private getTurnLatest(): { generation: number; row: AgyTranscriptRow } | undefined {
    if (!this.latest) return undefined;
    const turnFloor = this.turnStartGeneration ?? 0;
    if (this.latest.generation < turnFloor) return undefined;
    const leader = this.currentTurnBoundLeader();
    if (leader && this.latest.generation !== leader.generation) return undefined;
    return this.latest;
  }

  private getAdoptableLane(generation: number): Prompt | undefined {
    if (this.hasBoundSuccessor(generation)) return undefined;
    if (
      this.retainedLane
      && this.retainedLane.generation < generation
      && !this.retainedLane.output
      && !this.retainedLane.timedOut
    ) {
      return this.retainedLane;
    }
    const active = this.lane !== undefined ? this.prompts.get(this.lane) : undefined;
    if (
      active
      && active.generation < generation
      && active.inputStep !== undefined
      && !active.output
      && !active.timedOut
    ) {
      return active;
    }
    for (const candidate of this.prompts.values()) {
      if (
        candidate.generation < generation
        && candidate.inputStep !== undefined
        && !candidate.output
        && !candidate.timedOut
      ) {
        return candidate;
      }
    }
    return undefined;
  }

  private recordLatest(prompt: Prompt, row: AgyTranscriptRow): void {
    const seq = prompt.bindSeq ?? 0;
    if (!this.latest || seq > this.latestBindSeq || (seq === this.latestBindSeq && prompt.generation >= this.latest.generation)) {
      this.latest = { generation: prompt.generation, row };
      this.latestBindSeq = seq;
    }
  }

  private attributeLastResponse(prompt: Prompt): AgyTranscriptRow | undefined {
    prompt.settling = true;
    if (!prompt.output && isTerminalForegroundRow(prompt.lastResponse)) {
      prompt.output = prompt.lastResponse;
      this.recordLatest(prompt, prompt.lastResponse!);
      if (this.lane === prompt.generation) this.lane = undefined;
      if (this.retainedLane?.generation === prompt.generation) this.retainedLane = undefined;
      prompt.resolve();
    }
    return prompt.output;
  }

  observe(row: AgyTranscriptRow, cursorOrByteEnd?: AgyTranscriptCursor | number): boolean {
    if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT') {
      // The full native log wraps but retains the exact submitted payload.
      // FIFO unbound requests distinguish repeated identical user messages.
      const prompt = this.findMatchingPrompt(row.content);
      if (!prompt) {
        // Ignore duplicate or Context-instructions companion echoes of the currently
        // active incomplete bound prompt so they do not wipe the foreground lane.
        if (this.findBoundCompanionPrompt(row.content)) {
          return false;
        }
        this.lane = undefined;
        if (this.retainedLane) {
          const superseded = this.retainedLane;
          this.retainedLane = undefined;
          superseded.resolve();
        }
        return false;
      }
      this.lane = prompt.generation;
      prompt.inputStep = row.step_index;
      prompt.bindSeq = ++this.bindSeq;
      this.latestBound = { generation: prompt.generation, bindSeq: prompt.bindSeq };
      this.lastBoundGeneration = Math.max(this.lastBoundGeneration, prompt.generation);
      if (this.retainedLane && this.retainedLane.generation !== prompt.generation) {
        const superseded = this.retainedLane;
        this.retainedLane = undefined;
        superseded.resolve();
      }
      // Wake older or same-turn unresolved waits immediately so they yield to the bound
      // leader instead of hanging until the failure deadline.
      for (const existing of this.prompts.values()) {
        if (
          existing !== prompt
          && !existing.output
          && (existing.generation < prompt.generation
            || (this.turnStartGeneration !== undefined && existing.generation >= this.turnStartGeneration))
        ) {
          existing.resolve();
        }
      }
      return false;
    } else if (row.type === 'USER_INPUT') {
      const prompt = this.activeLanePrompt();
      if (prompt && !prompt.output && prompt.lastResponse?.tool_calls?.length) {
        prompt.lastResponse = undefined;
      }
      return false;
    } else if (row.type === 'SYSTEM_MESSAGE' && /\[Message\].*sender=/.test(row.content ?? '')) {
      const prompt = this.activeLanePrompt();
      if (!prompt || prompt.output) {
        this.lane = undefined;
        this.retainedLane = undefined;
      }
      return false;
    } else if (row.type === 'PLANNER_RESPONSE') {
      const prompt = this.activeLanePrompt();
      if (!prompt || prompt.inputStep === undefined || row.step_index <= prompt.inputStep) return false;
      const cursor = normalizeTranscriptCursor(cursorOrByteEnd);
      if (
        row.tool_calls?.length
        && cursor
        && this.continuationWatermark
        && cursor.incarnation === this.continuationWatermark.incarnation
        && cursor.byteOffset <= this.continuationWatermark.byteOffset
      ) {
        return false;
      }
      prompt.lastResponse = row;
      if (!row.tool_calls?.length || (prompt.settling && isTerminalForegroundRow(row))) {
        prompt.output = row;
        this.recordLatest(prompt, prompt.output);
        if (this.lane === prompt.generation) this.lane = undefined;
        if (this.retainedLane?.generation === prompt.generation) this.retainedLane = undefined;
        prompt.resolve();
        return true;
      }
      return false;
    }
    return false;
  }

  settle(generation: number): AgyTranscriptRow | undefined {
    const prompt = this.prompts.get(generation);
    if (!prompt) return undefined;
    prompt.settling = true;
    if (prompt.inputStep !== undefined || prompt.output) {
      return this.attributeLastResponse(prompt);
    }
    const turnLatest = this.getTurnLatest();
    if (turnLatest) return turnLatest.row;
    const adoptable = this.getAdoptableLane(generation);
    return adoptable ? this.attributeLastResponse(adoptable) : undefined;
  }

  async output(generation: number): Promise<AgyTranscriptRow | undefined> {
    const endAt = Number.isFinite(this.deadlineMs) && this.deadlineMs > 0
      ? Date.now() + this.deadlineMs
      : undefined;
    while (true) {
      const prompt = this.prompts.get(generation);
      if (!prompt) return undefined;
      if (prompt.output) return prompt.output;
      if (this.hasBoundSuccessor(generation)) return undefined;
      if (prompt.inputStep === undefined) {
        const turnLatest = this.getTurnLatest();
        if (turnLatest) return turnLatest.row;
      }
      const adoptable = prompt.inputStep === undefined ? this.getAdoptableLane(generation) : undefined;
      const waitPromise = adoptable
        ? Promise.race([prompt.ready, adoptable.ready])
        : prompt.ready;
      const remainingMs = endAt === undefined ? this.deadlineMs : endAt - Date.now();
      const timedOut = endAt !== undefined && remainingMs <= 0
        ? true
        : (await withTimeoutOutcome(waitPromise, remainingMs)).timedOut;
      if (timedOut) {
        const current = this.prompts.get(generation);
        if (!current) return undefined;
        if (current.output) return current.output;
        if (this.hasBoundSuccessor(generation)) return undefined;
        if (current.inputStep !== undefined && isTerminalForegroundRow(current.lastResponse)) {
          return this.attributeLastResponse(current);
        }
        if (current.inputStep === undefined) {
          const settled = this.settle(generation);
          if (settled) return settled;
        }
        current.timedOut = true;
        if (adoptable) {
          adoptable.timedOut = true;
          if (this.lane === adoptable.generation) this.lane = undefined;
          if (this.retainedLane?.generation === adoptable.generation) {
            this.retainedLane = undefined;
            adoptable.resolve();
          }
        }
        return undefined;
      }
    }
  }

  release(generation: number): void {
    const prompt = this.prompts.get(generation);
    this.prompts.delete(generation);
    if (this.prompts.size === 0) {
      this.lane = undefined;
      this.retainedLane?.resolve();
      this.retainedLane = undefined;
      return;
    }
    if (this.lane === generation) {
      const hasPendingLaterUnboundPrompt = [...this.prompts.values()].some(
        p => p.generation > generation && p.inputStep === undefined && !p.output && !p.timedOut,
      );
      if (
        prompt
        && prompt.inputStep !== undefined
        && !prompt.output
        && !prompt.timedOut
        && !this.hasBoundSuccessor(generation)
        && hasPendingLaterUnboundPrompt
      ) {
        // Keep the live bound lane reachable for an absorbed successor within the same
        // turn if this prompt's RPC releases before the native PLANNER_RESPONSE lands.
        this.retainedLane = prompt;
      }
      this.lane = undefined;
    }
  }
  releaseTurn(): void {
    for (const prompt of this.prompts.values()) prompt.resolve();
    this.retainedLane?.resolve();
    this.prompts.clear();
    this.lane = undefined;
    this.retainedLane = undefined;
    this.lastBoundGeneration = 0;
    this.latestBound = undefined;
    this.latestBindSeq = 0;
    this.turnStartGeneration = undefined;
    this.continuationWatermark = undefined;
    this.latest = undefined;
  }

  clear(): void {
    this.releaseTurn();
    this.authoritative = false;
  }
}
