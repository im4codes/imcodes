import { useState, useEffect, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { DEFAULT_SERVER_URL, isNative, isValidServerUrl, setServerUrl, getServerList, addServerToList, removeServerFromList } from '../native.js';
import { readFromClipboard } from '../util/clipboard.js';

interface Props {
  onConnect: (serverUrl: string) => void | Promise<void>;
}

export function ServerSetupPage({ onConnect }: Props) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<string[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [inputUrl, setInputUrl] = useState('');
  const [httpWarning, setHttpWarning] = useState(false);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const addPanelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getServerList().then((list) => {
      setServers(list);
    });
  }, []);

  const keepAddPanelVisible = () => {
    addPanelRef.current?.scrollIntoView?.({ block: 'nearest' });
  };

  useEffect(() => {
    if (!adding) return;
    inputRef.current?.focus();
    keepAddPanelVisible();
    const timer = setTimeout(keepAddPanelVisible, 180);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', keepAddPanelVisible);
    return () => {
      clearTimeout(timer);
      vv?.removeEventListener('resize', keepAddPanelVisible);
    };
  }, [adding]);

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
      await onConnect(url);
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
    // Warn if using HTTP on a non-localhost host
    try {
      const parsed = new URL(trimmed);
      setHttpWarning(parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1');
    } catch {
      setHttpWarning(false);
    }
    setError(null);
    setPasteHint(null);
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

  const handlePaste = async () => {
    const result = await readFromClipboard();
    if (result.ok) {
      setInputUrl(result.text);
      setError(null);
      setPasteHint(null);
      inputRef.current?.focus();
      requestAnimationFrame(keepAddPanelVisible);
      return;
    }
    setPasteHint(t(result.reason === 'empty' ? 'serverSetup.pasteEmpty' : 'serverSetup.pasteUnavailable'));
  };

  const cancelAdd = () => {
    setAdding(false);
    setInputUrl('');
    setError(null);
    setPasteHint(null);
  };

  return (
    <div class="login-page">
      <div class="login-card server-setup-card">
        <div class="server-setup-header">
          <h1>IM.codes</h1>
          <p class="server-setup-subtitle">
            {t('serverSetup.title')}
          </p>
        </div>

        {error && (
          <div class="server-setup-banner is-error">
            {error}
          </div>
        )}

        {httpWarning && (
          <div class="server-setup-banner is-warning">
            {t('serverSetup.httpWarning')}
          </div>
        )}

        <div class="server-setup-list">
          {servers.map((url) => {
            const isVerifying = connecting === url;
            const isDimmed = Boolean(connecting && !isVerifying);
            return (
              <div
                key={url}
                class={`server-setup-item${isVerifying ? ' is-verifying' : ''}${isDimmed ? ' is-dimmed' : ''}`}
                onClick={() => !connecting && handleConnect(url)}
              >
                <span class="server-setup-node-dot" aria-hidden="true" />
                <div class="server-setup-item-body">
                  <div class="server-setup-url">{url}</div>
                  {isVerifying && (
                    <div class="server-setup-status">
                      {t('serverSetup.verifying')}
                    </div>
                  )}
                </div>
                {!connecting && url !== DEFAULT_SERVER_URL && (
                  <button
                    type="button"
                    class="server-setup-remove"
                    onClick={(e) => handleRemove(url, e as unknown as MouseEvent)}
                    aria-label="Remove"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {adding ? (
          <div ref={addPanelRef} class="server-setup-add-panel">
            <div class="server-setup-input-row">
              <input
                ref={inputRef}
                class="input server-setup-input"
                type="url"
                placeholder={t('serverSetup.placeholder')}
                value={inputUrl}
                onFocus={keepAddPanelVisible}
                onInput={(e) => {
                  setInputUrl((e.target as HTMLInputElement).value);
                  setError(null);
                  setPasteHint(null);
                }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd();
                  if (e.key === 'Escape') cancelAdd();
                }}
              />
              <button
                type="button"
                class="btn btn-secondary server-setup-paste-btn"
                onClick={handlePaste}
                disabled={!!connecting}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                  <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                </svg>
                <span>{t('serverSetup.paste')}</span>
              </button>
            </div>
            {pasteHint && (
              <div class="server-setup-paste-hint" role="status">
                {pasteHint}
              </div>
            )}
            <div class="server-setup-actions">
              <button
                type="button"
                class="btn btn-primary"
                onClick={handleAdd}
                disabled={!inputUrl.trim() || !!connecting}
              >
                {t('serverSetup.connect')}
              </button>
              <button
                type="button"
                class="btn btn-ghost"
                onClick={cancelAdd}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            class="btn btn-ghost server-setup-add-trigger"
            onClick={() => {
              setAdding(true);
              setError(null);
              setPasteHint(null);
            }}
            disabled={!!connecting}
          >
            {t('serverSetup.addServer')}
          </button>
        )}
      </div>
    </div>
  );
}
