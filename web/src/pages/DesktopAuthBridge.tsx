import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../api.js';
import { DESKTOP_SETUP_AUTH_NONCE_PATH, parseDesktopSetupCallbackUrl } from '@shared/desktop-setup-auth.js';

interface Props {
  callbackUrl: string;
}

function isValidatedDesktopRedirect(raw: unknown, expectedCallback: string): raw is string {
  const expected = parseDesktopSetupCallbackUrl(expectedCallback);
  if (!expected || typeof raw !== 'string') return false;
  try {
    const parsed = new URL(raw);
    return parsed.origin === expected.origin
      && parsed.pathname === '/setup/callback'
      && parsed.searchParams.get('state') === expected.state
      && Boolean(parsed.searchParams.get('nonce'));
  } catch {
    return false;
  }
}

export function DesktopAuthBridge({ callbackUrl }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(() => t('login.desktop_callback_completing'));
  const [error, setError] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const startedRef = useRef(false);

  const runExchange = async () => {
    setError(null);
    setStatus(t('login.desktop_callback_completing'));
    try {
      const res = await apiFetch<{ nonce: string; redirectUrl: string }>(DESKTOP_SETUP_AUTH_NONCE_PATH, {
        method: 'POST',
        body: JSON.stringify({ callbackUrl }),
      });
      if (!isValidatedDesktopRedirect(res.redirectUrl, callbackUrl)) {
        throw new Error('invalid_desktop_callback');
      }
      setRedirectUrl(res.redirectUrl);
      setStatus(t('login.native_status_redirecting'));
      window.location.replace(res.redirectUrl);
    } catch {
      setError(t('login.desktop_callback_error'));
    }
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runExchange();
  }, [callbackUrl]);

  return (
    <div class="login-page">
      <div class="login-card">
        <h1>IM.codes</h1>
        <p style={{ color: '#94a3b8', marginBottom: 16, textAlign: 'center' }}>{status}</p>
        {error && (
          <div style={{ color: '#f87171', marginBottom: 16, textAlign: 'center', fontSize: 14 }}>
            {error}
          </div>
        )}
        {redirectUrl && (
          <a
            href={redirectUrl}
            class="btn btn-primary"
            style={{ width: '100%', display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}
          >
            {t('login.native_callback_fallback')}
          </a>
        )}
        {error && (
          <button
            class="btn btn-primary"
            style={{ width: '100%' }}
            onClick={() => void runExchange()}
          >
            {t('login.desktop_callback_retry')}
          </button>
        )}
      </div>
    </div>
  );
}
