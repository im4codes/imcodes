import type { Env } from '../src/types.js';
import { sha256Hex } from '../src/security/crypto.js';
import { updateServerHeartbeat, updateServerStatus } from '../src/db/queries.js';
import { dispatchPush } from '../src/routes/push.js';

const AUTH_TIMEOUT_MS = 5_000;
const MAX_QUEUE_SIZE = 100;
const MAX_MSG_BYTES = 65_536; // 64 KB
const IDLE_TIMEOUT_MS = 120_000; // 120s idle disconnect

interface QueuedMessage {
  data: string;
  timestamp: number;
}

export class DaemonBridge implements DurableObject {
  private env: Env;
  private ws: WebSocket | null = null;
  private authenticated = false;
  private serverId: string | null = null;
  private queue: QueuedMessage[] = [];
  private authTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private browserSockets: Set<WebSocket> = new Set();

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Daemon WebSocket connection
    if (url.pathname === '/daemon') {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.handleDaemonSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Terminal streamer WebSocket (browser ↔ daemon terminal stream)
    if (url.pathname === '/terminal') {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.handleBrowserSocket(server);
      // Forward session subscription to daemon
      const sessionName = url.searchParams.get('session');
      if (sessionName && this.ws && this.authenticated) {
        this.ws.send(JSON.stringify({ type: 'terminal.subscribe', session: sessionName }));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // Browser/terminal viewer WebSocket
    if (url.pathname === '/browser') {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.handleBrowserSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Send message to daemon (from router, for outbound dispatch)
    if (url.pathname === '/send' && req.method === 'POST') {
      const msg = await req.json();
      this.sendToDaemon(JSON.stringify(msg));
      return new Response('ok');
    }

    return new Response('Not Found', { status: 404 });
  }

  private handleDaemonSocket(ws: WebSocket): void {
    this.ws = ws;

    // Auth timeout
    this.authTimer = setTimeout(() => {
      if (!this.authenticated) {
        ws.close(4001, 'Auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.addEventListener('message', async (event) => {
      const data = typeof event.data === 'string' ? event.data : '';
      if (data.length > MAX_MSG_BYTES) {
        ws.close(4009, 'Message too large');
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      // Auth handshake: first message must be { type: 'auth', serverId, token }
      if (!this.authenticated) {
        if (msg.type === 'auth' && typeof msg.serverId === 'string' && typeof msg.token === 'string') {
          const server = await this.env.DB.prepare('SELECT token_hash FROM servers WHERE id = ?')
            .bind(msg.serverId)
            .first<{ token_hash: string }>();

          if (server) {
            const hash = await sha256Hex(msg.token);
            if (hash === server.token_hash) {
              this.authenticated = true;
              this.serverId = msg.serverId;
              if (this.authTimer !== undefined) clearTimeout(this.authTimer);
              ws.send(JSON.stringify({ type: 'auth_ok' }));
              this.resetIdleTimer(ws);
              // Mark server online immediately
              await updateServerHeartbeat(this.env.DB, msg.serverId);
              // Drain queued messages
              for (const q of this.queue) ws.send(q.data);
              this.queue = [];
              // Notify browsers that daemon (re)connected — they must re-subscribe
              // to terminal sessions since daemon process may have restarted and lost
              // all active subscriptions.
              const reconnectMsg = JSON.stringify({ type: 'daemon.reconnected' });
              for (const bs of this.browserSockets) {
                try { bs.send(reconnectMsg); } catch { this.browserSockets.delete(bs); }
              }
              return;
            }
          }
        }
        ws.close(4001, 'Auth failed');
        return;
      }

      // Reset idle timer on any authenticated message (heartbeat or data)
      this.resetIdleTimer(ws);

      // Update heartbeat timestamp in D1 on each heartbeat message
      if (msg.type === 'heartbeat' && this.serverId) {
        await updateServerHeartbeat(this.env.DB, this.serverId);
      }

      // Forward and normalize messages for browser viewers
      const BROWSER_FORWARD = ['terminal_update', 'terminal.history', 'session_event', 'session.error', 'session_list', 'session.idle', 'session.notification', 'session.tool'];
      if (BROWSER_FORWARD.includes(msg.type as string)) {
        let browserData = data;
        if (msg.type === 'terminal_update') {
          browserData = JSON.stringify({ ...msg, type: 'terminal.diff' });
        } else if (msg.type === 'session_event') {
          browserData = JSON.stringify({ ...msg, type: 'session.event' });
        }
        // session.error, session_list, session.idle, terminal.history pass through as-is
        for (const bs of this.browserSockets) {
          try { bs.send(browserData); } catch { this.browserSockets.delete(bs); }
        }
      }

      // Push notification on session.idle
      if (msg.type === 'session.idle' && this.serverId) {
        const project = typeof msg.project === 'string' ? msg.project : (typeof msg.session === 'string' ? msg.session : 'Session');
        void this.env.DB
          .prepare('SELECT user_id FROM servers WHERE id = ?')
          .bind(this.serverId)
          .first<{ user_id: string }>()
          .then((row) => {
            if (!row) return;
            return dispatchPush({
              userId: row.user_id,
              title: '✓ Task completed',
              body: `${project} is ready`,
              data: { sessionName: String(msg.session ?? ''), agentType: String(msg.agentType ?? '') },
            }, this.env);
          })
          .catch(() => { /* push is best-effort */ });
      }
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      this.authenticated = false;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.serverId) {
        void updateServerStatus(this.env.DB, this.serverId, 'offline');
        this.serverId = null;
      }
    });
  }

  private resetIdleTimer(ws: WebSocket): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      ws.close(4000, 'Idle timeout');
    }, IDLE_TIMEOUT_MS);
  }

  private handleBrowserSocket(ws: WebSocket): void {
    this.browserSockets.add(ws);
    ws.addEventListener('close', () => this.browserSockets.delete(ws));

    // Forward browser messages to daemon
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.sendToDaemon(event.data);
    });
  }

  sendToDaemon(data: string): void {
    if (this.ws && this.authenticated) {
      this.ws.send(data);
    } else {
      // Queue up to MAX_QUEUE_SIZE messages
      if (this.queue.length < MAX_QUEUE_SIZE) {
        this.queue.push({ data, timestamp: Date.now() });
      }
    }
  }
}
