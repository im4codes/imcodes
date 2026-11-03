import { useTranslation } from 'react-i18next';
import { isNative } from '../native.js';

export interface MobileServerMenuToolbarProps {
  onHome: () => void;
  onChangeServer: () => void;
  onOpenControlledNodes: () => void;
  /** Optional override for testing native vs web gating; defaults to production isNative() */
  isNativeApp?: boolean;
}

export function MobileServerMenuToolbar({
  onHome,
  onChangeServer,
  onOpenControlledNodes,
  isNativeApp,
}: MobileServerMenuToolbarProps) {
  const { t } = useTranslation();
  const nativeActive = typeof isNativeApp === 'boolean' ? isNativeApp : isNative();

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
      <button
        type="button"
        class="mobile-server-menu-item mobile-server-menu-controlled-nodes"
        onClick={onOpenControlledNodes}
      >
        <span aria-hidden="true">🖥</span>
        <span>{t('controlled_nodes.title', { defaultValue: 'AI Desk' })}</span>
      </button>
    </>
  );
}
