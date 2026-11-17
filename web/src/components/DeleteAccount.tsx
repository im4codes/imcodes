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
    <section class="dashboard-card dashboard-card-danger">
      <div class="dashboard-card-header" style={{ marginBottom: 8 }}>
        <h2 class="dashboard-card-title">{t('account.delete_title')}</h2>
      </div>
      <p class="dashboard-muted" style={{ marginTop: 0, marginBottom: 14 }}>{t('account.delete_warning')}</p>

      {error && (
        <div class="dashboard-error">{error}</div>
      )}

      {!showConfirm ? (
        <button
          type="button"
          class="btn btn-danger"
          style={{ fontSize: 13 }}
          onClick={() => setShowConfirm(true)}
        >
          {t('account.delete_btn')}
        </button>
      ) : (
        <div>
          <p style={{ fontSize: 13, color: '#e2e8f0', marginTop: 0, marginBottom: 10 }}>
            {t('account.delete_confirm_prompt')}
          </p>
          <div class="dashboard-inline-form">
            <input
              class="input"
              type="text"
              placeholder="DELETE"
              value={confirmText}
              onInput={(e) => setConfirmText((e.target as HTMLInputElement).value)}
            />
            <div class="dashboard-inline-form-actions">
              <button
                type="button"
                class="btn btn-danger"
                style={{ fontSize: 13 }}
                disabled={confirmText !== 'DELETE' || deleting}
                onClick={handleDelete}
              >
                {deleting ? t('common.loading') : t('account.delete_confirm')}
              </button>
              <button
                type="button"
                class="btn btn-ghost"
                style={{ fontSize: 13 }}
                onClick={() => { setShowConfirm(false); setConfirmText(''); }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
