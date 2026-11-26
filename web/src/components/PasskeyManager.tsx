import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { startRegistration } from '@simplewebauthn/browser';
import { listPasskeys, deletePasskey, passkeyRegisterBegin, passkeyRegisterComplete } from '../api.js';
import type { PasskeyCredential } from '../api.js';

export function PasskeyManager() {
  const { t } = useTranslation();
  const [credentials, setCredentials] = useState<PasskeyCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await listPasskeys();
      setCredentials(res.credentials);
    } catch {
      // user may not have any passkeys yet
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const handleAdd = async () => {
    setAdding(true);
    setError(null);
    try {
      const beginRes = await passkeyRegisterBegin();
      const { challengeId, ...options } = beginRes;
      const regResponse = await startRegistration(options as never);
      await passkeyRegisterComplete(challengeId, regResponse, deviceName.trim() || undefined);
      setDeviceName('');
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('cancelled') && !msg.includes('NotAllowedError')) {
        setError(t('passkey.add_error'));
      }
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (credId: string) => {
    try {
      await deletePasskey(credId);
      setCredentials((prev) => prev.filter((c) => c.id !== credId));
    } catch {
      setError(t('passkey.delete_error'));
    } finally {
      setConfirmDelete(null);
    }
  };

  const formatDate = (ts: number | null) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString();
  };

  return (
    <section class="dashboard-card passkey-manager">
      <div class="dashboard-card-header">
        <h2 class="dashboard-card-title">{t('passkey.title')}</h2>
      </div>

      {error && (
        <div class="dashboard-error">{error}</div>
      )}

      {loading ? (
        <p class="dashboard-muted" style={{ margin: 0 }}>{t('common.loading')}</p>
      ) : (
        <>
          {credentials.length === 0 ? (
            <p class="dashboard-muted" style={{ marginTop: 0, marginBottom: 14 }}>{t('passkey.none')}</p>
          ) : (
            <div class="passkey-list">
              {credentials.map((cred) => (
                <div key={cred.id} class="passkey-row">
                  <div class="passkey-row-main">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" style={{ flexShrink: 0 }}>
                      <path d="M12 2C9.24 2 7 4.24 7 7c0 2.08 1.26 3.86 3.08 4.63L9 22h6l-1.08-10.37C15.74 10.86 17 9.08 17 7c0-2.76-2.24-5-5-5z"/>
                      <circle cx="12" cy="7" r="2"/>
                    </svg>
                    <div class="passkey-row-text">
                      <div class="passkey-row-name">{cred.deviceName ?? t('passkey.unnamed')}</div>
                      <div class="passkey-row-meta">
                        {t('passkey.added')} {formatDate(cred.createdAt)}
                        {cred.lastUsedAt ? ` · ${t('passkey.last_used')} ${formatDate(cred.lastUsedAt)}` : ''}
                      </div>
                    </div>
                  </div>
                  <div class="passkey-row-actions">
                    {confirmDelete === cred.id ? (
                      <>
                        <button type="button" class="btn btn-danger" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => void handleDelete(cred.id)}>
                          {t('common.confirm')}
                        </button>
                        <button type="button" class="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setConfirmDelete(null)}>
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <button type="button" class="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px', color: '#f87171' }} onClick={() => setConfirmDelete(cred.id)}>
                        {t('common.delete')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div class="dashboard-inline-form">
            <input
              class="input"
              type="text"
              placeholder={t('passkey.device_name_placeholder')}
              value={deviceName}
              onInput={(e) => setDeviceName((e.target as HTMLInputElement).value)}
              maxLength={100}
            />
            <button type="button" class="btn btn-primary" onClick={handleAdd} disabled={adding}>
              {adding ? t('common.loading') : t('passkey.add')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
