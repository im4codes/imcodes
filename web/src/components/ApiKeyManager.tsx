import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { apiFetch, getApiBaseUrl } from '../api.js';

export const API_KEYS_PAGE_SIZE = 6;

export type ApiKeyStatusFilter = 'all' | 'active' | 'revoked';

interface KeyInfo {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

interface Props {
  keys: KeyInfo[];
  onKeysChanged: () => void;
  pageSize?: number;
}

interface RevokeTarget {
  id: string;
  label: string | null;
}

function RevokeConfirmDialog({
  target,
  error,
  onConfirm,
  onCancel,
}: {
  target: RevokeTarget;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const displayName = target.label || `key-${target.id.slice(0, 8)}`;
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<1 | 2>(1);

  return (
    <div class="ask-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div class="ask-dialog" style={{ maxWidth: 420 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#f87171' }}>{t('api_key.revoke_dialog_title')}</div>
        {error && <div class="dashboard-error" style={{ marginBottom: 0 }}>{error}</div>}
        {step === 1 ? (
          <>
            <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
              {t('api_key.revoke_dialog_about')}{' '}
              <code style={{ color: '#f87171', background: '#0f172a', padding: '2px 6px', borderRadius: 4 }}>{displayName}</code>.<br /><br />
              <strong style={{ color: '#e2e8f0' }}>{t('api_key.revoke_dialog_warning_strong')}</strong><br />
              {t('api_key.revoke_dialog_warning_daemons')}
            </div>
            <div class="ask-actions">
              <button type="button" class="ask-btn-cancel" onClick={onCancel}>{t('common.cancel')}</button>
              <button
                type="button"
                class="ask-btn-submit"
                style={{ background: '#dc2626' }}
                onClick={() => setStep(2)}
              >
                {t('api_key.revoke_dialog_continue')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>
              {t('api_key.revoke_dialog_confirm_prompt')}{' '}
              <code style={{ color: '#f87171', background: '#0f172a', padding: '2px 6px', borderRadius: 4 }}>{displayName}</code>
            </div>
            <input
              class="ask-custom-input"
              style={{ width: '100%' }}
              placeholder={displayName}
              value={typed}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
              autoFocus
            />
            <div class="ask-actions">
              <button type="button" class="ask-btn-cancel" onClick={onCancel}>{t('common.cancel')}</button>
              <button
                type="button"
                class="ask-btn-submit"
                style={{
                  background: typed === displayName ? '#ef4444' : '#7f1d1d',
                  opacity: typed === displayName ? 1 : 0.5,
                  cursor: typed === displayName ? 'pointer' : 'not-allowed',
                }}
                disabled={typed !== displayName}
                onClick={onConfirm}
              >
                {t('api_key.revoke_dialog_confirm_btn')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ApiKeyManager({ keys, onKeysChanged, pageSize = API_KEYS_PAGE_SIZE }: Props) {
  const { t } = useTranslation();
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<'key' | 'bind_url' | 'bind_command' | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ApiKeyStatusFilter>('all');
  const [page, setPage] = useState(1);

  const effectivePageSize = Math.max(1, pageSize);
  const activeCount = keys.filter((k) => !k.revokedAt).length;
  const revokedCount = keys.length - activeCount;
  const filteredKeys = keys.filter((k) => {
    if (statusFilter === 'active') return !k.revokedAt;
    if (statusFilter === 'revoked') return Boolean(k.revokedAt);
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filteredKeys.length / effectivePageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * effectivePageSize;
  const pageItems = filteredKeys.slice(startIndex, startIndex + effectivePageSize);

  useEffect(() => {
    setPage((prev) => {
      const clamped = Math.min(Math.max(1, prev), totalPages);
      return clamped === prev ? prev : clamped;
    });
  }, [totalPages]);

  const bindUrl = newKey ? `${getApiBaseUrl()}/bind/${newKey}` : '';
  const bindCommand = bindUrl ? `imcodes bind ${bindUrl}` : '';

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    setCopiedTarget(null);
    try {
      const body = newLabel.trim() ? { label: newLabel.trim() } : {};
      const res = await apiFetch<{ id: string; apiKey: string }>('/api/auth/user/me/keys', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setNewKey(res.apiKey);
      setNewLabel('');
      setStatusFilter((prev) => (prev === 'revoked' ? 'all' : prev));
      setPage(1);
      onKeysChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to generate key:', err);
      setGenError(msg);
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeError(null);
    try {
      await apiFetch(`/api/auth/user/me/keys/${revokeTarget.id}`, { method: 'DELETE' });
      setRevokeTarget(null);
      onKeysChanged();
    } catch (err) {
      console.error('Failed to revoke key:', err);
      setRevokeError(t('api_key.revoke_error'));
    }
  };

  const handleCopy = (target: 'key' | 'bind_url' | 'bind_command', text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedTarget(target);
    setTimeout(() => setCopiedTarget((prev) => (prev === target ? null : prev)), 2000);
  };

  const handleFilterChange = (nextFilter: ApiKeyStatusFilter) => {
    setStatusFilter(nextFilter);
    setPage(1);
  };

  const filterOptions: { id: ApiKeyStatusFilter; label: string; count: number }[] = [
    { id: 'all', label: t('api_key.filter_all'), count: keys.length },
    { id: 'active', label: t('api_key.filter_active'), count: activeCount },
    { id: 'revoked', label: t('api_key.filter_revoked'), count: revokedCount },
  ];

  return (
    <>
      {revokeTarget && (
        <RevokeConfirmDialog
          target={revokeTarget}
          error={revokeError}
          onConfirm={handleRevoke}
          onCancel={() => { setRevokeTarget(null); setRevokeError(null); }}
        />
      )}
      <section class="dashboard-card">
        <div class="dashboard-card-header">
          <div>
            <h2 class="dashboard-card-title">{t('api_key.title')}</h2>
            <p class="dashboard-card-subtitle">{t('api_key.subtitle')}</p>
          </div>
        </div>

        {newKey && (
          <div class="api-key-banner">
            <div class="api-key-banner-title">{t('api_key.save_once')}</div>
            <div class="api-key-banner-grid">
              <div>
                <div class="api-key-banner-label">{t('api_key.raw_key')}</div>
                <div class="api-key-banner-row">
                  <code class="api-key-banner-code">{newKey}</code>
                  <button type="button" class="btn btn-secondary" style={{ whiteSpace: 'nowrap' }} onClick={() => handleCopy('key', newKey)}>
                    {copiedTarget === 'key' ? t('api_key.copied') : t('api_key.copy')}
                  </button>
                </div>
              </div>
              <div>
                <div class="api-key-banner-label">{t('api_key.bind_url')}</div>
                <div class="api-key-banner-row">
                  <code class="api-key-banner-code">{bindUrl}</code>
                  <button type="button" class="btn btn-secondary" style={{ whiteSpace: 'nowrap' }} onClick={() => handleCopy('bind_url', bindUrl)}>
                    {copiedTarget === 'bind_url' ? t('api_key.copied') : t('api_key.copy')}
                  </button>
                </div>
              </div>
              <div>
                <div class="api-key-banner-label">{t('api_key.bind_command')}</div>
                <div class="api-key-banner-row">
                  <code class="api-key-banner-code">{bindCommand}</code>
                  <button type="button" class="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => handleCopy('bind_command', bindCommand)}>
                    {copiedTarget === 'bind_command' ? t('api_key.copied') : t('api_key.copy_bind_command')}
                  </button>
                </div>
              </div>
            </div>
            <button type="button" class="btn btn-secondary" style={{ marginTop: 10, fontSize: 12 }} onClick={() => setNewKey(null)}>
              {t('api_key.dismiss')}
            </button>
          </div>
        )}

        {genError && (
          <div class="dashboard-error">[Error] {genError}</div>
        )}

        <div class="dashboard-inline-form">
          <input
            class="input"
            type="text"
            placeholder={t('api_key.label_placeholder')}
            value={newLabel}
            onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
          />
          <button type="button" class="btn btn-primary" onClick={handleGenerate} disabled={generating}>
            {generating ? t('api_key.generating') : t('api_key.generate')}
          </button>
        </div>

        {keys.length === 0 ? (
          <div class="dashboard-empty" style={{ marginTop: 16 }}>{t('api_key.empty')}</div>
        ) : (
          <>
            <div class="api-key-toolbar">
              <div class="api-key-filters" role="group" aria-label={t('api_key.col_status')}>
                {filterOptions.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    class={`api-key-filter-btn${statusFilter === opt.id ? ' is-active' : ''}`}
                    aria-pressed={statusFilter === opt.id}
                    onClick={() => handleFilterChange(opt.id)}
                  >
                    <span>{opt.label}</span>
                    <span class="api-key-filter-count">{opt.count}</span>
                  </button>
                ))}
              </div>
              {filteredKeys.length > 0 && (
                <span class="api-key-range">
                  {t('api_key.pagination_range', {
                    start: startIndex + 1,
                    end: startIndex + pageItems.length,
                    total: filteredKeys.length,
                  })}
                </span>
              )}
            </div>

            {filteredKeys.length === 0 ? (
              <div class="dashboard-empty">{t('api_key.empty_filtered')}</div>
            ) : (
              <>
                <table class="api-key-table">
                  <thead>
                    <tr>
                      <th>{t('api_key.col_label')}</th>
                      <th>{t('api_key.col_created')}</th>
                      <th>{t('api_key.col_status')}</th>
                      <th class="is-actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((k) => (
                      <tr key={k.id} class="api-key-row">
                        <td class="api-key-cell-label">{k.label || t('api_key.no_label')}</td>
                        <td class="api-key-cell-created">{new Date(k.createdAt).toLocaleDateString()}</td>
                        <td class="api-key-cell-status">
                          <span class={`api-key-status ${k.revokedAt ? 'is-revoked' : 'is-active'}`}>
                            {k.revokedAt ? t('api_key.status_revoked') : t('api_key.status_active')}
                          </span>
                        </td>
                        <td class="api-key-cell-actions">
                          {!k.revokedAt && (
                            <button
                              type="button"
                              class="btn btn-secondary"
                              style={{ fontSize: 11, color: '#f87171', borderColor: 'rgba(248, 113, 113, 0.32)' }}
                              onClick={() => { setRevokeError(null); setRevokeTarget({ id: k.id, label: k.label }); }}
                            >
                              {t('api_key.revoke')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {totalPages > 1 && (
                  <div class="api-key-pagination">
                    <span class="api-key-page-info">
                      {t('api_key.pagination_page', { page: safePage, totalPages })}
                    </span>
                    <div class="api-key-page-controls">
                      <button
                        type="button"
                        class="btn btn-secondary"
                        disabled={safePage <= 1}
                        onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                      >
                        {t('api_key.prev_page')}
                      </button>
                      <button
                        type="button"
                        class="btn btn-secondary"
                        disabled={safePage >= totalPages}
                        onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                      >
                        {t('api_key.next_page')}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
