import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const delayMs = Number(process.env.IMCODES_MEMORY_MCP_TEST_DELAY_MS ?? 0);
const crashMarker = process.env.IMCODES_MEMORY_MCP_TEST_CRASH_MARKER;
const shouldCrash = Boolean(crashMarker && !existsSync(crashMarker));
if (shouldCrash && crashMarker) writeFileSync(crashMarker, 'crashed-once');
const startLog = process.env.IMCODES_MEMORY_MCP_TEST_START_LOG;
if (startLog) appendFileSync(startLog, `${Date.now()}\n`);
const crashAfterReadyMs = Number(process.env.IMCODES_MEMORY_MCP_TEST_CRASH_AFTER_READY_MS ?? 0);
const hangCallMarker = process.env.IMCODES_MEMORY_MCP_TEST_HANG_CALL_MARKER;
let readyCrashScheduled = false;

const tools = [{
  name: 'fixture_echo',
  description: 'Fixture tool.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
}];
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (shouldCrash) {
      process.exit(17);
      return;
    }
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fixture', version: '1' },
        },
      })}\n`);
    }, delayMs);
    return;
  }
  if (message.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } })}\n`);
    if (!readyCrashScheduled && Number.isSafeInteger(crashAfterReadyMs) && crashAfterReadyMs > 0) {
      readyCrashScheduled = true;
      setTimeout(() => process.exit(19), crashAfterReadyMs);
    }
    return;
  }
  if (message.method === 'tools/call') {
    if (hangCallMarker && !existsSync(hangCallMarker)) {
      writeFileSync(hangCallMarker, 'hung-once');
      return;
    }
    const reply = () => process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: String(message.params?.arguments?.value ?? '') }],
        structuredContent: { echoed: message.params?.arguments?.value ?? null },
      },
    })}\n`);
    const callDelayMs = Number(message.params?.arguments?.delayMs ?? 0);
    if (Number.isSafeInteger(callDelayMs) && callDelayMs > 0) setTimeout(reply, callDelayMs);
    else reply();
  }
});
