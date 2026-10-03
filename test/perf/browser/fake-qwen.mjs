#!/usr/bin/env node
/**
 * Test-only stand-in for the `qwen` CLI (perf harness). The daemon's qwen
 * transport spawns `qwen -p <message> --output-format stream-json ...` per turn
 * and reads JSON lines, so a tiny script gives the REAL daemon a genuine
 * accept -> echo -> answer path without any model/network.
 */
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('0.0.0-perf\n'); process.exit(0); }
if (args[0] === 'mcp') process.exit(0);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({ type: 'system', subtype: 'session_start', session_id: 'perf-qwen-session', model: 'perf-model' });
setTimeout(() => {
  emit({ type: 'assistant', message: { id: 'perf-msg', model: 'perf-model', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
  setTimeout(() => process.exit(0), 20);
}, Number(process.env.IMC_PERF_FAKE_QWEN_MS ?? 150));
