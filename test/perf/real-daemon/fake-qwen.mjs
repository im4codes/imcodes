#!/usr/bin/env node
// Stand-in for the `qwen` CLI used by the real-daemon perf run. The daemon's real
// QwenProvider spawns it exactly like the real CLI (`-p ... --output-format
// stream-json`), so provider parsing, transport-relay throttling and every
// timeline subscriber run for real; only the model backend is synthetic.
// Turn shape: CYCLES x (DELTAS text deltas every DELTA_MS, then one tool call +
// result) - roughly a long Brain turn streaming ~25-40 deltas/s with tools.
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0-perf'); process.exit(0); }
const CYCLES = Number(process.env.PERF_QWEN_CYCLES ?? 30);
const DELTAS = Number(process.env.PERF_QWEN_DELTAS ?? 30);
const DELTA_MS = Number(process.env.PERF_QWEN_DELTA_MS ?? 25);
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionIdIndex = args.indexOf('--session-id') >= 0 ? args.indexOf('--session-id') : args.indexOf('--resume');
const sessionId = sessionIdIndex >= 0 ? args[sessionIdIndex + 1] : 'perf-session';
send({ type: 'system', subtype: 'session_start', session_id: sessionId, model: 'perf-model' });
let finalText = '';
for (let c = 0; c < CYCLES; c += 1) {
  const messageId = `msg-${process.pid}-${c}`;
  send({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } });
  let text = '';
  for (let d = 0; d < DELTAS; d += 1) {
    const piece = `Streaming chunk ${c}.${d} of the assistant reply with some prose. `;
    text += piece;
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
    await sleep(DELTA_MS);
  }
  finalText = text;
  const toolId = `tool-${process.pid}-${c}`;
  send({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo ${c}` } } } });
  send({ type: 'assistant', message: { id: messageId, content: [{ type: 'text', text }, { type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo ${c}` } }], usage: { input_tokens: 10, output_tokens: 10 } } });
  send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok', is_error: false }] } });
  await sleep(20);
}
send({ type: 'assistant', message: { id: 'final', content: [{ type: 'text', text: finalText }], usage: { input_tokens: 10, output_tokens: 10 } } });
send({ type: 'result', result: finalText, usage: { input_tokens: 10, output_tokens: 10 } });
process.exit(0);
