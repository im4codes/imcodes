import { isUserVisible } from './util/isUserVisible.js';
import {
  extractAskQuestionsFromToolCallPayload,
  isAskQuestionToolName,
  normalizeAskQuestionsPayload,
  resolveAskQuestionEventToolUseId,
} from '@shared/ask-question-normalize.js';

export const PRE_ASK_FLUSH_REORDER_WINDOW_MS = 2000;

export interface TrailingAskQuestion {
  toolUseId: string;
  questions: unknown[];
  waitMs?: number;
}

interface MinimalEvent {
  eventId?: string;
  type: string;
  ts?: number;
  hidden?: boolean;
  payload?: Record<string, unknown> & { streaming?: boolean };
}

function isWithinPreAskFlushWindow(askTs: number | undefined, trailingAssistantTextTs: readonly number[]): boolean {
  if (trailingAssistantTextTs.length === 0) return true;
  if (typeof askTs !== 'number' || !Number.isFinite(askTs)) return false;
  for (const textTs of trailingAssistantTextTs) {
    const delta = textTs - askTs;
    if (delta < 0 || delta > PRE_ASK_FLUSH_REORDER_WINDOW_MS) return false;
  }
  return true;
}

/**
 * Find an ask.question the agent is still waiting on, by looking at the TAIL of
 * the timeline: if the most recent user-visible event is an `ask.question` (or a
 * fallback raw `tool.call` for `ask_question` / `AskUserQuestion` from an older
 * daemon without a subsequent result or reply), the agent asked and nothing has
 * followed — it's still pending. Any later visible message (or matching
 * `tool.result`) means it's no longer awaiting input, so return null.
 *
 * Legacy daemon tolerance: older daemons can flush a pre-ask `assistant.text`
 * slightly after `ask.question` in the same turn (observed ~59ms later). When no
 * `user.message` or `tool.result` follows and the trailing `assistant.text`
 * carries a finite `ts` within `0 <= text.ts - ask.ts <= 2000`, tolerate it
 * without reopening older questions that lack timestamps or arrive later.
 */
export function findTrailingAskQuestion(events: readonly MinimalEvent[]): TrailingAskQuestion | null {
  const completedToolIds = new Set<string>();
  let sawUnidentifiedToolResult = false;
  const trailingAssistantTextTs: number[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.hidden) continue;
    if (event.type === 'tool.result') {
      const id = event.payload?.toolCallId ?? event.payload?.toolUseId ?? event.payload?.id;
      if ((typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id))) {
        completedToolIds.add(String(id));
      } else {
        sawUnidentifiedToolResult = true;
      }
      continue;
    }
    if (event.type === 'tool.call' && isAskQuestionToolName(event.payload?.tool)) {
      const questions = extractAskQuestionsFromToolCallPayload(event.payload);
      if (questions.length === 0) continue;
      if (event.payload?._merged === true || event.payload?._toolFailed === true) return null;
      if (!isWithinPreAskFlushWindow(event.ts, trailingAssistantTextTs)) return null;
      const toolUseId = resolveAskQuestionEventToolUseId(event);
      if ((toolUseId && completedToolIds.has(toolUseId)) || sawUnidentifiedToolResult) return null;
      return {
        toolUseId,
        questions,
        ...(typeof event.payload?.waitMs === 'number' ? { waitMs: event.payload.waitMs } : {}),
      };
    }
    if (!isUserVisible(event)) continue;
    if (event.type === 'assistant.text') {
      if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) return null;
      trailingAssistantTextTs.push(event.ts);
      continue;
    }
    if (event.type !== 'ask.question') return null; // a later visible message → not waiting
    if (!isWithinPreAskFlushWindow(event.ts, trailingAssistantTextTs)) return null;
    const questions = normalizeAskQuestionsPayload(event.payload?.questions);
    if (questions.length === 0) return null;
    const toolUseId = resolveAskQuestionEventToolUseId(event);
    if ((toolUseId && completedToolIds.has(toolUseId)) || sawUnidentifiedToolResult) return null;
    return {
      toolUseId,
      questions,
      ...(typeof event.payload?.waitMs === 'number' ? { waitMs: event.payload.waitMs } : {}),
    };
  }
  return null;
}

function isAnyAskBoundaryEvent(event: MinimalEvent): boolean {
  return event.type === 'ask.question'
    || (event.type === 'tool.call' && isAskQuestionToolName(event.payload?.tool));
}

function isAskTimelineEvent(event: MinimalEvent): boolean {
  if (event.type === 'ask.question') return normalizeAskQuestionsPayload(event.payload?.questions).length > 0;
  if (event.type === 'tool.call' && isAskQuestionToolName(event.payload?.tool)) {
    return extractAskQuestionsFromToolCallPayload(event.payload).length > 0;
  }
  return false;
}

function readUserMessageAskToolUseId(payload: Record<string, unknown> | undefined): string {
  const raw = payload?.askToolUseId;
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

function readToolResultAnswerText(payload: Record<string, unknown> | undefined): string {
  if (!payload || payload._toolFailed === true || payload._isError === true || payload.isError === true) return '';
  const raw = payload.output ?? payload.result ?? payload.text;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Resolve concise human/tool answer text for answered `ask.question` and raw
 * ask `tool.call` events so historical & just-submitted timeline cards can render
 * a compact summary without duplicating unselected option boxes.
 *
 * Precedence:
 * 1. Local just-submitted answer in this ChatView instance (`submittedAskAnswers`).
 * 2. Explicit `user.message` whose `payload.askToolUseId` matches `toolUseId`.
 * 3. For raw `tool.call`, matching `tool.result` output (or pre-merged output).
 * 4. Immediate unattributed visible `user.message`, stopping at any visible
 *    `assistant.text`, any subsequent ask (including empty payloads), or any
 *    `user.message` bound to another `askToolUseId`.
 */
export function resolveAskQuestionAnswerMap(
  events: readonly MinimalEvent[],
  submittedAskAnswers?: Readonly<Record<string, string>>,
): Map<string, string> {
  const answers = new Map<string, string>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event.eventId || !isAskTimelineEvent(event)) continue;

    const directSubmitted = submittedAskAnswers?.[event.eventId]?.trim();
    const toolUseId = resolveAskQuestionEventToolUseId(event);
    const byToolSubmitted = toolUseId ? submittedAskAnswers?.[toolUseId]?.trim() : '';
    if (directSubmitted || byToolSubmitted) {
      answers.set(event.eventId, (directSubmitted || byToolSubmitted)!);
      continue;
    }

    if (toolUseId) {
      let explicitReply = '';
      for (let j = i + 1; j < events.length; j++) {
        const next = events[j];
        if (next.hidden) continue;
        if (next.type === 'user.message' && readUserMessageAskToolUseId(next.payload) === toolUseId) {
          const text = String(next.payload?.text ?? '').trim();
          if (text) {
            explicitReply = text;
            break;
          }
        }
      }
      if (explicitReply) {
        answers.set(event.eventId, explicitReply);
        continue;
      }
    }

    let resolvedFallback = '';
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      if (next.hidden) continue;
      if (isAnyAskBoundaryEvent(next)) {
        const nextToolUseId = resolveAskQuestionEventToolUseId(next);
        if (toolUseId && nextToolUseId === toolUseId) continue;
        break;
      }
      if (next.type === 'tool.result' && toolUseId) {
        const resId = next.payload?.toolCallId ?? next.payload?.toolUseId ?? next.payload?.id;
        if (resId !== undefined && resId !== null && String(resId) === toolUseId) {
          if (event.type === 'tool.call') {
            resolvedFallback = readToolResultAnswerText(next.payload);
          }
          break;
        }
      }
      if (next.type === 'user.message' && isUserVisible(next)) {
        const msgToolUseId = readUserMessageAskToolUseId(next.payload);
        if (msgToolUseId) break;
        const text = String(next.payload?.text ?? '').trim();
        if (text) resolvedFallback = text;
        break;
      }
      if (next.type === 'assistant.text' && isUserVisible(next)) {
        break;
      }
    }
    if (resolvedFallback) {
      answers.set(event.eventId, resolvedFallback);
      continue;
    }

    if (event.type === 'tool.call') {
      const preMergedOut = readToolResultAnswerText(event.payload);
      if (preMergedOut) {
        answers.set(event.eventId, preMergedOut);
      }
    }
  }
  return answers;
}
