import { describe, expect, it } from 'vitest';
import { normalizeProviderPayload } from '../../src/agent/transport-provider.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';

describe('normalizeProviderPayload', () => {
  it('preserves normalized payloads without inventing legacy context fields', () => {
    const payload: ProviderContextPayload = {
      userMessage: 'hello',
      assembledMessage: 'hello',
      systemText: 'system',
      messagePreamble: 'preamble',
      attachments: [],
      context: {
        systemText: 'system',
        messagePreamble: 'preamble',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'repo', userId: 'user-1' },
        authoritySource: 'processed_local',
        freshness: 'fresh',
        fallbackAllowed: false,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    };

    expect(normalizeProviderPayload(payload)).toBe(payload);
  });

  it('rejects dual-authority legacy extraSystemPrompt alongside a normalized payload', () => {
    const payload: ProviderContextPayload = {
      userMessage: 'hello',
      assembledMessage: 'hello',
      systemText: 'system',
      messagePreamble: undefined,
      attachments: [],
      context: {
        systemText: 'system',
        messagePreamble: undefined,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1' },
        authoritySource: 'processed_remote',
        freshness: 'fresh',
        fallbackAllowed: false,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    };

    expect(() => normalizeProviderPayload(payload, undefined, 'legacy raw context')).toThrow(
      /must not be combined with legacy extraSystemPrompt/i,
    );
  });
});
