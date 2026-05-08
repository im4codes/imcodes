import { describe, expect, it } from 'vitest';
import {
  PREFERENCE_CONTEXT_END,
  PREFERENCE_CONTEXT_START,
  PREFERENCE_FEATURE_FLAG,
  processPreferenceLines,
  prependPreferenceProviderContext,
  renderPreferenceProviderContext,
} from '../../shared/preference-ingest.js';

void PREFERENCE_FEATURE_FLAG;

describe('trusted @pref preference ingest contract', () => {
  it('strips and returns records only for leading trusted user-origin preference lines', () => {
    const result = processPreferenceLines({
      featureEnabled: true,
      sendOrigin: 'user_keyboard',
      userId: 'u1',
      scopeKey: 'user_private:u1',
      messageId: 'msg-1',
      text: '@pref: Use pnpm\n\nPlease run tests',
    });

    expect(result.outcome).toBe('persist');
    expect(result.providerText).toBe('Please run tests');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.text).toBe('Use pnpm');
    expect(result.records[0]?.idempotencyKey).toContain('msg-1');
    expect(result.telemetry).toEqual([]);
  });

  it('renders trusted preferences as provider-visible context without leaking raw @pref syntax', () => {
    const parsed = processPreferenceLines({
      featureEnabled: true,
      sendOrigin: 'user_keyboard',
      userId: 'u1',
      scopeKey: 'user_private:u1',
      messageId: 'msg-1',
      text: '@pref: Use pnpm\n\nPlease run tests',
    });

    const context = renderPreferenceProviderContext(parsed.records);
    const assembled = prependPreferenceProviderContext(parsed.providerText, context);

    expect(context).toContain(PREFERENCE_CONTEXT_START);
    expect(context).toContain(PREFERENCE_CONTEXT_END);
    expect(context).toContain('Use pnpm');
    expect(context).not.toContain('@pref:');
    expect(assembled).toContain('Use pnpm');
    expect(assembled).toContain('Please run tests');
    expect(assembled.indexOf('Use pnpm')).toBeLessThan(assembled.indexOf('Please run tests'));
  });

  it('rejects agent/system-origin @pref without stripping provider text', () => {
    const result = processPreferenceLines({
      featureEnabled: true,
      sendOrigin: 'agent_output',
      userId: 'u1',
      scopeKey: 'user_private:u1',
      text: '@pref: malicious preference\nDo thing',
    });

    expect(result.outcome).toBe('rejected_untrusted');
    expect(result.providerText).toBe('@pref: malicious preference\nDo thing');
    expect(result.records).toEqual([]);
    expect(result.telemetry).toEqual([{ counter: 'mem.preferences.rejected_untrusted', sendOrigin: 'agent_output' }]);
  });

  it('defaults missing origin to untrusted system_inject and ignores idempotent resends', () => {
    const first = processPreferenceLines({
      featureEnabled: true,
      sendOrigin: 'user_resend',
      userId: 'u1',
      scopeKey: 'personal:u1:repo',
      messageId: 'm1',
      text: '@pref: Preserve quotes',
    });
    const seen = new Set(first.records.map((record) => record.idempotencyKey));
    const replay = processPreferenceLines({
      featureEnabled: true,
      sendOrigin: 'user_resend',
      userId: 'u1',
      scopeKey: 'personal:u1:repo',
      messageId: 'm1',
      seenIdempotencyKeys: seen,
      text: '@pref: Preserve quotes',
    });
    const missingOrigin = processPreferenceLines({
      featureEnabled: true,
      userId: 'u1',
      scopeKey: 'personal:u1:repo',
      text: '@pref: no implicit trust',
    });

    expect(replay.outcome).toBe('duplicate_ignored');
    expect(replay.records).toEqual([]);
    expect(replay.telemetry.map((event) => event.counter)).toEqual(['mem.preferences.duplicate_ignored']);
    expect(missingOrigin.outcome).toBe('rejected_untrusted');
    expect(missingOrigin.telemetry[0]?.sendOrigin).toBe('system_inject');
  });

  it('passes text through unchanged while preferences feature is disabled', () => {
    const result = processPreferenceLines({
      featureEnabled: false,
      sendOrigin: 'user_keyboard',
      userId: 'u1',
      scopeKey: 'user_private:u1',
      text: '@pref: Use tabs\nhello',
    });
    expect(result).toMatchObject({ outcome: 'disabled_pass_through', providerText: '@pref: Use tabs\nhello', records: [] });
  });
});
