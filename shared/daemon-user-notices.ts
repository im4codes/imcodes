/**
 * Stable, user-facing daemon notice protocol.
 *
 * `text` remains an English fallback for old clients, exports and unknown
 * future codes. New clients render the code through their own locale. Params
 * are deliberately allow-listed and bounded so internal errors, paths,
 * session identities and other user data never become translation params.
 */
export const DAEMON_USER_NOTICE_CODE = {
  EXECUTION_POOL_UNCONFIGURED: 'execution_pool_unconfigured',
  SUPERVISION_AUDIT_STOPPED_BY_USER: 'supervision_audit_stopped_by_user',
  SUPERVISION_MISSING_COMPLETION: 'supervision_missing_completion',
  SUPERVISION_UNCONFIRMED_ACTIVITY: 'supervision_unconfirmed_activity',
  SUPERVISION_COMPLETION_UNKNOWN: 'supervision_completion_unknown',
  SUPERVISION_WAIT_VALIDATION_FAILED: 'supervision_wait_validation_failed',
  SUPERVISION_AUDIT_IDENTITY_RESTORE_FAILED: 'supervision_audit_identity_restore_failed',
  SUPERVISION_AUDIT_RECOVERY_LIMIT: 'supervision_audit_recovery_limit',
  SUPERVISION_HEARTBEAT_UNREACHABLE: 'supervision_heartbeat_unreachable',
  SUPERVISION_HEARTBEAT_FAILED: 'supervision_heartbeat_failed',
  SUPERVISION_AUDIT_IDENTITY_CHANGED: 'supervision_audit_identity_changed',
  SUPERVISION_AUDIT_RUNTIME_MISSING: 'supervision_audit_runtime_missing',
  SUPERVISION_AUDIT_CONTINUE_FAILED: 'supervision_audit_continue_failed',
  SUPERVISION_SESSION_BLOCKED: 'supervision_session_blocked',
  SUPERVISION_AUTHORITY_REHYDRATED: 'supervision_authority_rehydrated',
  SUPERVISION_AUTHORITY_RECOVERY_EXHAUSTED: 'supervision_authority_recovery_exhausted',
  SUPERVISION_RETURNED_CONTROL: 'supervision_returned_control',
  SUPERVISION_HUMAN_INPUT_BLOCKER: 'supervision_human_input_blocker',
  SUPERVISION_REPEAT_CONTINUE_LIMIT: 'supervision_repeat_continue_limit',
  SUPERVISION_CONTINUE_HARD_LIMIT: 'supervision_continue_hard_limit',
  SUPERVISION_AUDIT_UNUSABLE: 'supervision_audit_unusable',
  SUPERVISION_AUDIT_ROUTE_MISSING: 'supervision_audit_route_missing',
  SUPERVISION_AUDIT_ROUTE_REFUSED: 'supervision_audit_route_refused',
  SUPERVISION_AUDIT_PREPARE_FAILED: 'supervision_audit_prepare_failed',
  SUPERVISION_AUDIT_MARKER_MISSING: 'supervision_audit_marker_missing',
  SUPERVISION_CONTINUE_FAILED: 'supervision_continue_failed',
  CODEX_WATCHDOG_RECOVERED: 'codex_watchdog_recovered',
  MEMORY_WATCHDOG_RECOVERED: 'memory_watchdog_recovered',
  TRANSPORT_RECOVERY_STOPPED: 'transport_recovery_stopped',
  TRANSPORT_RECOVERING: 'transport_recovering',
  TRANSPORT_AUTO_RESTART_FAILED: 'transport_auto_restart_failed',
  QUEUED_MESSAGES_EXPIRED: 'queued_messages_expired',
  QUEUED_MESSAGES_FAILED: 'queued_messages_failed',
  DELEGATION_CONTEXT_OMITTED: 'delegation_context_omitted',
  AUDIT_WORKER_PROVISION_REFUSED: 'audit_worker_provision_refused',
  SESSION_STOP_FAILED: 'session_stop_failed',
  ALIAS_UNRESOLVED: 'alias_unresolved',
  QUEUE_OVERFLOW: 'queue_overflow',
  SESSION_AUTO_RESUME_FAILED: 'session_auto_resume_failed',
  CONVERSATION_STARTED: 'conversation_started',
  CONVERSATION_CLEAR_FAILED: 'conversation_clear_failed',
  SERVICE_TIER_CHANGE_FAILED: 'service_tier_change_failed',
  FAST_MODE_ON: 'fast_mode_on',
  FAST_MODE_OFF: 'fast_mode_off',
  UNKNOWN_MODEL: 'unknown_model',
  MODEL_SWITCHED: 'model_switched',
  MODEL_SWITCH_PROOF_GATED: 'model_switch_proof_gated',
  THINKING_LEVEL_UNSUPPORTED: 'thinking_level_unsupported',
  THINKING_LEVEL_SWITCHED: 'thinking_level_switched',
  MESSAGE_SEND_FAILED: 'message_send_failed',
  COMPACT_FAILED: 'compact_failed',
  SESSION_INLINE_ERROR: 'session_inline_error',
} as const;

export type DaemonUserNoticeCode = typeof DAEMON_USER_NOTICE_CODE[keyof typeof DAEMON_USER_NOTICE_CODE];
export type DaemonUserNoticeParam = string | number;
export type DaemonUserNoticeParams = Readonly<Record<string, DaemonUserNoticeParam>>;

export const DAEMON_USER_NOTICE_I18N_KEYS: Readonly<Record<DaemonUserNoticeCode, string>> =
  Object.fromEntries(
    Object.values(DAEMON_USER_NOTICE_CODE).map((code) => [code, `chat.daemon_notice.${code}`]),
  ) as Record<DaemonUserNoticeCode, string>;

/** Public so guard tests can prove every dynamic notice has an explicit path. */
export const DAEMON_USER_NOTICE_PARAM_KEYS: Readonly<Partial<Record<DaemonUserNoticeCode, readonly string[]>>> = {
  [DAEMON_USER_NOTICE_CODE.EXECUTION_POOL_UNCONFIGURED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_UNUSABLE]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_ROUTE_REFUSED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.SUPERVISION_AUTHORITY_REHYDRATED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.SUPERVISION_RETURNED_CONTROL]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.SUPERVISION_REPEAT_CONTINUE_LIMIT]: ['limit', 'bucket'],
  [DAEMON_USER_NOTICE_CODE.SUPERVISION_CONTINUE_HARD_LIMIT]: ['limit'],
  [DAEMON_USER_NOTICE_CODE.CODEX_WATCHDOG_RECOVERED]: ['minutes'],
  [DAEMON_USER_NOTICE_CODE.MEMORY_WATCHDOG_RECOVERED]: ['minutes'],
  [DAEMON_USER_NOTICE_CODE.TRANSPORT_RECOVERY_STOPPED]: ['limit', 'minutes'],
  [DAEMON_USER_NOTICE_CODE.TRANSPORT_RECOVERING]: ['count', 'detail'],
  [DAEMON_USER_NOTICE_CODE.TRANSPORT_AUTO_RESTART_FAILED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.QUEUED_MESSAGES_EXPIRED]: ['count', 'minutes'],
  [DAEMON_USER_NOTICE_CODE.QUEUED_MESSAGES_FAILED]: ['count'],
  [DAEMON_USER_NOTICE_CODE.AUDIT_WORKER_PROVISION_REFUSED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.SESSION_STOP_FAILED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.ALIAS_UNRESOLVED]: ['count', 'detail'],
  [DAEMON_USER_NOTICE_CODE.QUEUE_OVERFLOW]: ['limit'],
  [DAEMON_USER_NOTICE_CODE.SESSION_AUTO_RESUME_FAILED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.CONVERSATION_CLEAR_FAILED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.SERVICE_TIER_CHANGE_FAILED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.UNKNOWN_MODEL]: ['model', 'detail'],
  [DAEMON_USER_NOTICE_CODE.MODEL_SWITCHED]: ['model'],
  [DAEMON_USER_NOTICE_CODE.MODEL_SWITCH_PROOF_GATED]: ['model'],
  [DAEMON_USER_NOTICE_CODE.THINKING_LEVEL_UNSUPPORTED]: ['level', 'supported', 'detail'],
  [DAEMON_USER_NOTICE_CODE.THINKING_LEVEL_SWITCHED]: ['level'],
  [DAEMON_USER_NOTICE_CODE.MESSAGE_SEND_FAILED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.COMPACT_FAILED]: ['detail'],
  [DAEMON_USER_NOTICE_CODE.SESSION_INLINE_ERROR]: ['detail'],
};

const MAX_PARAM_LENGTH = 80;
const MAX_DETAIL_LENGTH = 200;

function sanitizeStringParam(key: string, raw: string): string {
  let value = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (key === 'detail') {
    value = value
      .replace(/\b(bearer)\s+\S+/gi, '$1 [redacted]')
      .replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=[redacted]');
  }
  return value.slice(0, key === 'detail' ? MAX_DETAIL_LENGTH : MAX_PARAM_LENGTH);
}

export function isDaemonUserNoticeCode(value: unknown): value is DaemonUserNoticeCode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(DAEMON_USER_NOTICE_I18N_KEYS, value);
}

export function normalizeDaemonUserNoticeParams(
  code: DaemonUserNoticeCode,
  value: unknown,
): Record<string, DaemonUserNoticeParam> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = new Set(DAEMON_USER_NOTICE_PARAM_KEYS[code] ?? []);
  const normalized: Record<string, DaemonUserNoticeParam> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      normalized[key] = raw;
    } else if (typeof raw === 'string') {
      normalized[key] = sanitizeStringParam(key, raw);
    }
  }
  return normalized;
}

function numberParam(params: DaemonUserNoticeParams, key: string): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringParam(params: DaemonUserNoticeParams, key: string): string {
  const value = params[key];
  return typeof value === 'string' && value ? value : 'unknown';
}

/** English fallback is centralized so emitters never carry display prose. */
export function formatDaemonUserNoticeEnglish(
  code: DaemonUserNoticeCode,
  params: DaemonUserNoticeParams = {},
): string {
  switch (code) {
    case DAEMON_USER_NOTICE_CODE.EXECUTION_POOL_UNCONFIGURED:
      return 'The configured execution pool is unavailable. Configure a compatible pool before retrying automation.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_STOPPED_BY_USER:
      return 'Supervision stopped because the audit session was stopped by the user, so its audit cannot complete.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_MISSING_COMPLETION:
      return 'Automation stopped because no completed assistant response was available for that turn. Manual continuation is required.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_UNCONFIRMED_ACTIVITY:
      return "Automation stopped because the assistant result arrived but this session's activity could not be confirmed before the deadline. Check the provider/runtime state; manual continuation is required.";
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_COMPLETION_UNKNOWN:
      return 'Automation could not determine whether the task is complete. Manual continuation is required.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_WAIT_VALIDATION_FAILED:
      return 'Automation could not validate the reported wait. Manual continuation is required.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_IDENTITY_RESTORE_FAILED:
      return 'Supervision could not restore the exact peer-audit session identity after restart. Manual review is required.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_RECOVERY_LIMIT:
      return 'The configured audit session stopped again after the automatic recovery limit. The audit remains pending for manual intervention.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_HEARTBEAT_UNREACHABLE:
      return 'The waiting-status heartbeat could not reach the execution session; the original wait deadline remains active.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_HEARTBEAT_FAILED:
      return 'The waiting-status heartbeat failed; the original wait deadline remains active.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_IDENTITY_CHANGED:
      return 'The configured audit session changed identity while recovery was pending. No continue prompt was sent.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_RUNTIME_MISSING:
      return 'The configured audit session stopped and has no live runtime, so its audit turn could not be continued automatically.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_CONTINUE_FAILED:
      return 'The configured audit session stopped, but its automatic continue prompt could not be delivered.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_SESSION_BLOCKED:
      return 'Supervision stopped because the session entered a blocked state.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUTHORITY_REHYDRATED:
      return 'The session was restored after an authority outage; supervision will retry within its restart budget.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUTHORITY_RECOVERY_EXHAUSTED:
      return 'Supervision stopped after the authority outage could not be recovered within its restart budget.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_RETURNED_CONTROL:
      return 'Automation returned control to the human because manual input is required.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_HUMAN_INPUT_BLOCKER:
      return 'Automation returned control because the executing session reported a human-input blocker.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_REPEAT_CONTINUE_LIMIT:
      return `Automation reached the repeated auto-continue limit (${numberParam(params, 'limit')}) for ${stringParam(params, 'bucket')}; handing control back to the human.`;
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_CONTINUE_HARD_LIMIT:
      return `Automation reached the auto-continue hard limit (${numberParam(params, 'limit')}); handing control back to the human.`;
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_UNUSABLE:
      return 'Automation observed a peer audit delegated to an unusable auditor. Manual review is required.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_ROUTE_MISSING:
      return 'Automation peer audit could not resolve the current session or configured auditor. Manual review is required.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_ROUTE_REFUSED:
      return 'Automation peer audit cannot use the configured auditor. Manual review is required.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_PREPARE_FAILED:
      return 'Automation could not ask the current session to prepare the peer audit. Manual review is required.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_MARKER_MISSING:
      return 'The delegated audit reply arrived, but the current session still did not report exactly one PASS/REWORK audit marker after an automatic correction attempt. Waiting until the audit deadline.';
    case DAEMON_USER_NOTICE_CODE.SUPERVISION_CONTINUE_FAILED:
      return 'Automation could not continue the task. Manual continuation is required.';
    case DAEMON_USER_NOTICE_CODE.CODEX_WATCHDOG_RECOVERED:
      return `Codex watchdog stopped a stale turn after ${numberParam(params, 'minutes')} minutes with no activity and sent \`continue\`.`;
    case DAEMON_USER_NOTICE_CODE.MEMORY_WATCHDOG_RECOVERED:
      return `Memory compression watchdog stopped a stale turn after ${numberParam(params, 'minutes')} minutes and sent \`continue\`.`;
    case DAEMON_USER_NOTICE_CODE.TRANSPORT_RECOVERY_STOPPED:
      return `Transport recovery stopped after ${numberParam(params, 'limit')} automatic restart attempts in ${numberParam(params, 'minutes')} minutes.`;
    case DAEMON_USER_NOTICE_CODE.TRANSPORT_RECOVERING:
      return `The provider is recovering; ${numberParam(params, 'count')} queued message(s) will be resent automatically.`;
    case DAEMON_USER_NOTICE_CODE.TRANSPORT_AUTO_RESTART_FAILED:
      return 'Automatic provider restart failed. Restart the session manually to recover.';
    case DAEMON_USER_NOTICE_CODE.QUEUED_MESSAGES_EXPIRED:
      return `${numberParam(params, 'count')} queued message(s) expired after ${numberParam(params, 'minutes')} minutes. Send them again.`;
    case DAEMON_USER_NOTICE_CODE.QUEUED_MESSAGES_FAILED:
      return `${numberParam(params, 'count')} queued message(s) still could not be delivered after reconnecting. Send them again.`;
    case DAEMON_USER_NOTICE_CODE.DELEGATION_CONTEXT_OMITTED:
      return 'Delegation context was unavailable; only the clean task was forwarded.';
    case DAEMON_USER_NOTICE_CODE.AUDIT_WORKER_PROVISION_REFUSED:
      return 'Automatic audit worker provisioning was refused; using the bounded busy-session queue fallback.';
    case DAEMON_USER_NOTICE_CODE.SESSION_STOP_FAILED:
      return 'Stopping the session failed.';
    case DAEMON_USER_NOTICE_CODE.ALIAS_UNRESOLVED:
      return `${numberParam(params, 'count')} alias marker(s) could not be resolved, so the message was not delivered.`;
    case DAEMON_USER_NOTICE_CODE.QUEUE_OVERFLOW:
      return `The queued-message limit (${numberParam(params, 'limit')}) was reached, so the oldest message was discarded. Send it again later.`;
    case DAEMON_USER_NOTICE_CODE.SESSION_AUTO_RESUME_FAILED:
      return 'Automatic session recovery failed. Restart the session manually.';
    case DAEMON_USER_NOTICE_CODE.CONVERSATION_STARTED:
      return 'Started a fresh conversation.';
    case DAEMON_USER_NOTICE_CODE.CONVERSATION_CLEAR_FAILED:
      return 'Starting a fresh conversation failed.';
    case DAEMON_USER_NOTICE_CODE.SERVICE_TIER_CHANGE_FAILED:
      return 'The service tier could not be changed.';
    case DAEMON_USER_NOTICE_CODE.FAST_MODE_ON:
      return 'Fast mode is on for this session (1.5x speed, increased plan usage).';
    case DAEMON_USER_NOTICE_CODE.FAST_MODE_OFF:
      return 'Fast mode is off for this session.';
    case DAEMON_USER_NOTICE_CODE.UNKNOWN_MODEL:
      return `Model ${stringParam(params, 'model')} is not available for this provider.`;
    case DAEMON_USER_NOTICE_CODE.MODEL_SWITCHED:
      return `Switched model to ${stringParam(params, 'model')}.`;
    case DAEMON_USER_NOTICE_CODE.MODEL_SWITCH_PROOF_GATED:
      return `Model switching for ${stringParam(params, 'model')} is unavailable until the provider capability is verified.`;
    case DAEMON_USER_NOTICE_CODE.THINKING_LEVEL_UNSUPPORTED:
      return `Thinking level ${stringParam(params, 'level')} is not supported by this provider.`;
    case DAEMON_USER_NOTICE_CODE.THINKING_LEVEL_SWITCHED:
      return `Switched thinking level to ${stringParam(params, 'level')}.`;
    case DAEMON_USER_NOTICE_CODE.MESSAGE_SEND_FAILED:
      return 'Sending the message failed.';
    case DAEMON_USER_NOTICE_CODE.COMPACT_FAILED:
      return 'Compacting the conversation failed.';
    case DAEMON_USER_NOTICE_CODE.SESSION_INLINE_ERROR:
      return 'The session reported an error.';
  }
}

export function createDaemonUserNoticePayload(
  code: DaemonUserNoticeCode,
  params: DaemonUserNoticeParams = {},
  englishFallback?: string,
): {
  text: string;
  noticeCode: DaemonUserNoticeCode;
  noticeParams: Record<string, DaemonUserNoticeParam>;
} {
  const noticeParams = normalizeDaemonUserNoticeParams(code, params);
  return {
    text: `⚠️ ${englishFallback ?? formatDaemonUserNoticeEnglish(code, noticeParams)}`,
    noticeCode: code,
    noticeParams,
  };
}

/** Attach a code to an existing exact legacy rendering (including its own icon). */
export function attachDaemonUserNotice(
  code: DaemonUserNoticeCode,
  text: string,
  params: DaemonUserNoticeParams = {},
): ReturnType<typeof createDaemonUserNoticePayload> {
  const noticeParams = normalizeDaemonUserNoticeParams(code, params);
  return { text, noticeCode: code, noticeParams };
}
