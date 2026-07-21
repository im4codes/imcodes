import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
const OPENSPEC_AUTO_DELIVER_KEYS = [
  'openspec.auto.action',
  'openspec.auto.kicker',
  'openspec.auto.custom',
  'openspec.auto.launcher_title',
  'openspec.auto.details_title',
  'openspec.auto.current_run',
  'openspec.auto.spec_rounds',
  'openspec.auto.impl_rounds',
  'openspec.auto.team_combo',
  'openspec.auto.auto_commit_push',
  'openspec.auto.auto_commit_push_help',
  'openspec.auto.active_prompt',
  'openspec.auto.compact',
  'openspec.auto.expand',
  'openspec.auto.list_title',
  'openspec.auto.list_empty',
  'openspec.auto.list_select',
  'openspec.auto.no_change',
  'openspec.auto.start',
  'openspec.auto.stop',
  'openspec.auto.stopping',
  'openspec.auto.view',
  'openspec.auto.tasks',
  'openspec.auto.tasks_unknown',
  'openspec.auto.tasks_progress',
  'openspec.auto.overall_progress',
  'openspec.auto.current_stage_progress',
  'openspec.auto.progress_count',
  'openspec.auto.progress_percent',
  'openspec.auto.prompt_count',
  'openspec.auto.prompt_progress',
  'openspec.auto.prompt_count_label',
  'openspec.auto.latest_message',
  'openspec.auto.materialized_limits',
  'openspec.auto.preset_limits',
  'openspec.auto.conflict_active',
  'openspec.auto.redacted_conflict',
  'openspec.auto.conflict_summary',
  'openspec.auto.lock_manual_actions',
  'openspec.auto.status_label',
  'openspec.auto.stage_label',
  'openspec.auto.elapsed',
  'openspec.auto.preset_label',
  'openspec.auto.owning_session',
  'openspec.auto.launched_from',
  'openspec.auto.execution_session',
  'openspec.auto.spec_round',
  'openspec.auto.impl_round',
  'openspec.auto.active_p2p',
  'openspec.auto.combo_id',
  'openspec.auto.verdict',
  'openspec.auto.terminal_reason',
  'openspec.auto.task_stats',
  'openspec.auto.scores',
  'openspec.auto.scores_empty',
  'openspec.auto.evidence',
  'openspec.auto.evidence_stale',
  'openspec.auto.error.missing_change',
  'openspec.auto.error.active_run',
  'openspec.auto.error.manual_team_busy',
  'openspec.auto.error.unsupported_runtime',
  'openspec.auto.error.launch_failed',
  'openspec.auto.error.invalid_rounds',
  'openspec.auto.error.daemon_offline',
  'openspec.auto.error.launch_timeout',
  'openspec.auto.error.stop_timeout',
  'openspec.auto.error.custom_combo_unsupported',
  'openspec.auto.error.combo_unsupported',
  'openspec.auto.error.strict_result_failed',
  'openspec.auto.preset.fast',
  'openspec.auto.preset.standard',
  'openspec.auto.preset.strict',
  'openspec.auto.preset.deep',
  'openspec.auto.status.proposed',
  'openspec.auto.status.spec_audit_repair',
  'openspec.auto.status.implementation_task_loop',
  'openspec.auto.status.implementation_audit_repair',
  'openspec.auto.status.commit_push',
  'openspec.auto.status.stopping',
  'openspec.auto.status.passed',
  'openspec.auto.status.needs_human',
  'openspec.auto.status.failed',
  'openspec.auto.status.stopped',
  'openspec.auto.stage.proposed',
  'openspec.auto.stage.spec_audit_repair',
  'openspec.auto.stage.implementation_task_loop',
  'openspec.auto.stage.implementation_audit_repair',
  'openspec.auto.stage.commit_push',
  'openspec.auto.stage.passed',
  'openspec.auto.stage.needs_human',
  'openspec.auto.stage.failed',
  'openspec.auto.stage.stopped',
  'openspec.auto.stage.stopping',
  'openspec.auto.score_module.spec',
  'openspec.auto.score_module.tasks',
  'openspec.auto.score_module.implementation',
  'openspec.auto.score_module.tests',
  'openspec.auto.score_module.risk',
  'openspec.auto.provenance.daemon',
  'openspec.auto.provenance.implementation_reported',
  'openspec.auto.provenance.audit_reported',
  'openspec.auto.provenance.none',
  'openspec.auto.ask.header',
  'openspec.auto.ask.needs_human_question',
  'openspec.auto.ask.review_continue',
  'openspec.auto.ask.review_continue_desc',
  'openspec.auto.ask.stop_summarize',
  'openspec.auto.ask.stop_summarize_desc',
  'openspec.auto.reason.missing_authoritative_json',
  'openspec.auto.reason.audit_p2p_failed',
  'openspec.auto.reason.auto_deliver_active',
  'openspec.auto.reason.invalid_authoritative_json',
  'openspec.auto.reason.audit_metadata_mismatch',
  'openspec.auto.reason.invalid_authoritative_result_path',
  'openspec.auto.reason.invalid_audit_verdict',
  'openspec.auto.reason.audit_blocked',
  'openspec.auto.reason.tasks_unreadable',
  'openspec.auto.reason.tasks_missing_checkboxes',
  'openspec.auto.reason.implementation_audit_required',
  'openspec.auto.reason.implementation_prompt_limit_reached',
  'openspec.auto.reason.max_elapsed_time_reached',
  'openspec.auto.reason.out_of_band_target_session_input',
  'openspec.auto.reason.spec_audit_rework_rounds_exhausted',
  'openspec.auto.reason.implementation_audit_rework_rounds_exhausted',
  'openspec.auto.reason.audit_pass_with_unchecked_tasks',
  'openspec.auto.reason.audit_pass_with_required_changes',
  'openspec.auto.reason.audit_pass_without_scores',
  'openspec.auto.reason.audit_pass_with_changed_files_without_repairs',
  'openspec.auto.reason.audit_pass_with_uncovered_changes',
  'openspec.auto.reason.auto_commit_push_failed',
  'openspec.auto.reason.auto_commit_push_git_status_failed',
  'openspec.auto.reason.auto_commit_push_preexisting_changes',
  'openspec.auto.reason.auto_commit_push_incomplete',
  'openspec.auto.reason.auto_commit_push_no_upstream',
  'openspec.auto.reason.auto_commit_push_not_pushed',
  'openspec.auto.reason.auto_commit_push_no_commit',
  'openspec.auto.reason.auto_commit_push_forbidden_paths',
  'openspec.auto.reason.auto_commit_push_unexpected_files',
  'openspec.auto.reason.final_audit_passed',
  'openspec.auto.lifecycle.spec_audit_repair_started',
  'openspec.auto.lifecycle.spec_audit_repair_p2p_started',
  'openspec.auto.lifecycle.implementation_prompt_dispatched',
  'openspec.auto.lifecycle.implementation_idle_incomplete',
  'openspec.auto.lifecycle.implementation_idle_all_checked',
  'openspec.auto.lifecycle.implementation_audit_repair_started',
  'openspec.auto.lifecycle.implementation_audit_repair_p2p_started',
  'openspec.auto.lifecycle.auto_commit_push_prompt_dispatched',
  'openspec.auto.lifecycle.authoritative_result_file_repair_prompt_dispatched',
  'openspec.auto.lifecycle.spec_audit_passed',
  'openspec.auto.lifecycle.spec_audit_rework_scored',
  'openspec.auto.lifecycle.spec_audit_blocked_scored',
] as const;
const ASK_QUESTION_KEYS = [
  'askQuestion.waiting',
  'askQuestion.retained',
  'askQuestion.customPlaceholder',
  'askQuestion.answerPlaceholder',
  'askQuestion.dismiss',
  'askQuestion.answer',
  'askQuestion.interrupt',
] as const;
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
  'gitRemoteUrl',
  'gitRemoteUrlPlaceholder',
  'gitRemoteUrlHelp',
  'gitRemoteCapabilityMissing',
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
  'invalid_git_remote',
  'git_clone_failed',
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
// dedicated-execution-clone-sessions — generic execution dropdown + grouped
// execution-detail strings (must exist in every locale).
const EXECUTION_ROUTING_KEYS = [
  'settings.executionRouting.ineligibleOption',
  'settings.executionRouting.ineligibleReason.capacity_full',
  'settings.executionRouting.ineligibleReason.template_ineligible',
  'settings.executionRouting.ineligibleReason.clone_of_clone_forbidden',
  'settings.executionRouting.ineligibleReason.worker_clone_forbidden',
  'settings.executionRouting.ineligibleReason.cron_clone_forbidden',
  'settings.executionRouting.ineligibleReason.target_not_found',
  'settings.executionRouting.ineligibleReason.destroy_forbidden',
  'session.execution.genericPrompt',
  'session.execution.useConfigured',
  'session.execution.useConfiguredNone',
  'session.execution.setSession',
  'session.executionGroup.title',
  'session.executionGroup.unknownRun',
  // OpenSpec left-panel Execute dropdown (task 2.4).
  'openspec.execute.action',
  'openspec.execute.dispatch_heading',
  'openspec.execute.dispatch_to',
  'openspec.execute.default_heading',
  'openspec.execute.set_default',
  'openspec.execute.clear_default',
  'openspec.execute.no_change',
  'openspec.execute.no_sessions',
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

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
  ), value);
}

describe('generic i18n coverage guard', () => {
  it('keeps OpenSpec Auto Deliver translation keys present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      for (const key of OPENSPEC_AUTO_DELIVER_KEYS) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string | undefined)?.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps visible Auto Deliver round labels localized outside English', () => {
    const english = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as unknown;
    const keys = ['openspec.auto.spec_rounds', 'openspec.auto.impl_rounds'] as const;
    for (const locale of SUPPORTED_LOCALES.filter((item) => item !== 'en')) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      for (const key of keys) {
        expect(readPath(messages, key), `${locale}:${key}`).not.toBe(readPath(english, key));
      }
    }
  });

  it('keeps AskQuestion translation keys present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      for (const key of ASK_QUESTION_KEYS) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string | undefined)?.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

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

  it('keeps execution-routing dropdown + grouping keys present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      for (const key of EXECUTION_ROUTING_KEYS) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string | undefined)?.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps execution-routing dropdown labels localized outside English', () => {
    const english = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as unknown;
    // Interpolation-only entries (e.g. ineligibleOption "{{name}} — {{reason}}")
    // are intentionally identical across locales, so assert on entries with real
    // prose that must differ from English.
    const keys = [
      'session.execution.setSession',
      'session.executionGroup.unknownRun',
      // OpenSpec Execute dropdown prose (task 2.4) — interpolation-only entries
      // like `openspec.execute.dispatch_to` are intentionally excluded here.
      'openspec.execute.action',
      'openspec.execute.clear_default',
    ] as const;
    for (const locale of SUPPORTED_LOCALES.filter((item) => item !== 'en')) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      for (const key of keys) {
        expect(readPath(messages, key), `${locale}:${key}`).not.toBe(readPath(english, key));
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

  it('keeps the Grok agent label present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      const label = readPath(messages, 'session.agentType.grok_sdk');
      const prerequisiteError = readPath(messages, 'new_session.grok_prerequisite_error');
      expect(label, `${locale}:session.agentType.grok_sdk`).toEqual(expect.any(String));
      expect((label as string).trim().length).toBeGreaterThan(0);
      expect(prerequisiteError, `${locale}:new_session.grok_prerequisite_error`).toEqual(expect.any(String));
      expect((prerequisiteError as string).trim().length).toBeGreaterThan(0);
      const mcpLabel = readPath(messages, 'sharedContext.management.mcpProviderGrokAcp');
      expect(mcpLabel, `${locale}:sharedContext.management.mcpProviderGrokAcp`).toEqual(expect.any(String));
      expect((mcpLabel as string).trim().length).toBeGreaterThan(0);
    }
  });
});
