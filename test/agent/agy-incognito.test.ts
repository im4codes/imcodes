import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_ACP_AGENT_NAME, AGY_CLI_FLAG, AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { withSessionPrivacy } from '../../shared/session-incognito-context.js';
import { supportsSessionIncognito } from '../../shared/session-incognito-types.js';
import { createAgyIncognitoEnvSync } from '../../src/agent/agy-incognito-isolation.js';
import { AgyAcpProvider } from '../../src/agent/providers/agy-acp.js';
import { AgySdkProvider } from '../../src/agent/providers/agy-sdk.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import { IMCODES_SESSION_ENV } from '../../shared/imcodes-send.js';

const tempDirs: string[] = [];
const providers: Array<{ disconnect(): Promise<void> }> = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    await provider.disconnect().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function listTree(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full);
      out.push(rel);
      if (entry.isDirectory()) walk(full);
    }
  };
  if (existsSync(rootDir)) walk(rootDir);
  return out.sort();
}

describe('AGY Incognito Isolation', () => {
  it('supportsSessionIncognito enables agy-sdk and claude-code-sdk only', () => {
    expect(supportsSessionIncognito(AGY_SDK_PROVIDER_ID)).toBe(true);
    expect(supportsSessionIncognito('claude-code-sdk')).toBe(true);
    expect(supportsSessionIncognito('kimi-sdk')).toBe(false);
    expect(supportsSessionIncognito('codex-sdk')).toBe(false);
    expect(supportsSessionIncognito('claude-code')).toBe(false);
    expect(supportsSessionIncognito('agy')).toBe(false);
  });

  it('provisions ephemeral HOME with only auth files, empty mcp_config.json, and idempotent cleanup', async () => {
    const fakeRealHome = makeTempDir('imcodes-fake-real-home-');
    const agyDir = path.join(fakeRealHome, '.gemini', 'antigravity-cli');
    const cfgDir = path.join(fakeRealHome, '.gemini', 'config');
    mkdirSync(path.join(agyDir, 'brain', 'old-conv'), { recursive: true });
    mkdirSync(path.join(agyDir, 'conversations'), { recursive: true });
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(path.join(agyDir, 'antigravity-oauth-token'), 'oauth-secret-token');
    writeFileSync(path.join(fakeRealHome, '.gemini', 'oauth_creds.json'), '{"access_token":"tok"}');
    writeFileSync(path.join(agyDir, 'settings.json'), '{"theme":"dark"}');
    writeFileSync(path.join(agyDir, 'history.jsonl'), '{"secret":"old-history"}\n');
    writeFileSync(path.join(agyDir, 'brain', 'old-conv', 'note.md'), 'old brain note');
    writeFileSync(path.join(agyDir, 'conversations', 'old-conv.pb'), 'pb');
    writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { [IMCODES_MEMORY_MCP_SERVER_NAME]: { command: 'imcodes' } } }));

    const isolated = createAgyIncognitoEnvSync(fakeRealHome);
    tempDirs.push(isolated.homeDir);

    expect(isolated.homeDir).not.toBe(fakeRealHome);
    expect(isolated.env.HOME).toBe(isolated.homeDir);
    expect(isolated.env.USERPROFILE).toBe(isolated.homeDir);
    expect(isolated.env.GEMINI_CLI_HOME).toBe(isolated.homeDir);
    expect(isolated.acpFlags).toEqual([AGY_CLI_FLAG.DISABLE_TELEMETRY, AGY_CLI_FLAG.LOG_FILE, isolated.logFile]);
    expect(isolated.streamFlags).toEqual([AGY_CLI_FLAG.LOG_FILE, isolated.logFile]);

    const copiedToken = path.join(isolated.homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    expect(lstatSync(copiedToken).isSymbolicLink()).toBe(false);
    expect(readFileSync(copiedToken, 'utf8')).toBe('oauth-secret-token');
    expect(readFileSync(path.join(isolated.homeDir, '.gemini', 'oauth_creds.json'), 'utf8')).toBe('{"access_token":"tok"}');

    const mcp = JSON.parse(readFileSync(path.join(isolated.homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    expect(mcp).toEqual({ mcpServers: {} });

    expect(existsSync(path.join(isolated.homeDir, '.gemini', 'antigravity-cli', 'settings.json'))).toBe(false);
    expect(existsSync(path.join(isolated.homeDir, '.gemini', 'antigravity-cli', 'history.jsonl'))).toBe(false);
    expect(existsSync(path.join(isolated.homeDir, '.gemini', 'antigravity-cli', 'brain'))).toBe(false);
    expect(existsSync(path.join(isolated.homeDir, '.gemini', 'antigravity-cli', 'conversations'))).toBe(false);

    await isolated.cleanup();
    expect(existsSync(isolated.homeDir)).toBe(false);
    await isolated.cleanup();
    isolated.cleanupSync();
    expect(existsSync(path.join(agyDir, 'antigravity-oauth-token'))).toBe(true);
  });

  it('runs AgyAcpProvider incognito sessions in isolated per-session ACP processes with zero writes to real HOME and removes ephemeral dirs on endSession', async () => {
    const work = makeTempDir('imcodes-agy-incog-acp-');
    const fakeRealHome = path.join(work, 'real-home');
    mkdirSync(path.join(fakeRealHome, '.gemini', 'antigravity-cli'), { recursive: true });
    mkdirSync(path.join(fakeRealHome, '.gemini', 'config'), { recursive: true });
    writeFileSync(path.join(fakeRealHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'oauth-secret');
    const realMcpPath = path.join(fakeRealHome, '.gemini', 'config', 'mcp_config.json');
    const originalRealMcp = JSON.stringify({ mcpServers: { [IMCODES_MEMORY_MCP_SERVER_NAME]: { command: 'imcodes' } } });
    writeFileSync(realMcpPath, originalRealMcp);
    const snapshotBefore = listTree(fakeRealHome);

    const probeLog = path.join(work, 'spawns.jsonl');
    const script = path.join(work, 'fake-acp.mjs');
    const binary = path.join(work, 'agy');
    writeFileSync(script, `
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const probeLog = process.env.PROBE_LOG;
fs.appendFileSync(probeLog, JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(2),
  home: process.env.HOME,
  userprofile: process.env.USERPROFILE,
  geminiHome: process.env.GEMINI_CLI_HOME,
  imcodesSessionEnv: process.env[${JSON.stringify(IMCODES_SESSION_ENV)}] ?? null,
}) + '\\n');
let count = 0;
const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    // Write a diagnostic file to current HOME to prove realHome is untouched for incognito.
    const agyRoot = path.join(process.env.HOME, '.gemini', 'antigravity-cli');
    fs.mkdirSync(agyRoot, { recursive: true });
    fs.writeFileSync(path.join(agyRoot, 'cache-marker.txt'), String(process.pid));
    send({ id: msg.id, result: {
      protocolVersion: 1,
      agentInfo: { name: ${JSON.stringify(AGY_ACP_AGENT_NAME)}, version: '1.5.8' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } },
    } });
    return;
  }
  if (msg.method === 'session/new') {
    count += 1;
    const sid = 'acp-' + process.pid + '-' + count;
    fs.appendFileSync(probeLog, JSON.stringify({ event: 'session/new', sid, mcpServers: msg.params.mcpServers, home: process.env.HOME }) + '\\n');
    send({ id: msg.id, result: {
      sessionId: sid,
      models: { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'Model A' }] },
    } });
    return;
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const text = (msg.params.prompt || []).map((b) => b.text || '').join('');
    const brainLogDir = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', sid, '.system_generated', 'logs');
    fs.mkdirSync(brainLogDir, { recursive: true });
    fs.writeFileSync(path.join(brainLogDir, 'transcript_full.jsonl'), JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: text }) + '\\n');
    send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ECHO:' + text } } } });
    send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'turn_completed' } } });
    send({ id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 2 } } });
    return;
  }
  if (msg.method === 'session/close') {
    send({ id: msg.id, result: {} });
  }
});
`);
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });

    const provider = new AgyAcpProvider();
    providers.push(provider);

    await withSessionPrivacy('deck_incog_1_brain', true, () =>
      provider.connect({ binaryPath: binary, env: { HOME: fakeRealHome, PROBE_LOG: probeLog } }),
    );
    // Deferred connect while incognito: zero spawns on realHome!
    expect(existsSync(probeLog)).toBe(false);
    expect(listTree(fakeRealHome)).toEqual(snapshotBefore);

    const complete = vi.fn();
    provider.onComplete(complete);

    const s1 = await provider.createSession({
      sessionKey: 'deck_incog_1_brain',
      sessionName: 'deck_incog_1_brain',
      cwd: work,
      agentId: 'model-a',
      incognito: true,
    });
    const s2 = await provider.createSession({
      sessionKey: 'deck_incog_2_brain',
      sessionName: 'deck_incog_2_brain',
      cwd: work,
      agentId: 'model-a',
      incognito: true,
    });

    await provider.send(s1, 'SECRET-ONE');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(complete.mock.calls[0]?.[1].content).toBe('ECHO:SECRET-ONE');

    await provider.send(s2, 'SECRET-TWO');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(complete.mock.calls[1]?.[1].content).toBe('ECHO:SECRET-TWO');

    const records = readFileSync(probeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const spawns = records.filter((r) => 'pid' in r);
    const news = records.filter((r) => r.event === 'session/new');

    expect(spawns).toHaveLength(2);
    expect(spawns[0].pid).not.toBe(spawns[1].pid);
    expect(spawns[0].home).not.toBe(fakeRealHome);
    expect(spawns[1].home).not.toBe(fakeRealHome);
    expect(spawns[0].home).not.toBe(spawns[1].home);
    expect(spawns[0].geminiHome).toBe(spawns[0].home);
    expect(spawns[0].userprofile).toBe(spawns[0].home);
    expect(spawns[0].argv).toContain(AGY_CLI_FLAG.DISABLE_TELEMETRY);
    expect(spawns[0].argv).toContain(AGY_CLI_FLAG.LOG_FILE);
    expect(spawns[0].argv).toContain(path.join(spawns[0].home, 'agy.log'));
    expect(news.map((n) => n.mcpServers)).toEqual([[], []]);

    // Real home remains completely clean!
    expect(listTree(fakeRealHome)).toEqual(snapshotBefore);
    expect(readFileSync(realMcpPath, 'utf8')).toBe(originalRealMcp);

    // Non-resumable enforcement
    expect(await provider.restoreSession(s1)).toBe(false);
    await expect(provider.createSession({
      sessionKey: 'deck_incog_resume',
      cwd: work,
      incognito: true,
      resumeId: 'native-resumed-id',
    })).rejects.toThrow(/resumed/i);

    const incogHome1 = spawns[0].home as string;
    const incogHome2 = spawns[1].home as string;
    expect(existsSync(incogHome1)).toBe(true);
    expect(existsSync(incogHome2)).toBe(true);

    // Clean up s1 on endSession -> ephemeral dir disappears while s2 keeps running
    await provider.endSession(s1);
    expect(existsSync(incogHome1)).toBe(false);
    expect(existsSync(incogHome2)).toBe(true);

    // Normal session lazily spawns shared process on fakeRealHome without affecting s2
    const norm = await provider.createSession({
      sessionKey: 'deck_normal_brain',
      sessionName: 'deck_normal_brain',
      cwd: work,
      agentId: 'model-a',
    });
    await provider.send(norm, 'NORMAL-PROMPT');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3), { timeout: 5000 });
    expect(complete.mock.calls[2]?.[1].content).toBe('ECHO:NORMAL-PROMPT');

    const recordsAfterNormal = readFileSync(probeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const sharedSpawn = recordsAfterNormal.filter((r) => 'pid' in r)[2];
    expect(sharedSpawn.home).toBe(fakeRealHome);
    expect(sharedSpawn.argv).not.toContain(AGY_CLI_FLAG.DISABLE_TELEMETRY);

    // detachSession on s2 also wipes s2 ephemeral dir cleanly
    await provider.detachSession(s2);
    expect(existsSync(incogHome2)).toBe(false);
  });

  it('isolates AgySdkProvider stream-json incognito sessions without touching real HOME mcp_config or resuming', async () => {
    const work = makeTempDir('imcodes-agy-incog-stream-');
    const fakeRealHome = path.join(work, 'real-home');
    mkdirSync(path.join(fakeRealHome, '.gemini', 'antigravity-cli'), { recursive: true });
    mkdirSync(path.join(fakeRealHome, '.gemini', 'config'), { recursive: true });
    writeFileSync(path.join(fakeRealHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'stream-oauth');
    const realMcpPath = path.join(fakeRealHome, '.gemini', 'config', 'mcp_config.json');
    writeFileSync(realMcpPath, '{"mcpServers":{}}');
    const snapshotBefore = listTree(fakeRealHome);

    const probeLog = path.join(work, 'stream-spawns.jsonl');
    const script = path.join(work, 'fake-stream.mjs');
    const binary = path.join(work, 'agy');
    writeFileSync(script, `
import readline from 'node:readline';
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--help') { console.log('Usage: agy'); process.exit(0); }
fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({
  args,
  home: process.env.HOME,
  userprofile: process.env.USERPROFILE,
  geminiHome: process.env.GEMINI_CLI_HOME,
  imcodesSession: process.env[${JSON.stringify(IMCODES_SESSION_ENV)}] ?? null,
}) + '\\n');
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'conv-incog-1' }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const text = msg.message.content;
  process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-incog-1', status: 'SUCCESS', response: 'STREAM:' + text } }) + '\\n');
});
`);
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });

    const provider = new AgySdkProvider();
    providers.push(provider);
    await withSessionPrivacy('deck_stream_incog_brain', true, () =>
      provider.connect({ binaryPath: binary, env: { HOME: fakeRealHome, PROBE_LOG: probeLog } }),
    );
    // Notice: ensureAgyMcpConfigHasImcodesEntry MUST NOT have modified realMcpPath
    expect(readFileSync(realMcpPath, 'utf8')).toBe('{"mcpServers":{}}');

    const complete = vi.fn();
    provider.onComplete(complete);

    const id = await provider.createSession({
      sessionKey: 'deck_stream_incog_brain',
      sessionName: 'deck_stream_incog_brain',
      cwd: work,
      agentId: 'gemini-4-hydrogen-high',
      incognito: true,
    });
    await provider.send(id, 'SECRET-STREAM');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(complete.mock.calls[0]?.[1].content).toBe('STREAM:SECRET-STREAM');

    const spawnRecord = JSON.parse(readFileSync(probeLog, 'utf8').trim());
    expect(spawnRecord.home).not.toBe(fakeRealHome);
    expect(spawnRecord.userprofile).toBe(spawnRecord.home);
    expect(spawnRecord.geminiHome).toBe(spawnRecord.home);
    expect(spawnRecord.imcodesSession).toBeNull();
    expect(spawnRecord.args).toContain(AGY_CLI_FLAG.LOG_FILE);
    expect(spawnRecord.args.at(-1)).toBe(AGY_CLI_FLAG.PRINT_STDIN);
    expect(listTree(fakeRealHome)).toEqual(snapshotBefore);

    expect(await provider.restoreSession(id)).toBe(false);
    await expect(provider.createSession({
      sessionKey: 'deck_stream_incog_resume',
      cwd: work,
      incognito: true,
      resumeId: 'conv-old',
    })).rejects.toThrow(/resumed/i);

    await provider.endSession(id);
    expect(existsSync(spawnRecord.home)).toBe(false);
  });
});
