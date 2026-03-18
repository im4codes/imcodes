import { useState, useEffect, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../api.js';

interface KeyInfo {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

interface Props {
  keys: KeyInfo[];
  onKeyCreated: () => void;
  onDeviceAppeared: () => void;
}

export function GettingStarted({ keys, onKeyCreated, onDeviceAppeared }: Props) {
  const { t } = useTranslation();
  const existingKey = keys.find((k) => !k.revokedAt);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasBindUrl = !!(apiKey || existingKey);

  // Poll for devices once we have a key
  useEffect(() => {
    if (!hasBindUrl) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await apiFetch<{ servers: unknown[] }>('/api/server');
        if (res.servers.length > 0) onDeviceAppeared();
      } catch { /* ignore */ }
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [hasBindUrl, onDeviceAppeared]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await apiFetch<{ apiKey: string }>('/api/auth/user/me/keys', {
        method: 'POST',
        body: JSON.stringify({ label: 'first-key' }),
      });
      setApiKey(res.apiKey);
      onKeyCreated();
    } catch (err) {
      console.error('Failed to generate key:', err);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Use the server URL (not window.location.origin which is https://localhost on native)
  const serverUrl = (() => {
    try {
      const raw = localStorage.getItem('rcc_auth');
      if (raw) return (JSON.parse(raw) as { baseUrl: string }).baseUrl;
    } catch { /* ignore */ }
    return window.location.origin;
  })();
  const bindUrl = apiKey
    ? `${serverUrl}/bind/${apiKey}`
    : existingKey
      ? `${serverUrl}/bind/<your-api-key>`
      : '';
  const fullCmd = bindUrl
    ? `npm i -g imcodes && imcodes bind ${bindUrl}`
    : '';

  return (
    <div style={{ border: '1px solid #334155', borderRadius: 12, padding: 24, marginBottom: 24 }}>
      <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>Connect a Device</h2>
      <p style={{ color: '#94a3b8', marginBottom: 24, fontSize: 14, margin: '0 0 24px' }}>
        Run the IM.codes daemon on your machine in two steps.
      </p>

      {/* Step 1 */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontWeight: 600, marginBottom: 10, color: hasBindUrl ? '#94a3b8' : '#e2e8f0', fontSize: 15 }}>
          {hasBindUrl ? t('getting_started.step1_done') : t('getting_started.step1_pending')}
        </div>
        {!hasBindUrl && (
          <button class="btn btn-primary" onClick={handleGenerate} disabled={generating}>
            {generating ? t('api_key.generating') : t('api_key.generate')}
          </button>
        )}
      </div>

      {/* Step 2 */}
      <div style={{ opacity: hasBindUrl ? 1 : 0.4 }}>
        <div style={{ fontWeight: 600, marginBottom: 10, color: '#e2e8f0', fontSize: 15 }}>
          Step 2: Run this command on your machine
        </div>
        {hasBindUrl && (
          <div style={{ background: '#0f172a', borderRadius: 8, padding: 14 }}>
            <pre style={{ margin: 0, color: '#e2e8f0', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {fullCmd}
            </pre>
            {apiKey && (
              <button
                class="btn btn-secondary"
                style={{ marginTop: 10, fontSize: 11 }}
                onClick={() => handleCopy(fullCmd)}
              >
                {copied ? t('api_key.copied') : t('api_key.copy')}
              </button>
            )}
            <div style={{ marginTop: 12, fontSize: 12, color: '#64748b' }}>
              Installs imcodes and binds this machine to your account.
              Auto-starts on login (macOS/Linux).
              {'\n'}Re-binding on the same machine will replace the previous server connection.
            </div>
          </div>
        )}
        {hasBindUrl && (
          <div style={{ marginTop: 16, fontSize: 13, color: '#64748b' }}>
            Waiting for your device to appear...
          </div>
        )}
      </div>
    </div>
  );
}
