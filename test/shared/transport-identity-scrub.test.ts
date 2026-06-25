import { describe, it, expect } from 'vitest';
import {
  CLONE_TRANSPORT_IDENTITY_KEY_NORMALIZED,
  cloneTransportConfigWithoutRuntimeIdentity,
  isCloneTransportIdentityKey,
  scrubCloneTransportIdentity,
} from '../../shared/transport-identity-scrub.js';

describe('isCloneTransportIdentityKey', () => {
  it('matches keys by normalized suffix regardless of case or separators', () => {
    for (const key of [
      'sessionId',
      'session_id',
      'session-id',
      'SESSION_ID',
      'providerSessionId',
      'codex-session-id',
      'cc_session_id',
      'sessionKey',
      'session-key',
      'providerSessionKey',
      'resumeId',
      'resume_id',
      'providerResumeId',
      'threadId',
      'thread-id',
      'provider_thread_id',
    ]) {
      expect(isCloneTransportIdentityKey(key)).toBe(true);
    }
  });

  it('matches every member of the explicit normalized denylist', () => {
    for (const normalized of CLONE_TRANSPORT_IDENTITY_KEY_NORMALIZED) {
      expect(isCloneTransportIdentityKey(normalized)).toBe(true);
    }
    // Sanity-check a few well-known entries spelled in their original form.
    expect(isCloneTransportIdentityKey('ccSessionId')).toBe(true);
    expect(isCloneTransportIdentityKey('providerResumeId')).toBe(true);
    expect(isCloneTransportIdentityKey('conversationId')).toBe(true);
    expect(isCloneTransportIdentityKey('bindExistingKey')).toBe(true);
  });

  it('does not match unrelated keys', () => {
    for (const key of [
      'model',
      'cwd',
      'providerId',
      'effort',
      'sessionLabel',
      'idForUser',
      'keyboard',
      'sessions',
    ]) {
      expect(isCloneTransportIdentityKey(key)).toBe(false);
    }
  });
});

describe('scrubCloneTransportIdentity', () => {
  it('strips suffix-matched identity keys (any case / separators)', () => {
    const input = {
      sessionId: 'abc',
      'session-id': 'abc',
      session_key: 'k',
      providerResumeId: 'r',
      'thread-id': 't',
      model: 'gpt',
      cwd: '/repo',
    };
    expect(scrubCloneTransportIdentity(input)).toEqual({ model: 'gpt', cwd: '/repo' });
  });

  it('strips explicit denylist members and preserves unrelated keys', () => {
    const input = {
      ccSessionId: 'cc',
      providerResumeId: 'pr',
      conversationId: 'conv',
      bindExistingKey: 'bind',
      model: 'claude',
      providerId: 'codex',
      cwd: '/home/repo',
    };
    expect(scrubCloneTransportIdentity(input)).toEqual({
      model: 'claude',
      providerId: 'codex',
      cwd: '/home/repo',
    });
  });

  it('scrubs nested objects recursively', () => {
    const input = {
      model: 'm',
      runtime: {
        sessionId: 'nested-session',
        nested: {
          providerSessionId: 'deep',
          keep: true,
        },
        cwd: '/x',
      },
    };
    expect(scrubCloneTransportIdentity(input)).toEqual({
      model: 'm',
      runtime: {
        nested: { keep: true },
        cwd: '/x',
      },
    });
  });

  it('scrubs objects inside arrays element-wise', () => {
    const input = {
      providerId: 'codex',
      children: [
        { sessionId: 's1', name: 'a' },
        { conversationId: 'c2', name: 'b' },
        'plain-string',
        42,
      ],
    };
    expect(scrubCloneTransportIdentity(input)).toEqual({
      providerId: 'codex',
      children: [
        { name: 'a' },
        { name: 'b' },
        'plain-string',
        42,
      ],
    });
  });

  it('returns non-object input unchanged', () => {
    expect(scrubCloneTransportIdentity('hello')).toBe('hello');
    expect(scrubCloneTransportIdentity(123)).toBe(123);
    expect(scrubCloneTransportIdentity(null)).toBe(null);
    expect(scrubCloneTransportIdentity(undefined)).toBe(undefined);
    expect(scrubCloneTransportIdentity(true)).toBe(true);
  });

  it('does not mutate the original input', () => {
    const input = { sessionId: 'x', model: 'm', nested: { threadId: 't', keep: 1 } };
    const snapshot = JSON.parse(JSON.stringify(input));
    scrubCloneTransportIdentity(input);
    expect(input).toEqual(snapshot);
  });
});

describe('cloneTransportConfigWithoutRuntimeIdentity', () => {
  it('returns a scrubbed copy for a plain record', () => {
    expect(
      cloneTransportConfigWithoutRuntimeIdentity({ sessionId: 's', model: 'm', cwd: '/c' }),
    ).toEqual({ model: 'm', cwd: '/c' });
  });

  it('returns null for null/undefined/non-record input', () => {
    expect(cloneTransportConfigWithoutRuntimeIdentity(null)).toBeNull();
    expect(cloneTransportConfigWithoutRuntimeIdentity(undefined)).toBeNull();
    // @ts-expect-error exercising defensive non-record handling
    expect(cloneTransportConfigWithoutRuntimeIdentity([])).toBeNull();
    // @ts-expect-error exercising defensive non-record handling
    expect(cloneTransportConfigWithoutRuntimeIdentity('str')).toBeNull();
  });
});
