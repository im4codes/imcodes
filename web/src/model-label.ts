import { bestModelLabel } from '../../src/shared/models/label.js';

export { shortModelLabel, bestModelLabel } from '../../src/shared/models/label.js';

/** Shared compact display helper: keep selection/version priority and raw model IDs separate. */
export function formatModelPresentation(...models: Array<string | null | undefined>): {
  label: string | null;
  title: string | undefined;
} {
  const label = bestModelLabel(...models);
  const fullModels = models.map((model) => model?.trim()).filter((model): model is string => Boolean(model));
  return {
    label: label?.split('-').slice(-2).join('-') ?? null,
    title: [...new Set(fullModels)].join(' · ') || undefined,
  };
}

export const SUBSESSION_CARD_MODEL_MAX_LENGTH = 9;
const MIN_ELIDED_WORD_LENGTH = 3;

function elideMiddleWithDot(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;
  if (maxLength === 1) return '.';
  const keep = maxLength - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}.${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

/**
 * Compact a model label to fit a narrow 54px sub-session card on a single line
 * by eliding the middle characters of long word segment(s) with `.`.
 * Leaves `subSessionModelPresentation` / `UsageFooter` labels unchanged.
 */
export function compactSubSessionModelLabel(
  label?: string | null,
  maxLength = SUBSESSION_CARD_MODEL_MAX_LENGTH,
): string | null {
  const trimmed = label?.trim();
  if (!trimmed) return null;
  if (maxLength <= 0) return '';
  if (trimmed.length <= maxLength) return trimmed;

  const parts = trimmed.split(/([-_\s]+)/).map((token) => ({
    original: token,
    isSep: /^[-_\s]+$/.test(token),
    targetLen: token.length,
  }));

  let totalLength = trimmed.length;
  while (totalLength > maxLength) {
    let longestIdx = -1;
    let longestLen = MIN_ELIDED_WORD_LENGTH;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part.isSep && part.targetLen > longestLen) {
        longestLen = part.targetLen;
        longestIdx = i;
      }
    }
    if (longestIdx === -1) break;
    parts[longestIdx].targetLen -= 1;
    totalLength -= 1;
  }

  if (totalLength > maxLength) {
    return elideMiddleWithDot(trimmed, maxLength);
  }

  return parts
    .map((part) => (part.isSep ? part.original : elideMiddleWithDot(part.original, part.targetLen)))
    .join('');
}

export const subSessionModelPresentation = formatModelPresentation;
