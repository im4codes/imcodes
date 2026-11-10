// Test-only composition: real settings, i18n, CSS and API client. HTTP boundary
// fixtures live in the test runner, never in the component or its save path.
import { render } from 'preact';
import { useState } from 'preact/hooks';
import '../../styles.css';
import '../../i18n/index.js';
import { SupervisionSettingsDialog } from '../../components/SessionSettingsDialog.js';
function Fixture() {
  const [open, setOpen] = useState(true);
  return open ? <SupervisionSettingsDialog
    serverId="pool-role-server" sessionName="deck_e2e_poolroles_brain"
    label="" description="" cwd="/fixture" type="codex-sdk" activeModel="gpt-6-luna"
    transportConfig={{ supervision: { mode: 'off' } }}
    onClose={() => setOpen(false)} onSaved={() => undefined}
  /> : <div data-testid="settings-closed" />;
}
render(<Fixture />, document.getElementById('fixture-root')!);
