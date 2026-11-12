import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { readFileRelayMode, saveFileRelayMode, getFileRelayUser } from '../r2-relay-preference.js';
import { FILE_RELAY_MODE } from '@shared/r2-relay.js';
/** Per-account local preference. Server credentials never enter browser storage. */
export function R2RelayToggle() {
  const { t } = useTranslation();
  const [mode, setMode] = useState(() => readFileRelayMode(getFileRelayUser()));
  return <label title={t('r2_relay.hint')} style={{ display: 'block', fontSize: 12, padding: '8px 0' }}>
    <input type="checkbox" checked={mode === FILE_RELAY_MODE.R2} onChange={(event) => {
      const next = event.currentTarget.checked ? FILE_RELAY_MODE.R2 : FILE_RELAY_MODE.DIRECT;
      saveFileRelayMode(getFileRelayUser(), next); setMode(next);
    }} /> {t('r2_relay.enable')}
  </label>;
}
