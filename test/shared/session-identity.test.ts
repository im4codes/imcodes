import { describe, expect, it } from 'vitest';
import {
  SESSION_IDENTITY_MAX_CHARS,
  SESSION_IDENTITY_SCOPES,
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

  it('accepts 30k characters and rejects the next character or oversized UTF-8', () => {
    expect(sessionIdentityContentError('x'.repeat(SESSION_IDENTITY_MAX_CHARS))).toBeNull();
    expect(sessionIdentityContentError('x'.repeat(SESSION_IDENTITY_MAX_CHARS + 1))).toBe('identity_content_too_large');
    expect(sessionIdentityContentError('\0')).toBe('identity_content_invalid');
  });

  it('requires scope keys only for project and session profiles', () => {
    expect(sessionIdentityScopeKeyError('user', '')).toBeNull();
    expect(sessionIdentityScopeKeyError('user', 'unexpected')).toBe('identity_scope_key_forbidden');
    expect(sessionIdentityScopeKeyError('project', '')).toBe('identity_scope_key_required');
    expect(sessionIdentityScopeKeyError('session', 'srv:deck_proj_brain')).toBeNull();
  });
});
