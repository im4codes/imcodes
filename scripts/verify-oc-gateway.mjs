#!/usr/bin/env node
/**
 * Preflight verification: connect to local OpenClaw gateway via WS,
 * complete handshake, send a test message, receive streaming response.
 *
 * Usage: node scripts/verify-oc-gateway.mjs [token]
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const TOKEN = process.argv[2] || process.env.OPENCLAW_GATEWAY_TOKEN;

if (!TOKEN) {
  console.error('Usage: node scripts/verify-oc-gateway.mjs <gateway-token>');
  console.error('  or set OPENCLAW_GATEWAY_TOKEN env var');
  process.exit(1);
}

const log = (tag, ...args) => console.log(`[${tag}]`, ...args);
const logJson = (tag, obj) => console.log(`[${tag}]`, JSON.stringify(obj, null, 2));

// ── State ──────────────────────────────────────────────────────────────
let ws;
let challengeNonce = null;
const pendingRequests = new Map(); // id → { resolve, reject }
let agentRunId = null;
let collectedOutput = '';

// ── Helpers ────────────────────────────────────────────────────────────
function sendRequest(method, params = {}) {
  const id = randomUUID();
  const frame = { type: 'req', id, method, params };
  log('TX', `${method} (${id.slice(0, 8)})`);
  ws.send(JSON.stringify(frame));
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }
    }, 30000);
  });
}

function sendConnect(nonce) {
  return sendRequest('connect', {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: 'gateway-client',
      version: '0.1.0',
      platform: process.platform,
      mode: 'backend',
      displayName: 'imcodes-preflight',
    },
    auth: { token: TOKEN },
    role: 'operator',
    scopes: ['operator.admin'],
  });
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  log('CONNECT', `Opening WS to ${GATEWAY_URL}`);

  ws = new WebSocket(GATEWAY_URL);

  ws.on('open', () => {
    log('WS', 'Connection opened, waiting for connect.challenge...');
  });

  ws.on('close', (code, reason) => {
    log('WS', `Closed: ${code} ${reason}`);
    process.exit(code === 1000 ? 0 : 1);
  });

  ws.on('error', (err) => {
    log('ERROR', err.message);
    process.exit(1);
  });

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log('RX', `Non-JSON: ${data.toString().slice(0, 200)}`);
      return;
    }

    // ── Event frames ─────────────────────────────────────────────────
    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        challengeNonce = msg.payload?.nonce;
        log('RX', `connect.challenge (nonce: ${challengeNonce?.slice(0, 12)}...)`);

        try {
          const helloOk = await sendConnect(challengeNonce);
          log('OK', '✅ Handshake complete');
          logJson('HELLO-OK', {
            protocol: helloOk.protocol,
            server: helloOk.server,
            authMode: helloOk.snapshot?.authMode,
            sessionDefaults: helloOk.snapshot?.sessionDefaults,
            methods: helloOk.features?.methods?.length + ' methods',
            events: helloOk.features?.events?.length + ' events',
          });

          // Now send a test message
          await testAgentMessage();
        } catch (err) {
          log('ERROR', `Handshake failed: ${err.message}`);
          ws.close();
        }
        return;
      }

      // Log ALL events with full payload for protocol discovery
      if (msg.event === 'chat') {
        const p = msg.payload;
        logJson('CHAT-EVENT', p);
        const text = p.text || p.delta || p.data?.text || '';
        if (text) {
          collectedOutput += text;
          process.stdout.write(text);
        }
        if (p.state === 'done' || p.state === 'complete') {
          log('AGENT', `\n✅ Agent done`);
        }
        return;
      }

      if (msg.event === 'agent') {
        logJson('AGENT-EVENT', msg.payload);
        const p = msg.payload;
        const text = p.data?.text || p.text || '';
        if (text) {
          collectedOutput += text;
          process.stdout.write(text);
        }
        return;
      }

      // Other events — log fully
      log('EVENT', `${msg.event}: ${JSON.stringify(msg.payload).slice(0, 500)}`);
      return;
    }

    // ── hello-ok special frame ────────────────────────────────────────
    if (msg.type === 'hello-ok') {
      // The connect response might come as hello-ok type directly
      // Find the pending connect request and resolve it
      for (const [id, handler] of pendingRequests) {
        handler.resolve(msg);
        pendingRequests.delete(id);
        break;
      }
      return;
    }

    // ── Response frames ──────────────────────────────────────────────
    if (msg.type === 'res') {
      const handler = pendingRequests.get(msg.id);
      if (handler) {
        pendingRequests.delete(msg.id);
        if (msg.ok) {
          handler.resolve(msg.payload);
        } else {
          handler.reject(new Error(`RPC error: ${msg.error?.code} — ${msg.error?.message}`));
        }
      } else {
        log('RX-RES', `Unmatched response: ${msg.id?.slice(0, 8)}`);
      }
      return;
    }

    log('RX', `Unknown frame type: ${msg.type}`);
  });
}

async function testAgentMessage() {
  log('TEST', '── Test 1: Send message to agent ──');

  try {
    const result = await sendRequest('agent', {
      message: 'Reply with exactly: "IMCODES_PREFLIGHT_OK". Nothing else.',
      agentId: 'main',
      sessionKey: 'imcodes-preflight-test',
      thinking: 'off',
      idempotencyKey: randomUUID(),
    });

    log('AGENT-START', `runId: ${result?.runId || 'unknown'}`);
    agentRunId = result?.runId;

    // Wait for agent events to complete
    log('TEST', 'Waiting for agent streaming events (15s max)...');
    await new Promise(resolve => setTimeout(resolve, 15000));

    log('RESULT', `Collected output (${collectedOutput.length} chars): "${collectedOutput.trim()}"`);

    // Test 2: Session isolation
    log('TEST', '── Test 2: Session isolation ──');
    collectedOutput = '';

    const result2 = await sendRequest('agent', {
      message: 'What was my previous message? If you have no prior context, reply "NO_CONTEXT".',
      agentId: 'main',
      sessionKey: 'imcodes-preflight-test-2',
      thinking: 'off',
      idempotencyKey: randomUUID(),
    });

    log('AGENT-START', `runId: ${result2?.runId || 'unknown'}`);
    await new Promise(resolve => setTimeout(resolve, 15000));

    log('RESULT', `Isolation test output: "${collectedOutput.trim()}"`);

    // Clean up
    log('CLEANUP', 'Resetting test sessions...');
    try {
      await sendRequest('sessions.reset', { sessionKey: 'agent:main:imcodes-preflight-test' });
      await sendRequest('sessions.reset', { sessionKey: 'agent:main:imcodes-preflight-test-2' });
      log('CLEANUP', '✅ Sessions reset');
    } catch (e) {
      log('CLEANUP', `Reset failed (non-critical): ${e.message}`);
    }

    log('DONE', '✅ All preflight tests complete');
    ws.close(1000);
  } catch (err) {
    log('ERROR', `Agent test failed: ${err.message}`);
    ws.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
