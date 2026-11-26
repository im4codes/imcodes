/** Browser-only fixture; the speech API is supplied by the Playwright test. */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { VoiceOverlay } from '../../components/VoiceOverlay.js';
import '../../i18n/index.js';
import '../../styles.css';

function Fixture() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [sent, setSent] = useState('');
  return <>
    <button onClick={() => setOpen(true)}>{t('voice.voice_input')}</button>
    <textarea class="fixture-composer" placeholder={t('voice.speak_now')} style={{ position: 'fixed', bottom: 12, left: 12 }} />
    <output>{sent}</output>
    <VoiceOverlay open={open} onClose={() => setOpen(false)} draftScope="voice-browser-fixture"
      autoStartListening={!new URLSearchParams(location.search).has('edit')}
      onSend={text => { setSent(text); return 'accepted'; }} />
  </>;
}
render(<Fixture />, document.getElementById('fixture-root')!);
