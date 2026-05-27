import { describe, expect, it } from 'vitest';
import {
  composeMessageSideProviderPrompt,
  composeProviderSystemText,
  getProviderSystemTextParts,
} from '../../src/agent/provider-context-routing.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';

function makePayload(overrides: Partial<ProviderContextPayload> = {}): ProviderContextPayload {
  const { context: contextOverrides, ...payloadOverrides } = overrides;
  const payload: ProviderContextPayload = {
    userMessage: 'ship it',
    assembledMessage: 'Relevant history\n\nship it',
    messagePreamble: 'Relevant history',
    attachments: undefined,
    context: {
      requiredAuthoredContext: [],
      advisoryAuthoredContext: [],
      appliedDocumentVersionIds: [],
      diagnostics: [],
    },
    authority: {
      namespace: { scope: 'personal', projectId: 'repo' },
      authoritySource: 'none',
      freshness: 'missing',
      fallbackAllowed: true,
      retryScheduled: false,
      providerPolicyOutcome: 'allowed',
      diagnostics: [],
    },
    supportClass: 'degraded-message-side-context-mapping',
    diagnostics: [],
    ...payloadOverrides,
  };
  payload.context = {
    requiredAuthoredContext: [],
    advisoryAuthoredContext: [],
    appliedDocumentVersionIds: [],
    diagnostics: [],
    ...(contextOverrides ?? {}),
  };
  return payload;
}

describe('provider context routing', () => {
  it('splits stable session instructions from turn-scoped instructions', () => {
    const payload = makePayload({
      sessionSystemText: 'Stable runtime rules',
      turnSystemText: 'Required shared context:\n- Active file rule',
      systemText: 'Stable runtime rules\n\nRequired shared context:\n- Active file rule',
      context: {
        sessionSystemText: 'Stable runtime rules',
        turnSystemText: 'Required shared context:\n- Active file rule',
        systemText: 'Stable runtime rules\n\nRequired shared context:\n- Active file rule',
        messagePreamble: 'Relevant history',
        requiredAuthoredContext: ['Active file rule'],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: ['doc-v1'],
        diagnostics: [],
      },
    });

    expect(getProviderSystemTextParts(payload)).toMatchObject({
      hasSplitSystemText: true,
      sessionSystemText: 'Stable runtime rules',
      turnSystemText: 'Required shared context:\n- Active file rule',
    });
    expect(composeProviderSystemText(payload)).toBe('Stable runtime rules\n\nRequired shared context:\n- Active file rule');
    expect(composeProviderSystemText(payload, { includeSession: false })).toBe('Required shared context:\n- Active file rule');
    expect(composeMessageSideProviderPrompt(payload, { includeSessionSystemText: false })).toBe(
      'Context instructions:\nRequired shared context:\n- Active file rule\n\nRelevant history\n\nship it',
    );
    expect(composeMessageSideProviderPrompt(payload, { includeSessionSystemText: false, labelContextInstructions: false })).toBe(
      'Required shared context:\n- Active file rule\n\nRelevant history\n\nship it',
    );
  });

  it('keeps legacy unsplit payloads unchanged for provider adapters', () => {
    const payload = makePayload({
      systemText: 'Legacy system text',
      context: {
        systemText: 'Legacy system text',
        messagePreamble: 'Relevant history',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
    });

    expect(getProviderSystemTextParts(payload).hasSplitSystemText).toBe(false);
    expect(composeProviderSystemText(payload, { includeSession: false })).toBe('Legacy system text');
    expect(composeMessageSideProviderPrompt(payload, { includeSessionSystemText: false })).toBe(
      'Context instructions:\nLegacy system text\n\nRelevant history\n\nship it',
    );
  });

  it('falls back to context split fields when top-level split fields are empty strings', () => {
    const payload = makePayload({
      sessionSystemText: '',
      turnSystemText: '   ',
      context: {
        sessionSystemText: 'Context stable rules',
        turnSystemText: 'Context turn rules',
        systemText: 'Context stable rules\n\nContext turn rules',
        messagePreamble: 'Relevant history',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
    });

    expect(getProviderSystemTextParts(payload)).toMatchObject({
      hasSplitSystemText: true,
      sessionSystemText: 'Context stable rules',
      turnSystemText: 'Context turn rules',
      combinedSystemText: 'Context stable rules\n\nContext turn rules',
    });
  });

  it('falls back to legacy system text when split fields are present but empty', () => {
    const payload = makePayload({
      sessionSystemText: '',
      turnSystemText: '   ',
      systemText: 'Legacy combined system rules',
      context: {
        sessionSystemText: '',
        turnSystemText: ' ',
        systemText: 'Legacy combined system rules',
        messagePreamble: 'Relevant history',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
    });

    expect(getProviderSystemTextParts(payload)).toMatchObject({
      hasSplitSystemText: false,
      sessionSystemText: 'Legacy combined system rules',
      combinedSystemText: 'Legacy combined system rules',
    });
    expect(composeProviderSystemText(payload, { includeSession: false })).toBe('Legacy combined system rules');
  });

  it('does not merge legacy system text when split fields contain real content', () => {
    const payload = makePayload({
      sessionSystemText: 'Stable split rules',
      turnSystemText: '',
      systemText: 'Legacy combined system rules',
      context: {
        sessionSystemText: 'Stable split rules',
        turnSystemText: '',
        systemText: 'Legacy combined system rules',
        messagePreamble: 'Relevant history',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
    });

    expect(getProviderSystemTextParts(payload)).toMatchObject({
      hasSplitSystemText: true,
      sessionSystemText: 'Stable split rules',
      turnSystemText: undefined,
      combinedSystemText: 'Stable split rules',
    });
    expect(composeProviderSystemText(payload)).toBe('Stable split rules');
  });
});
