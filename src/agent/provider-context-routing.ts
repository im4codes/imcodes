import type { ProviderContextPayload } from '../../shared/context-types.js';
import { joinSpanned, offsetIdentitySpan, verifyIdentitySpan, type SpannedText } from './priority-preserving-context-cap.js';

export interface ProviderSystemTextParts {
  hasSplitSystemText: boolean;
  sessionSystemText?: string;
  turnSystemText?: string;
  combinedSystemText?: string;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function getProviderSystemTextParts(payload: ProviderContextPayload): ProviderSystemTextParts {
  const legacySystemText = trimOrUndefined(payload.systemText)
    ?? trimOrUndefined(payload.context.systemText);
  const hasSplitSystemText = payload.sessionSystemText !== undefined
    || payload.turnSystemText !== undefined
    || payload.context.sessionSystemText !== undefined
    || payload.context.turnSystemText !== undefined;

  if (!hasSplitSystemText) {
    return {
      hasSplitSystemText: false,
      sessionSystemText: legacySystemText,
      combinedSystemText: legacySystemText,
    };
  }

  const sessionSystemText = trimOrUndefined(payload.sessionSystemText)
    ?? trimOrUndefined(payload.context.sessionSystemText);
  const turnSystemText = trimOrUndefined(payload.turnSystemText)
    ?? trimOrUndefined(payload.context.turnSystemText);
  if (!sessionSystemText && !turnSystemText && legacySystemText) {
    return {
      hasSplitSystemText: false,
      sessionSystemText: legacySystemText,
      combinedSystemText: legacySystemText,
    };
  }
  return {
    hasSplitSystemText: true,
    sessionSystemText,
    turnSystemText,
    combinedSystemText: [sessionSystemText, turnSystemText].filter(Boolean).join('\n\n') || undefined,
  };
}

export function composeProviderSystemText(
  payload: ProviderContextPayload,
  options: {
    includeSession?: boolean;
    includeTurn?: boolean;
  } = {},
): string | undefined {
  const includeSession = options.includeSession ?? true;
  const includeTurn = options.includeTurn ?? true;
  const parts = getProviderSystemTextParts(payload);
  if (!parts.hasSplitSystemText) {
    return parts.combinedSystemText;
  }
  return [
    includeSession ? parts.sessionSystemText : undefined,
    includeTurn ? parts.turnSystemText : undefined,
  ].filter(Boolean).join('\n\n') || undefined;
}

export function composeMessageSideProviderPrompt(
  payload: ProviderContextPayload,
  options: {
    includeSessionSystemText?: boolean;
    labelContextInstructions?: boolean;
  } = {},
): string {
  const includeSession = options.includeSessionSystemText ?? true;
  const labelContextInstructions = options.labelContextInstructions ?? true;
  const systemText = composeProviderSystemText(payload, { includeSession, includeTurn: true });
  const contextText = systemText
    ? (labelContextInstructions ? `Context instructions:\n${systemText}` : systemText)
    : undefined;
  return [contextText, payload.assembledMessage]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The stable session system text as providers see it (trimmed), together with the
 * identity span recorded at assembly time, re-based for the trim and verified
 * against the exact bytes. Never derived by searching the text.
 */
export function getProviderSessionSystemTextSpanned(payload: ProviderContextPayload): SpannedText | undefined {
  const parts = getProviderSystemTextParts(payload);
  const text = parts.sessionSystemText;
  if (!text) return undefined;
  const raw = parts.hasSplitSystemText
    ? (payload.sessionSystemText?.trim() ? payload.sessionSystemText : payload.context.sessionSystemText)
    : (payload.systemText?.trim() ? payload.systemText : payload.context.systemText);
  const leadingTrim = raw ? raw.length - raw.trimStart().length : 0;
  // In the legacy combined view the session text is the prefix of systemText, so
  // the same recorded span applies there too; verification rejects it otherwise.
  const identity = verifyIdentitySpan(text, offsetIdentitySpan(payload.context.sessionSystemTextIdentity, -leadingTrim));
  return identity ? { text, identity } : { text };
}

/** Span-carrying counterpart of {@link composeProviderSystemText}. */
export function composeProviderSystemTextSpanned(
  payload: ProviderContextPayload,
  options: { includeSession?: boolean; includeTurn?: boolean } = {},
): SpannedText | undefined {
  const includeSession = options.includeSession ?? true;
  const includeTurn = options.includeTurn ?? true;
  const parts = getProviderSystemTextParts(payload);
  const session = getProviderSessionSystemTextSpanned(payload);
  if (!parts.hasSplitSystemText) {
    // Legacy combined text: identity can only be honoured when the combined text
    // is exactly the verified session text (checked by the span's hash).
    return session;
  }
  return joinSpanned([
    includeSession ? session : undefined,
    includeTurn ? parts.turnSystemText : undefined,
  ], '\n\n');
}
