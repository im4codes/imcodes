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
    <div class="passkey-manager">
      <h3 style={{ marginBottom: 12 }}>{t('passkey.title')}</h3>

      {error && (
        <div style={{ color: '#f87171', marginBottom: 12, fontSize: 14 }}>{error}</div>
      )}

      {loading ? (
        <p style={{ color: '#64748b', fontSize: 14 }}>{t('common.loading')}</p>
      ) : (
        <>
          {credentials.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 14, marginBottom: 12 }}>{t('passkey.none')}</p>
          ) : (
            <div style={{ marginBottom: 12 }}>
              {credentials.map((cred) => (
                <div key={cred.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #1e293b' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" style={{ flexShrink: 0 }}>
                    <path d="M12 2C9.24 2 7 4.24 7 7c0 2.08 1.26 3.86 3.08 4.63L9 22h6l-1.08-10.37C15.74 10.86 17 9.08 17 7c0-2.76-2.24-5-5-5z"/>
                    <circle cx="12" cy="7" r="2"/>
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: '#e2e8f0' }}>{cred.deviceName ?? t('passkey.unnamed')}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {t('passkey.added')} {formatDate(cred.createdAt)}
                      {cred.lastUsedAt ? ` · ${t('passkey.last_used')} ${formatDate(cred.lastUsedAt)}` : ''}
                    </div>
                  </div>
                  {confirmDelete === cred.id ? (
                    <>
                      <button class="btn btn-danger" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => void handleDelete(cred.id)}>
                        {t('common.confirm')}
                      </button>
                      <button class="btn btn-ghost" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => setConfirmDelete(null)}>
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <button class="btn btn-ghost" style={{ fontSize: 12, padding: '4px 8px', color: '#f87171' }} onClick={() => setConfirmDelete(cred.id)}>
                      {t('common.delete')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              class="input"
              style={{ flex: 1 }}
              type="text"
              placeholder={t('passkey.device_name_placeholder')}
              value={deviceName}
              onInput={(e) => setDeviceName((e.target as HTMLInputElement).value)}
              maxLength={100}
            />
            <button class="btn btn-primary" onClick={handleAdd} disabled={adding}>
              {adding ? t('common.loading') : t('passkey.add')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
