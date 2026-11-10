/** Test-only fixture: real socket client, timeline owner and renderer. Not a production build entry. */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import i18n from '../../i18n/index.js';
import { configure, configureApiKey } from '../../api.js';
import { WsClient } from '../../ws-client.js';
import { useTimeline } from '../../hooks/useTimeline.js';
import { ChatView } from '../../components/ChatView.js';
import '../../styles.css';

const query = new URLSearchParams(location.search);
const role = query.get('role') ?? 'receiver';
const session = query.get('session') ?? 'deck_e2e_cross_client_brain';
configure(location.origin);
configureApiKey(`fixture-${role}`);
void i18n.changeLanguage('en');
const ws = new WsClient(location.origin, 'synthetic-server');
const received: unknown[] = [];
ws.onMessage((message) => received.push(message));
ws.connect();

function App() {
  const timeline = useTimeline(session, ws, 'synthetic-server');
  const [text, setText] = useState('Synthetic participant message');
  const [commandId, setCommandId] = useState('synthetic-command-1');
  const send = (body: string, id: string, deliveryMode?: string) => {
    timeline.addOptimisticUserMessage(body, id);
    ws.sendSessionCommand('send', { session, sessionName: session, text: body, commandId: id, ...(deliveryMode ? { deliveryMode } : {}) });
  };
  useEffect(() => {
    Object.assign(window, { sendIdentityFixture: { events: timeline.events, connected: ws.connected, send, ws, session, role, received } });
  });
  return <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    {role === 'sender' && <form onSubmit={(event) => { event.preventDefault(); send(text, commandId); }}>
      <input data-testid="message" value={text} onInput={(event) => setText(event.currentTarget.value)} />
      <input data-testid="command" value={commandId} onInput={(event) => setCommandId(event.currentTarget.value)} />
      <button data-testid="send" type="submit">{i18n.t('chat.send')}</button>
    </form>}
    <ChatView sessionId={session} serverId="synthetic-server" events={timeline.events} loading={false} />
  </div>;
}
render(<App />, document.getElementById('app')!);
window.addEventListener('pagehide', () => ws.disconnect());
