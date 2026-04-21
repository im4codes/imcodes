#!/usr/bin/env node
/**
 * Real end-to-end launch test for Qwen preset (MiniMax).
 *
 * Drives the real QwenProvider against the real qwen CLI with the user's
 * real ~/.imcodes/cc-presets.json — no mocks, no stubs. Strongest evidence
 * is a genuine assistant reply from MiniMax; if the --auth-type fix weren't
 * active, the qwen CLI would emit the "OAuth free tier discontinued" error
 * from ~/.qwen/settings.json's qwen-oauth selector.
 *
 * Also verifies the negative case by running a second session WITHOUT a
 * preset to confirm non-preset sessions are unaffected (they should still
 * work if the user has `qwen auth` configured, OR fail with a non-OAuth
 * error if they don't — but must NOT regress).
 *
 * Run:  node scripts/smoke-qwen-preset.mjs
 */
import { randomUUID } from 'node:crypto';

const { QwenProvider } = await import('../dist/src/agent/providers/qwen.js');
const { getQwenPresetTransportConfig } = await import('../dist/src/daemon/cc-presets.js');

async function runOneTurn(label, sessionCfg) {
  console.log(`\n[smoke] --- ${label} ---`);
  const provider = new QwenProvider();
  await provider.connect({});

  const errors = [];
  let completed = null;

  provider.onError((_sid, err) => {
    errors.push(err);
    console.log(`[smoke] ${label}: ERROR code=${err.code} msg=${String(err.message).split('\n')[0].slice(0, 200)}`);
  });
  provider.onComplete((_sid, msg) => {
    completed = msg;
    const text = Array.isArray(msg.content)
      ? msg.content.map((b) => (b?.text ?? '')).join('')
      : String(msg.content ?? '');
    console.log(`[smoke] ${label}: COMPLETE "${text.slice(0, 150)}"`);
  });

  const sessionKey = randomUUID();
  await provider.createSession({ sessionKey, cwd: process.cwd(), effort: 'medium', ...sessionCfg });
  await provider.send(sessionKey, 'hi').catch((e) => console.log(`[smoke] ${label}: send() threw: ${e?.message ?? e}`));

  const started = Date.now();
  while (Date.now() - started < 60_000 && !completed && errors.length === 0) {
    await new Promise((r) => setTimeout(r, 250));
  }

  await provider.disconnect();
  return { completed, errors };
}

// -- test 1: MiniMax preset (the fix's target case) ----------------------
const cfg = await getQwenPresetTransportConfig('minimax');
if (!cfg.settings) {
  console.error('[smoke] FAIL: preset "minimax" missing from ~/.imcodes/cc-presets.json');
  process.exit(2);
}
console.log(`[smoke] preset.selectedType=${cfg.settings.security?.auth?.selectedType}  model=${cfg.model}  envKeys=[${Object.keys(cfg.env).join(',')}]`);
const presetResult = await runOneTurn('minimax preset', {
  agentId: cfg.model,
  env: cfg.env,
  settings: cfg.settings,
});

// -- test 2: no preset (make sure we didn't break non-preset sessions) ---
// If user has ~/.qwen/settings.json pinned to qwen-oauth (current state), this
// SHOULD fail with the OAuth discontinued error — and that's correct behavior:
// we must not silently force an auth type onto non-preset users.
const noPresetResult = await runOneTurn('no preset', { agentId: 'qwen3-coder-plus' });

// -- verification --------------------------------------------------------
console.log('\n[smoke] === summary ===');
let exitCode = 0;

const presetGotReply = !!presetResult.completed;
const presetSawOAuth = presetResult.errors.some((e) => /OAuth free tier was discontinued/i.test(String(e.message ?? '')));
if (presetGotReply && !presetSawOAuth) {
  console.log('[smoke] PASS ✓  preset path works: MiniMax replied; no OAuth discontinuation error');
} else if (presetSawOAuth) {
  console.error('[smoke] FAIL ✗  preset still hits OAuth discontinuation — fix did NOT take effect');
  exitCode = 1;
} else {
  console.error('[smoke] FAIL ✗  preset got no reply and no OAuth error (some other failure — check above)');
  exitCode = 1;
}

const noPresetSawOAuth = noPresetResult.errors.some((e) => /OAuth free tier was discontinued/i.test(String(e.message ?? '')));
if (noPresetResult.completed) {
  console.log('[smoke] PASS ✓  no-preset path also works (user has working qwen auth)');
} else if (noPresetSawOAuth) {
  console.log('[smoke] PASS ✓  no-preset path fails with OAuth discontinuation — EXPECTED:');
  console.log('                the fix does not interfere with non-preset sessions; they still');
  console.log('                hit whatever ~/.qwen/settings.json says. User sees the real error');
  console.log('                and can run `qwen auth` to switch — correct unchanged behavior.');
} else {
  console.log('[smoke] NOTE    no-preset path failed with a NON-OAuth error (network/key):');
  for (const e of noPresetResult.errors) console.log(`        ${String(e.message ?? e).split('\n')[0].slice(0, 250)}`);
}

process.exit(exitCode);
