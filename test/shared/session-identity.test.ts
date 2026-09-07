import { describe, expect, it } from 'vitest';
import {
  SESSION_IDENTITY_MAX_CHARS,
  SESSION_IDENTITY_MAX_UTF8_BYTES,
  SESSION_IDENTITY_PROJECT_MAX_CHARS,
  SESSION_IDENTITY_SCOPES,
  SESSION_IDENTITY_SESSION_MAX_CHARS,
  SESSION_IDENTITY_USER_MAX_CHARS,
  renderSessionIdentityProfiles,
  sessionIdentityContentError,
  sessionIdentityScopeKeyError,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';

function profile(scope: SessionIdentityProfile['scope'], content: string): SessionIdentityProfile {
  return {
    scope,
    scopeKey: scope === 'user' ? '' : `${scope}-key`,
    content,
    contentHash: `${scope}-hash`,
    revision: 1,
    updatedAt: 1,
    source: 'mcp',
  };
}

describe('session identity contracts', () => {
  it('renders user -> project -> session in deterministic override order', () => {
    const rendered = renderSessionIdentityProfiles([
      profile(SESSION_IDENTITY_SCOPES.SESSION, 'session rule'),
      profile(SESSION_IDENTITY_SCOPES.USER, 'user rule'),
      profile(SESSION_IDENTITY_SCOPES.PROJECT, 'project rule'),
    ])!;
    expect(rendered.indexOf('<user>')).toBeLessThan(rendered.indexOf('<project>'));
    expect(rendered.indexOf('<project>')).toBeLessThan(rendered.indexOf('<session>'));
    expect(rendered).toContain('Later sections override');
    expect(rendered).toContain('latest explicit instruction overrides every conflicting identity section');
    expect(rendered).toContain('Platform system/developer instructions');
  });

  it('enforces user 20k, project 40k, and session 80k character limits', () => {
    expect(SESSION_IDENTITY_USER_MAX_CHARS).toBe(20_000);
    expect(SESSION_IDENTITY_PROJECT_MAX_CHARS).toBe(40_000);
    expect(SESSION_IDENTITY_SESSION_MAX_CHARS).toBe(80_000);
    expect(SESSION_IDENTITY_MAX_UTF8_BYTES).toBe(320_000);
    expect(SESSION_IDENTITY_MAX_CHARS).toBe(SESSION_IDENTITY_SESSION_MAX_CHARS);
    for (const [scope, limit] of [
      [SESSION_IDENTITY_SCOPES.USER, SESSION_IDENTITY_USER_MAX_CHARS],
      [SESSION_IDENTITY_SCOPES.PROJECT, SESSION_IDENTITY_PROJECT_MAX_CHARS],
      [SESSION_IDENTITY_SCOPES.SESSION, SESSION_IDENTITY_SESSION_MAX_CHARS],
    ] as const) {
      expect(sessionIdentityContentError('x'.repeat(limit), scope)).toBeNull();
      expect(sessionIdentityContentError('x'.repeat(limit + 1), scope)).toBe('identity_content_too_large');
    }
    expect(sessionIdentityContentError('😀'.repeat(SESSION_IDENTITY_SESSION_MAX_CHARS), 'session')).toBeNull();
    expect(sessionIdentityContentError('\0')).toBe('identity_content_invalid');
  });

  it('requires scope keys only for project and session profiles', () => {
    expect(sessionIdentityScopeKeyError('user', '')).toBeNull();
    expect(sessionIdentityScopeKeyError('user', 'unexpected')).toBe('identity_scope_key_forbidden');
    expect(sessionIdentityScopeKeyError('project', '')).toBe('identity_scope_key_required');
    expect(sessionIdentityScopeKeyError('session', 'srv:deck_proj_brain')).toBeNull();
  });
});
