import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApiError, apiFetch, passwordChange, passkeyVerifyBegin, passwordSetupWithPasskey, updateDisplayName, type MeResponse } from '../api.js';
import {
  bindUserEmail,
  extractAuthErrorDetails,
  fetchEmailAuthConfig,
  mapEmailAuthErrorCode,
  sendEmailVerificationCode,
} from '../api/email-auth.js';
import {
  EMAIL_AUTH_PURPOSE,
  EMAIL_OTP_RESEND_COOLDOWN_SECONDS,
  isValidEmail,
  isValidEmailOtp,
} from '@shared/email-auth.js';
import {
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_RESPONSE_FORMAT,
  TTS_DEFAULT_VOICE,
  TTS_ENGINES,
  TTS_RESPONSE_FORMATS,
  TTS_VOICE_LANG_KEYS,
  normalizeTtsVoiceLangKey,
  resolveServerTtsVoiceForLang,
  sanitizeTtsVoicesByLang,
  type TtsResponseFormat,
} from '@shared/tts-config.js';
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
  commitPushEnabledServers,
  subscribePushEnabledServers,
  hasUnsyncedPushNotificationEdits,
  hasUnsyncedPushEnabledServerEdits,
} from '../push-notifications.js';
import {
  getDesktopNotificationPermission,
  getLocalDesktopNotificationsEnabled,
  isDesktopNotificationSupported,
  requestDesktopNotificationPermission,
  setLocalDesktopNotificationsEnabled,
  subscribeDesktopNotificationsEnabled,
  type DesktopNotificationPermission,
} from '../desktop-notifications.js';
import { GuidePage } from './GuidePage.js';
import { PasskeyManager } from '../components/PasskeyManager.js';
import { KeyboardShortcutsSection } from '../components/KeyboardShortcutsSection.js';
import { SharedVoiceSection } from '../components/SharedVoiceSection.js';
import { OfflineVoiceModelSection } from '../components/OfflineVoiceModelSection.js';
import type { KeyboardShortcutOverrides } from '../keyboard-shortcuts.js';
import {
  formatGlobalFontDelta,
  MAX_GLOBAL_FONT_DELTA,
  MIN_GLOBAL_FONT_DELTA,
  useGlobalFontDelta,
} from '../global-font.js';
import {
  formatUiScale,
  markUiScalePrompted,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  UI_SCALE_STEP,
  useUiScale,
} from '../ui-scale.js';
import {
  canOpenNativeTtsSettings,
  fetchServerTtsConfig,
  fetchServerTtsVoices,
  getCachedServerTtsConfig,
  getCachedServerTtsVoices,
  getDefaultPresetTtsVoices,
  getNativeTtsVoiceQuality,
  getTtsAutoReadEnabled,
  getTtsMode,
  getTtsSpeechRate,
  getTtsState,
  openNativeTtsSettings,
  previewServerTtsVoice,
  saveServerTtsConfig,
  setTtsAutoReadEnabled,
  setTtsMode,
  setTtsSpeechRate,
  speakText,
  stopSpeaking,
  subscribeTtsPreferences,
  subscribeTtsState,
  TTS_RATE_OPTIONS,
  type TtsEngineMode,
  type TtsPlaybackState,
  type TtsVoiceOption,
} from '../tts.js';
import {
  getNativeTtsVoiceQualityLabelKey,
  isHighQualityNativeTtsVoice,
  isIosNativePlatform,
  type NativeTtsVoiceQualityInfo,
} from '../voice-recognition-backend.js';

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
  emailAuthEnabled?: boolean;
  userEmail?: string | null;
  emailVerified?: boolean;
  isAdmin?: boolean;
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
  emailAuthEnabled: emailAuthEnabledProp,
  userEmail: userEmailProp,
  emailVerified: emailVerifiedProp,
  isAdmin = false,
  serverUrl,
  initialTab = 'profile',
  shortcutOverrides,
  onChangeShortcutOverrides,
  onBack,
  onDisplayNameChanged,
  onUserAuthUpdated,
}: Props) {
  const { t, i18n } = useTranslation();
  const currentLang = i18n?.language;
  const [globalFontDelta, setGlobalFontDelta] = useGlobalFontDelta();
  const [uiScale, setUiScale, defaultUiScale] = useUiScale();
  const [ttsAutoRead, setTtsAutoRead] = useState<boolean>(() => getTtsAutoReadEnabled());
  const [ttsRate, setTtsRate] = useState<number>(() => getTtsSpeechRate());
  const [ttsMode, setLocalTtsMode] = useState<TtsEngineMode>(() => getTtsMode());
  const [ttsBaseUrl, setTtsBaseUrl] = useState<string>(() => getCachedServerTtsConfig()?.baseUrl ?? '');
  const [ttsApiKeyInput, setTtsApiKeyInput] = useState<string>('');
  const [ttsHasApiKey, setTtsHasApiKey] = useState<boolean>(() => getCachedServerTtsConfig()?.hasApiKey ?? false);
  const [ttsApiKeyMasked, setTtsApiKeyMasked] = useState<string | null>(() => getCachedServerTtsConfig()?.apiKeyMasked ?? null);
  const [ttsModel, setTtsModel] = useState<string>(() => getCachedServerTtsConfig()?.model ?? TTS_DEFAULT_MODEL);
  const [ttsVoice, setTtsVoice] = useState<string>(() => getCachedServerTtsConfig()?.voice ?? TTS_DEFAULT_VOICE);
  const [ttsLangVoices, setTtsLangVoices] = useState<Record<string, string>>(() => sanitizeTtsVoicesByLang(getCachedServerTtsConfig()?.voicesByLang));
  const [ttsFormat, setTtsFormat] = useState<TtsResponseFormat>(() => getCachedServerTtsConfig()?.responseFormat ?? TTS_DEFAULT_RESPONSE_FORMAT);
  const [ttsServerDefaultConfigured, setTtsServerDefaultConfigured] = useState<boolean>(() => getCachedServerTtsConfig()?.serverDefaultConfigured ?? false);
  const [ttsServerCanConfigureEndpoint, setTtsServerCanConfigureEndpoint] = useState<boolean | undefined>(undefined);
  const canConfigureTtsEndpoint = typeof ttsServerCanConfigureEndpoint === 'boolean'
    ? ttsServerCanConfigureEndpoint
    : Boolean(isAdmin);
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceOption[]>(() => (
    getCachedServerTtsVoices()?.voices ?? getDefaultPresetTtsVoices(getCachedServerTtsConfig()?.voice ?? TTS_DEFAULT_VOICE)
  ));
  const [ttsVoicesLoading, setTtsVoicesLoading] = useState(false);
  const [ttsSaving, setTtsSaving] = useState(false);
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsPlayback, setTtsPlayback] = useState<TtsPlaybackState>(() => (
    typeof getTtsState === 'function' ? getTtsState() : { status: 'idle', activeMessageId: null, error: null }
  ));
  const [ttsServerMsg, setTtsServerMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [nativeVoiceQuality, setNativeVoiceQuality] = useState<NativeTtsVoiceQualityInfo | null>(null);

  const refreshTtsVoices = useCallback(async (forceRefresh = false) => {
    if (typeof fetchServerTtsVoices !== 'function') return;
    setTtsVoicesLoading(true);
    try {
      const res = await fetchServerTtsVoices(forceRefresh ? { forceRefresh: true } : undefined);
      if (!mountedRef.current) return;
      if (res?.voices && res.voices.length > 0) {
        setTtsVoices(res.voices);
      }
    } catch {
      // Keep cached or preset voices when upstream discovery fails.
    } finally {
      if (mountedRef.current) setTtsVoicesLoading(false);
    }
  }, []);

  const ttsVoiceOptions = useMemo(() => {
    const base = ttsVoices.length > 0 ? ttsVoices : getDefaultPresetTtsVoices(ttsVoice);
    const current = ttsVoice.trim();
    if (current && !base.some((v) => v.id === current)) {
      return [{ id: current, name: current }, ...base];
    }
    return base;
  }, [ttsVoices, ttsVoice]);

  const handleVoicePreviewClick = useCallback(async (params: {
    previewId: string;
    voice: string;
    lang?: string;
    isPreviewing: boolean;
  }) => {
    setTtsServerMsg(null);
    if (params.isPreviewing) {
      await stopSpeaking();
      return;
    }
    if (typeof previewServerTtsVoice !== 'function') return;
    const res = await previewServerTtsVoice({
      voice: params.voice,
      lang: params.lang,
      rate: ttsRate,
      availableVoices: ttsVoiceOptions,
      fallbackLocale: currentLang,
      previewId: params.previewId,
    });
    if (!res.started && res.reason === 'error' && res.error) {
      setTtsServerMsg({ type: 'err', text: t('settings.tts_preview_failed', { error: res.error }) });
    }
  }, [currentLang, t, ttsRate, ttsVoiceOptions]);

  useEffect(() => {
    return subscribeTtsPreferences(() => {
      setTtsAutoRead(getTtsAutoReadEnabled());
      setTtsRate(getTtsSpeechRate());
      setLocalTtsMode(getTtsMode());
    });
  }, []);

  useEffect(() => {
    if (typeof subscribeTtsState !== 'function') return undefined;
    return subscribeTtsState((next) => {
      setTtsPlayback(next);
    });
  }, []);

  useEffect(() => {
    if (ttsMode !== 'server') return;
    void refreshTtsVoices();
  }, [ttsMode, refreshTtsVoices]);

  useEffect(() => {
    if (typeof fetchServerTtsConfig !== 'function') return;
    let cancelled = false;
    void fetchServerTtsConfig().then((cfg) => {
      if (cancelled || !cfg) return;
      setLocalTtsMode(cfg.mode);
      setTtsBaseUrl(cfg.baseUrl);
      setTtsHasApiKey(cfg.hasApiKey);
      setTtsApiKeyMasked(cfg.apiKeyMasked);
      setTtsModel(cfg.model);
      setTtsVoice(cfg.voice);
      setTtsLangVoices(sanitizeTtsVoicesByLang(cfg.voicesByLang));
      setTtsFormat(cfg.responseFormat);
      setTtsServerDefaultConfigured(cfg.serverDefaultConfigured);
      setTtsServerCanConfigureEndpoint(cfg.canConfigureEndpoint);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getNativeTtsVoiceQuality(currentLang).then((info) => {
      if (!cancelled) setNativeVoiceQuality(info);
    });
    return () => {
      cancelled = true;
    };
  }, [currentLang]);

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
  const [pwEmailCode, setPwEmailCode] = useState('');
  const [pwEmailSending, setPwEmailSending] = useState(false);
  const [pwEmailCooldown, setPwEmailCooldown] = useState(0);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [emailAuthEnabled, setEmailAuthEnabled] = useState(emailAuthEnabledProp === true);
  const [boundEmail, setBoundEmail] = useState<string | null>(userEmailProp ?? null);
  const [boundEmailVerified, setBoundEmailVerified] = useState(emailVerifiedProp === true);
  const [bindEmailInput, setBindEmailInput] = useState('');
  const [bindEmailCode, setBindEmailCode] = useState('');
  const [bindEmailSending, setBindEmailSending] = useState(false);
  const [bindEmailCooldown, setBindEmailCooldown] = useState(0);
  const [bindEmailSaving, setBindEmailSaving] = useState(false);
  const [bindEmailMsg, setBindEmailMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [pushPreferences, setPushPreferences] = useState<PushNotificationType[]>(() =>
    getLocalPushNotificationPreferences(),
  );
  const [desktopNotifPermission, setDesktopNotifPermission] = useState<DesktopNotificationPermission>(() =>
    getDesktopNotificationPermission(),
  );
  const [desktopNotifEnabled, setDesktopNotifEnabled] = useState<boolean>(() =>
    getLocalDesktopNotificationsEnabled(),
  );
  const [desktopNotifRequesting, setDesktopNotifRequesting] = useState(false);
  const [pushEnabledServers, setPushEnabledServers] = useState<string[] | null>(() =>
    getLocalPushEnabledServers(),
  );
  const pushEnabledServersRef = useRef<string[] | null>(pushEnabledServers);
  pushEnabledServersRef.current = pushEnabledServers;
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
    setDesktopNotifPermission(getDesktopNotificationPermission());
    setDesktopNotifEnabled(getLocalDesktopNotificationsEnabled());
    return subscribeDesktopNotificationsEnabled((enabled) => {
      setDesktopNotifEnabled(enabled);
      setDesktopNotifPermission(getDesktopNotificationPermission());
    });
  }, []);

  const handleEnableDesktopNotifications = async () => {
    setDesktopNotifRequesting(true);
    try {
      const nextPerm = await requestDesktopNotificationPermission();
      setDesktopNotifPermission(nextPerm);
      setDesktopNotifEnabled(getLocalDesktopNotificationsEnabled());
    } finally {
      setDesktopNotifRequesting(false);
    }
  };

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
    const unsubscribe = typeof subscribePushEnabledServers === 'function'
      ? subscribePushEnabledServers((next) => {
        if (!unmounted) {
          pushEnabledServersRef.current = next;
          setPushEnabledServers(next);
        }
      })
      : () => {};
    void fetchPushNotificationSettings().then((snapshot) => {
      if (unmounted || !snapshot) return;
      if (snapshot.types !== null && !userEditedPushRef.current && !hasUnsyncedPushNotificationEdits()) {
        setPushPreferences(snapshot.types);
      }
      if (snapshot.enabledServerIds !== undefined && !userEditedPushServersRef.current && !hasUnsyncedPushEnabledServerEdits()) {
        pushEnabledServersRef.current = snapshot.enabledServerIds;
        setPushEnabledServers(snapshot.enabledServerIds);
      }
    });
    return () => {
      unmounted = true;
      unsubscribe();
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

  const commitPushServerSelection = (next: string[]) => {
    userEditedPushServersRef.current = true;
    const prevRaw = pushEnabledServersRef.current;
    pushEnabledServersRef.current = next;
    setPushEnabledServers(next);
    void commitPushEnabledServers(next, prevRaw);
  };

  const togglePushServer = (serverId: string) => {
    const current = resolveEffectivePushEnabledServerIds(pushEnabledServersRef.current, accessibleServerIds);
    const next = current.includes(serverId) ? current.filter((item) => item !== serverId) : [...current, serverId];
    commitPushServerSelection(next);
  };

  const selectAllPushServers = () => {
    if (pushServers.length === 0) return;
    commitPushServerSelection(pushServers.map((s) => s.id));
  };

  const clearAllPushServers = () => {
    commitPushServerSelection([]);
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

  useEffect(() => {
    if (emailAuthEnabledProp !== undefined) setEmailAuthEnabled(emailAuthEnabledProp);
    if (userEmailProp !== undefined) setBoundEmail(userEmailProp);
    if (emailVerifiedProp !== undefined) setBoundEmailVerified(emailVerifiedProp);
    if (activeTab !== 'security') return;
    let cancelled = false;
    if (emailAuthEnabledProp === undefined) {
      void fetchEmailAuthConfig()
        .then((res) => {
          if (!cancelled && res && typeof res.emailAuthEnabled === 'boolean') {
            setEmailAuthEnabled(res.emailAuthEnabled);
          }
        })
        .catch(() => {});
    }
    if (userEmailProp === undefined) {
      void apiFetch<MeResponse>('/api/auth/user/me')
        .then((me) => {
          if (!cancelled && me && typeof me.id === 'string') {
            setBoundEmail(me.email ?? null);
            setBoundEmailVerified(Boolean(me.email_verified));
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [activeTab, emailAuthEnabledProp, userEmailProp, emailVerifiedProp]);

  useEffect(() => {
    if (bindEmailCooldown <= 0) return;
    const timer = setTimeout(() => setBindEmailCooldown((prev) => (prev > 0 ? prev - 1 : 0)), 1000);
    return () => clearTimeout(timer);
  }, [bindEmailCooldown]);

  useEffect(() => {
    if (pwEmailCooldown <= 0) return;
    const timer = setTimeout(() => setPwEmailCooldown((prev) => (prev > 0 ? prev - 1 : 0)), 1000);
    return () => clearTimeout(timer);
  }, [pwEmailCooldown]);

  const settingsAuthErrorMessage = (err: unknown, fallbackKey: string): string => {
    const { code, retryAfterMs } = extractAuthErrorDetails(err);
    const emailMsg = mapEmailAuthErrorCode(t, 'settings', code, retryAfterMs);
    if (emailMsg) return emailMsg;
    if (code === AUTH_ERROR_CODES.TOO_MANY_ATTEMPTS) {
      const minutes = Math.max(1, Math.ceil((retryAfterMs ?? 60_000) / 60_000));
      return t('login.too_many_attempts', { minutes });
    }
    return t(fallbackKey);
  };

  const handleSendBindEmailCode = async () => {
    setBindEmailMsg(null);
    if (!isValidEmail(bindEmailInput)) {
      setBindEmailMsg({ type: 'err', text: t('settings.invalid_email') });
      return;
    }
    setBindEmailSending(true);
    try {
      await sendEmailVerificationCode({
        email: bindEmailInput.trim(),
        purpose: EMAIL_AUTH_PURPOSE.BIND_EMAIL,
        lang: currentLang,
      });
      setBindEmailCooldown(EMAIL_OTP_RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setBindEmailMsg({ type: 'err', text: settingsAuthErrorMessage(err, 'settings.email_send_failed') });
    } finally {
      setBindEmailSending(false);
    }
  };

  const handleBindEmail = async () => {
    setBindEmailMsg(null);
    if (!isValidEmail(bindEmailInput)) {
      setBindEmailMsg({ type: 'err', text: t('settings.invalid_email') });
      return;
    }
    if (!isValidEmailOtp(bindEmailCode)) {
      setBindEmailMsg({ type: 'err', text: t('settings.email_code_required') });
      return;
    }
    setBindEmailSaving(true);
    try {
      const res = await bindUserEmail(bindEmailInput.trim(), bindEmailCode.trim());
      setBoundEmail(res.email);
      setBoundEmailVerified(Boolean(res.email_verified));
      setBindEmailInput('');
      setBindEmailCode('');
      setBindEmailMsg({ type: 'ok', text: t('settings.email_bound_success') });
    } catch (err) {
      setBindEmailMsg({ type: 'err', text: settingsAuthErrorMessage(err, 'settings.email_code_invalid') });
    } finally {
      setBindEmailSaving(false);
    }
  };

  const handleSendChangePwEmailCode = async () => {
    setPwMsg(null);
    setPwEmailSending(true);
    try {
      await sendEmailVerificationCode({
        purpose: EMAIL_AUTH_PURPOSE.PASSWORD_CHANGE,
        lang: currentLang,
      });
      setPwEmailCooldown(EMAIL_OTP_RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setPwMsg({ type: 'err', text: settingsAuthErrorMessage(err, 'settings.email_send_failed') });
    } finally {
      setPwEmailSending(false);
    }
  };

  const requiresEmailChangeCode = emailAuthEnabled && boundEmailVerified && Boolean(boundEmail);

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
    if (requiresEmailChangeCode && !isValidEmailOtp(pwEmailCode)) {
      setPwMsg({ type: 'err', text: t('settings.email_code_required') });
      return;
    }
    setPwSaving(true);
    try {
      if (requiresEmailChangeCode) {
        await passwordChange(oldPw, newPw, pwEmailCode.trim());
      } else {
        await passwordChange(oldPw, newPw);
      }
      setPwMsg({ type: 'ok', text: t('settings.password_changed') });
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
      setPwEmailCode('');
    } catch (err) {
      setPwMsg({ type: 'err', text: settingsAuthErrorMessage(err, 'settings.password_error') });
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
              <div class="settings-card" data-testid="settings-global-font-size">
                <h2 class="settings-card-heading">
                  {t('settings.appearance_title', { defaultValue: 'Appearance' })}
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                      <div style={inlineLabelStyle}>{t('chat.font.uiScaleLabel', { defaultValue: 'UI scale' })}</div>
                      <div style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.45 }}>
                        {t('settings.ui_scale_desc', { defaultValue: 'Uniformly scales the entire interface (buttons, sidebars, icons, modals, and text).' })}
                      </div>
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <button
                        type="button"
                        class="settings-btn-secondary"
                        onClick={() => {
                          markUiScalePrompted();
                          setUiScale((prev) => prev - UI_SCALE_STEP);
                        }}
                        disabled={uiScale <= MIN_UI_SCALE}
                        aria-label={t('chat.font.uiScaleDecrease', { defaultValue: 'Decrease UI scale' })}
                        style={{ minWidth: 32, padding: '6px 10px' }}
                      >
                        −
                      </button>
                      <span
                        data-testid="settings-ui-scale-readout"
                        style={{ minWidth: 48, textAlign: 'center', fontVariantNumeric: 'tabular-nums', fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}
                      >
                        {formatUiScale(uiScale)}
                      </span>
                      <button
                        type="button"
                        class="settings-btn-secondary"
                        onClick={() => {
                          markUiScalePrompted();
                          setUiScale((prev) => prev + UI_SCALE_STEP);
                        }}
                        disabled={uiScale >= MAX_UI_SCALE}
                        aria-label={t('chat.font.uiScaleIncrease', { defaultValue: 'Increase UI scale' })}
                        style={{ minWidth: 32, padding: '6px 10px' }}
                      >
                        +
                      </button>
                      {uiScale !== defaultUiScale && (
                        <button
                          type="button"
                          class="settings-btn-secondary"
                          data-testid="settings-ui-scale-reset"
                          aria-label={t('chat.font.uiScaleReset', { defaultValue: 'Reset UI scale' })}
                          onClick={() => {
                            markUiScalePrompted();
                            setUiScale(defaultUiScale);
                          }}
                          style={{ padding: '6px 10px', fontSize: '12px' }}
                        >
                          {t('chat.font.globalReset', { defaultValue: 'Reset' })}
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                      <div style={inlineLabelStyle}>{t('chat.font.globalSizeLabel', { defaultValue: 'Global size' })}</div>
                      <div style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.45 }}>
                        {t('settings.global_font_size_desc', { defaultValue: 'Adjusts font size across the entire app (+1 / -1 px).' })}
                      </div>
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <button
                        type="button"
                        class="settings-btn-secondary"
                        onClick={() => setGlobalFontDelta((prev) => prev - 1)}
                        disabled={globalFontDelta <= MIN_GLOBAL_FONT_DELTA}
                        aria-label={t('chat.font.globalDecrease', { defaultValue: 'Decrease global font size' })}
                        style={{ minWidth: 32, padding: '6px 10px' }}
                      >
                        −
                      </button>
                      <span
                        data-testid="settings-global-font-delta-readout"
                        style={{ minWidth: 42, textAlign: 'center', fontVariantNumeric: 'tabular-nums', fontSize: '14px', fontWeight: 600, color: '#e2e8f0' }}
                      >
                        {formatGlobalFontDelta(globalFontDelta)}
                      </span>
                      <button
                        type="button"
                        class="settings-btn-secondary"
                        onClick={() => setGlobalFontDelta((prev) => prev + 1)}
                        disabled={globalFontDelta >= MAX_GLOBAL_FONT_DELTA}
                        aria-label={t('chat.font.globalIncrease', { defaultValue: 'Increase global font size' })}
                        style={{ minWidth: 32, padding: '6px 10px' }}
                      >
                        +
                      </button>
                      {globalFontDelta !== 0 && (
                        <button
                          type="button"
                          class="settings-btn-secondary"
                          onClick={() => setGlobalFontDelta(0)}
                          style={{ padding: '6px 10px', fontSize: '12px' }}
                        >
                          {t('chat.font.globalReset', { defaultValue: 'Reset' })}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <OfflineVoiceModelSection />

              <SharedVoiceSection />

              <div class="settings-card" data-testid="settings-tts-card">
                <h2 class="settings-card-heading">
                  {t('settings.tts_title')}
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                      <div style={inlineLabelStyle}>{t('settings.tts_auto_read')}</div>
                      <div style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.45 }}>
                        {t('settings.tts_auto_read_desc')}
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={ttsAutoRead}
                      aria-label={t('settings.tts_auto_read')}
                      data-testid="settings-tts-auto-read-toggle"
                      class={ttsAutoRead ? 'settings-btn-primary' : 'settings-btn-secondary'}
                      style={{ minWidth: 64, padding: '6px 12px', fontSize: '12px' }}
                      onClick={() => {
                        const next = !ttsAutoRead;
                        setTtsAutoReadEnabled(next);
                        setTtsAutoRead(next);
                      }}
                    >
                      {ttsAutoRead ? t('common.on', { defaultValue: 'On' }) : t('common.off', { defaultValue: 'Off' })}
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                      <div style={inlineLabelStyle}>{t('settings.tts_rate')}</div>
                      <div style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.45 }}>
                        {t('settings.tts_rate_desc')}
                      </div>
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                      {TTS_RATE_OPTIONS.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          data-testid={`settings-tts-rate-${opt}`}
                          aria-pressed={ttsRate === opt}
                          class={ttsRate === opt ? 'settings-btn-primary' : 'settings-btn-secondary'}
                          style={{ minWidth: 46, padding: '6px 10px', fontSize: '12px' }}
                          onClick={() => {
                            setTtsSpeechRate(opt);
                            setTtsRate(opt);
                          }}
                        >
                          {opt}x
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                      <div style={inlineLabelStyle}>{t('settings.tts_engine')}</div>
                      <div style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.45 }}>
                        {t('settings.tts_engine_desc')}
                      </div>
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                      {TTS_ENGINES.map((engine) => (
                        <button
                          key={engine}
                          type="button"
                          data-testid={`settings-tts-engine-${engine}`}
                          aria-pressed={ttsMode === engine}
                          class={ttsMode === engine ? 'settings-btn-primary' : 'settings-btn-secondary'}
                          style={{ minWidth: 72, padding: '6px 12px', fontSize: '12px' }}
                          onClick={() => {
                            setTtsMode(engine);
                            setLocalTtsMode(engine);
                            setTtsServerMsg(null);
                            void stopSpeaking();
                            if (typeof saveServerTtsConfig === 'function') {
                              void saveServerTtsConfig({ mode: engine }).catch(() => {});
                            }
                          }}
                        >
                          {t(`settings.tts_engine_${engine}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  {ttsMode === 'server' && (
                    <div
                      data-testid="settings-tts-server-panel"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        borderTop: '1px solid rgba(148, 163, 184, 0.14)',
                        paddingTop: 12,
                      }}
                    >
                      {canConfigureTtsEndpoint && (
                        <>
                          <div>
                            <label style={inlineLabelStyle} for="settings-tts-server-baseurl-input">
                              {t('settings.tts_server_base_url')}
                            </label>
                            <input
                              id="settings-tts-server-baseurl-input"
                              data-testid="settings-tts-server-baseurl"
                              type="url"
                              class="settings-input"
                              value={ttsBaseUrl}
                              onInput={(e) => setTtsBaseUrl((e.target as HTMLInputElement).value)}
                              placeholder={ttsServerDefaultConfigured
                                ? t('settings.tts_server_default_configured')
                                : t('settings.tts_server_base_url_placeholder')}
                            />
                          </div>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                              <label style={inlineLabelStyle} for="settings-tts-server-apikey-input">
                                {t('settings.tts_server_api_key')}
                              </label>
                              {ttsHasApiKey && (
                                <button
                                  type="button"
                                  data-testid="settings-tts-server-clear-key"
                                  class="settings-btn-secondary"
                                  style={{ padding: '2px 8px', fontSize: '11px' }}
                                  disabled={ttsSaving}
                                  onClick={async () => {
                                    if (typeof saveServerTtsConfig !== 'function') return;
                                    setTtsSaving(true);
                                    setTtsServerMsg(null);
                                    try {
                                      const res = await saveServerTtsConfig({ apiKey: '' });
                                      if (res?.config) {
                                        setTtsHasApiKey(res.config.hasApiKey);
                                        setTtsApiKeyMasked(res.config.apiKeyMasked);
                                        setTtsServerCanConfigureEndpoint(res.config.canConfigureEndpoint);
                                        setTtsApiKeyInput('');
                                        setTtsServerMsg({ type: 'ok', text: t('settings.tts_server_saved') });
                                        void refreshTtsVoices();
                                      }
                                    } catch (err) {
                                      setTtsServerMsg({ type: 'err', text: err instanceof Error ? err.message : t('settings.tts_server_save_error') });
                                    } finally {
                                      setTtsSaving(false);
                                    }
                                  }}
                                >
                                  {t('settings.tts_server_api_key_clear')}
                                </button>
                              )}
                            </div>
                            <input
                              id="settings-tts-server-apikey-input"
                              data-testid="settings-tts-server-apikey"
                              type="password"
                              autocomplete="off"
                              class="settings-input"
                              value={ttsApiKeyInput}
                              onInput={(e) => setTtsApiKeyInput((e.target as HTMLInputElement).value)}
                              placeholder={t('settings.tts_server_api_key_placeholder')}
                            />
                            {ttsHasApiKey && ttsApiKeyMasked && (
                              <div data-testid="settings-tts-server-apikey-hint" style={{ color: '#94a3b8', fontSize: '11px', marginTop: 4 }}>
                                {t('settings.tts_server_api_key_keep', { masked: ttsApiKeyMasked })}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                        <div>
                          <label style={inlineLabelStyle} for="settings-tts-server-model-input">
                            {t('settings.tts_server_model')}
                          </label>
                          <input
                            id="settings-tts-server-model-input"
                            data-testid="settings-tts-server-model"
                            type="text"
                            class="settings-input"
                            value={ttsModel}
                            onInput={(e) => setTtsModel((e.target as HTMLInputElement).value)}
                            placeholder={TTS_DEFAULT_MODEL}
                          />
                        </div>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <label style={inlineLabelStyle} for="settings-tts-server-voice-input">
                              {t('settings.tts_server_voice')}
                            </label>
                            <button
                              type="button"
                              data-testid="settings-tts-server-refresh-voices"
                              class="settings-btn-secondary"
                              style={{ padding: '2px 8px', fontSize: '11px' }}
                              disabled={ttsVoicesLoading || ttsSaving}
                              onClick={() => void refreshTtsVoices(true)}
                            >
                              {ttsVoicesLoading ? '...' : t('settings.tts_server_voices_refresh')}
                            </button>
                          </div>
                          {(() => {
                            const defaultPreviewId = 'settings-default-voice-preview';
                            const isPreviewingDefault = ttsPlayback.status === 'speaking' && ttsPlayback.activeMessageId === defaultPreviewId;
                            return (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                <select
                                  id="settings-tts-server-voice-select"
                                  data-testid="settings-tts-server-voice-select"
                                  aria-label={t('settings.tts_server_voice')}
                                  class="settings-input"
                                  style={{ flex: 1, minWidth: 0 }}
                                  value={ttsVoice}
                                  onInput={(e) => setTtsVoice((e.currentTarget as HTMLSelectElement).value)}
                                  onChange={(e) => setTtsVoice((e.currentTarget as HTMLSelectElement).value)}
                                >
                                  {ttsVoiceOptions.map((voice) => {
                                    const label = voice.name && voice.name !== voice.id
                                      ? `${voice.name} (${voice.id})`
                                      : voice.id;
                                    return (
                                      <option key={voice.id} value={voice.id}>
                                        {voice.locale ? `${label} · ${voice.locale}` : label}
                                      </option>
                                    );
                                  })}
                                </select>
                                <button
                                  type="button"
                                  data-testid="settings-tts-server-voice-preview"
                                  class="settings-btn-secondary"
                                  style={{ flex: '0 0 auto', padding: '6px 10px', fontSize: '12px', whiteSpace: 'nowrap' }}
                                  disabled={ttsSaving}
                                  title={isPreviewingDefault ? t('settings.tts_preview_stop') : t('settings.tts_preview_voice')}
                                  aria-label={isPreviewingDefault ? t('settings.tts_preview_stop') : t('settings.tts_preview_voice')}
                                  onClick={() => void handleVoicePreviewClick({
                                    previewId: defaultPreviewId,
                                    voice: ttsVoice.trim() || TTS_DEFAULT_VOICE,
                                    isPreviewing: isPreviewingDefault,
                                  })}
                                >
                                  {isPreviewingDefault ? `■ ${t('settings.tts_preview_stop')}` : `▶ ${t('settings.tts_preview_voice')}`}
                                </button>
                              </div>
                            );
                          })()}
                          <input
                            id="settings-tts-server-voice-input"
                            data-testid="settings-tts-server-voice"
                            type="text"
                            class="settings-input"
                            value={ttsVoice}
                            onInput={(e) => setTtsVoice((e.target as HTMLInputElement).value)}
                            placeholder={TTS_DEFAULT_VOICE}
                          />
                        </div>
                        <div>
                          <label style={inlineLabelStyle} for="settings-tts-server-format-select">
                            {t('settings.tts_server_format')}
                          </label>
                          <select
                            id="settings-tts-server-format-select"
                            data-testid="settings-tts-server-format"
                            class="settings-input"
                            value={ttsFormat}
                            onInput={(e) => setTtsFormat((e.currentTarget as HTMLSelectElement).value as TtsResponseFormat)}
                            onChange={(e) => setTtsFormat((e.currentTarget as HTMLSelectElement).value as TtsResponseFormat)}
                          >
                            {TTS_RESPONSE_FORMATS.map((fmt) => (
                              <option key={fmt} value={fmt}>{fmt}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div data-testid="settings-tts-server-lang-voices">
                        <div style={{ marginBottom: 6 }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#cbd5e1' }}>
                            {t('settings.tts_server_lang_voices')}
                          </div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                            {t('settings.tts_server_lang_voices_hint')}
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                          {TTS_VOICE_LANG_KEYS.map((langKey) => {
                            const fallbackVoice = ttsVoice.trim() || TTS_DEFAULT_VOICE;
                            const matching = ttsVoiceOptions.filter((v) => v.locale && normalizeTtsVoiceLangKey(v.locale) === langKey);
                            const others = ttsVoiceOptions.filter((v) => !v.locale || normalizeTtsVoiceLangKey(v.locale) !== langKey);
                            const ordered = [...matching, ...others];
                            const selectedVal = ttsLangVoices[langKey] ?? '';
                            const hasSelectedInOrdered = !selectedVal || ordered.some((v) => v.id === selectedVal);
                            const autoResolved = resolveServerTtsVoiceForLang({
                              lang: langKey,
                              availableVoices: ttsVoiceOptions,
                              fallbackVoice,
                            });
                            const autoLabel = matching.length > 0
                              ? t('settings.tts_lang_voice_auto_matched', { voice: autoResolved })
                              : t('settings.tts_lang_voice_auto_fallback', { voice: autoResolved });
                            const handleLangSelect = (e: Event) => {
                              const nextVal = (e.currentTarget as HTMLSelectElement).value;
                              setTtsLangVoices((prev) => {
                                const next = { ...prev };
                                if (nextVal) next[langKey] = nextVal;
                                else delete next[langKey];
                                return next;
                              });
                            };
                            const langPreviewId = `settings-lang-voice-preview:${langKey}`;
                            const isPreviewingLang = ttsPlayback.status === 'speaking' && ttsPlayback.activeMessageId === langPreviewId;
                            const langPreviewVoice = selectedVal || autoResolved;
                            return (
                              <div key={langKey}>
                                <label style={inlineLabelStyle} for={`settings-tts-lang-voice-${langKey}`}>
                                  {t(`settings.tts_lang_${langKey}`)}
                                </label>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <select
                                    id={`settings-tts-lang-voice-${langKey}`}
                                    data-testid={`settings-tts-lang-voice-${langKey}`}
                                    aria-label={t(`settings.tts_lang_${langKey}`)}
                                    class="settings-input"
                                    style={{ flex: 1, minWidth: 0 }}
                                    value={selectedVal}
                                    onInput={handleLangSelect}
                                    onChange={handleLangSelect}
                                  >
                                    <option value="">{autoLabel}</option>
                                    {!hasSelectedInOrdered && (
                                      <option value={selectedVal}>{selectedVal}</option>
                                    )}
                                    {ordered.map((voice) => {
                                      const label = voice.name && voice.name !== voice.id
                                        ? `${voice.name} (${voice.id})`
                                        : voice.id;
                                      return (
                                        <option key={voice.id} value={voice.id}>
                                          {voice.locale ? `${label} · ${voice.locale}` : label}
                                        </option>
                                      );
                                    })}
                                  </select>
                                  <button
                                    type="button"
                                    data-testid={`settings-tts-lang-voice-preview-${langKey}`}
                                    class="settings-btn-secondary"
                                    style={{ flex: '0 0 auto', padding: '6px 8px', fontSize: '11px', whiteSpace: 'nowrap' }}
                                    disabled={ttsSaving}
                                    title={isPreviewingLang ? t('settings.tts_preview_stop') : t('settings.tts_preview_voice')}
                                    aria-label={isPreviewingLang ? t('settings.tts_preview_stop') : `${t('settings.tts_preview_voice')} ${t(`settings.tts_lang_${langKey}`)}`}
                                    onClick={() => void handleVoicePreviewClick({
                                      previewId: langPreviewId,
                                      voice: langPreviewVoice,
                                      lang: langKey,
                                      isPreviewing: isPreviewingLang,
                                    })}
                                  >
                                    {isPreviewingLang ? '■' : '▶'}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div class="settings-action-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          data-testid="settings-tts-server-save"
                          class="settings-btn-primary"
                          disabled={ttsSaving}
                          onClick={async () => {
                            if (typeof saveServerTtsConfig !== 'function') return;
                            setTtsSaving(true);
                            setTtsServerMsg(null);
                            try {
                              const voicesByLangPayload: Record<string, string> = {};
                              for (const langKey of TTS_VOICE_LANG_KEYS) {
                                voicesByLangPayload[langKey] = (ttsLangVoices[langKey] ?? '').trim();
                              }
                              const payload: {
                                mode: TtsEngineMode;
                                baseUrl?: string;
                                apiKey?: string;
                                model: string;
                                voice: string;
                                voicesByLang: Record<string, string>;
                                responseFormat: TtsResponseFormat;
                              } = {
                                mode: ttsMode,
                                model: ttsModel.trim(),
                                voice: ttsVoice.trim(),
                                voicesByLang: voicesByLangPayload,
                                responseFormat: ttsFormat,
                              };
                              if (canConfigureTtsEndpoint) {
                                payload.baseUrl = ttsBaseUrl.trim();
                                if (ttsApiKeyInput.trim()) {
                                  payload.apiKey = ttsApiKeyInput.trim();
                                }
                              }
                              const res = await saveServerTtsConfig(payload);
                              if (res?.config) {
                                setTtsBaseUrl(res.config.baseUrl);
                                setTtsHasApiKey(res.config.hasApiKey);
                                setTtsApiKeyMasked(res.config.apiKeyMasked);
                                setTtsModel(res.config.model);
                                setTtsVoice(res.config.voice);
                                setTtsLangVoices(sanitizeTtsVoicesByLang(res.config.voicesByLang));
                                setTtsFormat(res.config.responseFormat);
                                setTtsServerDefaultConfigured(res.config.serverDefaultConfigured);
                                setTtsServerCanConfigureEndpoint(res.config.canConfigureEndpoint);
                                setTtsApiKeyInput('');
                                setTtsServerMsg({ type: 'ok', text: t('settings.tts_server_saved') });
                                void refreshTtsVoices();
                              }
                            } catch (err) {
                              setTtsServerMsg({ type: 'err', text: err instanceof Error ? err.message : t('settings.tts_server_save_error') });
                            } finally {
                              setTtsSaving(false);
                            }
                          }}
                        >
                          {ttsSaving ? t('settings.tts_server_saving') : t('settings.tts_server_save')}
                        </button>
                        <button
                          type="button"
                          data-testid="settings-tts-server-test"
                          class="settings-btn-secondary"
                          disabled={ttsTesting || ttsSaving}
                          onClick={async () => {
                            setTtsTesting(true);
                            setTtsServerMsg(null);
                            try {
                              setTtsMode('server');
                              const res = await speakText(t('settings.tts_server_test_text'), {
                                messageId: 'settings-tts-test',
                                lang: currentLang,
                              });
                              if (!res.started) {
                                setTtsServerMsg({
                                  type: 'err',
                                  text: t('settings.tts_server_test_failed', { error: res.error ?? res.reason ?? 'error' }),
                                });
                              }
                            } catch (err) {
                              setTtsServerMsg({
                                type: 'err',
                                text: t('settings.tts_server_test_failed', { error: err instanceof Error ? err.message : 'error' }),
                              });
                            } finally {
                              setTtsTesting(false);
                            }
                          }}
                        >
                          {t('settings.tts_server_test')}
                        </button>
                      </div>
                      {ttsServerMsg && (
                        <div
                          data-testid="settings-tts-server-status"
                          style={{ fontSize: '12px', color: messageColor(ttsServerMsg.type) }}
                        >
                          {ttsServerMsg.text}
                        </div>
                      )}
                    </div>
                  )}
                  {ttsMode === 'system' && (
                    <div
                      data-testid="settings-tts-voice-hint"
                    style={{
                      color: '#94a3b8',
                      fontSize: '12px',
                      lineHeight: 1.5,
                      borderTop: '1px solid rgba(148, 163, 184, 0.14)',
                      paddingTop: 10,
                    }}
                  >
                    <div>{t('settings.tts_voice_hint')}</div>
                    {isIosNativePlatform() && nativeVoiceQuality?.voiceName?.trim() && (() => {
                      const voiceName = nativeVoiceQuality.voiceName.trim();
                      const qualityKey = getNativeTtsVoiceQualityLabelKey(nativeVoiceQuality);
                      const qualityLabel = qualityKey ? t(qualityKey) : '';
                      return (
                        <div data-testid="settings-tts-current-voice" style={{ marginTop: 4, color: '#cbd5e1' }}>
                          {qualityLabel
                            ? t('settings.tts_current_voice', { name: voiceName, quality: qualityLabel })
                            : voiceName}
                        </div>
                      );
                    })()}
                    {isIosNativePlatform()
                      && nativeVoiceQuality
                      && !isHighQualityNativeTtsVoice(nativeVoiceQuality) && (
                        <div data-testid="settings-tts-ios-enhanced-hint" style={{ marginTop: 4, color: '#cbd5e1' }}>
                          {t('settings.tts_ios_enhanced_hint')}
                        </div>
                    )}
                    {canOpenNativeTtsSettings() && (
                      <div style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          data-testid="settings-tts-open-settings-btn"
                          class="settings-btn-secondary"
                          style={{ padding: '6px 12px', fontSize: '12px' }}
                          onClick={() => {
                            void openNativeTtsSettings();
                          }}
                        >
                          {isIosNativePlatform()
                            ? t('settings.tts_open_ios_settings')
                            : t('settings.tts_open_android_settings')}
                        </button>
                      </div>
                    )}
                  </div>
                  )}
                </div>
              </div>

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
              {!isNative() && (
                <div class="settings-card" data-testid="desktop-notification-settings-card">
                  <div style={inlineLabelStyle}>{t('settings.push_desktop_label')}</div>
                  <h2 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 6px', color: '#e2e8f0' }}>
                    {t('settings.push_desktop_title')}
                  </h2>
                  <p style={{ color: '#94a3b8', fontSize: '13px', lineHeight: 1.5, margin: '0 0 12px' }}>
                    {t('settings.push_desktop_desc')}
                  </p>
                  {!isDesktopNotificationSupported() ? (
                    <div style={{ color: '#94a3b8', fontSize: '13px' }}>
                      {t('settings.push_desktop_unsupported')}
                    </div>
                  ) : desktopNotifPermission === 'granted' ? (
                    <label class="settings-checkbox-row">
                      <input
                        type="checkbox"
                        aria-label={t('settings.push_desktop_toggle_title')}
                        checked={desktopNotifEnabled}
                        onChange={() => setLocalDesktopNotificationsEnabled(!desktopNotifEnabled)}
                        style={checkboxStyle}
                      />
                      <div style={checkboxTextWrapStyle}>
                        <div style={checkboxTitleStyle}>{t('settings.push_desktop_toggle_title')}</div>
                        <div style={checkboxDescStyle}>{t('settings.push_desktop_toggle_desc')}</div>
                      </div>
                    </label>
                  ) : desktopNotifPermission === 'denied' ? (
                    <div style={{ color: '#f87171', fontSize: '13px' }}>
                      {t('settings.push_desktop_denied')}
                    </div>
                  ) : (
                    <button
                      type="button"
                      class="settings-btn-primary"
                      data-testid="enable-desktop-notifications-btn"
                      disabled={desktopNotifRequesting}
                      onClick={() => void handleEnableDesktopNotifications()}
                    >
                      {t('settings.push_desktop_enable_btn')}
                    </button>
                  )}
                </div>
              )}

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
                  {requiresEmailChangeCode && (
                    <>
                      <p style={{ color: '#94a3b8', fontSize: '12px', lineHeight: 1.5, marginTop: 0, marginBottom: '8px' }}>
                        {t('settings.email_change_pw_hint', { email: boundEmail })}
                      </p>
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder={t('settings.email_code_placeholder')}
                          value={pwEmailCode}
                          onInput={(e) => setPwEmailCode((e.target as HTMLInputElement).value)}
                          class="settings-input"
                          style={{ marginBottom: 0, flex: '1 1 auto', minWidth: 0 }}
                        />
                        <button
                          type="button"
                          onClick={handleSendChangePwEmailCode}
                          disabled={pwEmailSending || pwEmailCooldown > 0}
                          class="settings-btn-secondary"
                          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                        >
                          {pwEmailCooldown > 0
                            ? t('settings.resend_email_code', { seconds: pwEmailCooldown })
                            : t('settings.send_email_code')}
                        </button>
                      </div>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={handleChangePw}
                    disabled={pwSaving || !oldPw || !newPw || !confirmPw || (requiresEmailChangeCode && !isValidEmailOtp(pwEmailCode))}
                    class="settings-btn-primary settings-submit-btn"
                    style={{
                      opacity: (!oldPw || !newPw || !confirmPw || (requiresEmailChangeCode && !isValidEmailOtp(pwEmailCode)))
                        ? '0.5'
                        : '1',
                    }}
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

              {emailAuthEnabled && (
                <div class="settings-card" data-testid="settings-email-card">
                  <h2 class="settings-card-heading">
                    {t('settings.email_title')}
                  </h2>
                  {boundEmail && boundEmailVerified ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                        <span style={{ color: '#e2e8f0', fontSize: '14px', overflowWrap: 'anywhere' }}>{boundEmail}</span>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            color: '#4ade80',
                            background: 'rgba(34, 197, 94, 0.14)',
                            border: '1px solid rgba(34, 197, 94, 0.35)',
                            borderRadius: '4px',
                            padding: '1px 6px',
                          }}
                        >
                          {t('settings.email_verified_badge')}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p style={{ color: '#94a3b8', fontSize: '13px', lineHeight: 1.5, marginTop: 0, marginBottom: '12px' }}>
                        {t('settings.email_unbound_hint')}
                      </p>
                      <input
                        type="email"
                        placeholder={t('settings.email_placeholder')}
                        value={bindEmailInput}
                        onInput={(e) => setBindEmailInput((e.target as HTMLInputElement).value)}
                        class="settings-input"
                      />
                      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder={t('settings.email_code_placeholder')}
                          value={bindEmailCode}
                          onInput={(e) => setBindEmailCode((e.target as HTMLInputElement).value)}
                          class="settings-input"
                          style={{ marginBottom: 0, flex: '1 1 auto', minWidth: 0 }}
                        />
                        <button
                          type="button"
                          onClick={handleSendBindEmailCode}
                          disabled={bindEmailSending || bindEmailCooldown > 0 || !bindEmailInput.trim()}
                          class="settings-btn-secondary"
                          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                        >
                          {bindEmailCooldown > 0
                            ? t('settings.resend_email_code', { seconds: bindEmailCooldown })
                            : t('settings.send_email_code')}
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={handleBindEmail}
                          disabled={bindEmailSaving || !bindEmailInput.trim() || !isValidEmailOtp(bindEmailCode)}
                          class="settings-btn-primary settings-submit-btn"
                          style={{ opacity: (!bindEmailInput.trim() || !isValidEmailOtp(bindEmailCode)) ? '0.5' : '1' }}
                        >
                          {bindEmailSaving ? t('common.loading') : t('settings.bind_email_btn')}
                        </button>
                      </div>
                    </>
                  )}
                  {bindEmailMsg && (
                    <div style={{ marginTop: '8px', fontSize: '13px', color: messageColor(bindEmailMsg.type) }}>
                      {bindEmailMsg.text}
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
