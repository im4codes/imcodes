import { withTimeoutOutcome } from '../util/timeout-outcome.js';
import type { AgyTranscriptCursor, AgyTranscriptRow } from './agy-transcript-bridge.js';
import { isAgySubagentTool, isAgyInteractiveTool } from './agy-subagents.js';

function normalizeTranscriptCursor(cursor?: AgyTranscriptCursor | number): AgyTranscriptCursor | undefined {
  if (cursor === undefined) return undefined;
  return typeof cursor === 'number' ? { incarnation: 'unscoped', byteOffset: cursor } : cursor;
}

// A failure deadline, NOT a grace period for ordering or content deduplication.
export const NATIVE_OUTPUT_DEADLINE_MS = 60_000;
const NON_SUBAGENT_TOOL_SETTLE_GRACE_MS = 2_000;
const PREFIX_MIN_LENGTH = 80;
const PREFIX_PROBE_LENGTH = 160;
const USER_REQUEST_TAG_RE = /<\/?USER_REQUEST>/gi;
const TRAILING_META_RE = /^\s*(?:<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)\b[\s\S]*)?$/i;
const METADATA_BLOCK_RE = /^<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)\b[^>]*>[\s\S]*?<\/\1>/i;
const TRUNCATION_SUFFIX_RE = /(?:\s*\.{3,}|\s*…|\s*\[truncated\]|\s*<truncated(?:\s+[\d,]+\s+bytes)?\s*>)+$/i;
const SLASH_COMMAND_TOKEN_RE = /(?:^|[^\p{L}\p{N}_/])(\/[a-z][a-z0-9_-]*)(?=$|[^\p{L}\p{N}_/])/giu;
const TRAILING_SLASH_TOKEN_RE = /\s*(\/[a-z][a-z0-9_-]*)$/i;
const ONLY_SLASH_TOKENS_RE = /^(?:\s*\/[a-z][a-z0-9_-]*)+$/i;
const MAX_SLASH_ECHO_PEEL = 16;

interface PromptAlias {
  text: string;
  normText: string;
  tagCount: number;
}

interface Prompt {
  generation: number;
  text?: string;
  normText?: string;
  tagCount?: number;
  aliases?: PromptAlias[];
  boundBody?: string;
  boundNormBody?: string;
  inputStep?: number;
  bindSeq?: number;
  output?: AgyTranscriptRow;
  lastResponse?: AgyTranscriptRow;
  lastResponseAt?: number;
  settling?: boolean;
  settlingSince?: number;
  timedOut?: boolean;
  ready: Promise<void>;
  resolve: () => void;
}

interface ParsedInputEnvelopes {
  kind: 'plain' | 'wrapped' | 'invalid';
  bodies: string[];
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countUserRequestTags(text: string): number {
  USER_REQUEST_TAG_RE.lastIndex = 0;
  return (text.match(USER_REQUEST_TAG_RE) ?? []).length;
}

function parseNativeInputEnvelopes(content: string): ParsedInputEnvelopes {
  const firstOpen = /^\s*<USER_REQUEST>/i.exec(content);
  if (!firstOpen) {
    return countUserRequestTags(content) === 0
      ? { kind: 'plain', bodies: [content] }
      : { kind: 'invalid', bodies: [] };
  }

  const bodies: string[] = [];
  let pos = 0;
  while (pos < content.length) {
    const wsMatch = /^\s*/.exec(content.slice(pos));
    if (wsMatch) pos += wsMatch[0].length;
    if (pos >= content.length) break;

    const rest = content.slice(pos);
    const openMatch = /^<USER_REQUEST>/i.exec(rest);
    if (!openMatch) {
      const metaMatch = METADATA_BLOCK_RE.exec(rest);
      if (metaMatch) {
        pos += metaMatch[0].length;
        continue;
      }
      if (TRAILING_META_RE.test(rest) && countUserRequestTags(rest) === 0) {
        break;
      }
      return { kind: 'invalid', bodies: [] };
    }

    const afterOpen = content.slice(pos + openMatch[0].length);
    USER_REQUEST_TAG_RE.lastIndex = 0;
    let depth = 1;
    let match: RegExpExecArray | null;
    let closed = false;
    while ((match = USER_REQUEST_TAG_RE.exec(afterOpen)) !== null) {
      if (match[0].startsWith('</')) {
        depth--;
        if (depth === 0) {
          bodies.push(afterOpen.slice(0, match.index));
          pos += openMatch[0].length + match.index + match[0].length;
          closed = true;
          break;
        }
      } else {
        depth++;
      }
    }

    if (!closed) {
      // Antigravity caps oversized USER_INPUT rows and appends a terminal native
      // truncation marker before the outer closing tag is ever written. Treat that
      // explicit marker as a truncated wrapped envelope; bare unclosed wrappers
      // remain invalid.
      if (TRUNCATION_SUFFIX_RE.test(afterOpen.trim())) {
        bodies.push(afterOpen);
        break;
      }
      return { kind: 'invalid', bodies: [] };
    }
  }

  return bodies.length > 0
    ? { kind: 'wrapped', bodies }
    : { kind: 'invalid', bodies: [] };
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

function isNonSubagentToolFallbackRow(row: AgyTranscriptRow | undefined): boolean {
  if (!row || row.type !== 'PLANNER_RESPONSE') return false;
  if (!row.tool_calls?.length) return false;
  return !row.tool_calls.some(call => typeof call?.name === 'string' && isAgySubagentTool(call.name));
}

function extractSlashTokens(text: string, target = new Set<string>()): Set<string> {
  SLASH_COMMAND_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SLASH_COMMAND_TOKEN_RE.exec(text)) !== null) {
    target.add(match[1].toLowerCase());
  }
  return target;
}

function isOnlyAllowedSlashEcho(tail: string, allowedTokens: Set<string>): boolean {
  if (allowedTokens.size === 0 || !ONLY_SLASH_TOKENS_RE.test(tail)) return false;
  const tokens = tail.match(/\/[a-z][a-z0-9_-]*/gi);
  return Boolean(tokens && tokens.length > 0 && tokens.every(tok => allowedTokens.has(tok.toLowerCase())));
}

function stripAllowedTrailingSlashEchoVariants(candidate: string, allowedTokens: Set<string>): string[] {
  if (allowedTokens.size === 0) return [];
  const variants: string[] = [];
  let current = candidate.trim();
  for (let i = 0; i < MAX_SLASH_ECHO_PEEL; i++) {
    const m = TRAILING_SLASH_TOKEN_RE.exec(current);
    if (!m) break;
    if (!allowedTokens.has(m[1].toLowerCase())) break;
    const next = current.slice(0, m.index).trimEnd();
    if (!next) break;
    variants.push(next);
    current = next;
  }
  return variants;
}

const CONTEXT_INSTRUCTIONS_PREFIX = 'Context instructions:';

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function hasContextCompanionRelation(aRaw: string, bRaw: string): boolean {
  const check = (withCtx: string, withoutCtx: string): boolean => {
    const w = normalizeNewlines(withCtx);
    const b = normalizeNewlines(withoutCtx);
    const prefix = `${CONTEXT_INSTRUCTIONS_PREFIX}\n`;
    if (!w.startsWith(prefix) || !b || b.startsWith(prefix)) return false;
    if (w.endsWith(`\n\n${b}`)) return true;
    const bNorm = collapseWhitespace(b);
    if (!bNorm) return false;
    let sep = w.indexOf('\n\n');
    while (sep >= 0) {
      const tail = w.slice(sep + 2).trim();
      if (tail === b || collapseWhitespace(tail) === bNorm) return true;
      sep = w.indexOf('\n\n', sep + 2);
    }
    return false;
  };
  return check(aRaw, bRaw) || check(bRaw, aRaw);
}

function promptMatchTargets(prompt: Prompt): PromptAlias[] {
  const targets: PromptAlias[] = [];
  if (prompt.text) {
    targets.push({
      text: prompt.text,
      normText: prompt.normText ?? collapseWhitespace(prompt.text),
      tagCount: prompt.tagCount ?? countUserRequestTags(prompt.text),
    });
  }
  if (prompt.aliases) targets.push(...prompt.aliases);
  return targets;
}

function promptAllowedSlashTokens(prompt: Prompt, includeBound = false): Set<string> {
  const tokens = new Set<string>();
  for (const t of promptMatchTargets(prompt)) {
    extractSlashTokens(t.normText, tokens);
  }
  if (includeBound && prompt.boundNormBody) {
    extractSlashTokens(prompt.boundNormBody, tokens);
  }
  return tokens;
}

function matchesTargetOrCompanionWithSlashEcho(
  candidateBody: string,
  candidateNorm: string,
  targets: PromptAlias[],
  allowedSlashTokens: Set<string>,
  requireZeroTagCount = false,
): boolean {
  const candidateTrim = candidateBody.trim();
  const matchesTarget = (body: string, trim: string, norm: string, t: PromptAlias): boolean => {
    if (requireZeroTagCount && t.tagCount !== 0) return false;
    if (body === t.text || trim === t.text.trim()) return true;
    if (t.normText.length > 0 && norm === t.normText) return true;
    if (hasContextCompanionRelation(t.text, body)) return true;
    if (allowedSlashTokens.size > 0 && t.normText.length > 0) {
      if (trim.startsWith(t.text.trim()) && t.text.trim().length > 0) {
        const tail = trim.slice(t.text.trim().length);
        if (tail.length > 0 && isOnlyAllowedSlashEcho(tail, allowedSlashTokens)) return true;
      }
      if (norm.startsWith(t.normText)) {
        const tail = norm.slice(t.normText.length);
        if (tail.length > 0 && isOnlyAllowedSlashEcho(tail, allowedSlashTokens)) return true;
      }
    }
    return false;
  };

  if (targets.some(t => matchesTarget(candidateBody, candidateTrim, candidateNorm, t))) {
    return true;
  }

  for (const peeled of stripAllowedTrailingSlashEchoVariants(candidateBody, allowedSlashTokens)) {
    const peeledNorm = collapseWhitespace(peeled);
    if (!peeledNorm) continue;
    if (targets.some(t =>
      (!requireZeroTagCount || t.tagCount === 0)
      && (peeled === t.text.trim()
        || (t.normText.length > 0 && peeledNorm === t.normText)
        || hasContextCompanionRelation(t.text, peeled)),
    )) {
      return true;
    }
  }
  return false;
}

function promptMatchesBoundCompanionBody(
  prompt: Prompt,
  candidateBody: string,
  isPlain: boolean,
): boolean {
  const targets = promptMatchTargets(prompt);
  if (prompt.boundBody) {
    targets.push({
      text: prompt.boundBody,
      normText: prompt.boundNormBody ?? collapseWhitespace(prompt.boundBody),
      tagCount: countUserRequestTags(prompt.boundBody),
    });
  }
  if (targets.length === 0) return false;

  const candidateTrim = candidateBody.trim();
  const candidateNorm = collapseWhitespace(candidateBody);
  if (!candidateNorm) return false;

  const allowedSlashTokens = promptAllowedSlashTokens(prompt, true);
  if (matchesTargetOrCompanionWithSlashEcho(candidateBody, candidateNorm, targets, allowedSlashTokens)) {
    return true;
  }

  if (!TRUNCATION_SUFFIX_RE.test(candidateTrim)) return false;
  const strippedRow = collapseWhitespace(candidateTrim.replace(TRUNCATION_SUFFIX_RE, ''));
  if (!strippedRow) return false;
  if (!isPlain) {
    return targets.some(t => matchesTruncatedEnvelopePrefix(strippedRow, t.normText));
  }
  return targets.some(t => t.tagCount === 0 && matchesTruncatedPlainPrefix(strippedRow, t.normText));
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
  private stateChangeResolve?: () => void;
  private stateChangePromise?: Promise<void>;
  latest?: { generation: number; row: AgyTranscriptRow };
  constructor(private deadlineMs = NATIVE_OUTPUT_DEADLINE_MS) {}

  private getStateChangePromise(): Promise<void> {
    if (!this.stateChangePromise) {
      this.stateChangePromise = new Promise<void>(resolve => {
        this.stateChangeResolve = resolve;
      });
    }
    return this.stateChangePromise;
  }

  private notifyStateChange(): void {
    const resolve = this.stateChangeResolve;
    this.stateChangeResolve = undefined;
    this.stateChangePromise = undefined;
    resolve?.();
  }

  beginTurn(): void {
    this.latest = undefined;
    this.latestBound = undefined;
    this.latestBindSeq = 0;
    this.retainedLane?.resolve();
    this.retainedLane = undefined;
    this.turnStartGeneration = undefined;
    this.continuationWatermark = undefined;
    this.notifyStateChange();
  }

  register(
    generation: number,
    text: string,
    shareActiveTurn = false,
    continuationCursor?: AgyTranscriptCursor | number,
    companionAliases?: readonly string[],
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
    const aliases = companionAliases
      ?.map(alias => ({
        text: alias,
        normText: collapseWhitespace(alias),
        tagCount: countUserRequestTags(alias),
      }))
      .filter(a => a.text.length > 0 && a.text !== text);
    this.prompts.set(generation, {
      generation,
      text,
      normText,
      tagCount,
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
      ready,
      resolve,
    });
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

  private matchConcatenatedPrompts(
    body: string,
    candidates: Prompt[],
    requireZeroTagCount = false,
  ): Array<{ prompt: Prompt; boundBody: string }> | undefined {
    if (candidates.length < 2) return undefined;
    let remaining = collapseWhitespace(body);
    if (!remaining) return undefined;

    const used = new Set<Prompt>();
    const matched: Array<{ prompt: Prompt; boundBody: string }> = [];
    const combinedAllowedSlashTokens = new Set<string>();

    while (remaining.length > 0) {
      let bestLen = 0;
      const bestMatches: Array<{ prompt: Prompt; normBody: string }> = [];

      for (const p of candidates) {
        if (used.has(p)) continue;
        for (const t of promptMatchTargets(p)) {
          if (requireZeroTagCount && t.tagCount !== 0) continue;
          if (!t.normText || !remaining.startsWith(t.normText)) continue;
          if (t.normText.length > bestLen) {
            bestLen = t.normText.length;
            bestMatches.length = 0;
            bestMatches.push({ prompt: p, normBody: t.normText });
          } else if (t.normText.length === bestLen) {
            bestMatches.push({ prompt: p, normBody: t.normText });
          }
        }
      }

      if (bestMatches.length === 0) break;
      const chosen = selectUnambiguousPrefixMatch(bestMatches.map(m => m.prompt));
      if (!chosen) return undefined;
      const chosenEntry = bestMatches.find(m => m.prompt === chosen)!;
      used.add(chosen);
      matched.push({ prompt: chosen, boundBody: chosenEntry.normBody });
      for (const tok of promptAllowedSlashTokens(chosen)) combinedAllowedSlashTokens.add(tok);
      remaining = remaining.slice(bestLen).trimStart();
    }

    if (matched.length < 2) return undefined;
    if (remaining.length > 0 && !isOnlyAllowedSlashEcho(remaining, combinedAllowedSlashTokens)) {
      return undefined;
    }
    return matched;
  }

  private matchSingleWrappedBody(body: string, unbound: Prompt[]): Array<{ prompt: Prompt; boundBody: string }> {
    const exactWrapped = unbound.find(p =>
      promptMatchTargets(p).some(t => body === t.text || body.trim() === t.text.trim()),
    );
    if (exactWrapped) return [{ prompt: exactWrapped, boundBody: body }];

    const normRow = collapseWhitespace(body);
    if (!normRow) return [];

    const normFull = unbound.find(p =>
      promptMatchTargets(p).some(t => t.normText.length > 0 && normRow === t.normText),
    );
    if (normFull) return [{ prompt: normFull, boundBody: body }];

    const companion = unbound.find(p =>
      promptMatchTargets(p).some(t => hasContextCompanionRelation(t.text, body)),
    );
    if (companion) return [{ prompt: companion, boundBody: body }];

    const slashEchoMatches = unbound.filter(p =>
      matchesTargetOrCompanionWithSlashEcho(body, normRow, promptMatchTargets(p), promptAllowedSlashTokens(p)),
    );
    const slashEchoWinner = selectUnambiguousPrefixMatch(slashEchoMatches);
    if (slashEchoWinner) return [{ prompt: slashEchoWinner, boundBody: body }];

    const concatenated = this.matchConcatenatedPrompts(body, unbound);
    if (concatenated) return concatenated;

    const trimmedBody = body.trim();
    if (!TRUNCATION_SUFFIX_RE.test(trimmedBody)) return [];
    const strippedRow = collapseWhitespace(trimmedBody.replace(TRUNCATION_SUFFIX_RE, ''));
    const prefixMatches = unbound.filter(p =>
      promptMatchTargets(p).some(t => matchesTruncatedEnvelopePrefix(strippedRow, t.normText)),
    );
    const winner = selectUnambiguousPrefixMatch(prefixMatches);
    return winner ? [{ prompt: winner, boundBody: body }] : [];
  }

  private matchPlainBody(content: string, normRaw: string, unbound: Prompt[]): Array<{ prompt: Prompt; boundBody: string }> {
    const plainCandidates = unbound.filter(p => p.tagCount === 0);
    if (plainCandidates.length === 0) return [];

    const concatenated = this.matchConcatenatedPrompts(content, plainCandidates, true);
    if (concatenated) return concatenated;

    // Legacy substring wrapper matching applies only to the original primary payload text,
    // never to structured companion aliases (which must match via exact/normalized equality,
    // strict Context paragraph relation, slash-echo, concatenation, or explicit truncation markers).
    const exactPlain = plainCandidates.find(p => p.text !== undefined && content.includes(p.text));
    if (exactPlain) return [{ prompt: exactPlain, boundBody: content }];

    const normPlain = plainCandidates.find(p => p.normText !== undefined && p.normText.length > 0 && normRaw.includes(p.normText));
    if (normPlain) return [{ prompt: normPlain, boundBody: content }];

    const companionPlain = plainCandidates.find(p =>
      promptMatchTargets(p).some(t => hasContextCompanionRelation(t.text, content)),
    );
    if (companionPlain) return [{ prompt: companionPlain, boundBody: content }];

    const slashEchoMatches = plainCandidates.filter(p =>
      matchesTargetOrCompanionWithSlashEcho(content, normRaw, promptMatchTargets(p), promptAllowedSlashTokens(p), true),
    );
    const slashEchoWinner = selectUnambiguousPrefixMatch(slashEchoMatches);
    if (slashEchoWinner) return [{ prompt: slashEchoWinner, boundBody: content }];

    const trimmedContent = content.trim();
    if (!TRUNCATION_SUFFIX_RE.test(trimmedContent)) return [];
    const strippedRow = collapseWhitespace(trimmedContent.replace(TRUNCATION_SUFFIX_RE, ''));
    const prefixMatches = plainCandidates.filter(p =>
      promptMatchTargets(p).some(t => t.tagCount === 0 && matchesTruncatedPlainPrefix(strippedRow, t.normText)),
    );
    const winner = selectUnambiguousPrefixMatch(prefixMatches);
    return winner ? [{ prompt: winner, boundBody: content }] : [];
  }

  private boundCompanionCandidates(): Prompt[] {
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
    return candidates;
  }

  private findBoundCompanionPrompt(candidateBody: string | undefined, isPlain: boolean): Prompt | undefined {
    if (!candidateBody) return undefined;
    const candidates = this.boundCompanionCandidates();
    if (candidates.length === 0) return undefined;
    return candidates.find(p => promptMatchesBoundCompanionBody(p, candidateBody, isPlain));
  }

  private bindMatchedPrompt(prompt: Prompt, row: AgyTranscriptRow, boundBody: string): void {
    this.lane = prompt.generation;
    prompt.inputStep = row.step_index;
    if (boundBody) {
      prompt.boundBody = boundBody;
      prompt.boundNormBody = collapseWhitespace(boundBody);
    }
    prompt.bindSeq = ++this.bindSeq;
    this.latestBound = { generation: prompt.generation, bindSeq: prompt.bindSeq };
    this.lastBoundGeneration = Math.max(this.lastBoundGeneration, prompt.generation);
    if (this.retainedLane && this.retainedLane.generation !== prompt.generation) {
      const superseded = this.retainedLane;
      this.retainedLane = undefined;
      superseded.resolve();
    }
  }

  private clearActiveLane(): void {
    this.lane = undefined;
    if (this.retainedLane) {
      const superseded = this.retainedLane;
      this.retainedLane = undefined;
      superseded.resolve();
    }
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

  private attributeLastResponse(prompt: Prompt, allowNonSubagentToolFallback = false): AgyTranscriptRow | undefined {
    prompt.settling = true;
    prompt.settlingSince ??= Date.now();
    if (
      !prompt.output
      && prompt.lastResponse
      && (isTerminalForegroundRow(prompt.lastResponse)
        || (allowNonSubagentToolFallback && isNonSubagentToolFallbackRow(prompt.lastResponse)))
    ) {
      prompt.output = prompt.lastResponse;
      this.recordLatest(prompt, prompt.output);
      if (this.lane === prompt.generation) this.lane = undefined;
      if (this.retainedLane?.generation === prompt.generation) this.retainedLane = undefined;
      prompt.resolve();
      this.notifyStateChange();
    }
    return prompt.output;
  }

  observe(row: AgyTranscriptRow, cursorOrByteEnd?: AgyTranscriptCursor | number): boolean {
    if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT') {
      const content = row.content ?? '';
      let unbound = [...this.prompts.values()].filter(p => p.inputStep === undefined && p.text);
      const normRaw = collapseWhitespace(content);

      // 1. Direct raw payload fidelity (exact, trimmed, or whitespace-normalized full equality).
      if (content && unbound.length > 0) {
        const exactRaw = unbound.find(p =>
          promptMatchTargets(p).some(t => content === t.text || content.trim() === t.text.trim()),
        ) ?? (normRaw
          ? unbound.find(p => promptMatchTargets(p).some(t => t.normText.length > 0 && normRaw === t.normText))
          : undefined);
        if (exactRaw) {
          this.bindMatchedPrompt(exactRaw, row, content);
          this.notifyStateChange();
          return false;
        }
      }

      // 2. Parse single/coalesced wrapped <USER_REQUEST> envelopes or plain text.
      const envelopes = content ? parseNativeInputEnvelopes(content) : { kind: 'invalid' as const, bodies: [] };
      if (envelopes.kind === 'invalid') {
        if (this.findBoundCompanionPrompt(content, true)) return false;
        this.clearActiveLane();
        this.notifyStateChange();
        return false;
      }

      if (envelopes.kind === 'wrapped') {
        let stateChanged = false;
        for (const body of envelopes.bodies) {
          unbound = unbound.filter(p => p.inputStep === undefined);
          const matched = unbound.length > 0 ? this.matchSingleWrappedBody(body, unbound) : [];
          if (matched.length > 0) {
            for (const entry of matched) {
              this.bindMatchedPrompt(entry.prompt, row, entry.boundBody);
            }
            stateChanged = true;
          } else if (this.findBoundCompanionPrompt(body, false)) {
            // Keep active lane intact across companion echoes.
          } else {
            this.clearActiveLane();
            stateChanged = true;
          }
        }
        if (stateChanged) this.notifyStateChange();
        return false;
      }

      // envelopes.kind === 'plain'
      const matchedPlain = normRaw && unbound.length > 0 ? this.matchPlainBody(content, normRaw, unbound) : [];
      if (matchedPlain.length > 0) {
        for (const entry of matchedPlain) {
          this.bindMatchedPrompt(entry.prompt, row, entry.boundBody);
        }
        this.notifyStateChange();
        return false;
      }
      if (this.findBoundCompanionPrompt(content, true)) {
        return false;
      }
      this.clearActiveLane();
      this.notifyStateChange();
      return false;
    } else if (row.type === 'USER_INPUT') {
      const prompt = this.activeLanePrompt();
      if (prompt && !prompt.output && prompt.lastResponse?.tool_calls?.length) {
        prompt.lastResponse = undefined;
        prompt.lastResponseAt = undefined;
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
      prompt.lastResponseAt = Date.now();
      if (!row.tool_calls?.length || (prompt.settling && isTerminalForegroundRow(row))) {
        prompt.output = row;
        this.recordLatest(prompt, prompt.output);
        if (this.lane === prompt.generation) this.lane = undefined;
        if (this.retainedLane?.generation === prompt.generation) this.retainedLane = undefined;
        prompt.resolve();
        this.notifyStateChange();
        return true;
      }
      if (prompt.settling) {
        this.notifyStateChange();
      }
      return false;
    }
    return false;
  }

  settle(generation: number): AgyTranscriptRow | undefined {
    const prompt = this.prompts.get(generation);
    if (!prompt) return undefined;
    prompt.settling = true;
    prompt.settlingSince ??= Date.now();
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
      const graceCandidate = prompt.inputStep !== undefined ? prompt : adoptable;
      const gracePeriodMs = Number.isFinite(this.deadlineMs) && this.deadlineMs > 0
        ? Math.min(NON_SUBAGENT_TOOL_SETTLE_GRACE_MS, this.deadlineMs)
        : NON_SUBAGENT_TOOL_SETTLE_GRACE_MS;
      const graceEndAt = graceCandidate?.settling
        && graceCandidate.inputStep !== undefined
        && isNonSubagentToolFallbackRow(graceCandidate.lastResponse)
        ? Math.max(graceCandidate.settlingSince ?? Date.now(), graceCandidate.lastResponseAt ?? 0) + gracePeriodMs
        : undefined;
      const stateWait = this.getStateChangePromise();
      const waitPromise = adoptable
        ? Promise.race([prompt.ready, adoptable.ready, stateWait])
        : Promise.race([prompt.ready, stateWait]);
      const now = Date.now();
      const remainingDeadlineMs = endAt === undefined ? this.deadlineMs : endAt - now;
      const remainingGraceMs = graceEndAt === undefined ? undefined : Math.max(0, graceEndAt - now);
      const waitMs = remainingGraceMs === undefined
        ? remainingDeadlineMs
        : Number.isFinite(remainingDeadlineMs)
          ? Math.min(remainingDeadlineMs, remainingGraceMs)
          : remainingGraceMs;
      const timedOut = waitMs <= 0 && (endAt !== undefined || graceEndAt !== undefined)
        ? true
        : (await withTimeoutOutcome(waitPromise, waitMs)).timedOut;
      if (timedOut) {
        const current = this.prompts.get(generation);
        if (!current) return undefined;
        if (current.output) return current.output;
        if (this.hasBoundSuccessor(generation)) return undefined;
        const settledNow = Date.now();
        const activeCandidate = current.inputStep !== undefined ? current : adoptable;
        if (
          graceEndAt !== undefined
          && activeCandidate?.settling
          && activeCandidate.inputStep !== undefined
          && isNonSubagentToolFallbackRow(activeCandidate.lastResponse)
        ) {
          const latestGraceEndAt = Math.max(activeCandidate.settlingSince ?? settledNow, activeCandidate.lastResponseAt ?? 0) + gracePeriodMs;
          if (settledNow >= latestGraceEndAt) {
            return this.attributeLastResponse(activeCandidate, true);
          }
          if (endAt === undefined || settledNow < endAt) {
            continue;
          }
        }
        if (endAt !== undefined && settledNow < endAt) {
          continue;
        }
        if (
          current.inputStep !== undefined
          && (isTerminalForegroundRow(current.lastResponse) || isNonSubagentToolFallbackRow(current.lastResponse))
        ) {
          return this.attributeLastResponse(current, true);
        }
        if (current.inputStep === undefined) {
          const settled = this.settle(generation);
          if (settled) return settled;
          if (adoptable && isNonSubagentToolFallbackRow(adoptable.lastResponse)) {
            return this.attributeLastResponse(adoptable, true);
          }
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
      this.notifyStateChange();
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
    this.notifyStateChange();
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
    this.notifyStateChange();
  }

  clear(): void {
    this.releaseTurn();
    this.authoritative = false;
  }
}
