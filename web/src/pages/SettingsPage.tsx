import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { passwordChange, updateDisplayName } from '../api.js';

interface Props {
  displayName: string | null;
  onBack: () => void;
  onDisplayNameChanged: (name: string) => void;
}

export function SettingsPage({ displayName, onBack, onDisplayNameChanged }: Props) {
  const { t } = useTranslation();

  // Display name editing
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(displayName ?? '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Password change
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const handleSaveName = async () => {
    if (!nameValue.trim()) return;
    setNameSaving(true);
    setNameMsg(null);
    try {
      await updateDisplayName(nameValue.trim());
      onDisplayNameChanged(nameValue.trim());
      setEditingName(false);
      setNameMsg({ type: 'ok', text: t('settings.name_saved') });
    } catch {
      setNameMsg({ type: 'err', text: t('settings.name_error') });
    } finally {
      setNameSaving(false);
    }
  };

  const handleChangePw = async () => {
    setPwMsg(null);
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'err', text: t('settings.passwords_mismatch') });
      return;
    }
    if (newPw.length < 8) {
      setPwMsg({ type: 'err', text: t('settings.password_too_short') });
      return;
    }
    setPwSaving(true);
    try {
      await passwordChange(oldPw, newPw);
      setPwMsg({ type: 'ok', text: t('settings.password_changed') });
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
    } catch {
      setPwMsg({ type: 'err', text: t('settings.password_error') });
    } finally {
      setPwSaving(false);
    }
  };

  const cardStyle: Record<string, string> = {
    background: '#1e293b',
    borderRadius: '12px',
    padding: '20px',
    marginBottom: '16px',
  };

  const inputStyle: Record<string, string> = {
    width: '100%',
    padding: '10px 12px',
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '8px',
    color: '#e2e8f0',
    fontSize: '14px',
    marginBottom: '10px',
    boxSizing: 'border-box',
  };

  const btnPrimary: Record<string, string> = {
    padding: '10px 20px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '600',
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

  return (
    <div style={{ background: '#0a0e1a', color: '#e2e8f0', minHeight: '100%', padding: '20px', overflowY: 'auto' }}>
      <div style={{ maxWidth: '520px', margin: '0 auto' }}>
        <button onClick={onBack} style={{ ...btnSecondary, marginBottom: '20px' }}>
          {t('settings.back')}
        </button>
        <h1 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '24px' }}>{t('settings.title')}</h1>

        {/* Display Name */}
        <div style={cardStyle}>
          <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: '#94a3b8' }}>
            {t('settings.display_name')}
          </h2>
          {!editingName ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '16px' }}>{displayName || t('settings.no_name')}</span>
              <button onClick={() => { setEditingName(true); setNameValue(displayName ?? ''); setNameMsg(null); }} style={btnSecondary}>
                {t('settings.edit')}
              </button>
            </div>
          ) : (
            <div>
              <input
                type="text"
                value={nameValue}
                onInput={(e) => setNameValue((e.target as HTMLInputElement).value)}
                style={inputStyle}
                placeholder={t('settings.name_placeholder')}
              />
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleSaveName} disabled={nameSaving} style={btnPrimary}>
                  {nameSaving ? t('common.loading') : t('settings.save')}
                </button>
                <button onClick={() => { setEditingName(false); setNameMsg(null); }} style={btnSecondary}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
          {nameMsg && (
            <div style={{ marginTop: '8px', fontSize: '13px', color: nameMsg.type === 'ok' ? '#4ade80' : '#f87171' }}>
              {nameMsg.text}
            </div>
          )}
        </div>

        {/* Change Password */}
        <div style={cardStyle}>
          <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: '#94a3b8' }}>
            {t('settings.change_password')}
          </h2>
          <input
            type="password"
            placeholder={t('settings.old_password')}
            value={oldPw}
            onInput={(e) => setOldPw((e.target as HTMLInputElement).value)}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder={t('settings.new_password')}
            value={newPw}
            onInput={(e) => setNewPw((e.target as HTMLInputElement).value)}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder={t('settings.confirm_password')}
            value={confirmPw}
            onInput={(e) => setConfirmPw((e.target as HTMLInputElement).value)}
            style={inputStyle}
          />
          <button
            onClick={handleChangePw}
            disabled={pwSaving || !oldPw || !newPw || !confirmPw}
            style={{ ...btnPrimary, opacity: (!oldPw || !newPw || !confirmPw) ? '0.5' : '1' }}
          >
            {pwSaving ? t('common.loading') : t('settings.change_password_btn')}
          </button>
          {pwMsg && (
            <div style={{ marginTop: '8px', fontSize: '13px', color: pwMsg.type === 'ok' ? '#4ade80' : '#f87171' }}>
              {pwMsg.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
