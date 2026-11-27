import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';
import { TASK_PAIR_FLAGS } from '@shared/task-pair.js';

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
const TOOL_RESULT_STATUS_KEYS = [
  'chat.tool_result_done',
  'chat.tool_result_done_with_command',
] as const;
const COMPOSER_TARGET_KEYS = [
  'session.composer_target_label',
  'session.composer_target_aria',
] as const;
const DELEGATION_OBJECTIVE_TOGGLE_KEYS = [
  'delegation.objective_expand',
  'delegation.objective_collapse',
] as const;

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
  ), value);
}

export function findDuplicateJsonKeys(jsonText: string): string[] {
  let pos = 0;
  const duplicates: string[] = [];

  function skipWhitespace() {
    while (pos < jsonText.length) {
      const ch = jsonText[pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        pos++;
      } else {
        break;
      }
    }
  }

  function parseString(): string {
    pos++;
    let str = '';
    while (pos < jsonText.length) {
      const ch = jsonText[pos];
      if (ch === '\\') {
        pos++;
        const esc = jsonText[pos];
        if (esc === 'u') {
          str += String.fromCharCode(parseInt(jsonText.slice(pos + 1, pos + 5), 16));
          pos += 5;
        } else {
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          str += map[esc!] ?? esc;
          pos++;
        }
      } else if (ch === '"') {
        pos++;
        return str;
      } else {
        str += ch;
        pos++;
      }
    }
    throw new Error('Unterminated string in JSON');
  }

  function parseValue(currentPath: string) {
    skipWhitespace();
    if (pos >= jsonText.length) return;
    const ch = jsonText[pos];
    if (ch === '{') {
      parseObject(currentPath);
    } else if (ch === '[') {
      parseArray(currentPath);
    } else if (ch === '"') {
      parseString();
    } else if (ch === 't' && jsonText.startsWith('true', pos)) {
      pos += 4;
    } else if (ch === 'f' && jsonText.startsWith('false', pos)) {
      pos += 5;
    } else if (ch === 'n' && jsonText.startsWith('null', pos)) {
      pos += 4;
    } else {
      while (pos < jsonText.length && /[-+0-9.eE]/.test(jsonText[pos]!)) {
        pos++;
      }
    }
  }

  function parseArray(currentPath: string) {
    pos++;
    skipWhitespace();
    if (jsonText[pos] === ']') {
      pos++;
      return;
    }
    let idx = 0;
    while (pos < jsonText.length) {
      parseValue(`${currentPath}[${idx}]`);
      skipWhitespace();
      if (jsonText[pos] === ',') {
        pos++;
        idx++;
      } else if (jsonText[pos] === ']') {
        pos++;
        return;
      } else {
        throw new Error(`Unexpected token in array at ${pos}`);
      }
    }
  }

  function parseObject(currentPath: string) {
    pos++;
    skipWhitespace();
    if (jsonText[pos] === '}') {
      pos++;
      return;
    }
    const seen = new Set<string>();
    while (pos < jsonText.length) {
      skipWhitespace();
      if (jsonText[pos] !== '"') {
        throw new Error(`Expected string key at ${pos}`);
      }
      const key = parseString();
      if (seen.has(key)) {
        duplicates.push(currentPath ? `${currentPath}.${key}` : key);
      }
      seen.add(key);
      skipWhitespace();
      if (jsonText[pos] !== ':') {
        throw new Error(`Expected ":" at ${pos}`);
      }
      pos++;
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      parseValue(childPath);
      skipWhitespace();
      if (jsonText[pos] === ',') {
        pos++;
      } else if (jsonText[pos] === '}') {
        pos++;
        return;
      } else {
        throw new Error(`Expected "," or "}" at ${pos}`);
      }
    }
  }

  parseValue('');
  return duplicates;
}

describe('generic i18n coverage guard', () => {
  it('keeps delegation objective expand/collapse controls localized in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as unknown;
      for (const key of DELEGATION_OBJECTIVE_TOGGLE_KEYS) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps composer target labels localized in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as unknown;
      for (const key of COMPOSER_TARGET_KEYS) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string | undefined)?.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
      expect(
        readPath(messages, 'session.composer_target_aria'),
        `${locale}:session.composer_target_aria`,
      ).toContain('{{name}}');
    }
  });

  it('keeps completed tool result labels localized in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as unknown;
      for (const key of TOOL_RESULT_STATUS_KEYS) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string | undefined)?.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
      expect(
        readPath(messages, 'chat.tool_result_done_with_command'),
        `${locale}:chat.tool_result_done_with_command`,
      ).toContain('{{command}}');
    }
  });

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

  it('keeps the Hermes Agent and managed MCP labels present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      const label = readPath(messages, 'session.agentType.hermes_agent');
      const mcpLabel = readPath(messages, 'sharedContext.management.mcpProviderHermesAcp');
      const prerequisiteError = readPath(messages, 'new_session.hermes_prerequisite_error');
      expect(label, `${locale}:session.agentType.hermes_agent`).toBe('Hermes Agent');
      expect(mcpLabel, `${locale}:sharedContext.management.mcpProviderHermesAcp`).toBe('Hermes ACP');
      expect(prerequisiteError, `${locale}:new_session.hermes_prerequisite_error`).toEqual(expect.any(String));
      expect((prerequisiteError as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the DeepSeek Harness agent label present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      const label = readPath(messages, 'session.agentType.deepseek_harness');
      expect(label, `${locale}:session.agentType.deepseek_harness`).toEqual(expect.any(String));
      expect((label as string).trim().length).toBeGreaterThan(0);
      // The runtime is a brand name, so every locale intentionally keeps the
      // English spelling rather than transliterating it.
      expect(label, `${locale}:session.agentType.deepseek_harness`).toBe('DeepSeek Harness');
    }
  });

  it('keeps the Antigravity agent label present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      const label = readPath(messages, 'session.agentType.agy_sdk');
      const prerequisiteError = readPath(messages, 'new_session.agy_prerequisite_error');
      expect(label, `${locale}:session.agentType.agy_sdk`).toEqual(expect.any(String));
      expect((label as string).trim().length).toBeGreaterThan(0);
      expect(label, `${locale}:session.agentType.agy_sdk`).toBe('Antigravity');
      expect(prerequisiteError, `${locale}:new_session.agy_prerequisite_error`).toEqual(expect.any(String));
      expect((prerequisiteError as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps a taskPair.flag.<flag> label for every TASK_PAIR_FLAGS entry in every locale (a new flag must never ship without one)', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      for (const flag of TASK_PAIR_FLAGS) {
        const value = readPath(messages, `taskPair.flag.${flag}`);
        expect(value, `${locale}:taskPair.flag.${flag}`).toEqual(expect.any(String));
        expect((value as string | undefined)?.trim().length, `${locale}:taskPair.flag.${flag}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps push notification settings keys present in every locale', () => {
    const PUSH_NOTIFICATION_SETTINGS_KEYS = [
      'settings.push_notifications_label',
      'settings.push_notifications_title',
      'settings.push_notifications_desc',
      'settings.push_group_basic',
      'settings.push_task_complete_title',
      'settings.push_task_complete_desc',
      'settings.push_waiting_input_title',
      'settings.push_waiting_input_desc',
      'settings.push_session_error_title',
      'settings.push_session_error_desc',
      'settings.push_group_task_pair',
      'settings.push_task_pair_done_title',
      'settings.push_task_pair_done_desc',
      'settings.push_task_pair_paused_title',
      'settings.push_task_pair_paused_desc',
      'settings.push_task_pair_audit_title',
      'settings.push_task_pair_audit_desc',
      'settings.push_group_security',
      'settings.push_security_highest_badge',
      'settings.push_remote_desktop_title',
      'settings.push_remote_desktop_desc',
    ];

    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      for (const key of PUSH_NOTIFICATION_SETTINGS_KEYS) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string | undefined)?.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps settings tab labels and concise pain-free Feature Guide keys present and translated in all 7 locales', () => {
    const GUIDE_SECTION_IDS = [
      'overview',
      'team',
      'taskPairs',
      'executionPools',
      'controlledNodes',
      'remoteDesktopOcu',
      'quickInputVoice',
      'aliasesVerification',
      'isolationLiveness',
      'memoryIdentity',
      'autoCronMobile',
    ] as const;
    const GUIDE_TOP_KEYS = [
      'settings.tab_profile',
      'settings.tab_notifications',
      'settings.tab_security',
      'settings.tab_guide',
      'guide.kicker',
      'guide.title',
      'guide.subtitle',
      'guide.quick_jump',
      'guide.expand_all',
      'guide.collapse_all',
      'guide.tips_label',
    ] as const;
    const SECTION_FIELDS = ['pill', 'title', 'tagline', 'summary', 'tip_1', 'tip_2', 'tip_3'] as const;

    const enMessages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as unknown;
    const enTitle = readPath(enMessages, 'guide.title');

    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as unknown;
      expect(readPath(messages, 'guide.pain_label'), `${locale}:guide.pain_label must be removed`).toBeUndefined();
      expect(readPath(messages, 'guide.solution_label'), `${locale}:guide.solution_label must be removed`).toBeUndefined();
      for (const key of GUIDE_TOP_KEYS) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string | undefined)?.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
      if (locale !== 'en') {
        expect(readPath(messages, 'guide.title'), `${locale}:guide.title must be translated`).not.toBe(enTitle);
        expect(readPath(messages, 'settings.tab_profile'), `${locale}:settings.tab_profile must be translated`).not.toBe('Profile');
        expect(readPath(messages, 'settings.tab_notifications'), `${locale}:settings.tab_notifications must be translated`).not.toBe('Notifications');
        expect(readPath(messages, 'settings.tab_security'), `${locale}:settings.tab_security must be translated`).not.toBe('Security');
        expect(readPath(messages, 'settings.tab_guide'), `${locale}:settings.tab_guide must be translated`).not.toBe('User Guide');
      }
      for (const id of GUIDE_SECTION_IDS) {
        expect(readPath(messages, `guide.sections.${id}.pain`), `${locale}:guide.sections.${id}.pain must be removed`).toBeUndefined();
        expect(readPath(messages, `guide.sections.${id}.solution`), `${locale}:guide.sections.${id}.solution must be removed`).toBeUndefined();
        for (const field of SECTION_FIELDS) {
          const key = `guide.sections.${id}.${field}`;
          const value = readPath(messages, key);
          expect(value, `${locale}:${key}`).toEqual(expect.any(String));
          expect((value as string | undefined)?.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps doc_share keys aligned across all 7 locales and covering every key used in DocShareDialog / FileBrowser / OfficePreview', () => {
    const enMessages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as Record<string, any>;
    const enDocShareKeys = Object.keys(enMessages.doc_share ?? {}).sort();
    expect(enDocShareKeys.length).toBeGreaterThan(0);

    const usedKeys = new Set<string>();
    for (const relPath of [
      'src/components/DocShareDialog.tsx',
      'src/components/FileBrowser.tsx',
      'src/components/OfficePreview.tsx',
    ]) {
      const content = readFileSync(join(WEB_ROOT, relPath), 'utf8');
      for (const match of content.matchAll(/t\(['"](doc_share\.[^'"`]+)['"]/g)) {
        usedKeys.add(match[1]!);
      }
    }
    expect(usedKeys.size).toBeGreaterThan(0);

    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>;
      const localeKeys = Object.keys(messages.doc_share ?? {}).sort();
      expect(localeKeys, `${locale}:doc_share key parity`).toEqual(enDocShareKeys);

      for (const fullKey of usedKeys) {
        const val = readPath(messages, fullKey);
        expect(val, `${locale}:${fullKey}`).toEqual(expect.any(String));
        expect((val as string).trim().length, `${locale}:${fullKey}`).toBeGreaterThan(0);
      }

      if (locale !== 'en') {
        expect(messages.doc_share.group_share_title, `${locale}:group_share_title translated`).not.toBe(
          enMessages.doc_share.group_share_title,
        );
        expect(messages.doc_share.tab_team, `${locale}:tab_team translated`).not.toBe(
          enMessages.doc_share.tab_team,
        );
        expect(messages.doc_share.manage_node_groups_btn, `${locale}:manage_node_groups_btn translated`).not.toBe(
          enMessages.doc_share.manage_node_groups_btn,
        );
      }
    }
  });

  it('keeps mobile_menu keys aligned across all 7 locales and translated outside English', () => {
    const enMessages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as Record<string, any>;
    const enKeys = Object.keys(enMessages.mobile_menu ?? {}).sort();
    expect(enKeys).toEqual(
      expect.arrayContaining(['home', 'change_server', 'switch_view', 'tab_servers', 'tab_remote', 'remote_connect', 'remote_connect_label', 'remote_unavailable']),
    );

    const usedKeys = new Set<string>();
    for (const relPath of [
      'src/components/MobileServerMenuToolbar.tsx',
      'src/components/MobileRemoteDesktopMenuList.tsx',
    ]) {
      const content = readFileSync(join(WEB_ROOT, relPath), 'utf8');
      for (const match of content.matchAll(/t\(['"](mobile_menu\.[^'"`]+)['"]/g)) {
        usedKeys.add(match[1]!);
      }
    }
    expect(usedKeys.size).toBeGreaterThan(0);

    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>;
      const localeKeys = Object.keys(messages.mobile_menu ?? {}).sort();
      expect(localeKeys, `${locale}:mobile_menu key parity`).toEqual(enKeys);

      for (const fullKey of usedKeys) {
        const val = readPath(messages, fullKey);
        expect(val, `${locale}:${fullKey}`).toEqual(expect.any(String));
        expect((val as string).trim().length, `${locale}:${fullKey}`).toBeGreaterThan(0);
      }

      if (locale !== 'en') {
        expect(messages.mobile_menu.tab_servers, `${locale}:tab_servers translated`).not.toBe(
          enMessages.mobile_menu.tab_servers,
        );
        expect(messages.mobile_menu.tab_remote, `${locale}:tab_remote translated`).not.toBe(
          enMessages.mobile_menu.tab_remote,
        );
        expect(messages.mobile_menu.remote_connect, `${locale}:remote_connect translated`).not.toBe(
          enMessages.mobile_menu.remote_connect,
        );
      }
    }
  });

  it('keeps featureAnnouncements.cloudDocs localized per language without mixed Chinese/English cloud-doc nouns', () => {
    const enMessages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as Record<string, any>;
    const enKeys = Object.keys(enMessages.featureAnnouncements ?? {}).sort();
    expect(enKeys).toEqual(expect.arrayContaining(['label', 'messagePins', 'cloudDocs', 'dismiss']));

    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>;
      const announcements = messages.featureAnnouncements ?? {};
      expect(Object.keys(announcements).sort(), `${locale}:featureAnnouncements key parity`).toEqual(enKeys);

      for (const [key, value] of Object.entries(announcements)) {
        expect(value, `${locale}:featureAnnouncements.${key}`).toEqual(expect.any(String));
        expect((value as string).trim().length, `${locale}:featureAnnouncements.${key}`).toBeGreaterThan(0);
      }

      const cloudDocsText = String(announcements.cloudDocs ?? '');
      if (locale !== 'en') {
        expect(cloudDocsText, `${locale}:featureAnnouncements.cloudDocs must not contain English "cloud doc"`).not.toMatch(/cloud\s+docs?/i);
      }
      if (!locale.startsWith('zh-')) {
        expect(cloudDocsText, `${locale}:featureAnnouncements.cloudDocs must not contain Chinese cloud-doc terms`).not.toContain('云文档');
        expect(cloudDocsText, `${locale}:featureAnnouncements.cloudDocs must not contain Traditional Chinese cloud-doc terms`).not.toContain('雲端文件');
        if (locale !== 'ja') {
          expect(cloudDocsText, `${locale}:featureAnnouncements.cloudDocs must not contain Han characters`).not.toMatch(/[\u4e00-\u9fff]/);
        }
      } else if (locale === 'zh-CN') {
        expect(cloudDocsText, 'zh-CN:featureAnnouncements.cloudDocs should use 云文档').toContain('云文档');
        expect(cloudDocsText, 'zh-CN:featureAnnouncements.cloudDocs must not mix 雲端文件').not.toContain('雲端文件');
      } else if (locale === 'zh-TW') {
        expect(cloudDocsText, 'zh-TW:featureAnnouncements.cloudDocs should use 雲端文件').toContain('雲端文件');
        expect(cloudDocsText, 'zh-TW:featureAnnouncements.cloudDocs must not mix 云文档').not.toContain('云文档');
      }
    }
  });

  it('keeps repo callback pagination keys and placeholders present across all 7 locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>;
      for (const key of ['repo.callback_prev_page', 'repo.callback_next_page', 'repo.callback_page_info']) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
      const pageInfo = String(readPath(messages, 'repo.callback_page_info') ?? '');
      expect(pageInfo, `${locale}:repo.callback_page_info {{current}}`).toContain('{{current}}');
      expect(pageInfo, `${locale}:repo.callback_page_info {{total}}`).toContain('{{total}}');
      expect(pageInfo, `${locale}:repo.callback_page_info {{pageSize}}`).toContain('{{pageSize}}');
    }
  });

  it('keeps settings.shortcuts.actions.toggle_task_mode keys present and translated across all 7 locales', () => {
    const enMessages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as Record<string, any>;
    const enTitle = String(readPath(enMessages, 'settings.shortcuts.actions.toggle_task_mode.title') ?? '');
    const enDesc = String(readPath(enMessages, 'settings.shortcuts.actions.toggle_task_mode.desc') ?? '');
    expect(enTitle.trim().length).toBeGreaterThan(0);
    expect(enDesc.trim().length).toBeGreaterThan(0);

    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>;
      const title = readPath(messages, 'settings.shortcuts.actions.toggle_task_mode.title');
      const desc = readPath(messages, 'settings.shortcuts.actions.toggle_task_mode.desc');
      expect(title, `${locale}:toggle_task_mode.title`).toEqual(expect.any(String));
      expect(desc, `${locale}:toggle_task_mode.desc`).toEqual(expect.any(String));
      expect((title as string).trim().length, `${locale}:toggle_task_mode.title`).toBeGreaterThan(0);
      expect((desc as string).trim().length, `${locale}:toggle_task_mode.desc`).toBeGreaterThan(0);
      if (locale !== 'en') {
        expect(title, `${locale}:toggle_task_mode.title translated`).not.toBe(enTitle);
        expect(desc, `${locale}:toggle_task_mode.desc translated`).not.toBe(enDesc);
      }
    }
  });

  it('keeps settings.shortcuts.actions.toggle_remote_desktop and remote_desktop.shortcut_no_server translated across all 7 locales', () => {
    const enMessages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as Record<string, any>;
    const enTitle = String(readPath(enMessages, 'settings.shortcuts.actions.toggle_remote_desktop.title') ?? '');
    const enDesc = String(readPath(enMessages, 'settings.shortcuts.actions.toggle_remote_desktop.desc') ?? '');
    const enNoServer = String(readPath(enMessages, 'remote_desktop.shortcut_no_server') ?? '');
    expect(enTitle.trim().length).toBeGreaterThan(0);
    expect(enDesc.trim().length).toBeGreaterThan(0);
    expect(enNoServer.trim().length).toBeGreaterThan(0);

    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>;
      const title = readPath(messages, 'settings.shortcuts.actions.toggle_remote_desktop.title');
      const desc = readPath(messages, 'settings.shortcuts.actions.toggle_remote_desktop.desc');
      const noServer = readPath(messages, 'remote_desktop.shortcut_no_server');
      expect(title, `${locale}:toggle_remote_desktop.title`).toEqual(expect.any(String));
      expect(desc, `${locale}:toggle_remote_desktop.desc`).toEqual(expect.any(String));
      expect(noServer, `${locale}:remote_desktop.shortcut_no_server`).toEqual(expect.any(String));
      expect((title as string).trim().length, `${locale}:toggle_remote_desktop.title`).toBeGreaterThan(0);
      expect((desc as string).trim().length, `${locale}:toggle_remote_desktop.desc`).toBeGreaterThan(0);
      expect((noServer as string).trim().length, `${locale}:remote_desktop.shortcut_no_server`).toBeGreaterThan(0);
      if (locale !== 'en') {
        expect(title, `${locale}:toggle_remote_desktop.title translated`).not.toBe(enTitle);
        expect(desc, `${locale}:toggle_remote_desktop.desc translated`).not.toBe(enDesc);
        expect(noServer, `${locale}:remote_desktop.shortcut_no_server translated`).not.toBe(enNoServer);
      }
    }
  });

  it('keeps askQuestion source/jump keys present and translated across all 7 locales', () => {
    const enMessages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as Record<string, any>;
    const keys = ['askQuestion.fromTab', 'askQuestion.fromSubSession', 'askQuestion.goToSession'] as const;
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>;
      for (const key of keys) {
        const value = readPath(messages, key);
        const enValue = readPath(enMessages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
        if (locale !== 'en') {
          expect(value, `${locale}:${key} translated`).not.toBe(enValue);
        }
      }
    }
  });

  it('keeps top-level picker.* keys (including picker.files) localized and resolving across all 7 locales', async () => {
    const usedPickerKeys = new Set<string>();
    const collectPickerKeys = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          collectPickerKeys(fullPath);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          const content = readFileSync(fullPath, 'utf8');
          for (const match of content.matchAll(/\b(?:t|trans)\(\s*['"](picker\.[^'"`]+)['"]/g)) {
            usedPickerKeys.add(match[1]!);
          }
        }
      }
    };
    collectPickerKeys(join(WEB_ROOT, 'src'));
    expect(usedPickerKeys.has('picker.files')).toBe(true);

    const localeResources: Record<string, { translation: Record<string, any> }> = {};
    for (const locale of SUPPORTED_LOCALES) {
      localeResources[locale] = {
        translation: JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>,
      };
    }

    const i18nInstance = i18next.createInstance();
    await i18nInstance.init({
      resources: localeResources,
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });

    const enMessages = localeResources.en.translation;
    const enPickerFiles = readPath(enMessages, 'picker.files');
    expect(enPickerFiles).toBe('Files');

    for (const locale of SUPPORTED_LOCALES) {
      const messages = localeResources[locale].translation;
      for (const key of usedPickerKeys) {
        const value = readPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
        expect(value, `${locale}:${key} must not fall back to raw key`).not.toBe(key);
        expect(i18nInstance.getFixedT(locale)(key), `${locale}:i18n(${key})`).toBe(value);
      }
      expect(readPath(messages, 'picker.files'), `${locale}:picker.files matches p2p.picker.files`).toBe(
        readPath(messages, 'p2p.picker.files'),
      );
      if (locale !== 'en') {
        expect(readPath(messages, 'picker.files'), `${locale}:picker.files translated`).not.toBe(enPickerFiles);
      }
    }
  });

  it('enforces zero duplicate keys (top-level or nested) across all 7 locale JSON files', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const raw = readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8');
      const duplicates = findDuplicateJsonKeys(raw);
      expect(duplicates, `${locale}.json contains duplicate keys: ${duplicates.join(', ')}`).toEqual([]);
    }
  });

  it('keeps transfer center downloads.* and client_downloads.* fully localized and distinct across all 7 locales', async () => {
    const localeResources: Record<string, { translation: Record<string, any> }> = {};
    for (const locale of SUPPORTED_LOCALES) {
      localeResources[locale] = {
        translation: JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>,
      };
    }

    const i18nInstance = i18next.createInstance();
    await i18nInstance.init({
      resources: localeResources,
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });

    const expectedDownloadsKeys = [
      'downloads.title',
      'downloads.expand',
      'downloads.collapse',
      'downloads.clear_finished',
      'downloads.cancel',
      'downloads.retry',
      'downloads.save_share',
      'downloads.open_folder',
      'downloads.open_folder_hint',
      'downloads.dismiss',
      'downloads.progress_aria',
      'downloads.transferred',
      'downloads.speed',
      'downloads.speed_calculating',
      'downloads.status.preparing',
      'downloads.status.connecting',
      'downloads.status.transferring',
      'downloads.status.falling_back',
      'downloads.status.handed_off',
      'downloads.status.ready_to_save',
      'downloads.status.completed',
      'downloads.status.canceled',
      'downloads.status.failed',
      'downloads.status.paused',
      'downloads.route.pending',
      'downloads.route.direct',
      'downloads.route.http',
      'downloads.route.browser',
      'downloads.pause',
      'downloads.resume',
    ];

    const expectedClientDownloadsKeys = [
      'client_downloads.button_title',
      'client_downloads.title',
      'client_downloads.subtitle',
      'client_downloads.desktop_section',
      'client_downloads.mobile_section',
      'client_downloads.mac_title',
      'client_downloads.mac_arm64',
      'client_downloads.mac_intel',
      'client_downloads.win_title',
      'client_downloads.win_installer',
      'client_downloads.linux_title',
      'client_downloads.linux_deb',
      'client_downloads.linux_sh',
      'client_downloads.android_title',
      'client_downloads.android_fcm',
      'client_downloads.android_nofcm',
      'client_downloads.android_qr_alt',
      'client_downloads.android_download_apk',
      'client_downloads.ios_title',
      'client_downloads.ios_subtitle',
      'client_downloads.ios_qr_alt',
      'client_downloads.ios_open_store',
      'client_downloads.scan_hint',
      'client_downloads.archive_note_prefix',
      'client_downloads.archive_link',
    ];

    for (const locale of SUPPORTED_LOCALES) {
      const messages = localeResources[locale].translation;

      for (const key of expectedDownloadsKeys) {
        const val = readPath(messages, key);
        expect(typeof val, `${locale}:${key}`).toBe('string');
        expect((val as string).trim().length, `${locale}:${key} non-empty`).toBeGreaterThan(0);
        expect(i18nInstance.getFixedT(locale)(key), `${locale}:i18n(${key})`).toBe(val);
      }

      for (const key of expectedClientDownloadsKeys) {
        const val = readPath(messages, key);
        expect(typeof val, `${locale}:${key}`).toBe('string');
        expect((val as string).trim().length, `${locale}:${key} non-empty`).toBeGreaterThan(0);
        expect(i18nInstance.getFixedT(locale)(key), `${locale}:i18n(${key})`).toBe(val);
      }

      const downloadsTitle = readPath(messages, 'downloads.title');
      const clientDownloadsTitle = readPath(messages, 'client_downloads.title');
      expect(downloadsTitle, `${locale}: downloads.title !== client_downloads.title`).not.toBe(clientDownloadsTitle);
    }

    // Specific zh-CN assertions from acceptance criteria 2
    const zhMessages = localeResources['zh-CN'].translation;
    expect(readPath(zhMessages, 'downloads.title')).toBe('下载');
    expect(readPath(zhMessages, 'downloads.clear_finished')).toBe('清除已结束');
    expect(readPath(zhMessages, 'downloads.route.browser')).toBe('浏览器');
    expect(readPath(zhMessages, 'downloads.status.handed_off')).toBe('已交给浏览器');
    expect(readPath(zhMessages, 'downloads.transferred')).toBe('{{transferred}} / {{total}}');
    expect(readPath(zhMessages, 'downloads.dismiss')).toBe('移除');
    expect(readPath(zhMessages, 'client_downloads.title')).toBe('下载客户端');
    expect(readPath(zhMessages, 'client_downloads.button_title')).toBe('下载客户端');
  });

  it('keeps pc_app_update.* keys translated with matching placeholders across all 7 locales', async () => {
    const localeResources: Record<string, { translation: Record<string, any> }> = {};
    for (const locale of SUPPORTED_LOCALES) {
      localeResources[locale] = {
        translation: JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>,
      };
    }
    const i18nInstance = i18next.createInstance();
    await i18nInstance.init({
      resources: localeResources,
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });

    const keys = [
      'pc_app_update.downloading_title',
      'pc_app_update.downloading_body',
      'pc_app_update.downloaded_title',
      'pc_app_update.downloaded_body',
      'pc_app_update.restart_and_update',
      'pc_app_update.restarting',
      'pc_app_update.error_title',
      'pc_app_update.error_body',
      'pc_app_update.retry',
      'pc_app_update.reinstall',
      'pc_app_update.outdated_title',
      'pc_app_update.outdated_body',
      'pc_app_update.download_latest',
      'pc_app_update.later',
      'pc_app_update.dismiss',
    ];
    for (const locale of SUPPORTED_LOCALES) {
      const messages = localeResources[locale].translation;
      for (const key of keys) {
        const val = readPath(messages, key);
        expect(typeof val, `${locale}:${key}`).toBe('string');
        expect((val as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
        expect(i18nInstance.getFixedT(locale)(key), `${locale}:i18n(${key})`).toBe(val);
      }
      expect(String(readPath(messages, 'pc_app_update.downloading_title'))).toContain('{{version}}');
      expect(String(readPath(messages, 'pc_app_update.downloading_body'))).toContain('{{percent}}');
      expect(String(readPath(messages, 'pc_app_update.downloaded_title'))).toContain('{{version}}');
      expect(String(readPath(messages, 'pc_app_update.error_body'))).toContain('{{error}}');
    }
  });

  it('keeps email-auth login.* and settings.* keys localized across all 7 locales', () => {
    const keys = [
      'login.username_or_email_placeholder',
      'login.email_placeholder',
      'login.email_code_placeholder',
      'login.send_email_code',
      'login.resend_email_code',
      'login.forgot_password',
      'login.forgot_password_hint',
      'login.reset_password_btn',
      'login.password_reset_success',
      'login.password_register_email_hint',
      'login.email_auth_disabled',
      'login.invalid_email',
      'login.email_taken',
      'login.email_required',
      'login.email_code_required',
      'login.email_code_invalid',
      'login.email_code_expired',
      'login.email_code_rate_limited',
      'login.email_not_verified',
      'login.email_send_failed',
      'settings.email_title',
      'settings.email_verified_badge',
      'settings.email_unbound_hint',
      'settings.email_placeholder',
      'settings.email_code_placeholder',
      'settings.send_email_code',
      'settings.resend_email_code',
      'settings.bind_email_btn',
      'settings.change_email_btn',
      'settings.email_bound_success',
      'settings.email_change_pw_hint',
      'settings.email_taken',
      'settings.invalid_email',
      'settings.email_code_required',
      'settings.email_code_invalid',
      'settings.email_code_expired',
      'settings.email_code_rate_limited',
      'settings.email_not_verified',
      'settings.email_already_verified',
      'settings.email_send_failed',
    ];
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>;
      for (const key of keys) {
        const val = readPath(messages, key);
        expect(typeof val, `${locale}:${key}`).toBe('string');
        expect((val as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
      expect(String(readPath(messages, 'login.resend_email_code'))).toContain('{{seconds}}');
      expect(String(readPath(messages, 'login.email_code_rate_limited'))).toContain('{{seconds}}');
      expect(String(readPath(messages, 'settings.resend_email_code'))).toContain('{{seconds}}');
      expect(String(readPath(messages, 'settings.email_code_rate_limited'))).toContain('{{seconds}}');
      expect(String(readPath(messages, 'settings.email_change_pw_hint'))).toContain('{{email}}');
    }
  });

  it('keeps app.document_title defined, localized, and distinct across all 7 locales', () => {
    const titles: Record<string, string> = {};
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, any>;
      const val = readPath(messages, 'app.document_title');
      expect(typeof val, `${locale}:app.document_title`).toBe('string');
      expect((val as string).trim().length, `${locale}:app.document_title`).toBeGreaterThan(0);
      expect(val as string).not.toContain('The IM for agents');
      titles[locale] = val as string;
    }
    expect(titles.en).toBe('IM.codes — AI Force Workbench · Your Dedicated AI Squad');
    expect(titles['zh-CN']).toBe('IM.codes — AI 全栈工作台 · 你的专属 AI 战队');
    expect(titles['zh-TW']).toBe('IM.codes — AI 全端工作台 · 你的專屬 AI 戰隊');
    expect(titles.ja).toBe('IM.codes — AI フルスタック・ワークベンチ · あなた専属の AI 部隊');
    expect(titles.ko).toBe('IM.codes — AI 풀스택 워크벤치 · 나만의 AI 전대');
    expect(titles.es).toBe('IM.codes — Estación Full-Stack de IA · Tu Escuadrón de IA');
    expect(titles.ru).toBe('IM.codes — Full-Stack AI-платформа · Твой AI-отряд');
  });
});
