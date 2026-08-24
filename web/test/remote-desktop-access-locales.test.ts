import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';

const required = [
  'access_owner_title', 'access_public_id', 'access_create_link', 'access_secret_once', 'access_password_disable',
  'access_state_active', 'access_state_revoked', 'access_state_expired', 'access_expires_at', 'access_never_expires',
  'access_privacy_recovery',
] as const;

const requiredGuest = [
  'title', 'subtitle', 'public_id', 'password', 'connect', 'boundary', 'invited_target',
  'state_resolving', 'state_waiting_for_consent', 'state_approved', 'state_denied',
  'state_timeout', 'state_cancelled', 'state_cooldown', 'state_unavailable', 'target',
  'waiting_help', 'try_again', 'generic_error',
] as const;

describe('remote desktop access locale coverage', () => {
  it('ships owner and guest access labels in all supported locales', () => {
    for (const locale of [en, es, ja, ko, ru, zhCN, zhTW]) {
      for (const key of required) {
        expect(locale.remote_desktop[key]).toEqual(expect.any(String));
        expect(locale.remote_desktop[key].length).toBeGreaterThan(0);
      }
      for (const key of requiredGuest) {
        expect(locale.remote_desktop.guest[key]).toEqual(expect.any(String));
        expect(locale.remote_desktop.guest[key].length).toBeGreaterThan(0);
      }
    }
  });
});
