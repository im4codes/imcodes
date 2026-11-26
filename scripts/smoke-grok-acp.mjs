#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const TIMEOUT_MS = 10_000;

function firstLine(value) {
  return String(value ?? '').trim().split(/\r?\n/, 1)[0] ?? '';
}

const version = spawnSync('grok', ['version'], { encoding: 'utf8' });
if (version.error?.code === 'ENOENT') {
  console.error('[grok-acp-smoke] SKIP: official `grok` executable is not installed');
  process.exit(2);
}
if (version.status !== 0) {
  console.error(`[grok-acp-smoke] FAIL: version command exited ${version.status}`);
  process.exit(1);
}

const help = spawnSync('grok', ['agent', 'stdio', '--help'], { encoding: 'utf8' });
if (help.status !== 0) {
  console.error(`[grok-acp-smoke] FAIL: ACP help command exited ${help.status}`);
  process.exit(1);
}

const child = spawn('grok', ['--no-auto-update', 'agent', 'stdio'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let settled = false;
let stderrBytes = 0;
const timer = setTimeout(() => finish(1, 'ACP initialize timed out'), TIMEOUT_MS);

function finish(code, reason) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  child.stdin.end();
  child.kill('SIGTERM');
  if (code === 0) {
    console.log(`[grok-acp-smoke] PASS version=${firstLine(version.stdout)} protocol=1 loadSession=true compact=true stderrBytes=${stderrBytes}`);
  } else {
    console.error(`[grok-acp-smoke] FAIL: ${reason}`);
  }
  process.exitCode = code;
}

child.stderr.on('data', (chunk) => {
  stderrBytes += Buffer.byteLength(chunk);
});
child.on('error', (error) => finish(1, error.code === 'ENOENT' ? 'official `grok` executable is not installed' : 'ACP process failed to start'));
child.on('exit', (code, signal) => {
  if (!settled) finish(1, `ACP process exited before initialize (code=${code}, signal=${signal})`);
});

const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.id !== 1) return;
  if (message.error) {
    finish(1, `initialize returned JSON-RPC error code=${message.error.code ?? 'unknown'}`);
    return;
  }
  const result = message.result;
  const commands = Array.isArray(result?._meta?.availableCommands)
    ? result._meta.availableCommands
    : [];
  const hasCompact = commands.some((command) => command?.name === 'compact');
  if (result?.protocolVersion !== 1) {
    finish(1, `unexpected protocol version ${String(result?.protocolVersion)}`);
  } else if (result?.agentCapabilities?.loadSession !== true) {
    finish(1, 'loadSession capability was not advertised');
  } else if (!hasCompact) {
    finish(1, 'compact command was not advertised');
  } else {
    finish(0, 'ok');
  }
});

child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  },
})}\n`);
