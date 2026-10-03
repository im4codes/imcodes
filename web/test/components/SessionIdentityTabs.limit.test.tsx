/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import {
  SESSION_IDENTITY_SCOPES,
  SESSION_IDENTITY_SESSION_MAX_CHARS,
  sessionIdentityContentError,
  sessionIdentityMaxChars,
  type SessionIdentityScope,
} from '@shared/session-identity.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}|${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../src/api.js', () => ({
  fetchSessionIdentityProfile: vi.fn(async () => null),
  saveSessionIdentityProfile: vi.fn(),
  clearSessionIdentityProfile: vi.fn(),
}));
vi.mock('../../src/session-identity-refresh.js', () => ({ requestSessionIdentityRefresh: vi.fn() }));
vi.mock('../../src/components/file-browser-lazy.js', () => ({ FileBrowser: () => null }));

import { SessionIdentityTabs } from '../../src/components/SessionIdentityTabs.js';
import { fetchSessionIdentityProfile } from '../../src/api.js';

afterEach(() => { cleanup(); vi.mocked(fetchSessionIdentityProfile).mockReset(); });

function renderPending(content: string) {
  return render(h(SessionIdentityTabs, { serverId: 'srv', pendingSessionIdentity: content }));
}

describe('SessionIdentityTabs session limit', () => {
  it('shows the raised limit and no error at exactly the session limit', async () => {
    const { container } = renderPending('😀'.repeat(SESSION_IDENTITY_SESSION_MAX_CHARS));
    await waitFor(() => expect(container.textContent).toContain('session.identityCharacterCount'));
    expect(container.textContent).toContain(`"limit":${SESSION_IDENTITY_SESSION_MAX_CHARS}`);
    expect(container.textContent).toContain(`"count":${SESSION_IDENTITY_SESSION_MAX_CHARS}`);
    expect(container.textContent).not.toContain('session.identityTooLargeScoped');
  });

  it('accepts limit-1 without an error', async () => {
    const { container } = renderPending('😀'.repeat(SESSION_IDENTITY_SESSION_MAX_CHARS - 1));
    await waitFor(() => expect(container.textContent).toContain('session.identityCharacterCount'));
    expect(container.textContent).not.toContain('session.identityTooLargeScoped');
  });

  it('reports the scoped limit one code point over it', async () => {
    const { container } = renderPending('😀'.repeat(SESSION_IDENTITY_SESSION_MAX_CHARS + 1));
    await waitFor(() => expect(container.textContent).toContain('session.identityTooLargeScoped'));
    expect(container.textContent).toContain(`session.identityTooLargeScoped|{"limit":${SESSION_IDENTITY_SESSION_MAX_CHARS}}`);
  });
});

/** The counter text `session.identityCharacterCount|{"count":N,"limit":L}` rendered by the panel. */
function displayed(container: HTMLElement): { count: number; limit: number } {
  const match = /session\.identityCharacterCount\|(\{[^}]*\})/.exec(container.textContent ?? '');
  if (!match) throw new Error('character counter not rendered');
  return JSON.parse(match[1]!) as { count: number; limit: number };
}

/** Render the panel with `content` in `scope` (loaded profile for user/project, pending draft for session). */
async function renderScope(scope: SessionIdentityScope, content: string) {
  vi.mocked(fetchSessionIdentityProfile).mockImplementation(async (requested) => (
    requested === scope ? { scope, scopeKey: '', content, revision: 1, updatedAt: 0 } as never : null
  ));
  const view = render(h(SessionIdentityTabs, {
    serverId: 'srv',
    projectKey: 'github.com/acme/repo',
    ...(scope === SESSION_IDENTITY_SCOPES.SESSION ? { pendingSessionIdentity: content } : {}),
  }));
  if (scope !== SESSION_IDENTITY_SCOPES.SESSION) {
    fireEvent.click(view.getByText(`session.identityScope_${scope}`));
  }
  await waitFor(() => expect(view.container.textContent).toContain(`"limit":${sessionIdentityMaxChars(scope)}`));
  await waitFor(() => expect((view.getByLabelText('session-identity-content') as HTMLTextAreaElement).value).toBe(content));
  return view;
}

describe('SessionIdentityTabs counts in the authoritative unit (NFC + trim code points) for every scope', () => {
  const decomposed = (n: number) => 'e\u0301'.repeat(n); // NFC composes each pair into one code point (é)
  const padded = (n: number) => ` \n\t${'a'.repeat(n)}\n  `;
  const cases: Array<[string, (limit: number) => string, number, boolean]> = [
    ['NFC-decomposed content at the limit', (limit) => decomposed(limit), 0, false],
    ['NFC-decomposed content one over the limit', (limit) => decomposed(limit + 1), 1, true],
    ['content at the limit with surrounding whitespace', (limit) => padded(limit), 0, false],
    ['content one over the limit with surrounding whitespace', (limit) => padded(limit + 1), 1, true],
  ];
  for (const scope of [SESSION_IDENTITY_SCOPES.USER, SESSION_IDENTITY_SCOPES.PROJECT, SESSION_IDENTITY_SCOPES.SESSION]) {
    for (const [label, build, over, tooLarge] of cases) {
      it(`${scope}: ${label}`, async () => {
        const limit = sessionIdentityMaxChars(scope);
        const content = build(limit);
        // The raw string is far longer than the authoritative length; a raw counter would disagree.
        expect(Array.from(content).length).toBeGreaterThan(limit + over);
        const { container } = await renderScope(scope, content);

        expect(displayed(container)).toEqual({ count: limit + over, limit });
        // The displayed count and the gate agree: over the displayed limit <=> the gate rejects.
        expect(sessionIdentityContentError(content, scope) !== null).toBe(tooLarge);
        expect(displayed(container).count > limit).toBe(tooLarge);
        expect(container.textContent?.includes('session.identityTooLargeScoped')).toBe(tooLarge);
      });
    }
  }
});
