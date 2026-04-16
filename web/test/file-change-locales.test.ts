import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const;
const REQUIRED_CHAT_KEYS = [
  'file_change_title',
  'file_change_patch_count',
  'file_change_provider_claude_code',
  'file_change_provider_opencode',
  'file_change_provider_codex_sdk',
  'file_change_provider_qwen',
  'file_change_provider_gemini',
  'file_change_operation_create',
  'file_change_operation_update',
  'file_change_operation_delete',
  'file_change_operation_rename',
  'file_change_operation_unknown',
  'file_change_operation_mixed',
  'file_change_confidence_exact',
  'file_change_confidence_derived',
  'file_change_confidence_coarse',
  'file_change_confidence_mixed',
  'file_change_removed',
  'file_change_added',
  'file_change_truncated',
  'file_change_no_before',
  'file_change_no_after',
  'file_change_derived_no_preview',
  'file_change_coarse_hint',
  'file_change_renamed_from',
] as const;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function loadLocale(locale: typeof LOCALES[number]): Record<string, unknown> {
  const filePath = join(TEST_DIR, '..', 'src', 'i18n', 'locales', `${locale}.json`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

describe('file-change locale coverage', () => {
  it.each(LOCALES)('includes all required file-change chat keys in %s', (locale) => {
    const chat = loadLocale(locale).chat as Record<string, unknown>;
    expect(chat).toBeTruthy();
    for (const key of REQUIRED_CHAT_KEYS) {
      expect(chat[key], `${locale}:${key}`).toBeTypeOf('string');
      expect(String(chat[key]).length).toBeGreaterThan(0);
    }
  });
});
