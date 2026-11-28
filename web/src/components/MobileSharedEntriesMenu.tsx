import type { SharedEntrySummary } from '../api.js';
import { SharedEntriesPanel } from './SharedEntriesPanel.js';

interface Props {
  entries: SharedEntrySummary[];
  loading?: boolean;
  error?: string | null;
  openingEntryId?: string | null;
  onOpen: (entry: SharedEntrySummary) => void;
  onRefresh: () => void;
  onTogglePrivateDeviceBlock?: (serverId: string, blockPrivateDevices: boolean) => Promise<void> | void;
}

export function MobileSharedEntriesMenu({
  entries,
  loading = false,
  error = null,
  openingEntryId = null,
  onOpen,
  onRefresh,
  onTogglePrivateDeviceBlock,
}: Props) {
  return (
    <div class="mobile-server-menu-shared">
      <SharedEntriesPanel
        entries={entries}
        loading={loading}
        error={error}
        openingEntryId={openingEntryId}
        onOpen={onOpen}
        onRefresh={onRefresh}
        onTogglePrivateDeviceBlock={onTogglePrivateDeviceBlock}
      />
    </div>
  );
}
