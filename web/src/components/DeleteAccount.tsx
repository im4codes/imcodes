import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../api.js';

interface Props {
  onDeleted: () => void;
}

export function DeleteAccount({ onDeleted }: Props) {
  const { t } = useTranslation();
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await apiFetch('/api/auth/user/me', { method: 'DELETE' });
      // Clear all local storage and redirect to login
      localStorage.clear();
      onDeleted();
    } catch {
      setError(t('account.delete_error'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style={{ marginTop: 32, padding: 16, border: '1px solid #7f1d1d', borderRadius: 8, background: '#1a0000' }}>
      <h3 style={{ marginTop: 0, marginBottom: 8, color: '#f87171' }}>{t('account.delete_title')}</h3>
      <p style={{ fontSize: 14, color: '#94a3b8', marginBottom: 12 }}>{t('account.delete_warning')}</p>

      {error && (
        <div style={{ color: '#f87171', marginBottom: 12, fontSize: 14 }}>{error}</div>
      )}

      {!showConfirm ? (
        <button
          class="btn btn-danger"
          style={{ fontSize: 13 }}
          onClick={() => setShowConfirm(true)}
        >
          {t('account.delete_btn')}
        </button>
      ) : (
        <div>
          <p style={{ fontSize: 13, color: '#e2e8f0', marginBottom: 8 }}>
            {t('account.delete_confirm_prompt')}
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              class="input"
              style={{ flex: 1 }}
              type="text"
              placeholder="DELETE"
              value={confirmText}
              onInput={(e) => setConfirmText((e.target as HTMLInputElement).value)}
            />
            <button
              class="btn btn-danger"
              style={{ fontSize: 13 }}
              disabled={confirmText !== 'DELETE' || deleting}
              onClick={handleDelete}
            >
              {deleting ? t('common.loading') : t('account.delete_confirm')}
            </button>
            <button
              class="btn btn-ghost"
              style={{ fontSize: 13 }}
              onClick={() => { setShowConfirm(false); setConfirmText(''); }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
