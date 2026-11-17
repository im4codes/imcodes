import { useTranslation } from 'react-i18next';
import { isNative } from '../native.js';

export type MobileServerMenuTab = 'servers' | 'remote';

export interface MobileServerMenuToolbarProps {
  onHome: () => void;
  onChangeServer: () => void;
  onOpenControlledNodes: () => void;
  activeTab?: MobileServerMenuTab;
  onTabChange?: (tab: MobileServerMenuTab) => void;
  /** Optional override for testing native vs web gating; defaults to production isNative() */
  isNativeApp?: boolean;
}

export function MobileServerMenuToolbar({
  onHome,
  onChangeServer,
  onOpenControlledNodes,
  activeTab = 'servers',
  onTabChange,
  isNativeApp,
}: MobileServerMenuToolbarProps) {
  const { t } = useTranslation();
  const nativeActive = typeof isNativeApp === 'boolean' ? isNativeApp : isNative();
  const serversTabLabel = t('mobile_menu.tab_servers', { defaultValue: 'Servers' });
  const remoteTabLabel = t('mobile_menu.tab_remote', { defaultValue: 'Remote' });

  return (
    <>
      <div class="mobile-server-menu-top-row">
        <button
          type="button"
          class="mobile-server-menu-item mobile-server-menu-home"
          onClick={onHome}
        >
          {t('mobile_menu.home', { defaultValue: '← Home' })}
        </button>
        {nativeActive && (
          <button
            type="button"
            class="mobile-server-menu-item mobile-server-menu-change"
            onClick={onChangeServer}
            title={t('mobile_menu.change_server', { defaultValue: '⇄ Switch Cloud Server' })}
          >
            {t('mobile_menu.change_server', { defaultValue: '⇄ Switch Cloud Server' })}
          </button>
        )}
      </div>
      <div class="mobile-server-menu-desk-row">
        <button
          type="button"
          class="mobile-server-menu-item mobile-server-menu-controlled-nodes"
          onClick={onOpenControlledNodes}
        >
          <span aria-hidden="true">🖥</span>
          <span>{t('controlled_nodes.title', { defaultValue: 'AI Desk' })}</span>
        </button>
        <div
          class="mobile-server-menu-tabs"
          role="tablist"
          aria-label={t('mobile_menu.switch_view', { defaultValue: 'Menu view' })}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              onTabChange?.('servers');
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              onTabChange?.('remote');
            }
          }}
        >
          <button
            type="button"
            id="mobile-menu-tab-servers"
            role="tab"
            data-testid="mobile-menu-tab-servers"
            aria-selected={activeTab === 'servers'}
            aria-label={serversTabLabel}
            title={serversTabLabel}
            class={`mobile-server-menu-tab mobile-server-menu-tab-servers${activeTab === 'servers' ? ' active' : ''}`}
            onClick={() => onTabChange?.('servers')}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="6" rx="1.5" />
              <rect x="3" y="14" width="18" height="6" rx="1.5" />
              <circle cx="7" cy="7" r="0.9" fill="currentColor" stroke="none" />
              <circle cx="7" cy="17" r="0.9" fill="currentColor" stroke="none" />
              <line x1="11" y1="7" x2="17" y2="7" />
              <line x1="11" y1="17" x2="17" y2="17" />
            </svg>
          </button>
          <button
            type="button"
            id="mobile-menu-tab-remote"
            role="tab"
            data-testid="mobile-menu-tab-remote"
            aria-selected={activeTab === 'remote'}
            aria-label={remoteTabLabel}
            title={remoteTabLabel}
            class={`mobile-server-menu-tab mobile-server-menu-tab-remote${activeTab === 'remote' ? ' active' : ''}`}
            onClick={() => onTabChange?.('remote')}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
              <path d="M8.5 20.5h7" />
              <path d="M12 16.5v4" />
              <path d="M9.5 7.5l5 2.5-2.2.8-.8 2.2-2-5.5z" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
