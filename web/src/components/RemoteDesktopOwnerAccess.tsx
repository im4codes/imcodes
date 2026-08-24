import { useTranslation } from 'react-i18next';
import {
  RemoteDesktopAccessManagement,
  type RemoteDesktopAccessManagementProps,
} from './RemoteDesktopAccessManagement.js';

export interface RemoteDesktopOwnerAccessProps
  extends Omit<RemoteDesktopAccessManagementProps, 'hostId' | 'endpointLabel'> {
  hostId: string | null;
  endpointLabel?: string;
}

export function RemoteDesktopOwnerAccess({
  hostId,
  endpointLabel = '',
  ...props
}: RemoteDesktopOwnerAccessProps) {
  const { t } = useTranslation();
  if (!hostId) {
    return (
      <section class="remote-desktop-access-card" aria-label={t('remote_desktop.access_owner_title')}>
        <h3>{t('remote_desktop.access_owner_title')}</h3>
        <p>{t('remote_desktop.access_no_host')}</p>
      </section>
    );
  }
  return <RemoteDesktopAccessManagement hostId={hostId} endpointLabel={endpointLabel} {...props} />;
}
