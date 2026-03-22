import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { passkeyLoginBegin, passkeyLoginComplete, passkeyRegisterBegin, passkeyRegisterComplete, passwordLogin, passwordChange } from '../api.js';
import { isNative } from '../native.js';

interface Props {
  onLogin?: () => void;
  serverUrl?: string | null;
  onLoginSuccess?: (userId: string, serverUrl: string) => void;
  onChangeServer?: () => void;
}

export function LoginPage({ onLogin, serverUrl, onLoginSuccess, onChangeServer }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'buttons' | 'register' | 'password' | 'change_password'>('buttons');
  const [displayName, setDisplayName] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeySupported, setPasskeySupported] = useState(false);

  useEffect(() => {
    // Native apps always support passkey (WebAuthn runs in Custom Tab / ASWebAuthSession, not WebView).
    // On web, show passkey buttons whenever the browser supports WebAuthn.
    setPasskeySupported(isNative() || (typeof window !== 'undefined' && !!window.PublicKeyCredential));
  }, []);

  const handleGithub = () => {
    const params = new URLSearchParams({ reauth: '1', origin: window.location.origin });
    window.location.href = `/api/auth/github?${params}`;
  };

  // Native: open ASWebAuthenticationSession → server page auto-triggers passkey →
  // redirect to imcodes://auth?key=...&userId=...&keyId=... → session auto-closes.
  // Works with ANY server domain — no hardcoding.
  const handleNativeAuth = async (action?: string) => {
    if (!serverUrl) return;
    setLoading(true);
    setError(null);
    try {
      const AuthSession = (await import('../plugins/auth-session.js')).default;
      let url = `${serverUrl}/api/auth/passkey/native?callback=${encodeURIComponent('imcodes://auth')}&_t=${Date.now()}`;
      if (action) url += `&action=${action}`;
      const result = await AuthSession.start({ url, callbackScheme: 'imcodes' });
      const parsed = new URL(result.url);
      const key = parsed.searchParams.get('key');
      const userId = parsed.searchParams.get('userId');
      const keyId = parsed.searchParams.get('keyId');
      if (key && userId && keyId) {
        const { configureApiKey } = await import('../api.js');
        const { storeAuthKey } = await import('../biometric-auth.js');
        const { Preferences } = await import('@capacitor/preferences');
        await storeAuthKey(key);
        configureApiKey(key);
        await Preferences.set({ key: 'deck_api_key_id', value: keyId });
        onLoginSuccess?.(userId, serverUrl);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('cancel')) {
        setError(t('login.passkey_error'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    if (isNative()) return handleNativeAuth();
    setLoading(true);
    setError(null);
    try {
      const beginRes = await passkeyLoginBegin();
      const { challengeId, ...options } = beginRes;
      const authResponse = await startAuthentication(options as never);
      await passkeyLoginComplete(challengeId, authResponse);
      onLogin?.();
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NotAllowedError') || msg.toLowerCase().includes('not allowed')) {
        setError(t('login.passkey_not_found'));
      } else if (!msg.toLowerCase().includes('cancel')) {
        setError(t('login.passkey_error'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyRegister = async () => {
    if (isNative()) return handleNativeAuth('register');
    if (!displayName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const beginRes = await passkeyRegisterBegin(displayName.trim());
      const { challengeId, ...options } = beginRes;
      const regResponse = await startRegistration(options as never);
      await passkeyRegisterComplete(challengeId, regResponse, deviceName.trim() || undefined);
      onLogin?.();
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('cancel')) {
        setError(t('login.passkey_error'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordLogin = async () => {
    if (!username.trim() || !password) return;
    setLoading(true);
    setError(null);
    try {
      const native = isNative();
      const res = await passwordLogin(username.trim(), password, native);
      if (native && res.apiKey && res.userId && res.keyId) {
        const { configureApiKey } = await import('../api.js');
        const { storeAuthKey } = await import('../biometric-auth.js');
        const { Preferences } = await import('@capacitor/preferences');
        await storeAuthKey(res.apiKey);
        configureApiKey(res.apiKey);
        await Preferences.set({ key: 'deck_api_key_id', value: res.keyId });
        if (res.passwordMustChange) {
          setMode('change_password');
        } else {
          onLoginSuccess?.(res.userId, serverUrl!);
        }
      } else if (res.passwordMustChange) {
        setMode('change_password');
      } else {
        onLogin?.();
        window.location.reload();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid_credentials')) {
        setError(t('login.invalid_credentials'));
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async () => {
    if (!newPassword || newPassword !== confirmPassword) {
      setError(t('login.passwords_mismatch'));
      return;
    }
    if (newPassword.length < 8) {
      setError(t('login.password_too_short'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await passwordChange(password, newPassword);
      if (isNative() && serverUrl) {
        // API key was already stored during login — just proceed
        const { getAuthKey } = await import('../biometric-auth.js');
        const key = await getAuthKey();
        if (key) {
          // userId already known from login, but we can read from Preferences
          const { Preferences } = await import('@capacitor/preferences');
          await Preferences.get({ key: 'deck_api_key_id' });
          // Re-resolve userId from /me endpoint
          const { apiFetch } = await import('../api.js');
          const me = await apiFetch<{ userId: string }>('/api/auth/user/me');
          onLoginSuccess?.(me.userId, serverUrl);
          return;
        }
      }
      onLogin?.();
      window.location.reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="login-page">
      <div class="login-card">
        <h1>IM.codes</h1>
        <p style={{ color: '#94a3b8', marginBottom: 24, textAlign: 'center' }}>
          {t('login.subtitle')}
        </p>

        {error && (
          <div style={{ color: '#f87171', marginBottom: 16, textAlign: 'center', fontSize: 14 }}>
            {error}
          </div>
        )}

        {mode === 'buttons' && (
          <>
            {passkeySupported && (
              <>
                <button
                  class="btn btn-primary"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}
                  onClick={handlePasskeyLogin}
                  disabled={loading}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2C9.24 2 7 4.24 7 7c0 2.08 1.26 3.86 3.08 4.63L9 22h6l-1.08-10.37C15.74 10.86 17 9.08 17 7c0-2.76-2.24-5-5-5z"/>
                    <circle cx="12" cy="7" r="2"/>
                  </svg>
                  {loading ? t('common.loading') : t('login.passkey_signin')}
                </button>

                <button
                  class="btn btn-secondary"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 16 }}
                  onClick={() => { setMode('register'); setError(null); }}
                  disabled={loading}
                >
                  {t('login.passkey_create')}
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                  <div style={{ flex: 1, height: 1, background: '#334155' }} />
                  <span style={{ color: '#64748b', fontSize: 12 }}>{t('login.or')}</span>
                  <div style={{ flex: 1, height: 1, background: '#334155' }} />
                </div>
              </>
            )}

            {!isNative() && (
              <button
                class="btn btn-ghost"
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}
                onClick={handleGithub}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
                </svg>
                {t('login.github_signin')}
              </button>
            )}

            <button
              class="btn btn-ghost"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              onClick={() => { setMode('password'); setError(null); }}
            >
              {t('login.password_signin')}
            </button>
          </>
        )}

        {mode === 'password' && (
          <>
            <input
              class="input"
              style={{ width: '100%', marginBottom: 10, boxSizing: 'border-box' }}
              type="text"
              placeholder={t('login.username_placeholder')}
              value={username}
              onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
              autoFocus
            />
            <input
              class="input"
              style={{ width: '100%', marginBottom: 16, boxSizing: 'border-box' }}
              type="password"
              placeholder={t('login.password_placeholder')}
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && handlePasswordLogin()}
            />
            <button
              class="btn btn-primary"
              style={{ width: '100%', marginBottom: 10 }}
              onClick={handlePasswordLogin}
              disabled={loading || !username.trim() || !password}
            >
              {loading ? t('common.loading') : t('login.signin')}
            </button>
            <button
              class="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => { setMode('buttons'); setError(null); }}
              disabled={loading}
            >
              {t('common.cancel')}
            </button>
          </>
        )}

        {mode === 'change_password' && (
          <>
            <p style={{ color: '#f59e0b', fontSize: 14, marginBottom: 16, textAlign: 'center' }}>
              {t('login.must_change_password')}
            </p>
            <input
              class="input"
              style={{ width: '100%', marginBottom: 10, boxSizing: 'border-box' }}
              type="password"
              placeholder={t('login.new_password_placeholder')}
              value={newPassword}
              onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
              autoFocus
            />
            <input
              class="input"
              style={{ width: '100%', marginBottom: 16, boxSizing: 'border-box' }}
              type="password"
              placeholder={t('login.confirm_password_placeholder')}
              value={confirmPassword}
              onInput={(e) => setConfirmPassword((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && handleChangePassword()}
            />
            <button
              class="btn btn-primary"
              style={{ width: '100%' }}
              onClick={handleChangePassword}
              disabled={loading || !newPassword || newPassword !== confirmPassword}
            >
              {loading ? t('common.loading') : t('login.change_password_btn')}
            </button>
          </>
        )}

        {mode === 'register' && (
          <>
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 16 }}>
              {t('login.passkey_register_hint')}
            </p>
            <input
              class="input"
              style={{ width: '100%', marginBottom: 10, boxSizing: 'border-box' }}
              type="text"
              placeholder={t('login.display_name_placeholder')}
              value={displayName}
              onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
              maxLength={100}
              autoFocus
            />
            <input
              class="input"
              style={{ width: '100%', marginBottom: 16, boxSizing: 'border-box' }}
              type="text"
              placeholder={t('login.device_name_placeholder')}
              value={deviceName}
              onInput={(e) => setDeviceName((e.target as HTMLInputElement).value)}
              maxLength={100}
            />
            <button
              class="btn btn-primary"
              style={{ width: '100%', marginBottom: 10 }}
              onClick={handlePasskeyRegister}
              disabled={loading || !displayName.trim()}
            >
              {loading ? t('common.loading') : t('login.passkey_register_btn')}
            </button>
            <button
              class="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => { setMode('buttons'); setError(null); }}
              disabled={loading}
            >
              {t('common.cancel')}
            </button>
          </>
        )}
      {onChangeServer && (
        <div style={{ marginTop: 20, textAlign: 'center' }}>
          <span style={{ fontSize: 12, color: '#475569' }}>
            {serverUrl}&nbsp;
          </span>
          <button
            style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
            onClick={onChangeServer}
          >
            {t('serverSetup.changeServer')}
          </button>
        </div>
      )}
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <a
            href="/privacy.html"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#64748b', fontSize: 12, textDecoration: 'none', marginRight: 16 }}
          >
            {t('settings.privacy_policy')}
          </a>
          <a
            href="/terms.html"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#64748b', fontSize: 12, textDecoration: 'none' }}
          >
            {t('settings.terms_of_service')}
          </a>
        </div>
      </div>
    </div>
  );
}
