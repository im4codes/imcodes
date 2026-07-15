import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import http from 'http';
import { resolveLiveHookPort } from './hook-port.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import {
  MemoryMcpCallerEnvError,
  parseMcpRuntimeCallerFromEnv,
  type McpRuntimeCaller,
} from './memory-mcp-caller.js';
import { registerAliasMcpTools, registerMemoryMcpTools, type MemoryMcpToolDeps } from './memory-mcp-tools.js';
import { createDaemonMachineToolDeps } from './machine-mcp-deps.js';
import { loadStore, type SessionRecord } from '../store/session-store.js';
import { isDaemonCapabilityAdvertised } from './server-link.js';
import { EXECUTION_CLONE_CAPABILITY_V1 } from '../../shared/execution-clone.js';
import { resolveExecutionCloneLimitsForParentRun } from './execution-clone-limits-resolver.js';

export interface MemoryMcpServerOptions {
  env?: Record<string, string | undefined>;
  toolDeps?: MemoryMcpToolDeps;
}

export function createMemoryMcpServer(caller: McpRuntimeCaller, toolDeps: MemoryMcpToolDeps = {}): McpServer {
  const server = new McpServer({
    name: IMCODES_MEMORY_MCP_SERVER_NAME,
    version: '0.1.0',
  });
  registerMemoryMcpTools(server, caller, toolDeps);
  // Read-only alias tools (resolve_alias / list_aliases) share the same MCP
  // server surface but are NOT part of the memory tool set (kept off
  // MEMORY_MCP_TOOL_NAME_LIST / the memory schema firewall). No write tools.
  registerAliasMcpTools(server, caller);
  return server;
}

async function postHookSend(port: number, body: Record<string, unknown>, hookPath = '/send'): Promise<Record<string, unknown>> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: hookPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
          if ((res.statusCode ?? 500) >= 400 || parsed.ok === false) {
            reject(new Error(typeof parsed.error === 'string' ? parsed.error : `hook send failed with status ${res.statusCode ?? 0}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Compose the production stdio-MCP send defaults onto the (possibly test-injected)
 * `toolDeps`, PER FIELD. Every send-dep field independently preserves an injected
 * value and falls back to the daemon-backed default when absent. This MUST NOT be
 * all-or-nothing: a caller that supplies ONLY a custom `dispatchMessage` still
 * gets the default `cancelSession` (so `send_stop` is not `internal_error`), the
 * capability resolver, and the run-authoritative limit resolver (so a model-driven
 * clone create still enforces per-run caps). Exported for unit-testing the
 * production seam without a full stdio harness.
 */
export function mergeDefaultToolDeps(caller: McpRuntimeCaller, toolDeps: MemoryMcpToolDeps): MemoryMcpToolDeps {
  return {
    ...toolDeps,
    // FULL-node machine tools relay through the daemon's own bound credential.
    // An injected override (tests) wins; otherwise the daemon default is used.
    // This stdio MCP server only runs on FULL nodes, so the tools are advertised
    // (a controlled node never starts it — see registerMemoryMcpTools gate).
    machineDeps: toolDeps.machineDeps ?? createDaemonMachineToolDeps(),
    sendDeps: {
      ...toolDeps.sendDeps,
      // Production stdio MCP consults the daemon's static capability
      // advertisement for the execution-clone send/destroy gate instead of
      // defaulting to enabled. An explicitly-injected override (tests) wins —
      // the `??` is on the FUNCTION, so an injected fn returning `false` still
      // wins (we never fall back on a false RESULT, only an absent fn).
      isExecutionCloneCapabilityEnabled:
        toolDeps.sendDeps?.isExecutionCloneCapabilityEnabled
        ?? (() => isDaemonCapabilityAdvertised(EXECUTION_CLONE_CAPABILITY_V1)),
      // N2 (the standalone-MCP watershed): inject the run-authoritative limit
      // resolver so a model-driven `send_message.clone` on this stdio path
      // enforces the SAME tighter per-run limits the programmatic Team path
      // does — instead of always defaulting to cap=3/60min. Compose with any
      // explicitly-injected resolver (tests) rather than clobbering it; the
      // per-call `??` preserves the fallback even when an injected resolver
      // returns `undefined` for a given run. Keyed by the validated `parentRunId`.
      resolveExecutionCloneLimits: (parentRunId: string) =>
        toolDeps.sendDeps?.resolveExecutionCloneLimits?.(parentRunId)
        ?? resolveExecutionCloneLimitsForParentRun(parentRunId),
      // Per-field default: an injected `dispatchMessage` (tests) wins; otherwise
      // POST the daemon hook /send default.
      dispatchMessage:
        toolDeps.sendDeps?.dispatchMessage
        ?? (async (target: SessionRecord, message: string) => {
          const port = await resolveLiveHookPort();
          if (!port) throw new Error('daemon hook server is unavailable');
          if (!caller.sessionName) throw new Error('send_message requires a scoped caller');
          await postHookSend(port, {
            from: caller.sessionName,
            to: target.name,
            message,
            depth: 0,
          });
        }),
      // Per-field default: an injected `cancelSession` (tests) wins; otherwise
      // POST the daemon hook /stop default. Required so `send_stop` from this
      // stdio path force-stops a target instead of returning `internal_error`.
      cancelSession:
        toolDeps.sendDeps?.cancelSession
        ?? (async (target: SessionRecord) => {
          const port = await resolveLiveHookPort();
          if (!port) throw new Error('daemon hook server is unavailable');
          if (!caller.sessionName) throw new Error('send_stop requires a scoped caller');
          const res = await postHookSend(port, {
            from: caller.sessionName,
            to: target.name,
          }, '/stop');
          return (res as { stopped?: boolean }).stopped !== false;
        }),
    },
  };
}

export function createMemoryMcpServerFromEnv(options: MemoryMcpServerOptions = {}): McpServer {
  const caller = parseMcpRuntimeCallerFromEnv(options.env ?? process.env, 'stdio');
  return createMemoryMcpServer(caller, mergeDefaultToolDeps(caller, options.toolDeps ?? {}));
}

export async function runMemoryMcpServer(options: MemoryMcpServerOptions = {}): Promise<void> {
  try {
    await loadStore();
    const server = createMemoryMcpServerFromEnv(options);
    await server.connect(new StdioServerTransport());
  } catch (err) {
    if (err instanceof MemoryMcpCallerEnvError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}
