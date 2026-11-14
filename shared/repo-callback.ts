import {
  CALLBACK_MCP_TOOLS,
  CALLBACK_SOURCES,
  CALLBACK_STATUSES,
  CALLBACK_UPDATE_STATUSES,
  type CallbackStatus,
  type CallbackTaskRecord,
  type CallbackUpdateStatus,
} from './callback-types.js';

export const REPO_CALLBACK_EVENTS = ['pr_new', 'issue_new', 'ci_failed'] as const;
export type RepoCallbackEventType = (typeof REPO_CALLBACK_EVENTS)[number];

export const REPO_CALLBACK_STATUSES = CALLBACK_STATUSES;
export type RepoCallbackStatus = CallbackStatus;
export const REPO_CALLBACK_RESOLUTIONS = CALLBACK_UPDATE_STATUSES;
export type RepoCallbackResolutionStatus = CallbackUpdateStatus;
export type RepoCallbackRecord = CallbackTaskRecord;

export const REPO_CALLBACK_TARGET_BRAIN = 'brain' as const;

export const REPO_CALLBACK_MIN_INTERVAL_MS = 60_000;
export const REPO_CALLBACK_DEFAULT_INTERVAL_MS = 120_000;
export const REPO_CALLBACK_MAX_INTERVAL_MS = 3_600_000;
export const REPO_CALLBACK_INTERVAL_PRESETS_MS = [60_000, 120_000, 300_000, 900_000] as const;

export const REPO_CALLBACK_MAX_TEMPLATES_PER_SCOPE = 30;
export const REPO_CALLBACK_MAX_PROMPT_CHARS = 4_000;
export const REPO_CALLBACK_MAX_TEMPLATE_NAME_CHARS = 80;
export const REPO_CALLBACK_RECENT_HISTORY_LIMIT = 30;

export const REPO_CALLBACK_PREF_KEYS = {
  GLOBAL_TEMPLATES: 'repo_callback_global_templates',
  SERVER_CONFIG_PREFIX: 'repo_callback_server:',
} as const;

export function repoCallbackServerPrefKey(serverId: string): string {
  return `${REPO_CALLBACK_PREF_KEYS.SERVER_CONFIG_PREFIX}${serverId}`;
}

export type RepoCallbackTemplateScope = 'global' | 'repo';
export type RepoCallbackPromptSource = 'default' | 'global' | 'repo';

export interface RepoCallbackTemplate {
  id: string;
  name: string;
  scope: RepoCallbackTemplateScope;
  eventType: RepoCallbackEventType | 'all';
  prompt: string;
  updatedAt: number;
}

export interface RepoCallbackEventSetting {
  enabled: boolean;
  templateScope: RepoCallbackPromptSource;
  templateId?: string;
  customPrompt?: string;
}

export interface RepoCallbackRepoConfig {
  projectDir: string;
  enabled: boolean;
  intervalMs: number;
  target: string;
  events: Record<RepoCallbackEventType, RepoCallbackEventSetting>;
  templates: RepoCallbackTemplate[];
  updatedAt: number;
}

export interface RepoCallbackGlobalPrefs {
  version: 1;
  templates: RepoCallbackTemplate[];
}

export interface RepoCallbackServerPrefs {
  version: 1;
  repos: Record<string, RepoCallbackRepoConfig>;
}

export interface RepoCallbackDaemonSyncPayload {
  globalTemplates: RepoCallbackTemplate[];
  repos: Record<string, RepoCallbackRepoConfig>;
}

export interface RepoCallbackPromptContext {
  repo: string;
  projectDir: string;
  event: RepoCallbackEventType;
  title: string;
  number: string;
  url: string;
  author: string;
  branch: string;
  status: string;
  conclusion: string;
  details: string;
  callbackId: string;
}

export const REPO_CALLBACK_TEMPLATE_VARIABLES = [
  '{{repo}}',
  '{{projectDir}}',
  '{{event}}',
  '{{title}}',
  '{{number}}',
  '{{url}}',
  '{{author}}',
  '{{branch}}',
  '{{status}}',
  '{{conclusion}}',
  '{{details}}',
  '{{callbackId}}',
] as const;

export const REPO_CALLBACK_DEFAULT_PROMPTS: Record<RepoCallbackEventType, string> = {
  ci_failed: [
    'Repository CI failure detected in {{repo}} ({{projectDir}}).',
    'Run: #{{number}} — {{title}}',
    'Branch: {{branch}} | Actor: {{author}} | Status: {{status}} ({{conclusion}})',
    'URL: {{url}}',
    'Details:',
    '{{details}}',
    '',
    'Investigate the failed job/step logs, inspect whether a recent commit broke build or tests, and fix or triage accordingly.',
  ].join('\n'),
  pr_new: [
    'New Pull Request detected in {{repo}} ({{projectDir}}).',
    'PR #{{number}}: {{title}}',
    'Author: {{author}} | Branch: {{branch}}',
    'URL: {{url}}',
    '{{details}}',
    '',
    'Review the PR scope, diff, and checks, and decide whether action or feedback is needed.',
  ].join('\n'),
  issue_new: [
    'New Issue detected in {{repo}} ({{projectDir}}).',
    'Issue #{{number}}: {{title}}',
    'Author: {{author}}',
    'URL: {{url}}',
    '{{details}}',
    '',
    'Triage the issue, check reproduction details and related code paths, and determine next steps.',
  ].join('\n'),
};

export function isRepoCallbackEventType(value: unknown): value is RepoCallbackEventType {
  return value === 'pr_new' || value === 'issue_new' || value === 'ci_failed';
}

export function clampRepoCallbackIntervalMs(raw: unknown): number {
  const num = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : REPO_CALLBACK_DEFAULT_INTERVAL_MS;
  return Math.max(REPO_CALLBACK_MIN_INTERVAL_MS, Math.min(REPO_CALLBACK_MAX_INTERVAL_MS, num));
}

export function createDefaultRepoCallbackEventSetting(eventType: RepoCallbackEventType): RepoCallbackEventSetting {
  return {
    enabled: eventType === 'ci_failed',
    templateScope: 'default',
  };
}

export function createDefaultRepoCallbackConfig(projectDir: string): RepoCallbackRepoConfig {
  return {
    projectDir,
    enabled: false,
    intervalMs: REPO_CALLBACK_DEFAULT_INTERVAL_MS,
    target: REPO_CALLBACK_TARGET_BRAIN,
    events: {
      pr_new: createDefaultRepoCallbackEventSetting('pr_new'),
      issue_new: createDefaultRepoCallbackEventSetting('issue_new'),
      ci_failed: createDefaultRepoCallbackEventSetting('ci_failed'),
    },
    templates: [],
    updatedAt: 0,
  };
}

export function normalizeRepoCallbackTemplate(
  raw: unknown,
  fallbackScope: RepoCallbackTemplateScope,
): RepoCallbackTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, REPO_CALLBACK_MAX_TEMPLATE_NAME_CHARS) : '';
  const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim().slice(0, REPO_CALLBACK_MAX_PROMPT_CHARS) : '';
  if (!id || !name || !prompt) return null;
  const scope: RepoCallbackTemplateScope = obj.scope === 'global' || obj.scope === 'repo' ? obj.scope : fallbackScope;
  const eventType: RepoCallbackEventType | 'all' = isRepoCallbackEventType(obj.eventType) ? obj.eventType : 'all';
  const updatedAt = typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : Date.now();
  return { id, name, scope, eventType, prompt, updatedAt };
}

function normalizeTemplateList(raw: unknown, fallbackScope: RepoCallbackTemplateScope): RepoCallbackTemplate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RepoCallbackTemplate[] = [];
  for (const item of raw) {
    const tpl = normalizeRepoCallbackTemplate(item, fallbackScope);
    if (!tpl || seen.has(tpl.id)) continue;
    seen.add(tpl.id);
    out.push(tpl);
    if (out.length >= REPO_CALLBACK_MAX_TEMPLATES_PER_SCOPE) break;
  }
  return out;
}

export function normalizeRepoCallbackGlobalPrefs(raw: unknown): RepoCallbackGlobalPrefs {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    version: 1,
    templates: normalizeTemplateList(obj.templates, 'global'),
  };
}

function normalizeEventSetting(raw: unknown, eventType: RepoCallbackEventType): RepoCallbackEventSetting {
  const fallback = createDefaultRepoCallbackEventSetting(eventType);
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : fallback.enabled;
  const templateScope: RepoCallbackPromptSource =
    obj.templateScope === 'global' || obj.templateScope === 'repo' || obj.templateScope === 'default'
      ? obj.templateScope
      : 'default';
  const templateId = typeof obj.templateId === 'string' && obj.templateId.trim() ? obj.templateId.trim() : undefined;
  const customPrompt = typeof obj.customPrompt === 'string' && obj.customPrompt.trim()
    ? obj.customPrompt.trim().slice(0, REPO_CALLBACK_MAX_PROMPT_CHARS)
    : undefined;
  return {
    enabled,
    templateScope,
    ...(templateId ? { templateId } : {}),
    ...(customPrompt ? { customPrompt } : {}),
  };
}

export function normalizeRepoCallbackRepoConfig(raw: unknown, projectDirFallback?: string): RepoCallbackRepoConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const projectDir = typeof obj.projectDir === 'string' && obj.projectDir.trim()
    ? obj.projectDir.trim()
    : (projectDirFallback?.trim() ?? '');
  if (!projectDir) return null;
  const rawEvents = obj.events && typeof obj.events === 'object' ? (obj.events as Record<string, unknown>) : {};
  const target = typeof obj.target === 'string' && obj.target.trim()
    ? obj.target.trim()
    : REPO_CALLBACK_TARGET_BRAIN;
  return {
    projectDir,
    enabled: obj.enabled === true,
    intervalMs: clampRepoCallbackIntervalMs(obj.intervalMs),
    target,
    events: {
      pr_new: normalizeEventSetting(rawEvents.pr_new, 'pr_new'),
      issue_new: normalizeEventSetting(rawEvents.issue_new, 'issue_new'),
      ci_failed: normalizeEventSetting(rawEvents.ci_failed, 'ci_failed'),
    },
    templates: normalizeTemplateList(obj.templates, 'repo'),
    updatedAt: typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0,
  };
}

export function normalizeRepoCallbackServerPrefs(raw: unknown): RepoCallbackServerPrefs {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawRepos = obj.repos && typeof obj.repos === 'object' ? (obj.repos as Record<string, unknown>) : {};
  const repos: Record<string, RepoCallbackRepoConfig> = {};
  for (const [key, value] of Object.entries(rawRepos)) {
    const normalized = normalizeRepoCallbackRepoConfig(value, key);
    if (normalized) {
      repos[normalized.projectDir] = normalized;
    }
  }
  return { version: 1, repos };
}

export function resolveRepoCallbackPromptTemplate(
  config: RepoCallbackRepoConfig,
  eventType: RepoCallbackEventType,
  globalTemplates: readonly RepoCallbackTemplate[],
): string {
  const setting = config.events[eventType];
  // An explicit per-repo custom override takes precedence over template references.
  if (setting.customPrompt?.trim()) {
    return setting.customPrompt.trim();
  }
  if (setting.templateScope === 'repo' && setting.templateId) {
    const found = config.templates.find((tpl) => tpl.id === setting.templateId);
    if (found?.prompt.trim()) return found.prompt;
  }
  if (setting.templateScope === 'global' && setting.templateId) {
    const found = globalTemplates.find((tpl) => tpl.id === setting.templateId);
    if (found?.prompt.trim()) return found.prompt;
  }
  return REPO_CALLBACK_DEFAULT_PROMPTS[eventType];
}

export function renderRepoCallbackPrompt(template: string, ctx: RepoCallbackPromptContext): string {
  const replacements: Record<string, string> = {
    '{{repo}}': ctx.repo,
    '{{projectDir}}': ctx.projectDir,
    '{{event}}': ctx.event,
    '{{title}}': ctx.title,
    '{{number}}': ctx.number,
    '{{url}}': ctx.url,
    '{{author}}': ctx.author,
    '{{branch}}': ctx.branch,
    '{{status}}': ctx.status,
    '{{conclusion}}': ctx.conclusion,
    '{{details}}': ctx.details,
    '{{callbackId}}': ctx.callbackId,
  };
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(value);
  }
  const toolName = CALLBACK_MCP_TOOLS.UPDATE;
  // Unconditionally attach the daemon-authored callback envelope so custom prompts
  // or remote titles/details containing "callback_update" or stale IDs never strip
  // the authoritative callbackId and MCP parameter instructions.
  const envelope = [
    `[Callback ID: ${ctx.callbackId} | source: ${CALLBACK_SOURCES.REPO}]`,
    `Call MCP tool \`${toolName}\` with callbackId="${ctx.callbackId}", status="in_progress"|"done"|"ignored"|"failed", and a concise summary (optional: source="${CALLBACK_SOURCES.REPO}", relatedTaskId if you call pair_create for code changes, metadata).`,
  ].join('\n');
  const trimmedBody = rendered.trimEnd();
  return trimmedBody ? `${trimmedBody}\n\n${envelope}` : envelope;
}

export function buildRepoCallbackDedupKey(
  projectDir: string,
  eventType: RepoCallbackEventType,
  entityId: string,
  discriminator = '',
): string {
  return `${projectDir}|${eventType}|${entityId}|${discriminator}`;
}
