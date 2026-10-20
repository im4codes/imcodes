import { useTranslation } from 'react-i18next';
import { CapabilityOperationCard } from './CapabilityOperationCard.js';
import { useCapabilityOperationController } from '../hooks/useCapabilityOperationController.js';

interface Props {
  serverId?: string | null;
}

export function CapabilityOperationNotice({ serverId }: Props) {
  const { t } = useTranslation();
  const controller = useCapabilityOperationController(serverId);
  if (!serverId || !controller.operation) return null;

  return (
    <aside class="capability-global-operation" aria-label={t('capabilities.globalNoticeLabel')}>
      {controller.error && (
        <div class="capability-inline-alert" role="alert">
          {t(controller.error === 'status' ? 'capabilities.statusRefreshError' : controller.error === 'confirmation' ? 'capabilities.confirmationError' : 'capabilities.loadError')}
        </div>
      )}
      <CapabilityOperationCard
        operation={controller.operation}
        busy={controller.busy}
        offline={!controller.online}
        onInstall={() => void controller.install()}
        onCancel={() => void controller.cancel()}
        onRetry={() => void controller.refresh()}
      />
    </aside>
  );
}
