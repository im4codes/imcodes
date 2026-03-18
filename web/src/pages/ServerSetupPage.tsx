import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { DEFAULT_SERVER_URL, isNative, isValidServerUrl, setServerUrl, getServerList, addServerToList, removeServerFromList } from '../native.js';

interface Props {
  onConnect: (serverUrl: string) => void;
}

export function ServerSetupPage({ onConnect }: Props) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<string[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [inputUrl, setInputUrl] = useState('');

  useEffect(() => {
    getServerList().then((list) => {
      setServers(list);
      if (list.length === 0) setAdding(true); // show input immediately on first launch
    });
  }, []);

  const handleConnect = async (url: string) => {
    setConnecting(url);
    setError(null);
    try {
      if (isNative()) {
        // Native: use no-cors to bypass CORS restrictions (cross-origin self-hosted servers).
        // Response is opaque but a successful fetch confirms reachability.
        await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000), mode: 'no-cors' });
      } else {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error('not_ok');
      }
      await addServerToList(url);
      await setServerUrl(url);
      onConnect(url);
    } catch {
      setError(t('serverSetup.error'));
    } finally {
      setConnecting(null);
    }
  };

  const handleAdd = async () => {
    const trimmed = inputUrl.trim().replace(/\/$/, '');
    if (!trimmed) return;
    if (!isValidServerUrl(trimmed)) {
      setError(t('serverSetup.errorNotHttps'));
      return;
    }
    setError(null);
    if (!servers.includes(trimmed)) {
      setServers((prev) => [...prev, trimmed]);
    }
    setInputUrl('');
    setAdding(false);
    await handleConnect(trimmed);
  };

  const handleRemove = async (url: string, e: MouseEvent) => {
    e.stopPropagation();
    await removeServerFromList(url);
    setServers((prev) => prev.filter((u) => u !== url));
  };

  return (
    <div class="login-page">
      <div class="login-card" style={{ maxWidth: 380 }}>
        <h1>IM.codes</h1>
        <p style={{ color: '#94a3b8', marginBottom: 24, textAlign: 'center' }}>
          {t('serverSetup.title')}
        </p>

        {error && (
          <div style={{ color: '#f87171', marginBottom: 12, textAlign: 'center', fontSize: 14 }}>
            {error}
          </div>
        )}

        <div style={{ width: '100%', marginBottom: 12 }}>
          {servers.map((url) => (
            <div
              key={url}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                marginBottom: 8,
                background: '#1e293b',
                borderRadius: 8,
                border: '1px solid #334155',
                cursor: connecting ? 'default' : 'pointer',
                opacity: connecting && connecting !== url ? 0.5 : 1,
              }}
              onClick={() => !connecting && handleConnect(url)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: '#e2e8f0', wordBreak: 'break-all' }}>{url}</div>
                {connecting === url && (
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    {t('serverSetup.verifying')}
                  </div>
                )}
              </div>
              {!connecting && url !== DEFAULT_SERVER_URL && (
                <button
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#475569',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    fontSize: 16,
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                  onClick={(e) => handleRemove(url, e as unknown as MouseEvent)}
                  aria-label="Remove"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>

        {adding ? (
          <div style={{ width: '100%', marginBottom: 8 }}>
            <input
              class="input"
              style={{ width: '100%', marginBottom: 8, boxSizing: 'border-box' }}
              type="url"
              placeholder={t('serverSetup.placeholder')}
              value={inputUrl}
              onInput={(e) => { setInputUrl((e.target as HTMLInputElement).value); setError(null); }}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') { setAdding(false); setInputUrl(''); } }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                class="btn btn-primary"
                style={{ flex: 1 }}
                onClick={handleAdd}
                disabled={!inputUrl.trim()}
              >
                {t('serverSetup.connect')}
              </button>
              <button
                class="btn btn-ghost"
                style={{ flex: 1 }}
                onClick={() => { setAdding(false); setInputUrl(''); setError(null); }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            class="btn btn-ghost"
            style={{ width: '100%', fontSize: 14 }}
            onClick={() => setAdding(true)}
            disabled={!!connecting}
          >
            {t('serverSetup.addServer')}
          </button>
        )}
      </div>
    </div>
  );
}
