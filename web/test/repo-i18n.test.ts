import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'];
const localeDir = existsSync(join(process.cwd(), 'src', 'i18n', 'locales'))
  ? join(process.cwd(), 'src', 'i18n', 'locales')
  : join(process.cwd(), 'web', 'src', 'i18n', 'locales');
const REQUIRED_REPO_KEYS = [
  'branch_summary_title',
  'branch_summary_label',
  'info_title',
  'info_current_branch',
  'info_project_dir',
  'info_repository',
  'info_provider',
  'info_default_branch',
  'branch_local_label',
  'branch_local_short',
  'branch_remote_label',
  'branch_remote_short',
  'checkout_switch',
  'checkout_switching',
  'checkout_switch_to',
  'checkout_pending',
  'checkout_success',
  'checkout_remote_only_disabled',
  'checkout_dirty_worktree',
  'checkout_git_operation_in_progress',
  'checkout_invalid_target',
  'checkout_in_progress',
  'checkout_busy',
  'checkout_branch_in_use',
  'checkout_detached_head',
  'checkout_not_a_git_repo',
  'checkout_failed',
  'local_commit_fallback_loading',
  'local_commit_fallback_error',
];

describe('repo i18n keys', () => {
  it('defines branch summary and checkout strings in every supported locale', () => {
    for (const locale of LOCALES) {
      const file = join(localeDir, `${locale}.json`);
      const json = JSON.parse(readFileSync(file, 'utf8')) as { repo?: Record<string, string> };
      for (const key of REQUIRED_REPO_KEYS) {
        expect(json.repo?.[key], `${locale}.repo.${key}`).toEqual(expect.any(String));
        expect(json.repo?.[key]?.length, `${locale}.repo.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
