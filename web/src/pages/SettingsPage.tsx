import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApiError, passwordChange, passkeyVerifyBegin, passwordSetupWithPasskey, updateDisplayName } from '../api.js';
import { isNative } from '../native.js';

interface Props {
  displayName: string | null;
  username: string | null;
  hasPassword: boolean;
  serverUrl?: string | null;
  onBack: () => void;
  onDisplayNameChanged: (name: string) => void;
  onUserAuthUpdated: (next: { username: string | null; hasPassword: boolean }) => void;
}

export function SettingsPage({ displayName, username, hasPassword, serverUrl, onBack, onDisplayNameChanged, onUserAuthUpdated }: Props) {
  const { t } = useTranslation();

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

  const applySetupErrorCode = (errorCode: string | null) => {
    if (errorCode === 'username_taken') {
      setSetupMsg({ type: 'err', text: t('settings.username_taken') });
    } else if (errorCode === 'invalid_username_format') {
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
    const key = await getAuthKey();
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
    if (setupPassword.length < 8) {
      setSetupMsg({ type: 'err', text: t('settings.password_too_short') });
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
    if (newPw.length < 8) {
      setPwMsg({ type: 'err', text: t('settings.password_too_short') });
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

  const cardStyle: Record<string, string> = {
    background: '#1e293b',
    borderRadius: '12px',
    padding: '20px',
    marginBottom: '16px',
  };

  const inputStyle: Record<string, string> = {
    width: '100%',
    padding: '10px 12px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '8px',
    color: '#e2e8f0',
    fontSize: '14px',
    marginBottom: '10px',
    boxSizing: 'border-box',
  };

  const btnPrimary: Record<string, string> = {
    padding: '10px 20px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '600',
  };

  const btnSecondary: Record<string, string> = {
    padding: '8px 16px',
    background: '#334155',
    color: '#e2e8f0',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
  };

  const inlineLabelStyle: Record<string, string> = {
    fontSize: '12px',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: '6px',
  };

  const messageColor = (type: 'ok' | 'err'): string => (type === 'ok' ? '#4ade80' : '#f87171');

  return (
    <div style={{ background: '#0a0e1a', color: '#e2e8f0', minHeight: '100%', padding: '20px', overflowY: 'auto' }}>
      <div style={{ maxWidth: '520px', margin: '0 auto' }}>
        <button onClick={onBack} style={{ ...btnSecondary, marginBottom: '20px' }}>
          {t('settings.back')}
        </button>
        <h1 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>{t('settings.title')}</h1>

        <div style={cardStyle}>
          <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: '#94a3b8' }}>
            {t('settings.account_identity')}
          </h2>
          <div style={inlineLabelStyle}>{t('settings.username')}</div>
          <div style={{ fontSize: '16px', marginBottom: '14px' }}>{username ?? t('settings.no_username')}</div>
          <div style={inlineLabelStyle}>{t('settings.display_name')}</div>
          {!editingName ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '16px' }}>{displayName || t('settings.no_name')}</span>
              <button onClick={() => { setEditingName(true); setNameValue(displayName ?? ''); setNameMsg(null); }} style={btnSecondary}>
                {t('settings.edit')}
              </button>
            </div>
          ) : (
            <div>
              <input
                type="text"
                value={nameValue}
                onInput={(e) => setNameValue((e.target as HTMLInputElement).value)}
                style={inputStyle}
                placeholder={t('settings.name_placeholder')}
              />
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleSaveName} disabled={nameSaving} style={btnPrimary}>
                  {nameSaving ? t('common.loading') : t('settings.save')}
                </button>
                <button onClick={() => { setEditingName(false); setNameMsg(null); }} style={btnSecondary}>
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

        {!hasPassword ? (
          <div style={cardStyle}>
            <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: '#94a3b8' }}>
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
              style={inputStyle}
              autoCapitalize="none"
              autoCorrect="off"
              spellcheck={false}
            />
            <input
              type="password"
              placeholder={t('settings.new_password')}
              value={setupPassword}
              onInput={(e) => setSetupPassword((e.target as HTMLInputElement).value)}
              style={inputStyle}
            />
            <input
              type="password"
              placeholder={t('settings.confirm_password')}
              value={setupConfirmPassword}
              onInput={(e) => setSetupConfirmPassword((e.target as HTMLInputElement).value)}
              style={inputStyle}
            />
            <button
              onClick={handleSetupPassword}
              disabled={setupSaving || !setupUsername || !setupPassword || !setupConfirmPassword}
              style={{ ...btnPrimary, opacity: (!setupUsername || !setupPassword || !setupConfirmPassword) ? '0.5' : '1' }}
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
          <div style={cardStyle}>
            <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: '#94a3b8' }}>
              {t('settings.change_password')}
            </h2>
            <input
              type="password"
              placeholder={t('settings.old_password')}
              value={oldPw}
              onInput={(e) => setOldPw((e.target as HTMLInputElement).value)}
              style={inputStyle}
            />
            <input
              type="password"
              placeholder={t('settings.new_password')}
              value={newPw}
              onInput={(e) => setNewPw((e.target as HTMLInputElement).value)}
              style={inputStyle}
            />
            <input
              type="password"
              placeholder={t('settings.confirm_password')}
              value={confirmPw}
              onInput={(e) => setConfirmPw((e.target as HTMLInputElement).value)}
              style={inputStyle}
            />
            <button
              onClick={handleChangePw}
              disabled={pwSaving || !oldPw || !newPw || !confirmPw}
              style={{ ...btnPrimary, opacity: (!oldPw || !newPw || !confirmPw) ? '0.5' : '1' }}
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

        <div style={{ textAlign: 'center', marginTop: '24px', marginBottom: '12px' }}>
          <a
            href="https://im.codes/privacy.html"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#64748b', fontSize: '13px', textDecoration: 'none', marginRight: '16px' }}
          >
            {t('settings.privacy_policy')}
          </a>
          <a
            href="https://im.codes/terms.html"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#64748b', fontSize: '13px', textDecoration: 'none' }}
          >
            {t('settings.terms_of_service')}
          </a>
        </div>
      </div>
    </div>
  );
}
