/**
 * Launch plumbing for the DeepSeek Harness (`dsh`) child process.
 *
 * `dsh` boots a *profile* — an ordered stack of plugin-bundle layers — and
 * accepts extra `--patch` overlays applied after it. We never create or mutate
 * a profile of our own: the stock `headless` profile already carries the coding
 * persona, tool mode, and code runtime, and `dsh` bootstraps its dependency
 * tree by itself on first use. One generated overlay is enough to turn it into
 * a daemon-drivable session:
 *
 *   1. disable the two one-shot `headless` rows (they answer a single task,
 *      print the final text, and exit — the opposite of a live session), and
 *   2. insert our bridge plugin by ABSOLUTE PATH.
 *
 * Loading the bridge by absolute location (verified against dsh 0.1.0-rc.7) is
 * what keeps this decoupled: the bridge stays inside the daemon's own build
 * output, so its relative import of `shared/` resolves normally and nothing is
 * ever copied into the harness's pnpm-managed `node_modules`.
 *
 * That location is emitted as a `file:` URL, not a bare path. The harness
 * loader hands an unprefixed specifier straight to `await import(name)`, and on
 * Windows a drive-letter path (`C:\...`) makes Node parse `C:` as a URL scheme
 * and throw ERR_UNSUPPORTED_ESM_URL_SCHEME. A `file:` URL is the one form that
 * loads identically on Windows, Linux, and macOS.
 *
 * Overlay files are emitted as JSON. YAML is a JSON superset, so the harness
 * loader accepts them verbatim while we avoid hand-rolling YAML escaping.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DSH_AGENT_DEFAULT_MODEL_ROW_ID,
  DSH_BRIDGE_PLUGIN_ID,
  type DshLlmConfig,
} from '../../../../shared/deepseek-harness.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../../shared/memory-mcp-server-name.js';

/** Stock profile we overlay. `dsh` owns its bootstrap and dependency install. */
export const DSH_BASE_PROFILE = 'headless';

/** One-shot rows the overlay disables so the process stays alive for a session. */
export const DSH_DISABLED_ROW_IDS = ['headless-runner', 'headless-startup'] as const;

/** Package that connects one external MCP server and registers its tools. */
export const DSH_MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/** Loader row id of the IM.codes memory MCP connection. */
export const DSH_MEMORY_MCP_ROW_ID = `mcp-${IMCODES_MEMORY_MCP_SERVER_NAME}`;

/** Env var overriding the `dsh` executable. */
export const DSH_BINARY_ENV = 'IMCODES_DSH_BIN';

/** Default executable looked up on PATH. */
export const DSH_DEFAULT_BINARY = 'dsh';

export function resolveDshBinary(): string {
  return process.env[DSH_BINARY_ENV]?.trim() || DSH_DEFAULT_BINARY;
}

/**
 * `file:` URL of the compiled bridge plugin inside this build. Must stay a URL
 * rather than a path — see the module header for the Windows ESM constraint.
 */
export function resolveBridgeEntry(): string {
  return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'bridge.js')).href;
}

/** Directory holding generated per-session overlays. */
export function dshOverlayDir(): string {
  return join(homedir(), '.imcodes', 'dsh');
}

/** Minimal stdio MCP server description the overlay can mount. */
export interface DshMcpServer {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
}

export interface DshOverlayOptions {
  /** Stable key used for the overlay filename; one file per provider session. */
  sessionKey: string;
  /** IM.codes memory MCP server, mounted so the agent gets memory/send/cron tools. */
  memoryMcp?: DshMcpServer;
  /** LLM config written into the `agent-default-model` row (settings-based). */
  llm?: DshLlmConfig;
}

interface DshPatchRow {
  id?: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  insert?: DshPatchRow[];
}

/**
 * Compose the overlay rows.
 *
 * When a ccPreset supplies an LLM config (`options.llm`), the `agent-default-model`
 * row carries the full `{provider, model, baseUrl?, apiKey?}` — the settings-based
 * equivalent of the env-var mechanism CC SDK and qwen use. Without a preset, no model
 * row is emitted: a requested model then rides to the bridge as an env var and is
 * applied at `agents.create()` (see DSH_BRIDGE_MODEL_ENV).
 */
export function buildDshOverlay(
  options: Pick<DshOverlayOptions, 'memoryMcp' | 'llm'>,
): DshPatchRow[] {
  const rows: DshPatchRow[] = DSH_DISABLED_ROW_IDS.map((id) => ({ id, disabled: true }));
  const insert: DshPatchRow[] = [];
  if (options.memoryMcp) {
    insert.push({
      id: DSH_MEMORY_MCP_ROW_ID,
      name: DSH_MCP_CLIENT_PACKAGE,
      config: {
        transport: 'stdio',
        serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
        // Explicit, not inherited: a memory-MCP outage must degrade the
        // session's tool set, never block the agent from starting.
        failOnStartupError: false,
        command: options.memoryMcp.command,
        args: [...options.memoryMcp.args],
        env: options.memoryMcp.env,
      },
    });
  }
  insert.push({ id: DSH_BRIDGE_PLUGIN_ID, name: resolveBridgeEntry() });
  rows.push({ insert });
  if (options.llm) {
    const llmConfig: Record<string, unknown> = {
      provider: options.llm.provider,
      model: options.llm.model,
    };
    if (options.llm.baseUrl) llmConfig.baseUrl = options.llm.baseUrl;
    if (options.llm.apiKey) llmConfig.apiKey = options.llm.apiKey;
    rows.push({ id: DSH_AGENT_DEFAULT_MODEL_ROW_ID, config: llmConfig });
  }
  return rows;
}

function overlayPathFor(sessionKey: string): string {
  // Session keys are UUID-ish but arrive from callers; keep the filename to a
  // conservative charset so an odd key can never escape the overlay directory.
  return join(dshOverlayDir(), `${sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.patch.json`);
}

/** Write the overlay for a session and return its path. */
export async function writeDshOverlay(options: DshOverlayOptions): Promise<string> {
  await mkdir(dshOverlayDir(), { recursive: true });
  const path = overlayPathFor(options.sessionKey);
  await writeFile(path, `${JSON.stringify(buildDshOverlay(options), null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Delete a session's overlay. Called on teardown so the directory does not grow
 * without bound, and so a stale copy of the session's memory-MCP identity env
 * does not outlive the session on disk.
 */
export async function removeDshOverlay(sessionKey: string): Promise<void> {
  await rm(overlayPathFor(sessionKey), { force: true }).catch(() => {});
}

/** Command-line arguments for a bridge-driven `dsh` run. */
export function buildDshArgs(overlayPath: string): string[] {
  return ['--profile', DSH_BASE_PROFILE, '--patch', overlayPath];
}
