import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  readFileRelayMode,
  saveFileRelayMode,
  getFileRelayUser,
  isServerR2RelayEnabled,
  subscribeR2RelayState,
} from '../r2-relay-preference.js';
import { FILE_RELAY_MODE } from '@shared/r2-relay.js';

function readRelayToggleSnapshot() {
  const userId = getFileRelayUser();
  return {
    userId,
    serverEnabled: isServerR2RelayEnabled(),
    mode: readFileRelayMode(userId),
  };
}

/** Per-account local preference. Server credentials never enter browser storage. */
export function R2RelayToggle() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState(readRelayToggleSnapshot);

  useEffect(() => {
    setSnapshot(readRelayToggleSnapshot());
    return subscribeR2RelayState(() => {
      setSnapshot(readRelayToggleSnapshot());
    });
  }, []);

  if (!snapshot.serverEnabled || !snapshot.userId) return null;

  return <label title={t('r2_relay.hint')} style={{ display: 'block', fontSize: 12, padding: '8px 0' }}>
    <input type="checkbox" checked={snapshot.mode === FILE_RELAY_MODE.R2} onChange={(event) => {
      const next = event.currentTarget.checked ? FILE_RELAY_MODE.R2 : FILE_RELAY_MODE.DIRECT;
      saveFileRelayMode(snapshot.userId, next);
    }} /> {t('r2_relay.enable')}
  </label>;
}
