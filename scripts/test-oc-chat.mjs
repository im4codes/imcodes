#!/usr/bin/env node
/**
 * Quick test: send a message to OC discord:general via gateway WS
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';

const OC_CONFIG = JSON.parse(readFileSync(join(homedir(), '.openclaw/openclaw.json'), 'utf8'));
const TOKEN = OC_CONFIG.gateway?.auth?.token;
const URL = 'ws://127.0.0.1:18789';
const SESSION_KEY = 'agent:main:discord:channel:1476187408541286525';

if (!TOKEN) { console.error('No gateway token found'); process.exit(1); }

console.log(`Connecting to ${URL}...`);
console.log(`Session: ${SESSION_KEY}\n`);

const ws = new WebSocket(URL);
const pending = new Map();

function sendReq(method, params) {
  const id = randomUUID();
  const frame = { type: 'req', id, method, params };
  ws.send(JSON.stringify(frame));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
  });
}

ws.on('open', () => console.log('WS open'));

ws.on('message', async (raw) => {
  const msg = JSON.parse(raw.toString());

  // Handshake
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    console.log('Got challenge, sending connect...');
    sendReq('connect', {
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'gateway-client', version: '0.1.0', platform: 'darwin', mode: 'backend', displayName: 'imcodes-test' },
      auth: { token: TOKEN },
      role: 'operator',
      scopes: ['operator.write', 'operator.read', 'operator.admin']
    }).catch(() => {}); // hello-ok resolves this differently
    return;
  }

  // hello-ok can come as top-level type OR nested in res.payload.type
  const isHelloOk = msg.type === 'hello-ok' || (msg.type === 'res' && msg.payload?.type === 'hello-ok');
  if (isHelloOk) {
    const hello = msg.type === 'hello-ok' ? msg : msg.payload;
    console.log(`Connected! Protocol ${hello.protocol}, ${hello.features?.methods?.length} methods\n`);
    // Resolve the pending connect request
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve(hello);
      break;
    }
    // Send chat message — try sessions.send first, fall back to agent RPC
    console.log('Sending message to discord:general...\n');
    try {
      const res = await sendReq('sessions.send', {
        key: SESSION_KEY,
        message: 'test from imcodes transport-backed agent. reply with one short sentence.',
        thinking: 'off',
        idempotencyKey: randomUUID(),
      });
      console.log('\n[sessions.send res]', JSON.stringify(res).slice(0, 200));
    } catch (err) {
      console.log(`sessions.send failed (${err.message}), trying agent RPC...`);
      const res = await sendReq('agent', {
        sessionKey: SESSION_KEY,
        message: 'test from imcodes transport-backed agent. reply with one short sentence.',
        agentId: 'main',
        thinking: 'off',
        idempotencyKey: randomUUID(),
      });
      console.log('\n[agent res]', JSON.stringify(res).slice(0, 200));
    }
    return;
  }

  // RPC responses
  if (msg.type === 'res') {
    const p = pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(new Error(msg.error?.message || 'RPC failed'));
    }
    return;
  }

  // Agent streaming events
  if (msg.type === 'event' && msg.event === 'agent') {
    const { stream, data } = msg.payload || {};
    if (stream === 'assistant' && data?.delta) {
      process.stdout.write(data.delta);
    } else if (stream === 'lifecycle') {
      if (data?.phase === 'start') console.log('[agent started]');
      if (data?.phase === 'end') {
        console.log('\n[agent finished]');
        setTimeout(() => { ws.close(); process.exit(0); }, 1000);
      }
      if (data?.phase === 'error') console.log('\n[agent error]', JSON.stringify(data));
    }
  }

  if (msg.type === 'event' && msg.event === 'chat') {
    if (msg.payload?.state === 'error') console.log('\n[chat error]', JSON.stringify(msg.payload));
    if (msg.payload?.state === 'done') console.log('[chat done]');
  }
});

ws.on('error', (err) => { console.error('WS error:', err.message); process.exit(1); });
ws.on('close', (code) => { console.log(`WS closed: ${code}`); process.exit(0); });
setTimeout(() => { console.log('\nTimeout'); ws.close(); process.exit(1); }, 60000);
