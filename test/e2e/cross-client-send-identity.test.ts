import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { connectProvider, disconnectAll } from '../../src/agent/provider-registry.js';
import { getTransportRuntime, launchTransportSession, stopTransportRuntimeSession } from '../../src/agent/session-manager.js';
import { removeSession } from '../../src/store/session-store.js';
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import type { ServerLink } from '../../src/daemon/server-link.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
import { getProjectionDbPath } from '../../src/daemon/timeline-projection.js';
import { replayTransportHistory } from '../../src/daemon/transport-history.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import { TIMELINE_MESSAGES, TIMELINE_PROTOCOL_CAPABILITY, TIMELINE_PROTOCOL_REVISION } from '../../shared/timeline-protocol.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { SESSION_SEND_DELIVERY_MODES } from '../../shared/session-send-delivery.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MAIN = 'deck_e2e_cross_client_brain';
const SUB = 'deck_sub_e2e_cross_client_worker';
const PORT = 52044;
const requireWeb = createRequire(path.join(ROOT, 'web/package.json'));

/** Real daemon dispatch/runtime/provider/SQLite and real independent browser
 * clients. Only the account/ticket/WS routing service and model app-server peer
 * are synthetic. This is not a production account or physical phone test. */
describe('one stable send across independent desktop and phone clients', () => {
  let temp: string;
  let vite: any;
  let browser: any;
  let off: () => void;
  let wss: WebSocketServer;
  const peers = new Map<WebSocket, string>();
  const dispatches: Record<string, number> = {};
  const frames: Array<{ role: string; type: string; id?: unknown }> = [];
  const initialCounts: unknown[] = [];
  const jobs = new Set<Promise<void>>();
  const bootstrapped = new Set<string>();
  const canonicalReady = new Set<string>();
  const deferred = new Map<string, unknown[]>();
  const receiverPages = new Map<string, any>();
  const send = (peer: WebSocket, value: any) => {
    if (peer.readyState !== WebSocket.OPEN) return;
    frames.push({ role: peers.get(peer)!, type: value.type, id: value.event?.eventId });
    peer.send(JSON.stringify(value));
  };
  const broadcast = (value: any) => { for (const peer of peers.keys()) send(peer, value); };
  const link = { send: broadcast, sendControl: broadcast, sendData: broadcast } as unknown as ServerLink;
  const userRows = async (session: string) => (await replayTransportHistory(session)).filter((row: any) => row.type === 'user.message');
  const inputs = () => readFileSync(path.join(temp, 'provider.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.kind === 'input');

  beforeAll(async () => {
    temp = mkdtempSync(path.join(tmpdir(), 'imcodes-e2e-cross-client-'));
    const bin = path.join(temp, 'codex-fixture');
    writeFileSync(bin, `#!${process.execPath}\nimport(${JSON.stringify(path.join(ROOT, 'test/fixtures/send-identity-codex.mjs'))});\n`);
    chmodSync(bin, 0o755);
    await connectProvider('codex-sdk', { binaryPath: bin, env: { CODEX_HOME: path.join(temp, 'codex'), SEND_IDENTITY_LOG: path.join(temp, 'provider.jsonl') } });
    for (const [name, role] of [[MAIN, 'brain'], [SUB, 'worker']] as const) {
      expect(isKnownTestSessionLike({ name, projectName: 'e2e_cross_client', projectDir: temp })).toBe(true);
      await launchTransportSession({ name, role, projectName: 'e2e_cross_client', projectDir: temp, parentSession: name === SUB ? MAIN : undefined, agentType: 'codex-sdk' });
    }

    // Deliberately deliver actual fallback before actual primary, exposing the
    // receiver-only bug (the sender already has an optimistic row).
    off = timelineEmitter.on((event) => {
      if (![MAIN, SUB].includes(event.sessionId)) return;
      if (event.type === 'user.message') console.info('primary send identity', JSON.stringify({ session: event.sessionId, eventId: event.eventId,
        commandId: event.payload.commandId, clientMessageId: event.payload.clientMessageId, actor: event.payload.sharedActor }));
      if (event.type !== 'user.message') {
        // Reproduce a cold subscriber receiving legacy history before the live
        // stream. Hold independent live state frames until bootstrap completed;
        // otherwise they make chat.history intentionally ignore its fallback.
        const frame = { type: TIMELINE_MESSAGES.EVENT, event };
        if (bootstrapped.has(event.sessionId)) broadcast(frame);
        else deferred.set(event.sessionId, [...(deferred.get(event.sessionId) ?? []), frame]);
        return;
      }
      const job = (async () => {
        let rows: any[] = [];
        await vi.waitFor(async () => {
          rows = await userRows(event.sessionId);
          expect(rows.some((row) => row.commandId === event.payload.commandId)).toBe(true);
        });
        broadcast({ type: TRANSPORT_MSG.CHAT_HISTORY, sessionId: event.sessionId, events: rows });
        if (!bootstrapped.has(event.sessionId)) {
          // Observable barrier, not a timer: prove the independent receiver
          // actually applied the real JSONL bootstrap before live delivery.
          await receiverPages.get(event.sessionId).waitForFunction((id: string) =>
            (window as any).sendIdentityFixture.events.some((e: any) => e.payload.commandId === id), event.payload.commandId);
          bootstrapped.add(event.sessionId);
        }
        broadcast({ type: TIMELINE_MESSAGES.EVENT, event });
        for (const frame of deferred.get(event.sessionId) ?? []) broadcast(frame);
        deferred.delete(event.sessionId);
      })();
      jobs.add(job); void job.finally(() => jobs.delete(job));
    });

    const { createServer } = requireWeb('vite');
    const preset = requireWeb('@preact/preset-vite').default;
    vite = await createServer({
      configFile: false, root: path.join(ROOT, 'web'), cacheDir: path.join(temp, 'vite-cache'),
      plugins: [preset({ devToolsEnabled: false, prefreshEnabled: false }), {
        name: 'synthetic-account-routes', configureServer(server: any) {
          server.middlewares.use((req: any, res: any, next: () => void) => {
            if (!req.url?.startsWith('/api/')) return next();
            res.setHeader('Content-Type', 'application/json');
            if (req.url.startsWith('/api/auth/ws-ticket')) {
              const role = String(req.headers.authorization).includes('sender') ? 'sender' : 'receiver';
              res.end(JSON.stringify({ ticket: role })); return;
            }
            const url = new URL(req.url, 'http://localhost');
            const session = url.searchParams.get('sessionName') ?? MAIN;
            res.end(JSON.stringify({ events: canonicalReady.has(session) ? timelineEmitter.getBufferedEvents(session) : [], epoch: timelineEmitter.epoch, hasMore: false }));
          });
        },
      }],
      resolve: { alias: { '@shared': path.join(ROOT, 'shared') } },
      define: { __BUILD_TIME__: '"fixture"', __WEB_BUILD_ID__: '"fixture"', __PUSH_REGION__: '"global"' },
      server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false,
        fs: { allow: [ROOT, path.dirname(realpathSync(path.join(ROOT, 'web/node_modules'))), path.dirname(realpathSync(path.join(ROOT, 'node_modules')))] } }, logLevel: 'error',
    });
    wss = new WebSocketServer({ noServer: true });
    vite.httpServer.on('upgrade', (req: any, socket: any, head: any) => {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/server/')) return;
      wss.handleUpgrade(req, socket, head, (peer) => {
        peers.set(peer, url.searchParams.get('ticket') ?? 'receiver');
        send(peer, { type: P2P_WORKFLOW_MSG.DAEMON_HELLO, daemonId: 'synthetic-daemon', helloEpoch: 1, sentAt: Date.now(),
          capabilities: [TIMELINE_PROTOCOL_CAPABILITY], timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY, timelineProtocolRevision: TIMELINE_PROTOCOL_REVISION });
        peer.on('message', (bytes) => {
          const command = JSON.parse(bytes.toString());
          if (command.type === 'session.send') {
            dispatches[command.commandId] = (dispatches[command.commandId] ?? 0) + 1;
            // Synthetic authenticated participant stamp; not client-authored.
            const now = Date.now();
            const actor: SharedActorEnvelope = {
              actorUserId: peers.get(peer)!, actorDisplayName: 'Synthetic Participant', effectiveActorRole: 'participant',
              actionId: command.commandId, authorizedAt: now, origin: 'shared-server', primaryShareId: 'synthetic-share',
              snapshot: { target: { kind: 'server', serverId: 'synthetic-server' }, effectiveRole: 'participant',
                historyCutoffAt: 0, nextCoverageRecheckAt: null, coveringShareIds: ['synthetic-share'], primaryShareId: 'synthetic-share', authorizedAt: now },
            };
            command.sharedActor = actor;
            console.info('dispatch send identity', JSON.stringify({ session: command.sessionName, commandId: command.commandId, actor: peers.get(peer) }));
            handleWebCommand(command, link);
          } else if (command.type === TIMELINE_MESSAGES.HISTORY_REQUEST) {
            send(peer, { type: TIMELINE_MESSAGES.HISTORY, sessionName: command.sessionName, requestId: command.requestId,
              events: canonicalReady.has(command.sessionName) ? timelineEmitter.getBufferedEvents(command.sessionName) : [], epoch: timelineEmitter.epoch, hasMore: false });
          } else if (command.type === 'ping') send(peer, { type: 'pong' });
        });
        peer.on('close', () => peers.delete(peer));
      });
    });
    await vite.listen();
    browser = await requireWeb('playwright').chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close(); off?.();
    await Promise.allSettled([...jobs]);
    for (const peer of peers.keys()) peer.terminate();
    await new Promise<void>((resolve) => wss?.close(() => resolve()));
    await vite?.close();
    for (const name of [MAIN, SUB]) { await stopTransportRuntimeSession(name); removeSession(name); }
    await disconnectAll();
    await timelineStore.flushAll(3000);
    rmSync(temp, { recursive: true, force: true });
  });

  it('keeps one receiver bubble through fallback/live/replay/reload and preserves distinct sends, including busy append', { timeout: 60_000, retry: 0 }, async () => {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const sender = await desktop.newPage();
    const receiver = await phone.newPage();
    for (const page of [sender, receiver]) page.on('pageerror', (error: Error) => console.error('cross-client page error', error.message));
    const url = (role: string, session: string) => `http://127.0.0.1:${PORT}/src/fixtures/cross-client-send/index.html?role=${role}&session=${session}`;
    for (const session of [MAIN, SUB]) {
      await Promise.all([sender.goto(url('sender', session)), receiver.goto(url('receiver', session))]);
      receiverPages.set(session, receiver);
      for (const page of [sender, receiver]) await page.waitForFunction(() => (window as any).sendIdentityFixture?.connected);
      const id = `command-${session}`;
      const body = 'One synthetic participant send';
      const beforeInputs = inputs().length;
      await sender.getByTestId('message').fill(body);
      await sender.getByTestId('command').fill(id);
      await sender.getByTestId('send').click();
      await receiver.waitForFunction((id: string) => (window as any).sendIdentityFixture.received.some((message: any) =>
        message.event?.payload?.commandId === id), id);
      await receiver.locator('.chat-user').first().waitFor();
      await vi.waitFor(() => expect(getTransportRuntime(session)?.getStatus()).toBe('idle'));
      await Promise.all([...jobs]);
      // Keep full HTTP/WS history behind this render barrier, like a slow
      // catchup response. It must not hide a duplicate introduced by live ingest.
      await receiver.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      let sqliteRows = 0;
      await vi.waitFor(() => {
        const sql = new DatabaseSync(getProjectionDbPath(), { readOnly: true });
        try { sqliteRows = Number(sql.prepare("SELECT count(*) AS n FROM timeline_projection_events WHERE session_id=? AND type='user.message' AND json_extract(payload_json,'$.commandId')=?").get(session, id)?.n); }
        finally { sql.close(); }
        expect(sqliteRows).toBe(1);
      });
      console.info('initial send layers', JSON.stringify({ session, commandId: id, dispatches: dispatches[id],
        providerInputs: inputs().length - beforeInputs, fallbackRows: (await userRows(session)).filter((row: any) => row.commandId === id).length,
        sqliteRows, receiverBubbles: await receiver.locator('.chat-user').count() }));
      expect(await receiver.locator('.chat-user').count()).toBe(1);
      expect(await receiver.locator('.chat-shared-actor-label').textContent()).toContain('Synthetic Participant');
      expect(dispatches[id]).toBe(1);
      expect(inputs().length - beforeInputs).toBe(1);
      expect((await userRows(session)).filter((row: any) => row.commandId === id)).toHaveLength(1);
      initialCounts.push({ session, dispatches: 1, providerInputs: 1, sqliteRows: 1, fallbackRows: 1, receiverBubbles: 1 });
      canonicalReady.add(session);
      // Duplicate live frames, HTTP catchup, and a fresh receiver (no sender optimistic).
      const primary = timelineEmitter.getBufferedEvents(session).find((event) => event.type === 'user.message' && event.payload.commandId === id)!;
      broadcast({ type: TIMELINE_MESSAGES.EVENT, event: primary });
      broadcast({ type: TIMELINE_MESSAGES.HISTORY, sessionName: session, events: [primary], epoch: primary.epoch });
      await receiver.reload();
      await receiver.locator('.chat-user').first().waitFor();
      expect(await receiver.locator('.chat-user').count()).toBe(1);
      // Reconnect plus browser resume use the production socket/history/cache
      // path. This is synthetic lifecycle delivery, not a physical iOS claim.
      const receiverPeer = [...peers].find(([, role]) => role === 'receiver')![0];
      receiverPeer.close();
      await vi.waitFor(() => expect([...peers].some(([peer, role]) => role === 'receiver' && peer !== receiverPeer)).toBe(true), { timeout: 10_000 });
      await receiver.evaluate(() => {
        window.dispatchEvent(new Event('pageshow'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await receiver.setViewportSize({ width: 320, height: 568 });
      expect(await receiver.locator('.chat-user').count()).toBe(1);
      // A repeated delivery of the SAME command must not cause a second model
      // input or persistent record. This exercises existing daemon idempotence.
      await sender.evaluate(({ body, id }: any) => (window as any).sendIdentityFixture.ws.sendSessionCommand('send',
        { session: (window as any).sendIdentityFixture.session, text: body, commandId: id }), { body, id });
      await vi.waitFor(() => expect(dispatches[id]).toBe(2));
      expect(inputs().length - beforeInputs).toBe(1);
      expect((await userRows(session)).filter((row: any) => row.commandId === id)).toHaveLength(1);
      // Same user intentionally sends the SAME body with another stable command.
      await sender.evaluate(({ body, id }: any) => (window as any).sendIdentityFixture.send(body, id), { body, id: `${id}-again` });
      await vi.waitFor(async () => expect(await receiver.locator('.chat-user').count()).toBe(2));
      await vi.waitFor(() => expect(getTransportRuntime(session)?.getStatus()).toBe('idle'));
      // Another authenticated synthetic participant deliberately sends the same
      // body. Different command and actor remain a distinct bubble on both ends.
      await receiver.evaluate(({ body, id }: any) => (window as any).sendIdentityFixture.send(body, id), { body, id: `${id}-other-participant` });
      // The receiver can show its own optimistic third row before this actor's
      // authoritative echo reaches either page. Count is not a delivery ACK.
      await sender.waitForFunction((id: string) => (window as any).sendIdentityFixture.events.some((e: any) =>
        e.payload.commandId === id && e.payload.sharedActor?.actorUserId === 'receiver'), `${id}-other-participant`);
      await receiver.waitForFunction((id: string) => (window as any).sendIdentityFixture.events.some((e: any) =>
        e.payload.commandId === id && !e.payload.pending && e.payload.sharedActor?.actorUserId === 'receiver'), `${id}-other-participant`);
      await vi.waitFor(async () => {
        expect(await sender.locator('.chat-user').count()).toBe(3);
        expect(await receiver.locator('.chat-user').count()).toBe(3);
      });
      const actors = await sender.evaluate(() => (window as any).sendIdentityFixture.events.filter((e: any) => e.type === 'user.message').map((e: any) => e.payload.sharedActor?.actorUserId));
      expect(new Set(actors)).toEqual(new Set(['sender', 'receiver']));
      await vi.waitFor(() => expect(getTransportRuntime(session)?.getStatus()).toBe('idle'));
    }
    // Real Codex app-server steer into a held turn (not a duplicate model turn).
    await sender.evaluate(() => (window as any).sendIdentityFixture.send('HOLD synthetic foreground', 'hold-1'));
    await vi.waitFor(() => expect(inputs().some((row) => row.text.includes('HOLD synthetic foreground'))).toBe(true));
    await receiver.evaluate((mode: string) => (window as any).sendIdentityFixture.send('Synthetic active append', 'append-1', mode), SESSION_SEND_DELIVERY_MODES.APPEND);
    await vi.waitFor(() => expect(inputs().some((row) => row.method === 'turn/steer' && row.text.includes('Synthetic active append'))).toBe(true));
    await sender.waitForFunction(() => (window as any).sendIdentityFixture.events.some((e: any) =>
      e.payload.commandId === 'append-1' && e.payload.sharedActor?.actorUserId === 'receiver'));
    await vi.waitFor(async () => expect(await receiver.locator('.chat-user').count()).toBe(5));
    expect(inputs().filter((row) => row.text.includes('Synthetic active append'))).toHaveLength(1);
    expect(frames.some((frame) => frame.role === 'receiver' && frame.type === TRANSPORT_MSG.CHAT_HISTORY)).toBe(true);
    console.info('send-identity layered counts', JSON.stringify({ initialCounts, dispatches, providerInputs: inputs().map((row) => ({ method: row.method, threadId: row.threadId })), receiverBubbles: 5, frames: frames.length }));
    await desktop.close(); await phone.close();
  });
});
