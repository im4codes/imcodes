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

export function AdminPage({ onBack }: Props) {
  const { t } = useTranslation();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<AdminSettings>({});
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<{ type: 'disable' | 'delete'; user: AdminUser } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    } catch { setError(t('admin.action_error')); }
  };

  const handleDisable = async (user: AdminUser) => {
    try {
      await disableUser(user.id);
      setUsers((prev) => prev.map((u) => u.id === user.id ? { ...u, status: 'disabled' } : u));
    } catch { setError(t('admin.action_error')); }
    setConfirmAction(null);
  };

  const handleDelete = async (user: AdminUser) => {
    try {
      await deleteAdminUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch { setError(t('admin.action_error')); }
    setConfirmAction(null);
  };

  const handleToggleSetting = async (key: string, currentValue: string) => {
    const newValue = currentValue === 'true' ? 'false' : 'true';
    const updated = { ...settings, [key]: newValue };
    setSettings(updated);
    try {
      await updateAdminSettings({ [key]: newValue });
    } catch {
      setSettings(settings); // revert
      setError(t('admin.action_error'));
    }
  };

  const registrationEnabled = settings['registration_enabled'] === 'true';
  const requireApproval = settings['require_approval'] === 'true';

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
    <div style={{ background: '#0a0e1a', color: '#e2e8f0', minHeight: '100%', padding: '20px', overflowY: 'auto' }}>
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
                {t('admin.users')} ({users.length})
              </h2>

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
                    {users.map((user) => (
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
                  </tbody>
                </table>
              </div>
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
