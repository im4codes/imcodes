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
const exitCallValue = process.env.IMCODES_MEMORY_MCP_TEST_EXIT_CALL_VALUE;
const callerEnvError = process.env.IMCODES_MEMORY_MCP_TEST_CALLER_ENV_ERROR;
const replyLog = process.env.IMCODES_MEMORY_MCP_TEST_REPLY_LOG;
const callLog = process.env.IMCODES_MEMORY_MCP_TEST_CALL_LOG;
const dynamicCatalog = process.env.IMCODES_MEMORY_MCP_TEST_DYNAMIC_CATALOG === '1';
let readyCrashScheduled = false;
let dynamicPublishedTool = null;
let dynamicPublicationSeq = 0;

if (process.env.IMCODES_MEMORY_MCP_TEST_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {});
}

const echoTool = {
  name: 'fixture_echo',
  description: 'Fixture tool.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
};
const otherTool = {
  name: 'fixture_other',
  description: 'Second dynamic fixture tool.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
};
const baseTools = [echoTool];
const searchTool = {
  name: 'mcp_tool_search',
  description: 'Search/publish hidden fixture tools.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      activate: { type: 'boolean' },
      fallbackCall: { type: 'object' },
    },
    required: ['query'],
  },
};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (callerEnvError) {
      process.stderr.write(`[memory-mcp] fail-fast: ${callerEnvError}\n`);
      process.exit(2);
      return;
    }
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
    const tools = dynamicCatalog
      ? (dynamicPublishedTool === 'fixture_echo'
          ? [searchTool, echoTool]
          : dynamicPublishedTool === 'fixture_other'
            ? [searchTool, otherTool]
            : [searchTool])
      : baseTools;
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } })}\n`);
    if (!readyCrashScheduled && Number.isSafeInteger(crashAfterReadyMs) && crashAfterReadyMs > 0) {
      readyCrashScheduled = true;
      setTimeout(() => process.exit(19), crashAfterReadyMs);
    }
    return;
  }
  if (message.method === 'tools/call') {
    if (callLog) {
      appendFileSync(callLog, `${JSON.stringify({ name: message.params?.name, arguments: message.params?.arguments ?? {} })}\n`);
    }
    if (dynamicCatalog && message.params?.name === 'mcp_tool_search') {
      const query = String(message.params?.arguments?.query ?? '');
      const activate = message.params?.arguments?.activate !== false;
      const fallbackCall = message.params?.arguments?.fallbackCall;
      if (activate) {
        dynamicPublishedTool = (query === 'fixture_echo' || query === 'fixture_other') ? query : null;
        dynamicPublicationSeq += 1;
        if (dynamicPublishedTool) {
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`);
        }
      }
      const committedTool = dynamicPublishedTool;
      const committedSeq = dynamicPublicationSeq;
      const sendSearchReply = () => {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ published: committedTool ? [committedTool] : [], fallbackExecuted: Boolean(fallbackCall) }) }],
            structuredContent: { published: committedTool ? [committedTool] : [], fallbackExecuted: Boolean(fallbackCall) },
            ...(activate ? { _meta: { imcodesPublishedQuery: committedTool, imcodesPublishedSeq: committedSeq } } : {}),
          },
        })}\n`);
      };
      const fbDelayMs = Number(fallbackCall?.arguments?.delayMs ?? 0);
      if (Number.isSafeInteger(fbDelayMs) && fbDelayMs > 0) setTimeout(sendSearchReply, fbDelayMs);
      else sendSearchReply();
      return;
    }
    if (dynamicCatalog && (message.params?.name === 'fixture_echo' || message.params?.name === 'fixture_other') && dynamicPublishedTool !== message.params?.name) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown tool: ${message.params?.name}` },
      })}\n`);
      return;
    }
    const value = message.params?.arguments?.value;
    if (exitCallValue && value === exitCallValue) {
      process.exit(23);
      return;
    }
    if (hangCallMarker && !existsSync(hangCallMarker)) {
      writeFileSync(hangCallMarker, 'hung-once');
      return;
    }
    const reply = () => {
      if (replyLog) appendFileSync(replyLog, `${String(message.id)}\n`);
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: String(message.params?.arguments?.value ?? '') }],
          structuredContent: { echoed: message.params?.arguments?.value ?? null },
        },
      })}\n`);
    };
    const callDelayMs = Number(message.params?.arguments?.delayMs ?? 0);
    if (Number.isSafeInteger(callDelayMs) && callDelayMs > 0) setTimeout(reply, callDelayMs);
    else reply();
  }
});
