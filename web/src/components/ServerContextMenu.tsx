import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

interface Props {
  x: number;
  y: number;
  onRename: () => void;
  onUpgrade: () => void;
  onUpgradeAll?: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ServerContextMenu({ x, y, onRename, onUpgrade, onUpgradeAll, onDelete, onClose }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Clamp menu to viewport
  const style: Record<string, string | number> = { position: 'fixed', left: x, top: y };
  if (x + 160 > window.innerWidth) style.left = window.innerWidth - 164;
  if (y + 100 > window.innerHeight) style.top = y - 100;

  return (
    <div ref={ref} class="server-ctx-menu" style={style}>
      <button class="server-ctx-item" onClick={() => { onClose(); onRename(); }}>
        {t('session.rename')}
      </button>
      <button class="server-ctx-item" onClick={() => { onClose(); onUpgrade(); }}>
        {t('server.upgrade_daemon')}
      </button>
      {onUpgradeAll && (
        <button class="server-ctx-item" onClick={() => { onClose(); onUpgradeAll(); }}>
          {t('server.upgrade_all')}
        </button>
      )}
      <div class="menu-divider" />
      <button class="server-ctx-item server-ctx-item-danger" onClick={() => { onClose(); onDelete(); }}>
        {t('server.delete')}
      </button>
    </div>
  );
}

interface DeleteConfirmProps {
  serverName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteServerDialog({ serverName, onConfirm, onCancel }: DeleteConfirmProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const match = typed === serverName;

  return (
    <div class="ask-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div class="ask-dialog" style={{ maxWidth: 400 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#f87171' }}>{t('server.delete_title', { name: serverName })}</div>
        <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
          {t('server.delete_warning')}<br />
          <strong style={{ color: '#e2e8f0' }}>{t('server.delete_tmux_note')}</strong>{t('server.delete_tmux_suffix')}
        </div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>
          {t('server.delete_confirm_prompt')} <code style={{ color: '#f87171', background: '#1e293b', padding: '2px 6px', borderRadius: 4 }}>{serverName}</code>
        </div>
        <input
          class="ask-custom-input"
          style={{ width: '100%' }}
          placeholder={serverName}
          value={typed}
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          autoFocus
        />
        <div class="ask-actions">
          <button class="ask-btn-cancel" onClick={onCancel}>{t('common.cancel')}</button>
          <button
            class="ask-btn-submit"
            style={{ background: match ? '#ef4444' : '#7f1d1d', opacity: match ? 1 : 0.5, cursor: match ? 'pointer' : 'not-allowed' }}
            disabled={!match}
            onClick={onConfirm}
          >
            {t('server.delete_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
