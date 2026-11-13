import { useState, useEffect, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApiError, apiFetch, passwordChange, passkeyVerifyBegin, passwordSetupWithPasskey, updateDisplayName } from '../api.js';
import { isNative } from '../native.js';
import { validatePasswordComplexity } from '@shared/password-rules.js';
import { AUTH_ERROR_CODES } from '@shared/auth-error-codes.js';
import {
  PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
  PUSH_NOTIFICATION_TYPE_WAITING_INPUT,
  PUSH_NOTIFICATION_TYPE_SESSION_ERROR,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
  resolveEffectivePushEnabledServerIds,
  type PushNotificationType,
} from '@shared/push-notifications.js';
import {
  fetchPushNotificationSettings,
  getLocalPushNotificationPreferences,
  getLocalPushEnabledServers,
  syncPushNotificationPreferences,
  syncPushEnabledServers,
  hasUnsyncedPushNotificationEdits,
  hasUnsyncedPushEnabledServerEdits,
} from '../push-notifications.js';
import { GuidePage } from './GuidePage.js';
import { PasskeyManager } from '../components/PasskeyManager.js';
import { KeyboardShortcutsSection } from '../components/KeyboardShortcutsSection.js';
import type { KeyboardShortcutOverrides } from '../keyboard-shortcuts.js';

interface PushServerItem {
  id: string;
  name: string;
  kind: 'daemon' | 'controlled';
  online: boolean;
}

export type SettingsTab = 'profile' | 'notifications' | 'security' | 'shortcuts' | 'guide';

const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; labelKey: string }> = [
  { id: 'profile', labelKey: 'settings.tab_profile' },
  { id: 'notifications', labelKey: 'settings.tab_notifications' },
  { id: 'security', labelKey: 'settings.tab_security' },
  { id: 'shortcuts', labelKey: 'settings.tab_shortcuts' },
  { id: 'guide', labelKey: 'settings.tab_guide' },
];

interface Props {
  displayName: string | null;
  username: string | null;
  hasPassword: boolean;
  serverUrl?: string | null;
  initialTab?: SettingsTab;
  shortcutOverrides?: KeyboardShortcutOverrides;
  onChangeShortcutOverrides?: (
    value: KeyboardShortcutOverrides | ((prev: KeyboardShortcutOverrides) => KeyboardShortcutOverrides),
  ) => void;
  onBack: () => void;
  onDisplayNameChanged: (name: string) => void;
  onUserAuthUpdated: (next: { username: string | null; hasPassword: boolean }) => void;
}

export function SettingsPage({
  displayName,
  username,
  hasPassword,
  serverUrl,
  initialTab = 'profile',
  shortcutOverrides,
  onChangeShortcutOverrides,
  onBack,
  onDisplayNameChanged,
  onUserAuthUpdated,
}: Props) {
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(displayName ?? '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [setupUsername, setSetupUsername] = useState(username ?? '');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirmPassword, setSetupConfirmPassword] = useState('');
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupMsg, setSetupMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [pushPreferences, setPushPreferences] = useState<PushNotificationType[]>(() =>
    getLocalPushNotificationPreferences(),
  );
  const [pushEnabledServers, setPushEnabledServers] = useState<string[] | null>(() =>
    getLocalPushEnabledServers(),
  );
  const [pushServers, setPushServers] = useState<PushServerItem[]>([]);
  const [pushServersLoading, setPushServersLoading] = useState(false);
  const [pushServersError, setPushServersError] = useState(false);

  const userEditedPushRef = useRef(false);
  const userEditedPushServersRef = useRef(false);
  const mountedRef = useRef(true);
  const pushServersLoadedRef = useRef(false);
  const pushServersGenerationRef = useRef(0);
  const pushServersAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pushServersGenerationRef.current += 1;
      pushServersAbortRef.current?.abort();
      pushServersAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    let unmounted = false;
    void fetchPushNotificationSettings().then((snapshot) => {
      if (unmounted || !snapshot) return;
      if (snapshot.types !== null && !userEditedPushRef.current && !hasUnsyncedPushNotificationEdits()) {
        setPushPreferences(snapshot.types);
      }
      if (snapshot.enabledServerIds !== undefined && !userEditedPushServersRef.current && !hasUnsyncedPushEnabledServerEdits()) {
        setPushEnabledServers(snapshot.enabledServerIds);
      }
    });
    return () => {
      unmounted = true;
    };
  }, []);

  const loadPushServers = () => {
    pushServersAbortRef.current?.abort();
    const controller = new AbortController();
    pushServersAbortRef.current = controller;
    const gen = ++pushServersGenerationRef.current;

    setPushServersLoading(true);
    setPushServersError(false);

    void Promise.all([
      apiFetch<{ servers?: Array<{ id?: unknown; name?: unknown; status?: unknown }> }>('/api/server', { signal: controller.signal }),
      apiFetch<{ machines?: Array<{ serverId?: unknown; displayName?: unknown; online?: unknown }> }>('/api/machines', { signal: controller.signal }),
    ]).then(([serversRes, machinesRes]) => {
      if (!mountedRef.current || controller.signal.aborted || gen !== pushServersGenerationRef.current) return;
      if (!Array.isArray(serversRes?.servers) || !Array.isArray(machinesRes?.machines)) {
        throw new Error('Invalid server list response');
      }
      const merged = new Map<string, PushServerItem>();
      for (const srv of serversRes.servers) {
        const id = typeof srv.id === 'string' ? srv.id.trim() : '';
        if (!id) continue;
        const name = typeof srv.name === 'string' && srv.name.trim() ? srv.name.trim() : id;
        merged.set(id, {
          id,
          name,
          kind: 'daemon',
          online: srv.status === 'online',
        });
      }
      for (const machine of machinesRes.machines) {
        const id = typeof machine.serverId === 'string' ? machine.serverId.trim() : '';
        if (!id || merged.has(id)) continue;
        const name = typeof machine.displayName === 'string' && machine.displayName.trim() ? machine.displayName.trim() : id;
        merged.set(id, {
          id,
          name,
          kind: 'controlled',
          online: Boolean(machine.online),
        });
      }
      pushServersLoadedRef.current = true;
      setPushServers([...merged.values()]);
      setPushServersError(false);
    }).catch(() => {
      if (!mountedRef.current || controller.signal.aborted || gen !== pushServersGenerationRef.current) return;
      setPushServersError(true);
    }).finally(() => {
      if (!mountedRef.current || gen !== pushServersGenerationRef.current) return;
      if (pushServersAbortRef.current === controller) {
        pushServersAbortRef.current = null;
      }
      setPushServersLoading(false);
    });
  };

  useEffect(() => {
    if (activeTab !== 'notifications' || pushServersLoadedRef.current) return;
    loadPushServers();
    return () => {
      // Only cancel in-flight requests if leaving before a full authoritative snapshot completed.
      if (!pushServersLoadedRef.current) {
        pushServersGenerationRef.current += 1;
        pushServersAbortRef.current?.abort();
        pushServersAbortRef.current = null;
        if (mountedRef.current) {
          setPushServersLoading(false);
        }
      }
    };
  }, [activeTab]);

  const handleSelectTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  };

  const togglePushType = (type: PushNotificationType) => {
    userEditedPushRef.current = true;
    setPushPreferences((prev) => {
      const next = prev.includes(type) ? prev.filter((item) => item !== type) : [...prev, type];
      void syncPushNotificationPreferences(next);
      return next;
    });
  };

  const accessibleServerIds = pushServers.map((s) => s.id);
  const effectiveEnabledServers = resolveEffectivePushEnabledServerIds(pushEnabledServers, accessibleServerIds);

  const togglePushServer = (serverId: string) => {
    userEditedPushServersRef.current = true;
    setPushEnabledServers((prev) => {
      const current = resolveEffectivePushEnabledServerIds(prev, accessibleServerIds);
      const next = current.includes(serverId) ? current.filter((item) => item !== serverId) : [...current, serverId];
      void syncPushEnabledServers(next);
      return next;
    });
  };

  const selectAllPushServers = () => {
    if (pushServers.length === 0) return;
    userEditedPushServersRef.current = true;
    const next = pushServers.map((s) => s.id);
    setPushEnabledServers(next);
    void syncPushEnabledServers(next);
  };

  const clearAllPushServers = () => {
    userEditedPushServersRef.current = true;
    setPushEnabledServers([]);
    void syncPushEnabledServers([]);
  };

  const applySetupErrorCode = (errorCode: string | null) => {
    if (errorCode === AUTH_ERROR_CODES.USERNAME_TAKEN) {
      setSetupMsg({ type: 'err', text: t('settings.username_taken') });
    } else if (errorCode === AUTH_ERROR_CODES.INVALID_USERNAME_FORMAT) {
      setSetupMsg({ type: 'err', text: t('settings.username_invalid') });
    } else if (errorCode === 'wrong_passkey') {
      setSetupMsg({ type: 'err', text: t('settings.passkey_verify_wrong_account') });
    } else if (errorCode === 'no_passkeys') {
      setSetupMsg({ type: 'err', text: t('settings.passkey_verify_no_passkeys') });
    } else {
      setSetupMsg({ type: 'err', text: t('settings.password_setup_error') });
    }
  };

  const encodeNativePasswordSetupState = (payload: { apiKey: string; username: string; newPassword: string }): string => {
    const json = JSON.stringify(payload);
    const utf8 = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of utf8) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };

  const handleNativeSetupPassword = async (normalizedUsername: string) => {
    if (!serverUrl) {
      setSetupMsg({ type: 'err', text: t('settings.password_setup_error') });
      return;
    }
    const [{ getAuthKey }, { default: AuthSession }] = await Promise.all([
      import('../biometric-auth.js'),
      import('../plugins/auth-session.js'),
    ]);
    const key = await getAuthKey(serverUrl);
    if (!key) {
      setSetupMsg({ type: 'err', text: t('settings.password_setup_error') });
      return;
    }
    const url = new URL('/', serverUrl);
    url.searchParams.set('native_callback', 'imcodes://password-setup');
    url.searchParams.set('action', 'password_setup');
    url.searchParams.set('_t', String(Date.now()));
    url.hash = `state=${encodeURIComponent(encodeNativePasswordSetupState({
      apiKey: key,
      username: normalizedUsername,
      newPassword: setupPassword,
    }))}`;

    const result = await AuthSession.start({ url: url.toString(), callbackScheme: 'imcodes' });
    const callback = new URL(result.url);
    const ok = callback.searchParams.get('ok');
    if (ok === '1') {
      const nextUsername = callback.searchParams.get('username') ?? normalizedUsername;
      onUserAuthUpdated({ username: nextUsername, hasPassword: true });
      setSetupUsername(nextUsername);
      setSetupPassword('');
      setSetupConfirmPassword('');
      setSetupMsg({ type: 'ok', text: t('settings.password_setup_success') });
      return;
    }
    applySetupErrorCode(callback.searchParams.get('error'));
  };

  const handleSaveName = async () => {
    if (!nameValue.trim()) return;
    setNameSaving(true);
    setNameMsg(null);
    try {
      await updateDisplayName(nameValue.trim());
      onDisplayNameChanged(nameValue.trim());
      setEditingName(false);
      setNameMsg({ type: 'ok', text: t('settings.name_saved') });
    } catch {
      setNameMsg({ type: 'err', text: t('settings.name_error') });
    } finally {
      setNameSaving(false);
    }
  };

  const handleSetupPassword = async () => {
    setSetupMsg(null);
    const normalizedUsername = setupUsername.trim().toLowerCase();
    if (!normalizedUsername) {
      setSetupMsg({ type: 'err', text: t('settings.username_required') });
      return;
    }
    if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/.test(normalizedUsername)) {
      setSetupMsg({ type: 'err', text: t('settings.username_invalid') });
      return;
    }
    if (setupPassword !== setupConfirmPassword) {
      setSetupMsg({ type: 'err', text: t('settings.passwords_mismatch') });
      return;
    }
    const complexity = validatePasswordComplexity(setupPassword);
    if (!complexity.valid) {
      setSetupMsg({ type: 'err', text: t(`settings.${complexity.errorKey}`) });
      return;
    }
    setSetupSaving(true);
    try {
      if (isNative()) {
        await handleNativeSetupPassword(normalizedUsername);
      } else {
        const beginRes = await passkeyVerifyBegin();
        const { challengeId, ...options } = beginRes;
        const authResponse = await startAuthentication(options as never);
        const result = await passwordSetupWithPasskey(normalizedUsername, setupPassword, challengeId, authResponse);
        onUserAuthUpdated({ username: result.user.username, hasPassword: result.user.has_password });
        setSetupUsername(result.user.username ?? normalizedUsername);
        setSetupPassword('');
        setSetupConfirmPassword('');
        setSetupMsg({ type: 'ok', text: t('settings.password_setup_success') });
      }
    } catch (err) {
      const errorCode = err instanceof ApiError ? err.code : null;
      applySetupErrorCode(errorCode);
    } finally {
      setSetupSaving(false);
    }
  };

  const handleChangePw = async () => {
    setPwMsg(null);
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'err', text: t('settings.passwords_mismatch') });
      return;
    }
    const complexity = validatePasswordComplexity(newPw);
    if (!complexity.valid) {
      setPwMsg({ type: 'err', text: t(`settings.${complexity.errorKey}`) });
      return;
    }
    setPwSaving(true);
    try {
      await passwordChange(oldPw, newPw);
      setPwMsg({ type: 'ok', text: t('settings.password_changed') });
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
    } catch {
      setPwMsg({ type: 'err', text: t('settings.password_error') });
    } finally {
      setPwSaving(false);
    }
  };

  const inlineLabelStyle: Record<string, string> = {
    fontSize: '12px',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: '6px',
  };

  const checkboxStyle: Record<string, string> = {
    marginTop: '3px',
    cursor: 'pointer',
    width: '18px',
    height: '18px',
    flexShrink: '0',
  };

  const checkboxTextWrapStyle: Record<string, string> = {
    flex: '1 1 auto',
    minWidth: '0',
  };

  const checkboxTitleStyle: Record<string, string> = {
    fontSize: '13px',
    fontWeight: '600',
    color: '#e2e8f0',
    overflowWrap: 'anywhere',
  };

  const checkboxDescStyle: Record<string, string> = {
    fontSize: '12px',
    color: '#94a3b8',
    marginTop: '2px',
    lineHeight: '1.45',
    overflowWrap: 'anywhere',
  };

  const pushGroupTitleStyle: Record<string, string> = {
    fontSize: '12px',
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: '8px',
    marginTop: '16px',
  };

  const securityBadgeStyle: Record<string, string> = {
    display: 'inline-block',
    fontSize: '11px',
    fontWeight: '700',
    color: '#f87171',
    background: 'rgba(239, 68, 68, 0.18)',
    border: '1px solid rgba(239, 68, 68, 0.4)',
    borderRadius: '4px',
    padding: '1px 6px',
    marginLeft: '6px',
    verticalAlign: 'middle',
  };

  const messageColor = (type: 'ok' | 'err'): string => (type === 'ok' ? '#4ade80' : '#f87171');

  return (
    <div
      class="settings-page-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        background: '#0a0e1a',
        color: '#e2e8f0',
      }}
    >
      <header class="settings-page-header">
        <div class="settings-page-header-inner">
          <div class="settings-page-header-row">
            <button type="button" onClick={onBack} class="settings-btn-secondary settings-back-btn">
              {t('settings.back')}
            </button>
            <h1 class="settings-page-title">{t('settings.title')}</h1>
          </div>

          <div class="settings-tabs" role="tablist" aria-label={t('settings.title')}>
            {SETTINGS_TABS.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`settings-tabpanel-${tab.id}`}
                  class={`settings-tab-btn${selected ? ' is-active' : ''}`}
                  onClick={() => handleSelectTab(tab.id)}
                >
                  {t(tab.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        data-testid="settings-page-scroll"
        class="settings-page-scroll"
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          width: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          WebkitOverflowScrolling: 'touch',
          overscrollBehaviorY: 'contain',
          touchAction: 'pan-y',
        }}
      >
        <div
          class="settings-page-inner"
          style={{
            paddingBottom: 'calc(28px + max(var(--sab, 0px), env(safe-area-inset-bottom, 0px)))',
          }}
        >
          {activeTab === 'profile' && (
            <div
              role="tabpanel"
              id="settings-tabpanel-profile"
              aria-labelledby="settings-tab-profile"
              aria-label={t('settings.tab_profile')}
            >
              <div class="settings-card">
                <h2 class="settings-card-heading">
                  {t('settings.account_identity')}
                </h2>
                <div style={inlineLabelStyle}>{t('settings.username')}</div>
                <div class="settings-identity-value">{username ?? t('settings.no_username')}</div>
                <div style={inlineLabelStyle}>{t('settings.display_name')}</div>
                {!editingName ? (
                  <div class="settings-name-row">
                    <span class="settings-identity-value settings-identity-inline">
                      {displayName || t('settings.no_name')}
                    </span>
                    <button
                      type="button"
                      onClick={() => { setEditingName(true); setNameValue(displayName ?? ''); setNameMsg(null); }}
                      class="settings-btn-secondary"
                    >
                      {t('settings.edit')}
                    </button>
                  </div>
                ) : (
                  <div>
                    <input
                      type="text"
                      value={nameValue}
                      onInput={(e) => setNameValue((e.target as HTMLInputElement).value)}
                      class="settings-input"
                      placeholder={t('settings.name_placeholder')}
                    />
                    <div class="settings-action-row">
                      <button
                        type="button"
                        onClick={handleSaveName}
                        disabled={nameSaving}
                        class="settings-btn-primary"
                      >
                        {nameSaving ? t('common.loading') : t('settings.save')}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditingName(false); setNameMsg(null); }}
                        class="settings-btn-secondary"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}
                {nameMsg && (
                  <div style={{ marginTop: '8px', fontSize: '13px', color: messageColor(nameMsg.type) }}>
                    {nameMsg.text}
                  </div>
                )}
              </div>

              <footer class="settings-legal-footer">
                <a
                  href="https://im.codes/privacy.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="settings-legal-link"
                >
                  {t('settings.privacy_policy')}
                </a>
                <a
                  href="https://im.codes/terms.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="settings-legal-link"
                >
                  {t('settings.terms_of_service')}
                </a>
              </footer>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div
              role="tabpanel"
              id="settings-tabpanel-notifications"
              aria-labelledby="settings-tab-notifications"
              aria-label={t('settings.tab_notifications')}
            >
              {/* Push Notification Preferences */}
              <div class="settings-card" data-testid="push-notification-settings-card">
                <div style={inlineLabelStyle}>{t('settings.push_notifications_label')}</div>
                <h2 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 6px', color: '#e2e8f0' }}>
                  {t('settings.push_notifications_title')}
                </h2>
                <p style={{ color: '#94a3b8', fontSize: '13px', lineHeight: 1.5, margin: '0 0 16px' }}>
                  {t('settings.push_notifications_desc')}
                </p>

                {/* Group 1: Basic */}
                <div style={pushGroupTitleStyle}>{t('settings.push_group_basic')}</div>
                <div style={{ display: 'grid', gap: '8px' }}>
                  <label class="settings-checkbox-row">
                    <input
                      type="checkbox"
                      aria-label={t('settings.push_task_complete_title')}
                      checked={pushPreferences.includes(PUSH_NOTIFICATION_TYPE_TASK_COMPLETE)}
                      onChange={() => togglePushType(PUSH_NOTIFICATION_TYPE_TASK_COMPLETE)}
                      style={checkboxStyle}
                    />
                    <div style={checkboxTextWrapStyle}>
                      <div style={checkboxTitleStyle}>{t('settings.push_task_complete_title')}</div>
                      <div style={checkboxDescStyle}>{t('settings.push_task_complete_desc')}</div>
                    </div>
                  </label>

                  <label class="settings-checkbox-row">
                    <input
                      type="checkbox"
                      aria-label={t('settings.push_waiting_input_title')}
                      checked={pushPreferences.includes(PUSH_NOTIFICATION_TYPE_WAITING_INPUT)}
                      onChange={() => togglePushType(PUSH_NOTIFICATION_TYPE_WAITING_INPUT)}
                      style={checkboxStyle}
                    />
                    <div style={checkboxTextWrapStyle}>
                      <div style={checkboxTitleStyle}>{t('settings.push_waiting_input_title')}</div>
                      <div style={checkboxDescStyle}>{t('settings.push_waiting_input_desc')}</div>
                    </div>
                  </label>

                  <label class="settings-checkbox-row">
                    <input
                      type="checkbox"
                      aria-label={t('settings.push_session_error_title')}
                      checked={pushPreferences.includes(PUSH_NOTIFICATION_TYPE_SESSION_ERROR)}
                      onChange={() => togglePushType(PUSH_NOTIFICATION_TYPE_SESSION_ERROR)}
                      style={checkboxStyle}
                    />
                    <div style={checkboxTextWrapStyle}>
                      <div style={checkboxTitleStyle}>{t('settings.push_session_error_title')}</div>
                      <div style={checkboxDescStyle}>{t('settings.push_session_error_desc')}</div>
                    </div>
                  </label>
                </div>

                {/* Group 2: Task Lifecycle */}
                <div style={pushGroupTitleStyle}>{t('settings.push_group_task_pair')}</div>
                <div style={{ display: 'grid', gap: '8px' }}>
                  <label class="settings-checkbox-row">
                    <input
                      type="checkbox"
                      aria-label={t('settings.push_task_pair_done_title')}
                      checked={pushPreferences.includes(PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE)}
                      onChange={() => togglePushType(PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE)}
                      style={checkboxStyle}
                    />
                    <div style={checkboxTextWrapStyle}>
                      <div style={checkboxTitleStyle}>{t('settings.push_task_pair_done_title')}</div>
                      <div style={checkboxDescStyle}>{t('settings.push_task_pair_done_desc')}</div>
                    </div>
                  </label>

                  <label class="settings-checkbox-row">
                    <input
                      type="checkbox"
                      aria-label={t('settings.push_task_pair_paused_title')}
                      checked={pushPreferences.includes(PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED)}
                      onChange={() => togglePushType(PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED)}
                      style={checkboxStyle}
                    />
                    <div style={checkboxTextWrapStyle}>
                      <div style={checkboxTitleStyle}>{t('settings.push_task_pair_paused_title')}</div>
                      <div style={checkboxDescStyle}>{t('settings.push_task_pair_paused_desc')}</div>
                    </div>
                  </label>

                  <label class="settings-checkbox-row">
                    <input
                      type="checkbox"
                      aria-label={t('settings.push_task_pair_audit_title')}
                      checked={pushPreferences.includes(PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT)}
                      onChange={() => togglePushType(PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT)}
                      style={checkboxStyle}
                    />
                    <div style={checkboxTextWrapStyle}>
                      <div style={checkboxTitleStyle}>{t('settings.push_task_pair_audit_title')}</div>
                      <div style={checkboxDescStyle}>{t('settings.push_task_pair_audit_desc')}</div>
                    </div>
                  </label>
                </div>

                {/* Group 3: Security Alert */}
                <div style={pushGroupTitleStyle}>{t('settings.push_group_security')}</div>
                <div style={{ display: 'grid', gap: '8px' }}>
                  <label class="settings-checkbox-row settings-checkbox-row-security">
                    <input
                      type="checkbox"
                      aria-label={t('settings.push_remote_desktop_title')}
                      checked={pushPreferences.includes(PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP)}
                      onChange={() => togglePushType(PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP)}
                      style={checkboxStyle}
                    />
                    <div style={checkboxTextWrapStyle}>
                      <div style={checkboxTitleStyle}>
                        {t('settings.push_remote_desktop_title')}
                        <span style={securityBadgeStyle}>{t('settings.push_security_highest_badge')}</span>
                      </div>
                      <div style={checkboxDescStyle}>{t('settings.push_remote_desktop_desc')}</div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Push Notification Allowed Servers */}
              <div class="settings-card" data-testid="push-notification-servers-card">
                <div style={inlineLabelStyle}>{t('settings.push_servers_label')}</div>
                <h2 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 6px', color: '#e2e8f0' }}>
                  {t('settings.push_servers_title')}
                </h2>
                <p style={{ color: '#94a3b8', fontSize: '13px', lineHeight: 1.5, margin: '0 0 12px' }}>
                  {t('settings.push_servers_desc')}
                </p>

                <div class="settings-action-row" style={{ marginBottom: '12px' }}>
                  <button
                    type="button"
                    class="settings-btn-secondary"
                    style={{ minHeight: '32px', padding: '6px 12px', fontSize: '12px' }}
                    disabled={pushServers.length === 0 || pushServers.every((s) => effectiveEnabledServers.includes(s.id))}
                    onClick={selectAllPushServers}
                  >
                    {t('settings.push_servers_select_all')}
                  </button>
                  <button
                    type="button"
                    class="settings-btn-secondary"
                    style={{ minHeight: '32px', padding: '6px 12px', fontSize: '12px' }}
                    disabled={effectiveEnabledServers.length === 0}
                    onClick={clearAllPushServers}
                  >
                    {t('settings.push_servers_clear')}
                  </button>
                </div>

                {pushServersLoading && pushServers.length === 0 ? (
                  <div style={{ color: '#94a3b8', fontSize: '13px' }}>{t('common.loading')}</div>
                ) : pushServersError && pushServers.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <span style={{ color: '#f87171', fontSize: '13px' }}>{t('settings.push_servers_load_error')}</span>
                    <button
                      type="button"
                      class="settings-btn-secondary"
                      style={{ minHeight: '32px', padding: '6px 12px', fontSize: '12px' }}
                      onClick={loadPushServers}
                    >
                      {t('common.retry')}
                    </button>
                  </div>
                ) : pushServers.length === 0 ? (
                  <div style={{ color: '#94a3b8', fontSize: '13px' }}>{t('settings.push_servers_empty')}</div>
                ) : (
                  <div style={{ display: 'grid', gap: '8px' }}>
                    {pushServers.map((srv) => (
                      <label key={srv.id} class="settings-checkbox-row">
                        <input
                          type="checkbox"
                          aria-label={srv.name}
                          checked={effectiveEnabledServers.includes(srv.id)}
                          onChange={() => togglePushServer(srv.id)}
                          style={checkboxStyle}
                        />
                        <div style={checkboxTextWrapStyle}>
                          <div style={checkboxTitleStyle}>{srv.name}</div>
                          <div style={checkboxDescStyle}>
                            {srv.kind === 'controlled'
                              ? t('settings.push_server_role_controlled')
                              : t('settings.push_server_role_daemon')}
                            {' · '}
                            {srv.online
                              ? t('settings.push_server_online')
                              : t('settings.push_server_offline')}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'security' && (
            <div
              role="tabpanel"
              id="settings-tabpanel-security"
              aria-labelledby="settings-tab-security"
              aria-label={t('settings.tab_security')}
            >
              {!hasPassword ? (
                <div class="settings-card">
                  <h2 class="settings-card-heading">
                    {t('settings.set_password_login')}
                  </h2>
                  <p style={{ color: '#94a3b8', fontSize: '14px', lineHeight: 1.6, marginTop: 0, marginBottom: '14px' }}>
                    {t('settings.set_password_hint')}
                  </p>
                  <input
                    type="text"
                    placeholder={t('settings.username_placeholder')}
                    value={setupUsername}
                    onInput={(e) => setSetupUsername((e.target as HTMLInputElement).value)}
                    class="settings-input"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellcheck={false}
                  />
                  <input
                    type="password"
                    placeholder={t('settings.new_password')}
                    value={setupPassword}
                    onInput={(e) => setSetupPassword((e.target as HTMLInputElement).value)}
                    class="settings-input"
                  />
                  <input
                    type="password"
                    placeholder={t('settings.confirm_password')}
                    value={setupConfirmPassword}
                    onInput={(e) => setSetupConfirmPassword((e.target as HTMLInputElement).value)}
                    class="settings-input"
                  />
                  <button
                    type="button"
                    onClick={handleSetupPassword}
                    disabled={setupSaving || !setupUsername || !setupPassword || !setupConfirmPassword}
                    class="settings-btn-primary settings-submit-btn"
                    style={{ opacity: (!setupUsername || !setupPassword || !setupConfirmPassword) ? '0.5' : '1' }}
                  >
                    {setupSaving ? t('common.loading') : t('settings.set_password_btn')}
                  </button>
                  {setupMsg && (
                    <div style={{ marginTop: '8px', fontSize: '13px', color: messageColor(setupMsg.type) }}>
                      {setupMsg.text}
                    </div>
                  )}
                </div>
              ) : (
                <div class="settings-card">
                  <h2 class="settings-card-heading">
                    {t('settings.change_password')}
                  </h2>
                  <input
                    type="password"
                    placeholder={t('settings.old_password')}
                    value={oldPw}
                    onInput={(e) => setOldPw((e.target as HTMLInputElement).value)}
                    class="settings-input"
                  />
                  <input
                    type="password"
                    placeholder={t('settings.new_password')}
                    value={newPw}
                    onInput={(e) => setNewPw((e.target as HTMLInputElement).value)}
                    class="settings-input"
                  />
                  <input
                    type="password"
                    placeholder={t('settings.confirm_password')}
                    value={confirmPw}
                    onInput={(e) => setConfirmPw((e.target as HTMLInputElement).value)}
                    class="settings-input"
                  />
                  <button
                    type="button"
                    onClick={handleChangePw}
                    disabled={pwSaving || !oldPw || !newPw || !confirmPw}
                    class="settings-btn-primary settings-submit-btn"
                    style={{ opacity: (!oldPw || !newPw || !confirmPw) ? '0.5' : '1' }}
                  >
                    {pwSaving ? t('common.loading') : t('settings.change_password_btn')}
                  </button>
                  {pwMsg && (
                    <div style={{ marginTop: '8px', fontSize: '13px', color: messageColor(pwMsg.type) }}>
                      {pwMsg.text}
                    </div>
                  )}
                </div>
              )}

              <PasskeyManager />
            </div>
          )}

          {activeTab === 'shortcuts' && (
            <div
              role="tabpanel"
              id="settings-tabpanel-shortcuts"
              aria-labelledby="settings-tab-shortcuts"
              aria-label={t('settings.tab_shortcuts')}
            >
              <KeyboardShortcutsSection
                overrides={shortcutOverrides}
                onChangeOverrides={onChangeShortcutOverrides}
              />
            </div>
          )}

          {activeTab === 'guide' && (
            <div
              role="tabpanel"
              id="settings-tabpanel-guide"
              aria-labelledby="settings-tab-guide"
              aria-label={t('settings.tab_guide')}
            >
              <GuidePage />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
