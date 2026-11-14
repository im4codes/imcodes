import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { CallbackStatus, CallbackTaskRecord } from '@shared/callback-types.js';
import {
  REPO_CALLBACK_DEFAULT_PROMPTS,
  REPO_CALLBACK_INTERVAL_PRESETS_MS,
  REPO_CALLBACK_MAX_PROMPT_CHARS,
  REPO_CALLBACK_MAX_TEMPLATE_NAME_CHARS,
  REPO_CALLBACK_TARGET_BRAIN,
  REPO_CALLBACK_TEMPLATE_VARIABLES,
  createDefaultRepoCallbackConfig,
  resolveRepoCallbackPromptTemplate,
  type RepoCallbackEventType,
  type RepoCallbackRepoConfig,
  type RepoCallbackTemplate,
  type RepoCallbackTemplateScope,
} from '@shared/repo-callback.js';
import type { WsClient } from '../ws-client.js';
import {
  loadRepoCallbackPrefs,
  saveRepoCallbackGlobalTemplates,
  saveRepoCallbackRepoConfig,
} from '../repo-callback-prefs.js';

export interface RepoCallbackTargetOption {
  sessionName: string;
  label: string;
  state?: string;
}

export type CallbackListFilter = 'all' | 'active' | 'done' | 'ignored' | 'failed';

interface Props {
  open: boolean;
  onClose: () => void;
  ws: WsClient;
  serverId?: string | null;
  projectDir: string;
  readOnly?: boolean;
  callbackTargets?: RepoCallbackTargetOption[];
  callbacks: CallbackTaskRecord[];
  runtimeEnabled: boolean;
  checking: boolean;
  lastCheckedAt?: number;
  lastError?: string;
  onConfigSaved?: (config: RepoCallbackRepoConfig, globalTemplates: RepoCallbackTemplate[]) => void;
}

const EVENT_ORDER: RepoCallbackEventType[] = ['ci_failed', 'pr_new', 'issue_new'];

function formatIntervalLabel(ms: number): string {
  const mins = Math.round(ms / 60_000);
  return `${mins}m`;
}

function makeTemplateId(scope: RepoCallbackTemplateScope): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${scope}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${scope}_${Date.now().toString(36)}`;
}

function statusColors(status: CallbackStatus): { bg: string; color: string; border: string } {
  switch (status) {
    case 'in_progress':
      return { bg: 'rgba(59,130,246,0.18)', color: '#93c5fd', border: 'rgba(59,130,246,0.4)' };
    case 'done':
      return { bg: 'rgba(34,197,94,0.16)', color: '#86efac', border: 'rgba(34,197,94,0.4)' };
    case 'ignored':
      return { bg: 'rgba(100,116,139,0.18)', color: '#cbd5e1', border: 'rgba(100,116,139,0.4)' };
    case 'failed':
      return { bg: 'rgba(239,68,68,0.18)', color: '#fca5a5', border: 'rgba(239,68,68,0.45)' };
    case 'pending':
    default:
      return { bg: 'rgba(245,158,11,0.18)', color: '#fcd34d', border: 'rgba(245,158,11,0.4)' };
  }
}

export function RepoCallbackModal({
  open,
  onClose,
  ws,
  serverId,
  projectDir,
  readOnly = false,
  callbackTargets = [],
  callbacks,
  runtimeEnabled,
  checking,
  lastCheckedAt,
  lastError,
  onConfigSaved,
}: Props) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [loading, setLoading] = useState(false);
  const editedSourceTemplateRef = useRef<Partial<Record<RepoCallbackEventType, { scope: RepoCallbackTemplateScope; id: string; name: string }>>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [globalTemplates, setGlobalTemplates] = useState<RepoCallbackTemplate[]>([]);
  const [draft, setDraft] = useState<RepoCallbackRepoConfig>(() => createDefaultRepoCallbackConfig(projectDir));
  const [expandedEvent, setExpandedEvent] = useState<RepoCallbackEventType | null>('ci_failed');
  const [templateNameDraft, setTemplateNameDraft] = useState('');
  const [filter, setFilter] = useState<CallbackListFilter>('all');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFeedback(null);
    loadRepoCallbackPrefs(serverId, projectDir)
      .then((loaded) => {
        if (cancelled) return;
        setGlobalTemplates(loaded.globalPrefs.templates);
        setDraft(loaded.repoConfig);
      })
      .catch((err) => {
        if (cancelled) return;
        setFeedback({ kind: 'error', text: err instanceof Error ? err.message : tRef.current('repo.callback_load_error') });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    try {
      ws.repoCallbackStatus?.(projectDir);
    } catch {
      // ignore if disconnected
    }
    return () => {
      cancelled = true;
    };
  }, [open, serverId, projectDir, ws]);

  const filteredCallbacks = useMemo(() => {
    return callbacks.filter((cb) => {
      if (filter === 'all') return true;
      if (filter === 'active') return cb.status === 'pending' || cb.status === 'in_progress';
      return cb.status === filter;
    });
  }, [callbacks, filter]);

  const targetOptions = useMemo(() => {
    const known = new Map<string, RepoCallbackTargetOption>();
    for (const opt of callbackTargets) {
      if (opt.sessionName) known.set(opt.sessionName, opt);
    }
    if (draft.target && draft.target !== REPO_CALLBACK_TARGET_BRAIN && !known.has(draft.target)) {
      known.set(draft.target, { sessionName: draft.target, label: draft.target });
    }
    return [...known.values()];
  }, [callbackTargets, draft.target]);

  if (!open) return null;

  const eventLabel = (eventType: RepoCallbackEventType): string => {
    switch (eventType) {
      case 'ci_failed': return t('repo.callback_event_ci_failed');
      case 'pr_new': return t('repo.callback_event_pr_new');
      case 'issue_new': return t('repo.callback_event_issue_new');
    }
  };

  const statusLabel = (status: CallbackStatus): string => {
    switch (status) {
      case 'pending': return t('repo.callback_status_pending');
      case 'in_progress': return t('repo.callback_status_in_progress');
      case 'done': return t('repo.callback_status_done');
      case 'ignored': return t('repo.callback_status_ignored');
      case 'failed': return t('repo.callback_status_failed');
    }
  };

  const getCurrentPromptText = (eventType: RepoCallbackEventType): string => {
    const setting = draft.events[eventType];
    if (setting.customPrompt !== undefined) return setting.customPrompt;
    return resolveRepoCallbackPromptTemplate(draft, eventType, globalTemplates);
  };

  const selectedTemplateKey = (eventType: RepoCallbackEventType): string => {
    const setting = draft.events[eventType];
    if (setting.customPrompt?.trim()) {
      return 'default';
    }
    if (setting.templateScope === 'global' && setting.templateId) {
      return `global:${setting.templateId}`;
    }
    if (setting.templateScope === 'repo' && setting.templateId) {
      return `repo:${setting.templateId}`;
    }
    return 'default';
  };

  const handleSelectTemplate = (eventType: RepoCallbackEventType, value: string) => {
    setFeedback(null);
    if (value === 'default') {
      delete editedSourceTemplateRef.current[eventType];
      setDraft((prev) => ({
        ...prev,
        events: {
          ...prev.events,
          [eventType]: {
            ...prev.events[eventType],
            templateScope: 'default',
            templateId: undefined,
            customPrompt: undefined,
          },
        },
      }));
      return;
    }
    const [scopeRaw, ...rest] = value.split(':');
    const scope: RepoCallbackTemplateScope = scopeRaw === 'global' ? 'global' : 'repo';
    const templateId = rest.join(':');
    const pool = scope === 'global' ? globalTemplates : draft.templates;
    const found = pool.find((tpl) => tpl.id === templateId);
    if (found) {
      editedSourceTemplateRef.current[eventType] = { scope, id: found.id, name: found.name };
      setTemplateNameDraft(found.name);
    } else {
      delete editedSourceTemplateRef.current[eventType];
    }
    // Keep customPrompt undefined on template selection so saved config references
    // the live reusable template until the user explicitly edits the textarea.
    setDraft((prev) => ({
      ...prev,
      events: {
        ...prev.events,
        [eventType]: {
          ...prev.events[eventType],
          templateScope: scope,
          templateId,
          customPrompt: undefined,
        },
      },
    }));
  };

  const handlePromptChange = (eventType: RepoCallbackEventType, value: string) => {
    const nextValue = value.slice(0, REPO_CALLBACK_MAX_PROMPT_CHARS);
    setDraft((prev) => {
      const current = prev.events[eventType];
      if (current.templateScope !== 'default' && current.templateId) {
        const pool = current.templateScope === 'global' ? globalTemplates : prev.templates;
        const found = pool.find((tpl) => tpl.id === current.templateId);
        if (found) {
          editedSourceTemplateRef.current[eventType] = {
            scope: current.templateScope,
            id: found.id,
            name: found.name,
          };
        }
      }
      return {
        ...prev,
        events: {
          ...prev.events,
          [eventType]: {
            ...current,
            templateScope: 'default',
            templateId: undefined,
            customPrompt: nextValue,
          },
        },
      };
    });
  };

  const handleSaveTemplate = async (eventType: RepoCallbackEventType, scope: RepoCallbackTemplateScope) => {
    const name = templateNameDraft.trim().slice(0, REPO_CALLBACK_MAX_TEMPLATE_NAME_CHARS);
    const prompt = getCurrentPromptText(eventType).trim().slice(0, REPO_CALLBACK_MAX_PROMPT_CHARS);
    if (!name || !prompt) {
      setFeedback({ kind: 'error', text: t('repo.callback_tpl_name_required') });
      return;
    }
    const now = Date.now();
    const setting = draft.events[eventType];
    const pool = scope === 'global' ? globalTemplates : draft.templates;
    const priorRef = editedSourceTemplateRef.current[eventType];
    const activeSameScope = setting.templateScope === scope && setting.templateId
      ? pool.find((tpl) => tpl.id === setting.templateId)
      : (priorRef?.scope === scope ? pool.find((tpl) => tpl.id === priorRef.id) : undefined);
    const targetId = activeSameScope && activeSameScope.name === name
      ? activeSameScope.id
      : makeTemplateId(scope);
    const nextTemplate: RepoCallbackTemplate = {
      id: targetId,
      name,
      scope,
      eventType,
      prompt,
      updatedAt: now,
    };

    try {
      setSaving(true);
      setFeedback(null);
      if (scope === 'global') {
        const nextGlobal = [
          nextTemplate,
          ...globalTemplates.filter((tpl) => tpl.id !== targetId),
        ];
        const savedGlobal = await saveRepoCallbackGlobalTemplates(nextGlobal);
        setGlobalTemplates(savedGlobal.templates);
        const nextDraft: RepoCallbackRepoConfig = {
          ...draft,
          events: {
            ...draft.events,
            [eventType]: {
              ...draft.events[eventType],
              templateScope: 'global',
              templateId: targetId,
              customPrompt: undefined,
            },
          },
        };
        setDraft(nextDraft);
        if (serverId) {
          await saveRepoCallbackRepoConfig(serverId, nextDraft);
        }
        ws.repoCallbackSync?.();
        onConfigSaved?.(nextDraft, savedGlobal.templates);
        setFeedback({ kind: 'success', text: t('repo.callback_tpl_saved_global', { name }) });
      } else {
        const nextTemplates = [
          nextTemplate,
          ...draft.templates.filter((tpl) => tpl.id !== targetId),
        ];
        const nextDraft: RepoCallbackRepoConfig = {
          ...draft,
          templates: nextTemplates,
          events: {
            ...draft.events,
            [eventType]: {
              ...draft.events[eventType],
              templateScope: 'repo',
              templateId: targetId,
              customPrompt: undefined,
            },
          },
        };
        setDraft(nextDraft);
        if (serverId) {
          await saveRepoCallbackRepoConfig(serverId, nextDraft);
          ws.repoCallbackSync?.();
          onConfigSaved?.(nextDraft, globalTemplates);
        }
        setFeedback({ kind: 'success', text: t('repo.callback_tpl_saved_repo', { name }) });
      }
      setTemplateNameDraft('');
    } catch (err) {
      setFeedback({ kind: 'error', text: err instanceof Error ? err.message : t('repo.callback_save_error') });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSelectedTemplate = async (eventType: RepoCallbackEventType) => {
    const setting = draft.events[eventType];
    if (!setting.templateId || setting.templateScope === 'default') return;
    try {
      setSaving(true);
      setFeedback(null);
      if (setting.templateScope === 'global') {
        const nextGlobal = globalTemplates.filter((tpl) => tpl.id !== setting.templateId);
        const savedGlobal = await saveRepoCallbackGlobalTemplates(nextGlobal);
        setGlobalTemplates(savedGlobal.templates);
      }
      const nextDraft: RepoCallbackRepoConfig = {
        ...draft,
        templates: setting.templateScope === 'repo'
          ? draft.templates.filter((tpl) => tpl.id !== setting.templateId)
          : draft.templates,
        events: {
          ...draft.events,
          [eventType]: {
            ...draft.events[eventType],
            templateScope: 'default',
            templateId: undefined,
            customPrompt: undefined,
          },
        },
      };
      setDraft(nextDraft);
      if (serverId) {
        await saveRepoCallbackRepoConfig(serverId, nextDraft);
      }
      ws.repoCallbackSync?.();
      setFeedback({ kind: 'success', text: t('repo.callback_tpl_deleted') });
    } catch (err) {
      setFeedback({ kind: 'error', text: err instanceof Error ? err.message : t('repo.callback_save_error') });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!serverId) {
      setFeedback({ kind: 'error', text: t('repo.callback_missing_server') });
      return;
    }
    try {
      setSaving(true);
      setFeedback(null);
      const nextConfig: RepoCallbackRepoConfig = {
        ...draft,
        projectDir,
        updatedAt: Date.now(),
      };
      await saveRepoCallbackRepoConfig(serverId, nextConfig);
      ws.repoCallbackSync?.();
      ws.repoCallbackStatus?.(projectDir);
      onConfigSaved?.(nextConfig, globalTemplates);
      setFeedback({ kind: 'success', text: t('repo.callback_saved') });
    } catch (err) {
      setFeedback({ kind: 'error', text: err instanceof Error ? err.message : t('repo.callback_save_error') });
    } finally {
      setSaving(false);
    }
  };

  const handleCheckNow = () => {
    setFeedback(null);
    ws.repoCallbackCheckNow?.(projectDir);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('repo.callback_modal_title')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(2, 6, 23, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 740,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#0f172a',
          color: '#e2e8f0',
          border: '1px solid #334155',
          borderRadius: 10,
          overflow: 'hidden',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 16px',
            borderBottom: '1px solid #1e293b',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>
            {t('repo.callback_modal_title')}
          </span>
          <span style={{ fontSize: 11, color: runtimeEnabled ? '#4ade80' : '#94a3b8' }}>
            {checking
              ? t('repo.callback_checking')
              : runtimeEnabled
                ? t('repo.callback_runtime_active')
                : t('repo.callback_runtime_idle')}
          </span>
          {!readOnly && (
            <button
              type="button"
              class="btn btn-sm"
              disabled={checking || !draft.enabled}
              onClick={handleCheckNow}
              style={{ fontSize: 12 }}
            >
              {t('repo.callback_check_now')}
            </button>
          )}
          <button
            type="button"
            class="btn btn-sm"
            onClick={onClose}
            aria-label={t('common.close')}
            style={{ fontSize: 12 }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {loading && <div style={{ fontSize: 12, color: '#94a3b8' }}>{t('common.loading')}</div>}

          {lastError && (
            <div style={{
              fontSize: 12,
              padding: '8px 10px',
              borderRadius: 6,
              background: 'rgba(127, 29, 29, 0.28)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              color: '#fecaca',
            }}>
              {t('repo.callback_last_error', { error: lastError })}
            </div>
          )}

          {feedback && (
            <div
              role={feedback.kind === 'error' ? 'alert' : 'status'}
              style={{
                fontSize: 12,
                padding: '8px 10px',
                borderRadius: 6,
                background: feedback.kind === 'error' ? 'rgba(127, 29, 29, 0.28)' : 'rgba(20, 83, 45, 0.28)',
                border: `1px solid ${feedback.kind === 'error' ? 'rgba(239, 68, 68, 0.4)' : 'rgba(34, 197, 94, 0.4)'}`,
                color: feedback.kind === 'error' ? '#fecaca' : '#bbf7d0',
              }}
            >
              {feedback.text}
            </div>
          )}

          {/* Top Settings */}
          <div style={{
            padding: 12,
            borderRadius: 8,
            background: '#111c33',
            border: '1px solid #1e293b',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, cursor: readOnly ? 'default' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  disabled={readOnly}
                  onChange={(e) => setDraft((prev) => ({ ...prev, enabled: (e.target as HTMLInputElement).checked }))}
                />
                <span>{t('repo.callback_enabled')}</span>
              </label>

              {lastCheckedAt && (
                <span style={{ fontSize: 11, color: '#64748b' }}>
                  {t('repo.callback_last_checked', { time: new Date(lastCheckedAt).toLocaleTimeString() })}
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#cbd5e1' }}>
                <span>{t('repo.callback_interval_label')}</span>
                <select
                  value={String(draft.intervalMs)}
                  disabled={readOnly}
                  onChange={(e) => setDraft((prev) => ({ ...prev, intervalMs: Number((e.target as HTMLSelectElement).value) }))}
                  style={{ background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '6px 8px', fontSize: 12 }}
                >
                  {REPO_CALLBACK_INTERVAL_PRESETS_MS.map((ms) => (
                    <option key={ms} value={String(ms)}>
                      {t('repo.callback_interval_minutes', { minutes: formatIntervalLabel(ms) })}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#cbd5e1' }}>
                <span>{t('repo.callback_target_label')}</span>
                <select
                  aria-label={t('repo.callback_target_label')}
                  value={draft.target}
                  disabled={readOnly}
                  onChange={(e) => setDraft((prev) => ({ ...prev, target: (e.target as HTMLSelectElement).value }))}
                  style={{ background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '6px 8px', fontSize: 12 }}
                >
                  <option value={REPO_CALLBACK_TARGET_BRAIN}>{t('repo.callback_target_brain')}</option>
                  {targetOptions.map((opt) => (
                    <option key={opt.sessionName} value={opt.sessionName}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {/* Events & Two-Level Prompt Templates */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {t('repo.callback_events_title')}
            </div>

            {EVENT_ORDER.map((eventType) => {
              const setting = draft.events[eventType];
              const isCi = eventType === 'ci_failed';
              const isExpanded = expandedEvent === eventType;
              const tplKey = selectedTemplateKey(eventType);
              const eligibleGlobal = globalTemplates.filter((tpl) => tpl.eventType === 'all' || tpl.eventType === eventType);
              const eligibleRepo = draft.templates.filter((tpl) => tpl.eventType === 'all' || tpl.eventType === eventType);
              const canDeleteSelected = setting.templateScope !== 'default' && Boolean(setting.templateId);

              return (
                <div
                  key={eventType}
                  style={{
                    borderRadius: 8,
                    border: isCi ? '1px solid rgba(239, 68, 68, 0.45)' : '1px solid #1e293b',
                    borderLeft: isCi ? '3px solid #ef4444' : undefined,
                    background: isCi ? 'rgba(127, 29, 29, 0.12)' : '#111c33',
                    padding: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, fontSize: 13, fontWeight: isCi ? 600 : 500, cursor: readOnly ? 'default' : 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={setting.enabled}
                        disabled={readOnly}
                        onChange={(e) => {
                          const checked = (e.target as HTMLInputElement).checked;
                          setDraft((prev) => ({
                            ...prev,
                            events: {
                              ...prev.events,
                              [eventType]: { ...prev.events[eventType], enabled: checked },
                            },
                          }));
                        }}
                      />
                      <span>{eventLabel(eventType)}</span>
                      {isCi && (
                        <span style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '1px 6px',
                          borderRadius: 9999,
                          background: 'rgba(239, 68, 68, 0.22)',
                          color: '#fca5a5',
                        }}>
                          {t('repo.callback_event_critical')}
                        </span>
                      )}
                    </label>

                    <button
                      type="button"
                      class="btn btn-sm"
                      onClick={() => setExpandedEvent(isExpanded ? null : eventType)}
                      style={{ fontSize: 11 }}
                    >
                      {isExpanded ? t('repo.callback_hide_prompt') : t('repo.callback_edit_prompt')}
                    </button>
                  </div>

                  {isExpanded && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, borderTop: '1px solid rgba(51,65,85,0.45)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <label style={{ fontSize: 11, color: '#94a3b8' }}>
                          {t('repo.callback_template_label')}
                        </label>
                        <select
                          aria-label={`${eventLabel(eventType)} ${t('repo.callback_template_label')}`}
                          value={tplKey}
                          disabled={readOnly}
                          onChange={(e) => handleSelectTemplate(eventType, (e.target as HTMLSelectElement).value)}
                          style={{ flex: 1, minWidth: 160, maxWidth: '100%', background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: '5px 8px', fontSize: 12 }}
                        >
                          <option value="default">{t('repo.callback_tpl_source_default')}</option>
                          {eligibleGlobal.map((tpl) => (
                            <option key={`global:${tpl.id}`} value={`global:${tpl.id}`}>
                              [{t('repo.callback_tpl_scope_global')}] {tpl.name}
                            </option>
                          ))}
                          {eligibleRepo.map((tpl) => (
                            <option key={`repo:${tpl.id}`} value={`repo:${tpl.id}`}>
                              [{t('repo.callback_tpl_scope_repo')}] {tpl.name}
                            </option>
                          ))}
                        </select>
                        {!readOnly && canDeleteSelected && (
                          <button
                            type="button"
                            class="btn btn-sm"
                            disabled={saving}
                            onClick={() => void handleDeleteSelectedTemplate(eventType)}
                            style={{ fontSize: 11, color: '#fca5a5' }}
                          >
                            {t('repo.callback_tpl_delete')}
                          </button>
                        )}
                      </div>

                      <textarea
                        aria-label={`${eventLabel(eventType)} ${t('repo.callback_prompt_label')}`}
                        rows={4}
                        value={getCurrentPromptText(eventType)}
                        disabled={readOnly}
                        placeholder={REPO_CALLBACK_DEFAULT_PROMPTS[eventType]}
                        onInput={(e) => handlePromptChange(eventType, (e.target as HTMLTextAreaElement).value)}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid #334155',
                          borderRadius: 6,
                          padding: 8,
                          fontSize: 12,
                          fontFamily: 'monospace',
                          resize: 'vertical',
                        }}
                      />

                      <div style={{ fontSize: 11, color: '#64748b' }}>
                        {t('repo.callback_template_vars_hint', { vars: REPO_CALLBACK_TEMPLATE_VARIABLES.join(' ') })}
                      </div>

                      {!readOnly && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <input
                            type="text"
                            aria-label={t('repo.callback_tpl_name_placeholder')}
                            value={templateNameDraft}
                            onInput={(e) => setTemplateNameDraft((e.target as HTMLInputElement).value)}
                            placeholder={t('repo.callback_tpl_name_placeholder')}
                            style={{
                              flex: 1,
                              minWidth: 150,
                              background: '#0f172a',
                              color: '#e2e8f0',
                              border: '1px solid #334155',
                              borderRadius: 6,
                              padding: '5px 8px',
                              fontSize: 12,
                            }}
                          />
                          <button
                            type="button"
                            class="btn btn-sm"
                            disabled={saving}
                            onClick={() => void handleSaveTemplate(eventType, 'global')}
                            style={{ fontSize: 11 }}
                          >
                            {t('repo.callback_tpl_save_global')}
                          </button>
                          <button
                            type="button"
                            class="btn btn-sm"
                            disabled={saving}
                            onClick={() => void handleSaveTemplate(eventType, 'repo')}
                            style={{ fontSize: 11 }}
                          >
                            {t('repo.callback_tpl_save_repo')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!readOnly && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                disabled={saving || loading}
                onClick={() => void handleSaveSettings()}
                style={{ fontSize: 12, padding: '6px 14px' }}
              >
                {saving ? t('repo.callback_saving') : t('repo.callback_save')}
              </button>
            </div>
          )}

          {/* Independent Recent Callbacks List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid #1e293b', paddingTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {t('repo.callback_recent_title')} ({filteredCallbacks.length})
              </span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {(['all', 'active', 'done', 'ignored', 'failed'] as CallbackListFilter[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    class="btn btn-sm"
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      background: filter === key ? '#1d4ed8' : '#1e293b',
                      color: filter === key ? '#ffffff' : '#cbd5e1',
                      border: '1px solid #334155',
                    }}
                  >
                    {t(`repo.callback_filter_${key}`)}
                  </button>
                ))}
              </div>
            </div>

            {filteredCallbacks.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', padding: '12px 0', textAlign: 'center' }}>
                {t('repo.callback_recent_empty')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {filteredCallbacks.map((cb) => {
                  const palette = statusColors(cb.status);
                  return (
                    <div
                      key={cb.callbackId}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 6,
                        background: '#111c33',
                        border: '1px solid #1e293b',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '1px 6px',
                          borderRadius: 9999,
                          background: palette.bg,
                          color: palette.color,
                          border: `1px solid ${palette.border}`,
                        }}>
                          {statusLabel(cb.status)}
                        </span>
                        <code style={{ fontSize: 10, color: '#94a3b8' }}>{cb.eventType}</code>
                        {cb.url ? (
                          <a
                            href={cb.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ fontSize: 12, fontWeight: 500, color: '#93c5fd', flex: 1, minWidth: 140, textDecoration: 'none' }}
                          >
                            {cb.title}
                          </a>
                        ) : (
                          <span style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0', flex: 1, minWidth: 140 }}>
                            {cb.title}
                          </span>
                        )}
                        <span style={{ fontSize: 10, color: '#64748b' }}>
                          {cb.targetSession}
                        </span>
                      </div>

                      {cb.summary && (
                        <div style={{ fontSize: 12, color: '#cbd5e1', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {cb.summary}
                        </div>
                      )}
                      {cb.lastError && (
                        <div style={{ fontSize: 11, color: '#fca5a5', overflowWrap: 'anywhere' }}>
                          {cb.lastError}
                        </div>
                      )}
                      {cb.relatedTaskId && (
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>
                          {t('repo.callback_related_task', { taskId: cb.relatedTaskId })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
