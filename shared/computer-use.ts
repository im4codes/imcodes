import { DAEMON_COMMAND_TYPES } from './daemon-command-types.js';
import { DAEMON_MSG } from './daemon-events.js';

export const COMPUTER_USE_TOOLS = [
  'list_apps',
  'get_app_state',
  'click',
  'perform_secondary_action',
  'scroll',
  'drag',
  'type_text',
  'press_key',
  'set_value',
  'shell_session1',
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_evaluate',
  'browser_close',
] as const;

export type ComputerUseToolName = (typeof COMPUTER_USE_TOOLS)[number];

export const COMPUTER_USE_DOC_TOPICS = [
  'overview',
  'workflow',
  'tools',
  'browser',
  'windows',
  'safety',
] as const;

export type ComputerUseDocTopic = (typeof COMPUTER_USE_DOC_TOPICS)[number];

export const COMPUTER_USE_DEFAULT_TIMEOUT_MS = 30_000;
export const COMPUTER_USE_MIN_TIMEOUT_MS = 1_000;
/** Maximum for GUI and browser Computer Use methods. */
export const COMPUTER_USE_MAX_TIMEOUT_MS = 120_000;
/** Maximum for the active-user shell; intentionally longer than GUI actions. */
export const COMPUTER_USE_SHELL_SESSION1_MAX_TIMEOUT_MS = 900_000;
export const COMPUTER_USE_MAX_ARGUMENT_BYTES = 64 * 1024;
export const COMPUTER_USE_MAX_TEXT_BYTES = 256 * 1024;
export const COMPUTER_USE_MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;
export const COMPUTER_USE_MAX_ERROR_BYTES = 8 * 1024;
/** Optional cursor travel duration for coordinate drag actions. */
export const COMPUTER_USE_DRAG_DURATION_MIN_MS = 100;
export const COMPUTER_USE_DRAG_DURATION_MAX_MS = 20_000;
export const COMPUTER_USE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const COMPUTER_USE_HTTP_PROTOCOL = 'imcodes.computer_use.http.v1' as const;
export const COMPUTER_USE_HTTP_ENVELOPE_VERSION = 1 as const;
export const COMPUTER_USE_HTTP_RESPONSE_MAX_BYTES =
  (COMPUTER_USE_MAX_TEXT_BYTES + COMPUTER_USE_MAX_IMAGE_BASE64_BYTES + COMPUTER_USE_MAX_ERROR_BYTES) * 6 + 4096;

export const COMPUTER_USE_OUTCOMES = [
  'not_dispatched',
  'dispatched_no_result',
  'completed',
  'tool_error',
] as const;

export type ComputerUseOutcome = (typeof COMPUTER_USE_OUTCOMES)[number];

export const COMPUTER_USE_HTTP_REASON = {
  INVALID_REQUEST: 'invalid_request',
  SCOPED_AUTH: 'scoped_auth',
  TARGET_FORBIDDEN: 'target_forbidden',
  EXEC_DISABLED: 'exec_disabled',
  RELAY_DEADLINE: 'relay_deadline',
  INVALID_RESULT: 'invalid_result',
} as const;

export type ComputerUseHttpReason = (typeof COMPUTER_USE_HTTP_REASON)[keyof typeof COMPUTER_USE_HTTP_REASON];

export interface ComputerUseRequest {
  correlationId: string;
  tool: ComputerUseToolName;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ComputerUseContentItem {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ComputerUseResult {
  correlationId: string;
  ok: boolean;
  tool: ComputerUseToolName;
  content: ComputerUseContentItem[];
  durationMs: number;
  error?: string;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface ComputerUseFrame extends ComputerUseRequest {
  type: typeof DAEMON_COMMAND_TYPES.COMPUTER_USE;
}

export interface ComputerUseResultFrame extends ComputerUseResult {
  type: typeof DAEMON_MSG.COMPUTER_USE_RESULT;
}

export interface ComputerUseHttpEnvelope {
  protocol: typeof COMPUTER_USE_HTTP_PROTOCOL;
  version: typeof COMPUTER_USE_HTTP_ENVELOPE_VERSION;
  outcome: ComputerUseOutcome;
  result?: ComputerUseResult;
  reason?: ComputerUseHttpReason;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function computerUseMaxTimeoutMs(tool: ComputerUseToolName): number {
  return tool === 'shell_session1'
    ? COMPUTER_USE_SHELL_SESSION1_MAX_TIMEOUT_MS
    : COMPUTER_USE_MAX_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolName(value: unknown): value is ComputerUseToolName {
  return typeof value === 'string' && (COMPUTER_USE_TOOLS as readonly string[]).includes(value);
}

function isContentItem(value: unknown): value is ComputerUseContentItem {
  if (!isRecord(value)) return false;
  if (value.type !== 'text' && value.type !== 'image') return false;
  if (value.text !== undefined && typeof value.text !== 'string') return false;
  if (value.data !== undefined && typeof value.data !== 'string') return false;
  if (value.mimeType !== undefined && typeof value.mimeType !== 'string') return false;
  if (value.type === 'text') {
    if (typeof value.text !== 'string') return false;
    return utf8ByteLength(value.text) <= COMPUTER_USE_MAX_TEXT_BYTES;
  }
  if (typeof value.data !== 'string'
    || typeof value.mimeType !== 'string'
    || !(COMPUTER_USE_IMAGE_MIME_TYPES as readonly string[]).includes(value.mimeType)) return false;
  return utf8ByteLength(value.data) <= COMPUTER_USE_MAX_IMAGE_BASE64_BYTES;
}

const COMPUTER_USE_REQUEST_KEYS = new Set(['type', 'correlationId', 'tool', 'arguments', 'timeoutMs']);
const COMPUTER_USE_RESULT_KEYS = new Set(['type', 'correlationId', 'ok', 'tool', 'content', 'durationMs', 'error', 'timedOut', 'truncated']);
const COMPUTER_USE_HTTP_ENVELOPE_KEYS = new Set(['protocol', 'version', 'outcome', 'result', 'reason']);
const COMPUTER_USE_HTTP_REASONS: ReadonlySet<string> = new Set(Object.values(COMPUTER_USE_HTTP_REASON));

export function validateComputerUseFrame(raw: unknown): ValidationResult<ComputerUseFrame> {
  if (!isRecord(raw)) return { ok: false, error: 'not_object' };
  for (const key of Object.keys(raw)) if (!COMPUTER_USE_REQUEST_KEYS.has(key)) return { ok: false, error: `unknown_field:${key}` };
  if (raw.type !== DAEMON_COMMAND_TYPES.COMPUTER_USE) return { ok: false, error: 'invalid_type' };
  if (typeof raw.correlationId !== 'string' || raw.correlationId.length < 8 || raw.correlationId.length > 128) return { ok: false, error: 'invalid_correlationId' };
  if (!isToolName(raw.tool)) return { ok: false, error: 'invalid_tool' };
  if (raw.arguments !== undefined && !isRecord(raw.arguments)) return { ok: false, error: 'invalid_arguments' };
  if (raw.arguments !== undefined && utf8ByteLength(JSON.stringify(raw.arguments)) > COMPUTER_USE_MAX_ARGUMENT_BYTES) return { ok: false, error: 'arguments_too_large' };
  const timeoutMs = raw.timeoutMs;
  const maxTimeoutMs = computerUseMaxTimeoutMs(raw.tool);
  if (timeoutMs !== undefined
    && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < COMPUTER_USE_MIN_TIMEOUT_MS || timeoutMs > maxTimeoutMs)) {
    return { ok: false, error: 'invalid_timeoutMs' };
  }
  return {
    ok: true,
    value: {
      type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
      correlationId: raw.correlationId,
      tool: raw.tool,
      ...(raw.arguments !== undefined ? { arguments: raw.arguments } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  };
}

export function validateComputerUseResultFrame(raw: unknown): ValidationResult<ComputerUseResultFrame> {
  if (!isRecord(raw)) return { ok: false, error: 'not_object' };
  for (const key of Object.keys(raw)) if (!COMPUTER_USE_RESULT_KEYS.has(key)) return { ok: false, error: `unknown_field:${key}` };
  if (raw.type !== DAEMON_MSG.COMPUTER_USE_RESULT) return { ok: false, error: 'invalid_type' };
  if (typeof raw.correlationId !== 'string' || raw.correlationId.length < 8 || raw.correlationId.length > 128) return { ok: false, error: 'invalid_correlationId' };
  if (!isToolName(raw.tool)) return { ok: false, error: 'invalid_tool' };
  if (typeof raw.ok !== 'boolean') return { ok: false, error: 'invalid_ok' };
  if (!Array.isArray(raw.content) || !raw.content.every(isContentItem)) return { ok: false, error: 'invalid_content' };
  const durationMs = raw.durationMs;
  if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0) return { ok: false, error: 'invalid_durationMs' };
  if (raw.error !== undefined && (typeof raw.error !== 'string' || raw.error.length === 0 || utf8ByteLength(raw.error) > COMPUTER_USE_MAX_ERROR_BYTES)) return { ok: false, error: 'invalid_error' };
  if (raw.timedOut !== undefined && typeof raw.timedOut !== 'boolean') return { ok: false, error: 'invalid_timedOut' };
  if (raw.truncated !== undefined && typeof raw.truncated !== 'boolean') return { ok: false, error: 'invalid_truncated' };
  if (raw.ok && raw.error !== undefined) return { ok: false, error: 'success_forbids_error' };
  if (!raw.ok && raw.error === undefined) return { ok: false, error: 'failure_requires_error' };
  return {
    ok: true,
    value: {
      type: DAEMON_MSG.COMPUTER_USE_RESULT,
      correlationId: raw.correlationId,
      ok: raw.ok,
      tool: raw.tool,
      content: raw.content,
      durationMs,
      ...(raw.error !== undefined ? { error: raw.error } : {}),
      ...(raw.timedOut !== undefined ? { timedOut: raw.timedOut } : {}),
      ...(raw.truncated !== undefined ? { truncated: raw.truncated } : {}),
    },
  };
}

export function encodeComputerUseHttpEnvelope(
  outcome: ComputerUseOutcome,
  result?: ComputerUseResult,
  reason?: ComputerUseHttpEnvelope['reason'],
): ComputerUseHttpEnvelope {
  return {
    protocol: COMPUTER_USE_HTTP_PROTOCOL,
    version: COMPUTER_USE_HTTP_ENVELOPE_VERSION,
    outcome,
    ...(result ? { result } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function decodeComputerUseHttpEnvelope(raw: unknown): ValidationResult<ComputerUseHttpEnvelope> {
  if (!isRecord(raw)) return { ok: false, error: 'not_object' };
  for (const key of Object.keys(raw)) if (!COMPUTER_USE_HTTP_ENVELOPE_KEYS.has(key)) return { ok: false, error: `unknown_field:${key}` };
  if (raw.protocol !== COMPUTER_USE_HTTP_PROTOCOL) return { ok: false, error: 'invalid_protocol' };
  if (raw.version !== COMPUTER_USE_HTTP_ENVELOPE_VERSION) return { ok: false, error: 'invalid_version' };
  if (typeof raw.outcome !== 'string' || !(COMPUTER_USE_OUTCOMES as readonly string[]).includes(raw.outcome)) return { ok: false, error: 'invalid_outcome' };
  const outcome = raw.outcome as ComputerUseOutcome;
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || !COMPUTER_USE_HTTP_REASONS.has(raw.reason))) return { ok: false, error: 'invalid_reason' };
  let result: ComputerUseResult | undefined;
  if (raw.result !== undefined) {
    const normalized = validateComputerUseResultFrame({ type: DAEMON_MSG.COMPUTER_USE_RESULT, ...raw.result });
    if (!normalized.ok) return { ok: false, error: `invalid_result:${normalized.error}` };
    const { type: _type, ...rest } = normalized.value;
    result = rest;
  }
  if ((outcome === 'completed' || outcome === 'tool_error') !== Boolean(result)) return { ok: false, error: 'outcome_result_mismatch' };
  if (outcome === 'completed' && result?.ok !== true) return { ok: false, error: 'completed_requires_ok' };
  if (outcome === 'tool_error' && result?.ok !== false) return { ok: false, error: 'tool_error_requires_failure' };
  if ((outcome === 'not_dispatched' || outcome === 'dispatched_no_result') && result) return { ok: false, error: 'pre_result_forbidden' };
  return {
    ok: true,
    value: {
      protocol: COMPUTER_USE_HTTP_PROTOCOL,
      version: COMPUTER_USE_HTTP_ENVELOPE_VERSION,
      outcome,
      ...(result ? { result } : {}),
      ...(raw.reason !== undefined ? { reason: raw.reason as ComputerUseHttpEnvelope['reason'] } : {}),
    },
  };
}

export function computerUseDocs(topic: ComputerUseDocTopic): string {
  switch (topic) {
    case 'overview':
      return [
        'Computer Use controls GUI apps either on the current full imcodes daemon host (machine=local) or on a controlled machine through a typed helper running in the active user desktop session.',
        'The agent never receives shell access for this surface: call computer_use_call with one named tool and JSON arguments.',
        'Target controlled machines accept either their stable ref_name or the complete ^^(ref_name) marker. When the message already contains a marker, pass either form without calling list_machines first; use list_machines only for discovery or an explicit status request. On full imcodes daemons, machine=local/localhost/self/this controls the daemon host directly. Results are bounded text/image MCP-style content.',
        'When the user asks to use a browser on the daemon host, call computer_use_call with machine=local and the built-in CDP-backed browser_* tools; do not probe for or install a separate Playwright runtime through a shell.',
        'Open Computer Use (OCU) supplies the integrated cross-platform desktop-app control path; browser_* is IM.codes\' separate CDP implementation and should be preferred over coordinate GUI control for web pages.',
      ].join('\n');
    case 'workflow':
      return [
        'Recommended workflow:',
        '1. Use machine=local/localhost/self/this for this daemon host. For a controlled node, pass either a known stable ref_name or the complete ^^(ref_name) marker directly; call list_machines only when no exact target is available or the user asks for status.',
        '2. computer_use_docs for the relevant topic/tool details only.',
        '3. computer_use_call tool=list_apps to discover app ids.',
        '4. For element/index actions, call computer_use_call tool=get_app_state first to discover stable element indexes; pure coordinate click can use the fast path directly when the target is known.',
        '5. Prefer element/index based actions when precision matters; use coordinate actions for low-latency direct control and verify when needed.',
        '6. For web pages, prefer browser_* tools and pull computer_use_docs topic=browser only when browser automation details are needed.',
      ].join('\n');
    case 'tools':
      return [
        `Available tools: ${COMPUTER_USE_TOOLS.join(', ')}.`,
        'shell_session1: run a bounded shell command in the active logged-in user session through the IPC helper; its requested timeout may be 1,000..900,000 ms. For SYSTEM/session-0 shell use exec_remote instead.',
        'list_apps: enumerate controllable GUI apps.',
        'get_app_state: inspect one app/window accessibility tree.',
        `click, perform_secondary_action, scroll, drag: pointer/UI actions. On Windows, coordinate drag accepts optional duration_ms=${COMPUTER_USE_DRAG_DURATION_MIN_MS}..${COMPUTER_USE_DRAG_DURATION_MAX_MS} for cursor travel duration; omit it for normal speed.`,
        'type_text, press_key, set_value: keyboard/value actions.',
        'Arguments are open-computer-use-compatible. Call get_app_state first to find app ids and element indexes; pure coordinate click may skip state and uses a Windows fast path when possible.',
        'Action results omit screenshots and full UI state by default for low-latency control. Pass arguments.includeState=true to return state text, or includeImage=true to request a compressed image; optional imageFormat=jpeg|webp|png, imageQuality=1..100, imageMaxWidth=320..3840.',
        'GUI and browser methods keep the 1,000..120,000 ms timeout range; only shell_session1 permits up to 900,000 ms.',
      ].join('\n');
    case 'browser':
      return [
        'Browser control uses Chrome DevTools Protocol (CDP), the mature browser automation protocol used by Chrome/Edge tooling, and is more deterministic for web pages than screen coordinates.',
        'For the current daemon host use computer_use_call with machine=local. browser_* is IM.codes\' built-in CDP path, separate from the integrated Open Computer Use desktop-app path; do not replace it with shell-launched Playwright.',
        'Use browser_open first with url. Optional arguments: channel=chrome|msedge|chromium, executablePath, headless=true|false, noSandbox=false, cdpEndpoint to attach to an existing browser target websocket.',
        'Then use browser_navigate, browser_snapshot, browser_click, browser_fill, browser_press, browser_evaluate, browser_close.',
        'Every browser snapshot includes automation.cdpEndpoint, cdpHost, and cdpPort. A local Python/Node script may attach to that loopback CDP endpoint (for example Playwright connect_over_cdp) to run complex logic against the same browser instance instead of launching another browser.',
        'The daemon-managed endpoint listens on 127.0.0.1 only. Coordinate MCP browser calls and external scripts so they do not race, and do not terminate the shared browser until the task is finished.',
        'Selectors are CSS selectors. For click/fill you may pass selector or visible text. Prefer stable CSS selectors over coordinates.',
        'Linux without DISPLAY/WAYLAND defaults to headless and uses no-sandbox/dev-shm-safe flags unless noSandbox=false is passed.',
        'browser_open, browser_navigate, and browser_snapshot return url/title, bounded visible text, and common links/buttons/inputs. Pass includeImage=true only when visual evidence is needed; the optional viewport screenshot is delivered as model-visible image content.',
        'browser_evaluate runs JavaScript in the page, not a shell. Use it for read-only inspection by default; ask before submitting forms, purchases, destructive actions, or externally visible changes.',
      ].join('\n');
    case 'windows':
      return [
        'Windows controlled nodes run the main service as SYSTEM/session 0, but GUI automation must run in the interactive user session.',
        'IM.codes starts a user-session helper with CreateProcessAsUser and talks to it over a private named-pipe IPC channel.',
        'The helper can inspect/control apps in the active desktop; session-0 services are not GUI automation targets.',
        'Windows OCU frames and screenshots use physical pixels. At display scaling above 100%, they can be larger than DPI-virtualized dimensions reported by a DPI-unaware shell; use get_app_state frame coordinates directly rather than rescaling them from GetSystemMetrics output.',
        `The Windows coordinate click/drag fast path is per-monitor DPI-aware so its window origin and OCU local frame remain in the same physical-pixel coordinate space. Coordinate drag accepts duration_ms=${COMPUTER_USE_DRAG_DURATION_MIN_MS}..${COMPUTER_USE_DRAG_DURATION_MAX_MS}.`,
        'Use exec_remote for session-0/SYSTEM commands and computer_use_call tool=shell_session1 for user-session commands.',
      ].join('\n');
    case 'safety':
      return [
        'Ask the user before destructive or externally visible actions such as sending messages, deleting data, purchases, or changing account/security settings.',
        'Shell is intentionally split: exec_remote is session-0/SYSTEM; shell_session1 is active-user/session-1. Both are explicit typed methods with bounded JSON arguments/results.',
        'If the UI state is ambiguous, call get_app_state again instead of guessing.',
      ].join('\n');
  }
}
