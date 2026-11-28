import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

function flatten(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    out.push(...flatten(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

describe('share i18n parity', () => {
  it('keeps the share namespace keys identical across supported locales', () => {
    const entries = SUPPORTED_LOCALES.map((locale) => {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as { share?: unknown };
      return [locale, flatten(messages.share).sort()] as const;
    });

    const [, baseKeys] = entries[0];
    for (const [locale, keys] of entries) {
      expect(keys, locale).toEqual(baseKeys);
    }
  });

  it('defines a translated owner role for controlled nodes in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as { share?: { role?: { owner?: unknown } } };
      const owner = messages.share?.role?.owner;

      expect(typeof owner, locale).toBe('string');
      expect(String(owner).trim(), locale).not.toBe('');
      expect(owner, locale).not.toBe('share.role.owner');
    }
  });

  it('defines non-empty security warning texts for device and session sharing in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as { share?: { warning?: { device?: unknown; session?: unknown } } };
      const warning = messages.share?.warning;

      expect(warning, locale).toBeDefined();
      expect(typeof warning?.device, locale).toBe('string');
      expect(String(warning?.device).trim(), locale).not.toBe('');
      expect(warning?.device, locale).not.toBe('share.warning.device');

      expect(typeof warning?.session, locale).toBe('string');
      expect(String(warning?.session).trim(), locale).not.toBe('');
      expect(warning?.session, locale).not.toBe('share.warning.session');
    }
  });

  it('defines non-empty trust and roleHelp copy without legacy AI-account or sandbox-limit disclaimers in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as {
        share?: {
          shell_participant_forbidden?: unknown;
          trust?: { title?: unknown; body?: unknown };
          roleHelp?: { viewer?: unknown; participant?: unknown; serverParticipant?: unknown };
        };
      };
      expect(messages.share?.shell_participant_forbidden, locale).toBeUndefined();
      expect(String(messages.share?.trust?.title ?? '').trim(), locale).not.toBe('');
      expect(String(messages.share?.trust?.body ?? '').trim(), locale).not.toBe('');
      expect(String(messages.share?.roleHelp?.viewer ?? '').trim(), locale).not.toBe('');
      expect(String(messages.share?.roleHelp?.participant ?? '').trim(), locale).not.toBe('');
      const serverParticipantHelp = String(messages.share?.roleHelp?.serverParticipant ?? '').trim();
      expect(serverParticipantHelp, locale).not.toBe('');
      expect(serverParticipantHelp, locale).not.toMatch(/cannot stop|不可关闭|不可關閉|終了はできません|종료는 불가|no puede cerrar|не закрывать/i);
    }
  });

  it('defines non-empty cross-group privateDeviceBlock copy across all seven locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as {
        share?: {
          privateDeviceBlock?: { label?: unknown; help?: unknown; shortHelp?: unknown };
        };
      };
      const block = messages.share?.privateDeviceBlock;
      expect(block, locale).toBeDefined();
      const label = String(block?.label ?? '').trim();
      const help = String(block?.help ?? '').trim();
      const shortHelp = String(block?.shortHelp ?? '').trim();
      expect(label, `${locale}:label`).not.toBe('');
      expect(help, `${locale}:help`).not.toBe('');
      expect(shortHelp, `${locale}:shortHelp`).not.toBe('');
      expect(help, `${locale}:group-wording`).toMatch(/shared group|共享分组|共用群組|共有グループ|공유 그룹|grupo compartido|общую группу/i);
    }
  });
});
