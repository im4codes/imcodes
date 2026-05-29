import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
const CLONE_UI_KEYS = [
  'menu',
  'title',
  'source',
  'targetProjectName',
  'targetProjectPlaceholder',
  'finalSessionName',
  'previewUnavailable',
  'preserveDirectories',
  'overrideDirectories',
  'cwdOverride',
  'cwdOverridePlaceholder',
  'browseCwd',
  'daemonHostValidation',
  'runningWarning',
  'capabilityMissing',
  'submit',
  'submitting',
  'blankProject',
  'notConnected',
  'daemonOffline',
  'missingServer',
  'cwdRequired',
  'progress',
  'subSessionProgress',
  'operationId',
  'success',
  'cleanupRequired',
  'cleanupRequiredBody',
  'cleanupResourceDetail',
  'warningsTitle',
  'skippedMembersTitle',
  'skippedMemberDetail',
  'skippedCronJobs',
  'skippedOrchestrationRuns',
] as const;
const CLONE_STATES = [
  'validating',
  'reserving',
  'creating_main',
  'creating_subs',
  'writing_db',
  'provider_create',
  'writing_pref',
  'committing',
  'rolling_back',
  'succeeded',
  'failed',
  'cancelled',
  'cleanup_required',
] as const;
const CLONE_ERROR_CODES = [
  'invalid_request',
  'forbidden',
  'unsupported_command',
  'source_not_found',
  'source_not_role_compatible',
  'blank_target_project',
  'name_taken',
  'invalid_cwd',
  'incomplete_clone_spec',
  'unsupported_session_type',
  'p2p_config_invalid',
  'persist_failed',
  'idempotency_conflict',
  'server_commit_failed',
  'server_p2p_commit_failed',
  'cancelled',
  'cleanup_required',
  'internal_error',
] as const;
const CLONE_WARNING_CODES = [
  'running_source_excluded_state',
  'p2p_prompt_session_reference',
  'p2p_skipped_participant_dropped',
  'skipped_member',
  'scheduled_work_skipped',
  'p2p_config_missing',
  'rollback_partial',
] as const;
const CLONE_CLEANUP_RESOURCE_KINDS = [
  'daemon_session',
  'daemon_p2p_scope',
  'server_db_session',
  'server_p2p_pref',
  'provider_session',
] as const;
const CLONE_SKIPPED_REASONS = [
  'stopped',
  'error',
  'closed',
  'hidden',
  'nested',
  'server_only_orphan',
  'unsupported',
  'incomplete_spec',
] as const;
const TIMELINE_STATUS_KEYS = [
  'ok',
  'empty',
  'partial',
  'deferred',
  'canceled',
  'payloadTruncated',
  'cursorReset',
  'queueFull',
  'deadlineExceeded',
  'timeout',
  'unavailable',
  'projectionUnavailable',
  'malformedRequest',
  'internalError',
  'detailMissing',
  'detailExpired',
  'detailUnauthorized',
  'detailOversized',
  'detailMalformed',
  'detailEpochMismatch',
  'detailGenerationMismatch',
  'detailHydrated',
  'pageCursorReset',
  'pageMalformed',
  'error',
] as const;
const CHAT_FONT_KEYS = [
  'dialogLabel',
  'typeLabel',
  'codeTab',
  'cjkTab',
  'familyLabel',
  'cjkFamilyLabel',
  'allBuiltInCjk',
] as const;
const CHAT_FONT_CJK_FAMILY_KEYS = [
  'system-cjk',
  'pingfang-sc',
  'songti-sc',
  'kaiti-sc',
  'stheiti',
  'stsong',
  'stkaiti',
  'stfangsong',
  'microsoft-yahei',
  'simsun',
  'nsimsun',
  'dengxian',
  'kaiti',
  'fangsong',
  'microsoft-jhenghei',
] as const;

describe('generic i18n coverage guard', () => {
  it('keeps memory post-1.1 translation keys present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as {
        memory?: { quickSearch?: Record<string, string>; skills?: Record<string, string> };
      };
      expect(messages.memory?.quickSearch?.disabled, locale).toEqual(expect.any(String));
      expect(messages.memory?.quickSearch?.noResults, locale).toEqual(expect.any(String));
      expect(messages.memory?.skills?.disabled, locale).toEqual(expect.any(String));
      expect(messages.memory?.skills?.layerDiagnostics, locale).toEqual(expect.any(String));
    }
  });

  it('keeps session group clone translation keys present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as {
        session?: {
          clone?: Record<string, unknown> & {
            state?: Record<string, string>;
            errorCode?: Record<string, string>;
            warningCode?: Record<string, string>;
            cleanupResourceKind?: Record<string, string>;
            skippedReason?: Record<string, string>;
          };
        };
      };
      const clone = messages.session?.clone;
      for (const key of CLONE_UI_KEYS) {
        expect(clone?.[key], `${locale}: session.clone.${key}`).toEqual(expect.any(String));
      }
      for (const state of CLONE_STATES) {
        expect(clone?.state?.[state], `${locale}: session.clone.state.${state}`).toEqual(expect.any(String));
      }
      for (const code of CLONE_ERROR_CODES) {
        expect(clone?.errorCode?.[code], `${locale}: session.clone.errorCode.${code}`).toEqual(expect.any(String));
      }
      for (const code of CLONE_WARNING_CODES) {
        expect(clone?.warningCode?.[code], `${locale}: session.clone.warningCode.${code}`).toEqual(expect.any(String));
      }
      for (const kind of CLONE_CLEANUP_RESOURCE_KINDS) {
        expect(clone?.cleanupResourceKind?.[kind], `${locale}: session.clone.cleanupResourceKind.${kind}`).toEqual(expect.any(String));
      }
      for (const reason of CLONE_SKIPPED_REASONS) {
        expect(clone?.skippedReason?.[reason], `${locale}: session.clone.skippedReason.${reason}`).toEqual(expect.any(String));
      }
    }
  });

  it('keeps timeline status translation keys present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as {
        chat?: { timelineStatus?: Record<string, string> };
      };
      for (const key of TIMELINE_STATUS_KEYS) {
        expect(messages.chat?.timelineStatus?.[key], `${locale}: chat.timelineStatus.${key}`).toEqual(expect.any(String));
        expect(messages.chat?.timelineStatus?.[key]?.trim().length, `${locale}: chat.timelineStatus.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps chat font picker translation keys present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as {
        chat?: { font?: Record<string, unknown> & { cjkFamilies?: Record<string, string> } };
      };
      const font = messages.chat?.font;
      for (const key of CHAT_FONT_KEYS) {
        expect(font?.[key], `${locale}: chat.font.${key}`).toEqual(expect.any(String));
        expect((font?.[key] as string | undefined)?.trim().length, `${locale}: chat.font.${key}`).toBeGreaterThan(0);
      }
      for (const key of CHAT_FONT_CJK_FAMILY_KEYS) {
        expect(font?.cjkFamilies?.[key], `${locale}: chat.font.cjkFamilies.${key}`).toEqual(expect.any(String));
        expect(font?.cjkFamilies?.[key]?.trim().length, `${locale}: chat.font.cjkFamilies.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
