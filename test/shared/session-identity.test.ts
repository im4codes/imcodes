import { describe, expect, it } from 'vitest';
import {
  sessionIdentityProjectKey,
  sessionIdentitySessionKey,
  SESSION_IDENTITY_BLOCK_CLOSE_TAG,
  SESSION_IDENTITY_BLOCK_OPEN_TAG,
  SESSION_IDENTITY_COMBINED_MAX_CHARS,
  SESSION_IDENTITY_MAX_CHARS,
  SESSION_IDENTITY_SOURCE_FILE_MAX_BYTES,
  SESSION_IDENTITY_PROJECT_MAX_CHARS,
  SESSION_IDENTITY_SCOPES,
  SESSION_IDENTITY_SESSION_MAX_CHARS,
  SESSION_IDENTITY_USER_MAX_CHARS,
  SESSION_IDENTITY_SCOPE_LIST,
  renderSessionIdentityProfiles,
  sessionIdentityContentError,
  sessionIdentityContentLength,
  sessionIdentityMaxChars,
  sessionIdentityScopeKeyError,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';
import { MEMORY_MCP_TOOL_CONTRACTS, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';

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

  it('enforces user 50k, project 100k, and session 200k character limits', () => {
    // Pinned on purpose: these are product decisions, so a change should have
    // to be made here too rather than slipping through as a side effect.
    expect(SESSION_IDENTITY_USER_MAX_CHARS).toBe(50_000);
    expect(SESSION_IDENTITY_PROJECT_MAX_CHARS).toBe(150_000);
    expect(SESSION_IDENTITY_SESSION_MAX_CHARS).toBe(250_000);
    // Derived, not restated: the file pre-read must track the session cap, and
    // a second literal is how the two drift apart into a profile that validates
    // but cannot be read back off disk.
    expect(SESSION_IDENTITY_SOURCE_FILE_MAX_BYTES).toBe(SESSION_IDENTITY_SESSION_MAX_CHARS * 4 + 3);
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
    expect(sessionIdentityContentError('中'.repeat(49_323), 'session')).toBeNull();
    expect(sessionIdentityContentError('\0')).toBe('identity_content_invalid');
  });

  it('requires scope keys only for project and session profiles', () => {
    expect(sessionIdentityScopeKeyError('user', '')).toBeNull();
    expect(sessionIdentityScopeKeyError('user', 'unexpected')).toBe('identity_scope_key_forbidden');
    expect(sessionIdentityScopeKeyError('project', '')).toBe('identity_scope_key_required');
    expect(sessionIdentityScopeKeyError('session', 'srv:deck_proj_brain')).toBeNull();
  });
});

describe('identity limit propagation', () => {
  it('derives the combined ceiling from the three scopes', () => {
    expect(SESSION_IDENTITY_COMBINED_MAX_CHARS)
      .toBe(SESSION_IDENTITY_USER_MAX_CHARS + SESSION_IDENTITY_PROJECT_MAX_CHARS + SESSION_IDENTITY_SESSION_MAX_CHARS);
    expect(SESSION_IDENTITY_COMBINED_MAX_CHARS).toBe(450_000);
  });

  it('accepts every scope at exactly its limit in 4-byte code points and rejects one more', () => {
    // Code points, not UTF-16 units or bytes: an emoji is 2 UTF-16 units and 4
    // UTF-8 bytes but must count as one character toward the limit.
    for (const [scope, limit] of [
      [SESSION_IDENTITY_SCOPES.USER, SESSION_IDENTITY_USER_MAX_CHARS],
      [SESSION_IDENTITY_SCOPES.PROJECT, SESSION_IDENTITY_PROJECT_MAX_CHARS],
      [SESSION_IDENTITY_SCOPES.SESSION, SESSION_IDENTITY_SESSION_MAX_CHARS],
    ] as const) {
      expect(sessionIdentityContentError('😀'.repeat(limit), scope)).toBeNull();
      expect(sessionIdentityContentError('😀'.repeat(limit + 1), scope)).toBe('identity_content_too_large');
    }
  });

  it('keeps a lower scope bounded by its own limit even though a higher scope allows more', () => {
    expect(sessionIdentityContentError('x'.repeat(SESSION_IDENTITY_USER_MAX_CHARS + 1), SESSION_IDENTITY_SCOPES.USER))
      .toBe('identity_content_too_large');
    expect(sessionIdentityContentError('x'.repeat(SESSION_IDENTITY_USER_MAX_CHARS + 1), SESSION_IDENTITY_SCOPES.SESSION))
      .toBeNull();
  });

  it('renders the identity block with the exported delimiters providers cut against', () => {
    const rendered = renderSessionIdentityProfiles([
      { scope: 'user', scopeKey: '', content: 'u', contentHash: 'h', revision: 1, updatedAt: 1, source: 'web' },
    ]) ?? '';
    expect(rendered.startsWith(SESSION_IDENTITY_BLOCK_OPEN_TAG)).toBe(true);
    expect(rendered.endsWith(SESSION_IDENTITY_BLOCK_CLOSE_TAG)).toBe(true);
  });

  it('advertises the real limits in the MCP tool contract instead of stale literals', () => {
    const contract = MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET];
    const description = JSON.stringify(contract.inputSchema);
    expect(description).toContain(`user scope up to ${SESSION_IDENTITY_USER_MAX_CHARS.toLocaleString('en-US')} characters`);
    expect(description).toContain(`project up to ${SESSION_IDENTITY_PROJECT_MAX_CHARS.toLocaleString('en-US')}`);
    expect(description).toContain(`session up to ${SESSION_IDENTITY_SESSION_MAX_CHARS.toLocaleString('en-US')} characters`);
    // The previous description advertised limits the code no longer enforced.
    expect(description).not.toContain('40,000');
    expect(description).not.toContain('80,000');
  });
});

describe('identity limit boundaries and normalization', () => {
  const scopes = [
    [SESSION_IDENTITY_SCOPES.USER, SESSION_IDENTITY_USER_MAX_CHARS],
    [SESSION_IDENTITY_SCOPES.PROJECT, SESSION_IDENTITY_PROJECT_MAX_CHARS],
    [SESSION_IDENTITY_SCOPES.SESSION, SESSION_IDENTITY_SESSION_MAX_CHARS],
  ] as const;

  it.each(scopes)('%s accepts limit-1 and limit, and rejects limit+1', (scope, limit) => {
    expect(sessionIdentityContentError('a'.repeat(limit - 1), scope)).toBeNull();
    expect(sessionIdentityContentError('a'.repeat(limit), scope)).toBeNull();
    expect(sessionIdentityContentError('a'.repeat(limit + 1), scope)).toBe('identity_content_too_large');
  });

  it.each(scopes)('%s counts interior newlines as characters', (scope, limit) => {
    const lines = 'line\n'.repeat(Math.floor(limit / 5));
    const exact = `${lines}${'z'.repeat(limit - Array.from(lines).length)}`;
    expect(Array.from(exact)).toHaveLength(limit);
    expect(sessionIdentityContentError(exact, scope)).toBeNull();
    expect(sessionIdentityContentError(`${exact}\nz`, scope)).toBe('identity_content_too_large');
  });

  it.each(scopes)('%s counts after NFC composition, so decomposed input at the limit is accepted', (scope, limit) => {
    // 'e' + U+0301 is two code points raw but one after NFC.
    const decomposed = 'e\u0301'.repeat(limit);
    expect(Array.from(decomposed)).toHaveLength(limit * 2);
    expect(sessionIdentityContentError(decomposed, scope)).toBeNull();
    expect(sessionIdentityContentError(`${decomposed}e\u0301`, scope)).toBe('identity_content_too_large');
  });

  it.each(scopes)('%s trims surrounding whitespace before counting', (scope, limit) => {
    expect(sessionIdentityContentError(`\n   ${'q'.repeat(limit)}   \n`, scope)).toBeNull();
  });
});

describe('sessionIdentityContentLength is the single authoritative unit', () => {
  it.each([
    ['NFC-decomposed', 'e\u0301'.repeat(3), 3],
    ['surrounding whitespace', ' \n\tabc\n ', 3],
    ['emoji', '😀😀', 2],
    ['CJK with inner newline', '中\n文', 3],
    ['empty after trim', ' \n ', 0],
  ])('%s', (_label, value, expected) => {
    expect(sessionIdentityContentLength(value)).toBe(expected);
  });

  it('agrees with the write gate at limit and limit+1 for decomposed and padded input in every scope', () => {
    for (const scope of SESSION_IDENTITY_SCOPE_LIST) {
      const limit = sessionIdentityMaxChars(scope);
      for (const build of [(n: number) => 'e\u0301'.repeat(n), (n: number) => `  ${'a'.repeat(n)}\n`]) {
        expect(sessionIdentityContentLength(build(limit))).toBe(limit);
        expect(sessionIdentityContentError(build(limit), scope)).toBeNull();
        expect(sessionIdentityContentLength(build(limit + 1))).toBe(limit + 1);
        expect(sessionIdentityContentError(build(limit + 1), scope)).toBe('identity_content_too_large');
      }
    }
  });
});

describe('session identity scope keys', () => {
  it('keys a project identity by the canonical project id, falling back to the project name', () => {
    expect(sessionIdentityProjectKey({ contextNamespace: { projectId: ' github-org/repo ' }, project: 'repo' })).toBe('github-org/repo');
    expect(sessionIdentityProjectKey({ contextNamespace: { projectId: '  ' }, project: ' repo ' })).toBe('repo');
    expect(sessionIdentityProjectKey({ contextNamespace: null, project: 'repo' })).toBe('repo');
    expect(sessionIdentityProjectKey({})).toBe('');
  });

  it('keys a session identity by server and session name', () => {
    expect(sessionIdentitySessionKey('srv-1', 'deck_proj_brain')).toBe('srv-1:deck_proj_brain');
  });
});
