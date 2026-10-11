import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  LINUX_DESKTOP_MANUAL_INSTALL_COMMANDS,
  REMOTE_DESKTOP_LINUX_SUDO_REQUIRED_CAPABILITY,
} from '@shared/remote-desktop-install.js';
import { copyToClipboard } from '../util/clipboard.js';
import type { MachineListItem } from '../api/machines.js';

export interface LinuxDesktopManualInstallDialogProps {
  machine: MachineListItem;
  onClose: () => void;
}

export function LinuxDesktopManualInstallDialog({ machine, onClose }: LinuxDesktopManualInstallDialogProps) {
  const { t } = useTranslation();
  const [distro, setDistro] = useState<'ubuntu' | 'centos'>('ubuntu');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const command = LINUX_DESKTOP_MANUAL_INSTALL_COMMANDS[distro];
  const sudoRequired = Boolean(machine.capabilities?.includes(REMOTE_DESKTOP_LINUX_SUDO_REQUIRED_CAPABILITY));

  const handleCopy = () => {
    copyToClipboard(command, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      class="ask-dialog-overlay"
      data-testid="linux-desktop-manual-install-dialog"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="ask-dialog" style={{ maxWidth: '640px', width: '90%' }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '18px', fontWeight: 600, color: 'var(--text-primary, #e2e8f0)' }}>
          {t('remote_desktop.linux_manual_install_title')}
        </h3>

        <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--text-secondary, #94a3b8)', lineHeight: 1.5 }}>
          {sudoRequired
            ? t('remote_desktop.linux_manual_install_sudo_notice')
            : t('remote_desktop.linux_manual_install_desc')}
        </p>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <button
            type="button"
            class={`tab-btn ${distro === 'ubuntu' ? 'is-active' : ''}`}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
              background: distro === 'ubuntu' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.05)',
              color: distro === 'ubuntu' ? '#38bdf8' : 'inherit',
              cursor: 'pointer',
              fontWeight: 500,
            }}
            onClick={() => setDistro('ubuntu')}
          >
            {t('remote_desktop.linux_manual_install_tab_ubuntu')}
          </button>
          <button
            type="button"
            class={`tab-btn ${distro === 'centos' ? 'is-active' : ''}`}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
              background: distro === 'centos' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.05)',
              color: distro === 'centos' ? '#38bdf8' : 'inherit',
              cursor: 'pointer',
              fontWeight: 500,
            }}
            onClick={() => setDistro('centos')}
          >
            {t('remote_desktop.linux_manual_install_tab_centos')}
          </button>
        </div>

        <div style={{
          position: 'relative',
          background: 'rgba(0, 0, 0, 0.4)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: '8px',
          padding: '12px 14px',
          marginBottom: '16px',
        }}>
          <pre style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontFamily: 'monospace',
            fontSize: '13px',
            color: '#e2e8f0',
            lineHeight: 1.4,
          }}>
            {command}
          </pre>
        </div>

        <div class="ask-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted, #64748b)' }}>
            {t('remote_desktop.linux_manual_install_done_hint')}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              class="ask-btn-cancel"
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              class="ask-btn-submit"
              onClick={handleCopy}
            >
              {copied ? t('remote_desktop.linux_manual_install_copied') : t('remote_desktop.linux_manual_install_copy')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
