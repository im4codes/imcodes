import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_ACP_AGENT_NAME, AGY_CLI_FLAG, AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { withSessionPrivacy } from '../../shared/session-incognito-context.js';
import { supportsSessionIncognito } from '../../shared/session-incognito-types.js';
import {
  createAgyIncognitoEnvSync,
  reclaimOrphanedAgyIncognitoHomes,
  reclaimOrphanedAgyIncognitoHomesSync,
} from '../../src/agent/agy-incognito-isolation.js';
import { AgyAcpProvider, createAgyProvider } from '../../src/agent/providers/agy-acp.js';
import { AgySdkProvider } from '../../src/agent/providers/agy-sdk.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import { IMCODES_SESSION_ENV } from '../../shared/imcodes-send.js';

const tempDirs: string[] = [];
const providers: Array<{ disconnect(): Promise<void> }> = [];
const strayPids: number[] = [];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const pid of strayPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
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
  it('supportsSessionIncognito enables agy-sdk alongside integrated runtimes only', () => {
    expect(supportsSessionIncognito(AGY_SDK_PROVIDER_ID)).toBe(true);
    expect(supportsSessionIncognito('claude-code-sdk')).toBe(true);
    expect(supportsSessionIncognito('codex-sdk')).toBe(true);
    expect(supportsSessionIncognito('pi')).toBe(true);
    expect(supportsSessionIncognito('kimi-sdk')).toBe(false);
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
    expect(existsSync(path.join(isolated.homeDir, '.imcodes-owner.json'))).toBe(true);

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

  it('reclaims SIGKILL-orphaned incognito homes on cold restart without touching live or unowned dirs, and retries failed cleanup', async () => {
    const work = makeTempDir('imcodes-agy-orphan-');
    const customTmp = path.join(work, 'tmp');
    const sourceHome = path.join(work, 'real-home');
    mkdirSync(customTmp, { recursive: true });
    mkdirSync(path.join(sourceHome, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(path.join(sourceHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'orphan-auth');

    // Unowned directory matching prefix must never be deleted by orphan sweeper.
    const unownedDir = path.join(customTmp, 'imcodes-agy-incog-unowned');
    mkdirSync(unownedDir, { recursive: true });
    writeFileSync(path.join(unownedDir, 'keep.txt'), 'unowned');

    const isolationUrl = pathToFileURL(path.resolve('src/agent/agy-incognito-isolation.ts')).href;
    const loader = path.resolve('node_modules/tsx/dist/loader.mjs');
    const workerScript = path.join(work, 'provision.mjs');
    writeFileSync(workerScript, `
import { writeFileSync } from 'node:fs';
import { createAgyIncognitoEnvSync } from ${JSON.stringify(isolationUrl)};
const iso = createAgyIncognitoEnvSync(process.env.SRC_HOME);
writeFileSync(iso.homeDir + '/private-sentinel.txt', 'SECRET');
process.stdout.write(iso.homeDir + '\\n');
if (process.env.HOLD === '1') {
  setInterval(() => {}, 1000);
} else {
  await iso.cleanup();
  process.exit(0);
}
`);

    const spawnAndReadLine = (hold: string) => {
      const child = spawn(process.execPath, ['--import', loader, workerScript], {
        env: { ...process.env, TMPDIR: customTmp, SRC_HOME: sourceHome, HOLD: hold },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const linePromise = new Promise<string>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => {
          out += d.toString('utf8');
          if (out.includes('\n')) resolve(out.trim().split('\n')[0]!);
        });
        child.once('error', reject);
      });
      return { child, linePromise };
    };

    // 1. Dead SIGKILL orphan + concurrent active sibling instance
    const victim = spawnAndReadLine('1');
    const orphanDir = await victim.linePromise;
    const active = spawnAndReadLine('1');
    const activeDir = await active.linePromise;

    victim.child.kill('SIGKILL');
    await new Promise((r) => victim.child.once('exit', r));
    expect(existsSync(orphanDir)).toBe(true);

    // 2. Cold restart / new provisioning sweeps only the dead victim's orphan dir
    const cold = spawnSync(process.execPath, ['--import', loader, workerScript], {
      env: { ...process.env, TMPDIR: customTmp, SRC_HOME: sourceHome, HOLD: '0' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(cold.status).toBe(0);
    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(activeDir)).toBe(true);
    expect(existsSync(unownedDir)).toBe(true);

    active.child.kill('SIGTERM');
    await new Promise((r) => active.child.once('exit', r));
    expect(reclaimOrphanedAgyIncognitoHomesSync(customTmp)).toBe(1);
    expect(existsSync(activeDir)).toBe(false);
    expect(existsSync(unownedDir)).toBe(true);

    // 3. Cleanup failure must not permanently mark cleaned=true
    vi.stubEnv('TMPDIR', customTmp);
    const locked = createAgyIncognitoEnvSync(sourceHome);
    const nested = path.join(locked.homeDir, 'locked-sub');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'secret.txt'), 'locked');
    chmodSync(nested, 0o500);
    try {
      await locked.cleanup();
      expect(existsSync(locked.homeDir)).toBe(true);
    } finally {
      chmodSync(nested, 0o700);
    }
    await locked.cleanup();
    expect(existsSync(locked.homeDir)).toBe(false);
  });

  it('disposes isolated ACP dir on unexpected child exit and rejects resurrection, and cleans up on startup failure', async () => {
    const work = makeTempDir('imcodes-agy-incog-crash-');
    const fakeRealHome = path.join(work, 'real-home');
    mkdirSync(path.join(fakeRealHome, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(path.join(fakeRealHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'crash-oauth');

    const record = path.join(work, 'crash-home.txt');
    const script = path.join(work, 'crash-acp.mjs');
    const binary = path.join(work, 'agy');
    writeFileSync(script, `
import readline from 'node:readline';
import fs from 'node:fs';
fs.appendFileSync(process.env.PROBE_RECORD, process.env.HOME + '\\n');
fs.writeFileSync(process.env.HOME + '/private-sentinel.txt', 'CRASH-SECRET');
const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    const version = process.env.MODE === 'old-acp' ? '1.4.0' : '1.5.8';
    send({ id: msg.id, result: {
      protocolVersion: 1,
      agentInfo: { name: ${JSON.stringify(AGY_ACP_AGENT_NAME)}, version },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } },
    } });
    return;
  }
  if (msg.method === 'session/new') {
    if (process.env.MODE === 'fail-new') {
      send({ id: msg.id, error: { code: -32000, message: 'new session failed' } });
      return;
    }
    send({ id: msg.id, result: {
      sessionId: 'acp-crash-1',
      models: { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'Model A' }] },
    } });
    return;
  }
  if (msg.method === 'session/prompt') {
    process.exit(17);
  }
});
`);
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });

    // A) Crash during prompt -> error emitted, dir deleted, session non-resurrectable
    const pCrash = new AgyAcpProvider();
    providers.push(pCrash);
    await withSessionPrivacy('deck_incog_crash_brain', true, () =>
      pCrash.connect({ binaryPath: binary, env: { HOME: fakeRealHome, PROBE_RECORD: record } }),
    );
    const errors: unknown[] = [];
    pCrash.onError((_sid, err) => errors.push(err));
    const sid = await pCrash.createSession({ sessionKey: 'deck_incog_crash_brain', cwd: work, incognito: true });
    await pCrash.send(sid, 'BOOM');
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    const crashHome = readFileSync(record, 'utf8').trim().split('\n')[0]!;
    await vi.waitFor(() => expect(existsSync(crashHome)).toBe(false), { timeout: 5000 });
    await expect(pCrash.send(sid, 'RESURRECT')).rejects.toThrow(/terminated|resum/i);
    await expect(pCrash.createSession({ sessionKey: 'deck_incog_crash_brain', cwd: work, incognito: true })).rejects.toThrow(/ended|new session/i);

    // B) Handshake / version failure during initialize -> dir cleaned up immediately
    const pOld = new AgyAcpProvider();
    providers.push(pOld);
    await withSessionPrivacy('deck_incog_oldacp_brain', true, () =>
      pOld.connect({ binaryPath: binary, env: { HOME: fakeRealHome, PROBE_RECORD: record, MODE: 'old-acp' } }),
    );
    const sidOld = await pOld.createSession({ sessionKey: 'deck_incog_oldacp_brain', cwd: work, incognito: true });
    await expect(pOld.send(sidOld, 'HELLO')).rejects.toThrow(/version|restore/i);
    const oldHome = readFileSync(record, 'utf8').trim().split('\n')[1]!;
    expect(existsSync(oldHome)).toBe(false);

    // C) session/new failure -> dir cleaned up immediately
    const pFailNew = new AgyAcpProvider();
    providers.push(pFailNew);
    await withSessionPrivacy('deck_incog_failnew_brain', true, () =>
      pFailNew.connect({ binaryPath: binary, env: { HOME: fakeRealHome, PROBE_RECORD: record, MODE: 'fail-new' } }),
    );
    const sidNew = await pFailNew.createSession({ sessionKey: 'deck_incog_failnew_brain', cwd: work, incognito: true });
    await expect(pFailNew.send(sidNew, 'HELLO')).rejects.toThrow();
    const failNewHome = readFileSync(record, 'utf8').trim().split('\n')[2]!;
    expect(existsSync(failNewHome)).toBe(false);
  });

  it('fails closed for incognito on legacy stream AgySdkProvider (<1.5.0) while preserving ordinary stream mode and >=1.5.0 ACP incognito', async () => {
    const work = makeTempDir('imcodes-agy-legacy-failclosed-');
    const fakeRealHome = path.join(work, 'real-home');
    mkdirSync(path.join(fakeRealHome, '.gemini', 'antigravity-cli'), { recursive: true });
    mkdirSync(path.join(fakeRealHome, '.gemini', 'config'), { recursive: true });
    const realMcpPath = path.join(fakeRealHome, '.gemini', 'config', 'mcp_config.json');
    writeFileSync(realMcpPath, '{"mcpServers":{}}');

    const script = path.join(work, 'legacy-stream.mjs');
    const binary = path.join(work, 'agy');
    writeFileSync(script, `
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.4.12'); process.exit(0); }
if (args[0] === '--help') { console.log('Usage: agy'); process.exit(0); }
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'conv-legacy-1' }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-legacy-1', status: 'SUCCESS', response: 'LEGACY:' + msg.message.content } }) + '\\n');
});
`);
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });

    const legacy = await createAgyProvider({ binaryPath: binary, env: { HOME: fakeRealHome } });
    expect(legacy).toBeInstanceOf(AgySdkProvider);
    providers.push(legacy);

    await withSessionPrivacy('deck_legacy_incog_brain', true, () =>
      legacy.connect({ binaryPath: binary, env: { HOME: fakeRealHome } }),
    );
    // connect() inside incognito context must NOT mutate real mcp_config.json before createSession rejects.
    expect(readFileSync(realMcpPath, 'utf8')).toBe('{"mcpServers":{}}');

    await expect(legacy.createSession({
      sessionKey: 'deck_legacy_incog_brain',
      sessionName: 'deck_legacy_incog_brain',
      cwd: work,
      incognito: true,
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR, recoverable: false });
    await expect(withSessionPrivacy('deck_legacy_incog_ctx', true, () =>
      legacy.createSession({ sessionKey: 'deck_legacy_incog_ctx', cwd: work }),
    )).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR, recoverable: false });

    // Positive control: ordinary (non-incognito) old stream session continues working normally
    const complete = vi.fn();
    legacy.onComplete(complete);
    const normId = await legacy.createSession({
      sessionKey: 'deck_legacy_normal_brain',
      sessionName: 'deck_legacy_normal_brain',
      cwd: work,
    });
    await legacy.send(normId, 'HELLO-LEGACY');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(complete.mock.calls[0]?.[1].content).toBe('LEGACY:HELLO-LEGACY');
  });

  it('kills same-group descendants when ACP exits early, reaps orphaned ACP process groups after daemon SIGKILL, and rolls back failed env setup', async () => {
    const work = makeTempDir('imcodes-agy-r2-f1-');
    const customTmp = path.join(work, 'tmp');
    const sourceHome = path.join(work, 'real-home');
    mkdirSync(customTmp, { recursive: true });
    mkdirSync(path.join(sourceHome, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(path.join(sourceHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'FAKE-AUTH');
    vi.stubEnv('TMPDIR', customTmp);

    // 1. Setup rollback: antigravity-oauth-token copies, then google_accounts.json as a directory throws -> zero leaks
    const badSource = path.join(work, 'bad-source');
    mkdirSync(path.join(badSource, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(path.join(badSource, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'FAKE-AUTH');
    mkdirSync(path.join(badSource, '.gemini', 'google_accounts.json'), { recursive: true });
    expect(() => createAgyIncognitoEnvSync(badSource)).toThrow();
    expect(readdirSync(customTmp).filter((n) => n.startsWith('imcodes-agy-incog-'))).toEqual([]);

    // Shared fake ACP + same-group native writer fixture
    const workerScript = path.join(work, 'fake-native.mjs');
    writeFileSync(workerScript, `
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'history.jsonl');
setInterval(() => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, 'PRIVATE-DATA\\n');
}, 50);
`);
    const acpScript = path.join(work, 'fake-acp.mjs');
    writeFileSync(acpScript, `
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
fs.writeFileSync(process.env.PROBE_HOME, process.env.HOME);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: ${JSON.stringify(AGY_ACP_AGENT_NAME)}, version: '1.5.8' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } },
      },
    });
  }
  if (m.method === 'session/new') {
    send({
      id: m.id,
      result: { sessionId: 'incog-r2-sid', models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'M1' }] } },
    });
  }
  if (m.method === 'session/prompt') {
    const w = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(workerScript)}], {
      env: process.env,
      detached: false,
      stdio: 'ignore',
    });
    fs.writeFileSync(process.env.PROBE_PID, String(w.pid));
    w.unref();
    if (process.env.STAY_ALIVE !== '1') {
      setTimeout(() => process.exit(17), 80);
    } else {
      setTimeout(() => send({ id: m.id, result: { stopReason: 'end_turn' } }), 50);
    }
  }
});
`);
    const binary = path.join(work, 'fake-agy');
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${acpScript}' "$@"\n`, { mode: 0o700 });

    // 2. ACP root exits while same-group worker survives -> disposeIsolatedSession must kill group BEFORE removing home
    const probeHome1 = path.join(work, 'home1.txt');
    const probePid1 = path.join(work, 'pid1.txt');
    const p1 = new AgyAcpProvider();
    providers.push(p1);
    await withSessionPrivacy('deck_r2_acp_exit', true, () =>
      p1.connect({ binaryPath: binary, env: { HOME: sourceHome, TMPDIR: customTmp, PROBE_HOME: probeHome1, PROBE_PID: probePid1 } }),
    );
    const sid1 = await p1.createSession({ sessionKey: 'deck_r2_acp_exit', cwd: work, incognito: true, agentId: 'm1' });
    const p1Err = new Promise<void>((resolve) => p1.onError(() => resolve()));
    await p1.send(sid1, 'PRIVATE-PROMPT');
    await Promise.race([p1Err, new Promise((_, reject) => setTimeout(() => reject(new Error('exit timeout')), 5000))]);
    const workerPid1 = Number(readFileSync(probePid1, 'utf8'));
    const privateHome1 = readFileSync(probeHome1, 'utf8');
    strayPids.push(workerPid1);

    await vi.waitFor(() => {
      expect(pidAlive(workerPid1)).toBe(false);
      expect(existsSync(privateHome1)).toBe(false);
    }, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 250));
    expect(existsSync(privateHome1)).toBe(false);
    expect(existsSync(path.join(privateHome1, '.gemini', 'antigravity-cli', 'history.jsonl'))).toBe(false);
    expect(await reclaimOrphanedAgyIncognitoHomes(customTmp)).toBe(0);

    // 3. Daemon SIGKILL leaves detached ACP leader + same-group worker alive -> startup sweep kills tree/group first,
    //    never touches live siblings, unowned dirs, or recycled unrelated PIDs.
    const providerUrl = pathToFileURL(path.resolve('src/agent/providers/agy-acp.ts')).href;
    const ctxUrl = pathToFileURL(path.resolve('shared/session-incognito-context.ts')).href;
    const loader = path.resolve('node_modules/tsx/dist/loader.mjs');
    const daemonRunner = path.join(work, 'daemon-runner.mjs');
    writeFileSync(daemonRunner, `
import { withSessionPrivacy } from ${JSON.stringify(ctxUrl)};
import { AgyAcpProvider } from ${JSON.stringify(providerUrl)};
const p = new AgyAcpProvider();
await withSessionPrivacy(process.env.SESS, true, () =>
  p.connect({
    binaryPath: process.env.BIN,
    env: {
      HOME: process.env.SRC_HOME,
      TMPDIR: process.env.TMPDIR,
      PROBE_HOME: process.env.PROBE_HOME,
      PROBE_PID: process.env.PROBE_PID,
      STAY_ALIVE: '1',
    },
  }),
);
const sid = await p.createSession({ sessionKey: process.env.SESS, cwd: process.env.WORK, incognito: true, agentId: 'm1' });
const done = new Promise((resolve) => p.onComplete(() => resolve()));
await p.send(sid, 'SPAWN-WORKER');
await done;
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
`);

    const spawnDaemon = (tag: string) => {
      const pHome = path.join(work, `home-${tag}.txt`);
      const pPid = path.join(work, `pid-${tag}.txt`);
      const proc = spawn(process.execPath, ['--import', loader, daemonRunner], {
        env: {
          ...process.env,
          TMPDIR: customTmp,
          SRC_HOME: sourceHome,
          BIN: binary,
          WORK: work,
          SESS: `deck_r2_${tag}`,
          PROBE_HOME: pHome,
          PROBE_PID: pPid,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const ready = new Promise<void>((resolve, reject) => {
        let out = '';
        proc.stdout.on('data', (d) => {
          out += d.toString('utf8');
          if (out.includes('READY\n')) resolve();
        });
        proc.once('error', reject);
        proc.once('exit', (code) => reject(new Error(`daemon ${tag} exited early (${code})`)));
      });
      return { proc, ready, pHome, pPid };
    };

    const victim = spawnDaemon('victim');
    const sibling = spawnDaemon('sibling');
    strayPids.push(victim.proc.pid!, sibling.proc.pid!);
    await Promise.all([victim.ready, sibling.ready]);

    const unownedDir = path.join(customTmp, 'imcodes-agy-incog-unowned');
    mkdirSync(unownedDir, { recursive: true });
    writeFileSync(path.join(unownedDir, 'keep.txt'), 'unowned');

    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    strayPids.push(unrelated.pid!);
    const recycledDir = path.join(customTmp, 'imcodes-agy-incog-recycled-pid');
    mkdirSync(recycledDir, { recursive: true });
    writeFileSync(path.join(recycledDir, '.imcodes-owner.json'), JSON.stringify({
      version: 1,
      pid: 999_999_999,
      createdAt: Date.now() - 10_000,
      childPid: unrelated.pid,
      childStartTicks: '999999999',
      childProcessStart: 'Thu Jan  1 00:00:00 1970',
      ownsProcessGroup: true,
    }));

    const victimHome = readFileSync(victim.pHome, 'utf8');
    const victimWorkerPid = Number(readFileSync(victim.pPid, 'utf8'));
    const siblingHome = readFileSync(sibling.pHome, 'utf8');
    const siblingWorkerPid = Number(readFileSync(sibling.pPid, 'utf8'));
    strayPids.push(victimWorkerPid, siblingWorkerPid);

    victim.proc.kill('SIGKILL');
    await new Promise((r) => victim.proc.once('exit', r));
    expect(pidAlive(victimWorkerPid)).toBe(true);
    expect(existsSync(victimHome)).toBe(true);

    // Cold startup reclaim sweeps victim + recycled-pid metadata dir, while preserving sibling, unrelated, and unowned
    const reclaimed = await reclaimOrphanedAgyIncognitoHomes(customTmp);
    expect(reclaimed).toBe(2);
    expect(pidAlive(victimWorkerPid)).toBe(false);
    expect(existsSync(victimHome)).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
    expect(existsSync(victimHome)).toBe(false);

    // Preserved targets remain alive and intact
    expect(pidAlive(sibling.proc.pid!)).toBe(true);
    expect(pidAlive(siblingWorkerPid)).toBe(true);
    expect(existsSync(siblingHome)).toBe(true);
    expect(pidAlive(unrelated.pid!)).toBe(true);
    expect(existsSync(unownedDir)).toBe(true);

    // Clean shutdown of remaining sibling & unrelated helper
    sibling.proc.kill('SIGKILL');
    await new Promise((r) => sibling.proc.once('exit', r));
    await reclaimOrphanedAgyIncognitoHomes(customTmp);
    expect(pidAlive(siblingWorkerPid)).toBe(false);
    expect(existsSync(siblingHome)).toBe(false);
    unrelated.kill('SIGKILL');
    await new Promise((r) => unrelated.once('exit', r));
  });

  it('reaps detached child processes on process.exit(17) before removing home, and preserves owner metadata for cold reclaim if verification fails', async () => {
    const work = makeTempDir('imcodes-agy-r3-exit-');
    const customTmp = path.join(work, 'tmp');
    mkdirSync(customTmp, { recursive: true });
    vi.stubEnv('TMPDIR', customTmp);

    const isoUrl = pathToFileURL(path.resolve('src/agent/agy-incognito-isolation.ts')).href;
    const loader = path.resolve('node_modules/tsx/dist/loader.mjs');

    const writerScript = path.join(work, 'detached-writer.mjs');
    writeFileSync(writerScript, `
import fs from 'node:fs';
import path from 'node:path';
const file = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'history.jsonl');
setInterval(() => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, 'PRIVATE-DATA\\n');
}, 50);
`);

    const exitingOwner = path.join(work, 'exiting-owner.mjs');
    writeFileSync(exitingOwner, `
import { spawn } from 'node:child_process';
import { createAgyIncognitoEnvSync } from ${JSON.stringify(isoUrl)};
const iso = createAgyIncognitoEnvSync();
let childPid = null;
if (process.env.SPAWN_CHILD !== '0') {
  const child = spawn(process.execPath, [${JSON.stringify(writerScript)}], {
    env: { ...process.env, ...iso.env },
    detached: true,
    stdio: 'ignore',
  });
  await iso.registerChildProcess(child.pid, true);
  child.unref();
  childPid = child.pid;
}
if (process.env.BREAK_REAPER_PATH === '1') {
  // Break PATH only after registerChildProcess records the child identity so non-Linux
  // hosts still persist childProcessStart before exercising exit-hook ps failure.
  process.env.PATH = '';
}
process.stdout.write(JSON.stringify({ home: iso.homeDir, pid: childPid }) + '\\n');
setTimeout(() => process.exit(17), 120);
`);

    const runExitingOwner = async (extraEnv: Record<string, string>) => {
      const proc = spawn(process.execPath, ['--import', loader, exitingOwner], {
        env: { ...process.env, TMPDIR: customTmp, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      const [code] = await new Promise<[number | null]>((resolve) => proc.once('exit', (c) => resolve([c])));
      const info = JSON.parse(stdout.trim()) as { home: string; pid: number | null };
      if (info.pid) strayPids.push(info.pid);
      return { code, info };
    };

    // Case 1: Normal process.exit(17) while detached writer is active -> kills writer before deleting home
    const res1 = await runExitingOwner({ SPAWN_CHILD: '1' });
    expect(res1.code).toBe(17);
    expect(res1.info.pid).toBeTruthy();
    await new Promise((r) => setTimeout(r, 350));
    expect(pidAlive(res1.info.pid!)).toBe(false);
    expect(existsSync(res1.info.home)).toBe(false);
    expect(existsSync(path.join(res1.info.home, '.gemini', 'antigravity-cli', 'history.jsonl'))).toBe(false);
    expect(existsSync(path.join(res1.info.home, '.imcodes-owner.json'))).toBe(false);
    expect(await reclaimOrphanedAgyIncognitoHomes(customTmp)).toBe(0);

    // Case 2: Construction/idle home with no registered child -> exit hook cleans home immediately
    const res2 = await runExitingOwner({ SPAWN_CHILD: '0' });
    expect(res2.code).toBe(17);
    expect(res2.info.pid).toBeNull();
    expect(existsSync(res2.info.home)).toBe(false);

    // Case 3: Verification/termination cannot be confirmed on exit (PATH='' breaks ps in POSIX reaper) ->
    // exit hook preserves directory and intact owner marker; subsequent cold reclaim kills writer and deletes home.
    const res3 = await runExitingOwner({ SPAWN_CHILD: '1', BREAK_REAPER_PATH: '1' });
    expect(res3.code).toBe(17);
    expect(res3.info.pid).toBeTruthy();
    expect(pidAlive(res3.info.pid!)).toBe(true);
    expect(existsSync(res3.info.home)).toBe(true);
    const preservedMeta = JSON.parse(readFileSync(path.join(res3.info.home, '.imcodes-owner.json'), 'utf8')) as {
      childPid?: number;
      childStartTicks?: string;
      childProcessStart?: string;
      ownsProcessGroup?: boolean;
    };
    expect(preservedMeta.childPid).toBe(res3.info.pid);
    if (process.platform === 'linux') {
      expect(preservedMeta.childStartTicks).toBeTruthy();
    } else {
      expect(preservedMeta.childProcessStart).toBeTruthy();
    }
    expect(preservedMeta.ownsProcessGroup).toBe(true);

    expect(await reclaimOrphanedAgyIncognitoHomes(customTmp)).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(pidAlive(res3.info.pid!)).toBe(false);
    expect(existsSync(res3.info.home)).toBe(false);
  });

  it('waits for async childProcessStart persistence when /proc start ticks are unavailable (non-Linux / darwin)', async () => {
    const customTmp = makeTempDir('agy-incog-darwin-');
    const loader = pathToFileURL(path.resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href;
    const isoUrl = pathToFileURL(path.resolve(process.cwd(), 'src/agent/agy-incognito-isolation.ts')).href;
    const work = makeTempDir('agy-incog-darwin-work-');
    const script = path.join(work, 'darwin-register.mjs');
    writeFileSync(script, `
Object.defineProperty(process, 'platform', { value: 'darwin' });
const { spawn } = await import('node:child_process');
const { createAgyIncognitoEnvSync, reclaimOrphanedAgyIncognitoHomes } = await import(${JSON.stringify(isoUrl)});
const iso = createAgyIncognitoEnvSync();
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
});
await iso.registerChildProcess(child.pid, true);
child.unref();
process.stdout.write(JSON.stringify({ home: iso.homeDir, pid: child.pid }) + '\\n');
process.kill(process.pid, 'SIGKILL');
`);

    const proc = spawn(process.execPath, ['--import', loader, script], {
      env: { ...process.env, TMPDIR: customTmp },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      proc.once('exit', (c, sig) => resolve([c, sig]));
    });
    expect(code).toBeNull();
    expect(signal).toBe('SIGKILL');
    const info = JSON.parse(stdout.trim()) as { home: string; pid: number };
    strayPids.push(info.pid);
    expect(pidAlive(info.pid)).toBe(true);
    expect(existsSync(info.home)).toBe(true);

    const meta = JSON.parse(readFileSync(path.join(info.home, '.imcodes-owner.json'), 'utf8')) as {
      childPid?: number;
      childStartTicks?: string;
      childProcessStart?: string;
      ownsProcessGroup?: boolean;
    };
    expect(meta.childPid).toBe(info.pid);
    expect(meta.childStartTicks).toBeUndefined();
    expect(meta.childProcessStart).toBeTruthy();
    expect(meta.ownsProcessGroup).toBe(true);

    expect(await reclaimOrphanedAgyIncognitoHomes(customTmp)).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(pidAlive(info.pid)).toBe(false);
    expect(existsSync(info.home)).toBe(false);
  });
});
