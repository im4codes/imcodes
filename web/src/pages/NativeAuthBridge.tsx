/**
 * NativeAuthBridge — rendered inside ASWebAuthenticationSession for passkey auth.
 *
 * Flow:
 *   1. Passkey WebAuthn at server origin (same-origin, no CORS issues)
 *   2. Fetch API key from server (JSON)
 *   3. Navigate to imcodes://auth?key=... to trigger ASWebAuthenticationSession callback
 */
import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { passkeyLoginBegin, passkeyLoginCompleteNative, passkeyRegisterBegin, passkeyRegisterComplete } from '../api.js';

interface Props {
  callbackUrl: string;
}

/**
 * Try multiple methods to navigate to custom URL scheme.
 * ASWebAuthenticationSession should detect at least one of these.
 */
function navigateToCallback(url: string) {
  // Method 1: direct assignment
  window.location.href = url;
  // Method 2: replace (in case href doesn't work)
  setTimeout(() => { try { window.location.replace(url); } catch { /* ignore */ } }, 200);
  // Method 3: anchor click
  setTimeout(() => {
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
  }, 400);
  // Method 4: open
  setTimeout(() => { try { window.open(url, '_self'); } catch { /* ignore */ } }, 600);
}

export function NativeAuthBridge({ callbackUrl }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<'buttons' | 'register'>('buttons');
  const [displayName, setDisplayName] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [autoTriggered, setAutoTriggered] = useState(false);
  const [callbackLink, setCallbackLink] = useState<string | null>(null);

  const buildCallbackUrl = (apiKey: string, userId: string, keyId: string): string => {
    const url = new URL(callbackUrl);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('userId', userId);
    url.searchParams.set('keyId', keyId);
    return url.toString();
  };

  const doLogin = async (source: string) => {
    setLoading(true);
    setError(null);
    setStatus('Getting challenge...');
    try {
      const beginRes = await passkeyLoginBegin();
      const { challengeId, ...options } = beginRes;
      setStatus('Authenticating...');
      const authResponse = await startAuthentication(options as never);
      setStatus('Getting API key...');
      const res = await passkeyLoginCompleteNative(challengeId, authResponse);
      setStatus('Redirecting...');
      const url = buildCallbackUrl(res.apiKey, res.userId, res.keyId);
      setCallbackLink(url);
      navigateToCallback(url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NotAllowedError') || msg.toLowerCase().includes('not allowed')) {
        if (source === 'auto') {
          setStatus(null);
        } else {
          setError(t('login.passkey_not_found'));
        }
      } else if (!msg.toLowerCase().includes('cancel')) {
        setError(`[DEBUG ${source}] ${msg}`);
      }
      setLoading(false);
    }
  };

  useEffect(() => {
    if (autoTriggered) return;
    setAutoTriggered(true);
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'register') {
      setMode('register');
      return;
    }
    doLogin('auto');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRegister = async () => {
    if (!displayName.trim()) return;
    setLoading(true);
    setError(null);
    setStatus('Creating passkey...');
    try {
      const beginRes = await passkeyRegisterBegin(displayName.trim());
      const { challengeId, ...options } = beginRes;
      setStatus('Registering...');
      const regResponse = await startRegistration(options as never);
      setStatus('Saving...');
      await passkeyRegisterComplete(challengeId, regResponse, deviceName.trim() || undefined);
      // After registration, login to get API key
      setStatus('Logging in...');
      const beginRes2 = await passkeyLoginBegin();
      const { challengeId: cid2, ...opts2 } = beginRes2;
      setStatus('Authenticating...');
      const authResponse = await startAuthentication(opts2 as never);
      setStatus('Getting API key...');
      const res = await passkeyLoginCompleteNative(cid2, authResponse);
      setStatus('Redirecting...');
      const url = buildCallbackUrl(res.apiKey, res.userId, res.keyId);
      setCallbackLink(url);
      navigateToCallback(url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('cancel')) {
        setError(`[DEBUG reg] ${msg}`);
      }
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

        {status && (
          <div style={{ color: '#60a5fa', marginBottom: 12, textAlign: 'center', fontSize: 12, fontFamily: 'monospace' }}>
            {status}
          </div>
        )}

        {error && (
          <div style={{ color: '#f87171', marginBottom: 16, textAlign: 'center', fontSize: 14, wordBreak: 'break-all' }}>
            {error}
          </div>
        )}

        {/* Fallback: visible link if automatic redirect doesn't trigger callback */}
        {callbackLink && (
          <div style={{ marginBottom: 16, textAlign: 'center' }}>
            <a
              href={callbackLink}
              style={{ color: '#60a5fa', fontSize: 14, textDecoration: 'underline' }}
            >
              Tap here if not redirected automatically
            </a>
          </div>
        )}

        {mode === 'buttons' && (
          <>
            <button
              class="btn btn-primary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}
              onClick={() => doLogin('tap')}
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
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              onClick={() => { setMode('register'); setError(null); setStatus(null); }}
              disabled={loading}
            >
              {t('login.passkey_create')}
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
              onClick={handleRegister}
              disabled={loading || !displayName.trim()}
            >
              {loading ? t('common.loading') : t('login.passkey_register_btn')}
            </button>
            <button
              class="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => { setMode('buttons'); setError(null); setStatus(null); }}
              disabled={loading}
            >
              {t('common.cancel')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
