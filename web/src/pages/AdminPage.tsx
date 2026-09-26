import { useState, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  fetchAdminUsers,
  approveUser,
  disableUser,
  deleteAdminUser,
  fetchAdminSettings,
  updateAdminSettings,
  type AdminUser,
  type AdminSettings,
} from '../api.js';

interface Props {
  onBack: () => void;
}

type UserStatusFilter = 'all' | 'pending' | 'active' | 'disabled';
const USERS_PER_PAGE = 20;

export function AdminPage({ onBack }: Props) {
  const { t } = useTranslation();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<AdminSettings>({});
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<{ type: 'disable' | 'delete'; user: AdminUser } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>('all');
  const [usernameQuery, setUsernameQuery] = useState('');
  const [requestedPage, setRequestedPage] = useState(1);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, s] = await Promise.all([fetchAdminUsers(), fetchAdminSettings()]);
      setUsers(u);
      setSettings(s);
    } catch {
      setError(t('admin.load_error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadData(); }, [loadData]);

  const handleApprove = async (user: AdminUser) => {
    try {
      await approveUser(user.id);
      setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, status: 'active' } : u));
    } catch (err) { setError(`${t('admin.action_error')}: ${err instanceof Error ? err.message : String(err)}`); }
  };

  const handleDisable = async (user: AdminUser) => {
    try {
      await disableUser(user.id);
      setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, status: 'disabled' } : u));
    } catch (err) { setError(`${t('admin.action_error')}: ${err instanceof Error ? err.message : String(err)}`); }
    setConfirmAction(null);
  };

  const handleDelete = async (user: AdminUser) => {
    try {
      await deleteAdminUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err) { setError(`${t('admin.action_error')}: ${err instanceof Error ? err.message : String(err)}`); }
    setConfirmAction(null);
  };

  const handleToggleSetting = async (key: string, currentValue: string) => {
    const newValue = currentValue === 'true' ? 'false' : 'true';
    const prev = { ...settings };
    setSettings({ ...settings, [key]: newValue });
    try {
      await updateAdminSettings({ [key]: newValue });
    } catch (err) {
      setSettings(prev); // revert
      const msg = err instanceof Error ? err.message : String(err);
      setError(`${t('admin.action_error')}: ${msg}`);
    }
  };

  const registrationEnabled = settings['registration_enabled'] === 'true';
  const requireApproval = settings['require_approval'] === 'true';
  const normalizedUsernameQuery = usernameQuery.trim().toLocaleLowerCase();
  const filteredUsers = users.filter((user) => (
    (statusFilter === 'all' || user.status === statusFilter)
    && (!normalizedUsernameQuery || (user.username ?? '').toLocaleLowerCase().includes(normalizedUsernameQuery))
  ));
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / USERS_PER_PAGE));
  const currentPage = Math.min(requestedPage, totalPages);
  const visibleUsers = filteredUsers.slice((currentPage - 1) * USERS_PER_PAGE, currentPage * USERS_PER_PAGE);
  const statusCounts: Record<UserStatusFilter, number> = {
    all: users.length,
    pending: users.filter((user) => user.status === 'pending').length,
    active: users.filter((user) => user.status === 'active').length,
    disabled: users.filter((user) => user.status === 'disabled').length,
  };

  const cardStyle: Record<string, string> = {
    background: '#1e293b',
    borderRadius: '12px',
    padding: '20px',
    marginBottom: '16px',
  };

  const btnSecondary: Record<string, string> = {
    padding: '8px 16px',
    background: '#334155',
    color: '#e2e8f0',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
  };

  const btnSmall = (color: string): Record<string, string> => ({
    padding: '4px 12px',
    background: color,
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: '600',
  });

  const statusBadge = (status: string): Record<string, string> => {
    const colors: Record<string, string> = { active: '#4ade80', pending: '#fbbf24', disabled: '#f87171' };
    return {
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '9999px',
      fontSize: '11px',
      fontWeight: '600',
      background: (colors[status] ?? '#64748b') + '22',
      color: colors[status] ?? '#64748b',
    };
  };

  return (
    <div
      data-testid="admin-page-scroll"
      style={{
        background: '#0a0e1a', color: '#e2e8f0', flex: '1 1 auto', width: '100%', height: '100%', minHeight: 0,
        boxSizing: 'border-box', padding: '20px', overflowY: 'auto', overscrollBehaviorY: 'contain',
        touchAction: 'pan-y', WebkitOverflowScrolling: 'touch',
      }}
    >
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>
        <button onClick={onBack} style={{ ...btnSecondary, marginBottom: '20px' }}>
          {t('admin.back')}
        </button>
        <h1 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>{t('admin.title')}</h1>

        {error && (
          <div style={{ padding: '10px 16px', background: '#f8717122', color: '#f87171', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>{t('common.loading')}</div>
        ) : (
          <>
            {/* Settings */}
            <div style={cardStyle}>
              <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px', color: '#94a3b8' }}>
                {t('admin.settings')}
              </h2>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: '500' }}>{t('admin.registration_enabled')}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>{t('admin.registration_enabled_desc')}</div>
                </div>
                <ToggleSwitch
                  checked={registrationEnabled}
                  onChange={() => handleToggleSetting('registration_enabled', settings['registration_enabled'] ?? 'false')}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ opacity: registrationEnabled ? 1 : 0.5 }}>
                  <div style={{ fontSize: '14px', fontWeight: '500' }}>{t('admin.require_approval')}</div>
                  <div style={{ fontSize: '12px', color: '#64748b' }}>
                    {registrationEnabled ? t('admin.require_approval_desc') : t('admin.require_approval_disabled')}
                  </div>
                </div>
                <ToggleSwitch
                  checked={requireApproval}
                  disabled={!registrationEnabled}
                  onChange={() => handleToggleSetting('require_approval', settings['require_approval'] ?? 'false')}
                />
              </div>
            </div>

            {/* User List */}
            <div style={cardStyle}>
              <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px', color: '#94a3b8' }}>
                {t('admin.users')} ({filteredUsers.length}/{users.length})
              </h2>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '14px' }}>
                <input
                  type="search"
                  value={usernameQuery}
                  onInput={(event) => {
                    setUsernameQuery(event.currentTarget.value);
                    setRequestedPage(1);
                  }}
                  placeholder={t('admin.search_placeholder')}
                  aria-label={t('admin.search_placeholder')}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: '8px',
                    border: '1px solid #475569', background: '#0f172a', color: '#e2e8f0', fontSize: '13px',
                    outline: 'none',
                  }}
                />
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {(['all', 'pending', 'active', 'disabled'] as const).map((filter) => {
                    const selected = statusFilter === filter;
                    return (
                      <button
                        key={filter}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setStatusFilter(filter);
                          setRequestedPage(1);
                        }}
                        style={{
                          padding: '6px 10px', borderRadius: '9999px', cursor: 'pointer', fontSize: '12px',
                          border: selected ? '1px solid #60a5fa' : '1px solid #475569',
                          background: selected ? '#3b82f633' : '#0f172a',
                          color: selected ? '#93c5fd' : '#94a3b8',
                        }}
                      >
                        {t(`admin.filter_${filter}`)} ({statusCounts[filter]})
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #334155', textAlign: 'left' }}>
                      <th style={{ padding: '8px 8px', color: '#94a3b8', fontWeight: '500' }}>{t('admin.col_username')}</th>
                      <th style={{ padding: '8px 8px', color: '#94a3b8', fontWeight: '500' }}>{t('admin.col_display_name')}</th>
                      <th style={{ padding: '8px 8px', color: '#94a3b8', fontWeight: '500' }}>{t('admin.col_status')}</th>
                      <th style={{ padding: '8px 8px', color: '#94a3b8', fontWeight: '500' }}>{t('admin.col_role')}</th>
                      <th style={{ padding: '8px 8px', color: '#94a3b8', fontWeight: '500' }}>{t('admin.col_created')}</th>
                      <th style={{ padding: '8px 8px', color: '#94a3b8', fontWeight: '500' }}>{t('admin.col_actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUsers.map((user) => (
                      <tr key={user.id} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '10px 8px' }}>{user.username ?? '-'}</td>
                        <td style={{ padding: '10px 8px', color: '#94a3b8' }}>{user.displayName ?? '-'}</td>
                        <td style={{ padding: '10px 8px' }}>
                          <span style={statusBadge(user.status)}>{t(`admin.status_${user.status}`)}</span>
                        </td>
                        <td style={{ padding: '10px 8px' }}>
                          {user.isAdmin && (
                            <span style={{ ...statusBadge('active'), background: '#3b82f622', color: '#60a5fa' }}>
                              Admin
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '10px 8px', color: '#64748b', fontSize: '12px' }}>
                          {new Date(user.createdAt).toLocaleDateString()}
                        </td>
                        <td style={{ padding: '10px 8px' }}>
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            {user.status === 'pending' && (
                              <button style={btnSmall('#22c55e')} onClick={() => handleApprove(user)}>
                                {t('admin.approve')}
                              </button>
                            )}
                            {user.status !== 'disabled' && (
                              <button style={btnSmall('#f59e0b')} onClick={() => setConfirmAction({ type: 'disable', user })}>
                                {t('admin.disable')}
                              </button>
                            )}
                            {user.username !== 'admin' && (
                              <button style={btnSmall('#ef4444')} onClick={() => setConfirmAction({ type: 'delete', user })}>
                                {t('common.delete')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredUsers.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ padding: '24px 8px', textAlign: 'center', color: '#64748b' }}>
                          {t('admin.no_users_found')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {filteredUsers.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginTop: '14px' }}>
                  <button
                    type="button"
                    disabled={currentPage === 1}
                    onClick={() => setRequestedPage((page) => Math.max(1, page - 1))}
                    style={{ ...btnSecondary, padding: '6px 10px', opacity: currentPage === 1 ? 0.45 : 1 }}
                  >
                    {t('admin.previous_page')}
                  </button>
                  <span style={{ color: '#94a3b8', fontSize: '12px', minWidth: '88px', textAlign: 'center' }}>
                    {t('admin.page_info', { current: currentPage, total: totalPages })}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage === totalPages}
                    onClick={() => setRequestedPage((page) => Math.min(totalPages, page + 1))}
                    style={{ ...btnSecondary, padding: '6px 10px', opacity: currentPage === totalPages ? 0.45 : 1 }}
                  >
                    {t('admin.next_page')}
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Confirmation dialog */}
        {confirmAction && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}>
            <div style={{ background: '#1e293b', borderRadius: '12px', padding: '24px', maxWidth: '400px', width: '90%' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px' }}>
                {confirmAction.type === 'delete' ? t('admin.confirm_delete_title') : t('admin.confirm_disable_title')}
              </h3>
              <p style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '20px' }}>
                {confirmAction.type === 'delete'
                  ? t('admin.confirm_delete_msg', { name: confirmAction.user.username ?? confirmAction.user.id })
                  : t('admin.confirm_disable_msg', { name: confirmAction.user.username ?? confirmAction.user.id })}
              </p>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button style={btnSecondary} onClick={() => setConfirmAction(null)}>
                  {t('common.cancel')}
                </button>
                <button
                  style={btnSmall(confirmAction.type === 'delete' ? '#ef4444' : '#f59e0b')}
                  onClick={() => {
                    if (confirmAction.type === 'delete') void handleDelete(confirmAction.user);
                    else void handleDisable(confirmAction.user);
                  }}
                >
                  {t('common.confirm')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Toggle switch component
function ToggleSwitch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      onClick={disabled ? undefined : onChange}
      style={{
        width: '44px',
        height: '24px',
        borderRadius: '12px',
        border: 'none',
        background: checked ? '#3b82f6' : '#475569',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'background 0.2s',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '2px',
          left: checked ? '22px' : '2px',
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.2s',
        }}
      />
    </button>
  );
}
