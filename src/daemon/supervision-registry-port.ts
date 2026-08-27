/**
 * Production binding between the supervision MCP tools and the real registry.
 *
 * This binding existed ONLY in tests. `createMemoryMcpServerFromEnv()`
 * constructed the server with three arguments, so the fourth
 * (`supervisionToolDeps`) fell back to `{}` and `deps.registry` was undefined in
 * every daemon process. The tools were registered and published on the MCP
 * surface, but every call answered `unavailable: supervision registry not
 * bound` -- a feature that looked present and was permanently inert.
 */
import { getSupervisionTaskRegistry } from './supervision-state-store.js';
import type {
  SupervisionMcpToolDeps,
  SupervisionRegistryPort,
} from './supervision-mcp-tools.js';

/**
 * Resolve the registry PER CALL, never once at construction.
 *
 * The registry is a lazily-opened singleton over a SQLite file. Capturing it in
 * a closure would pin whichever instance existed when the MCP server was built,
 * so a daemon restart (or any reset that reopens the database) would leave the
 * tools bound to a closed handle while still reporting themselves as bound --
 * strictly worse than the unbound error, because it fails silently. Looking it
 * up on each call means the tools always speak to the current binding.
 */
export function createSupervisionRegistryPort(): SupervisionRegistryPort {
  return {
    getStatus: (taskId) => getSupervisionTaskRegistry().get(taskId)?.status,
    applyIntent: (input) => {
      getSupervisionTaskRegistry().applyTaskIntent(input);
    },
    list: (filter) => getSupervisionTaskRegistry().list(filter as never) as never,
    get: (taskId) => getSupervisionTaskRegistry().get(taskId) as never,
    recover: (input) => {
      getSupervisionTaskRegistry().recoverTask(input);
    },
  };
}

export function createSupervisionMcpToolDeps(): SupervisionMcpToolDeps {
  return { registry: createSupervisionRegistryPort() };
}
