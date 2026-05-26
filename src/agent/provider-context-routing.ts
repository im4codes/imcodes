import type { ProviderContextPayload } from '../../shared/context-types.js';

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
  const hasSplitSystemText = payload.sessionSystemText !== undefined
    || payload.turnSystemText !== undefined
    || payload.context.sessionSystemText !== undefined
    || payload.context.turnSystemText !== undefined;

  if (!hasSplitSystemText) {
    const systemText = trimOrUndefined(payload.systemText);
    return {
      hasSplitSystemText: false,
      sessionSystemText: systemText,
      combinedSystemText: systemText,
    };
  }

  const sessionSystemText = trimOrUndefined(payload.sessionSystemText)
    ?? trimOrUndefined(payload.context.sessionSystemText);
  const turnSystemText = trimOrUndefined(payload.turnSystemText)
    ?? trimOrUndefined(payload.context.turnSystemText);
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
