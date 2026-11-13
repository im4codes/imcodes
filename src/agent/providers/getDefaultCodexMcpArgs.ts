import {
  IMCODES_MEMORY_MCP_LAUNCH_ARGS,
  IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
  isImcodesMemoryMcpLaunch,
} from './getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { IMCODES_MCP_TOOL_CATALOG_MODE_ENV } from '../../../shared/memory-mcp-env.js';
import { MCP_TOOL_CATALOG_MODES } from '../../../shared/mcp-tool-discovery.js';
import { CODEX_DEFAULT_USER_INPUT_CONFIG } from '../../../shared/codex-user-input.js';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function formatTomlKeySegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlKeySegments(rawPath: string): string[] | null {
  const segments: string[] = [];
  let i = 0;
  const len = rawPath.length;
  const skipWs = () => {
    while (i < len && /\s/.test(lineChar(i))) i += 1;
  };
  const lineChar = (idx: number) => rawPath[idx]!;
  while (i < len) {
    skipWs();
    if (i >= len) break;
    const ch = lineChar(i);
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let val = '';
      let closed = false;
      while (i < len) {
        const c = lineChar(i);
        if (quote === '"' && c === '\\' && i + 1 < len) {
          const next = lineChar(i + 1);
          val += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          closed = true;
          break;
        }
        val += c;
        i += 1;
      }
      if (!closed) return null;
      segments.push(val);
    } else {
      const start = i;
      while (i < len && /[A-Za-z0-9_-]/.test(lineChar(i))) i += 1;
      if (i === start) return null;
      segments.push(rawPath.slice(start, i));
    }
    skipWs();
    if (i >= len) break;
    if (lineChar(i) !== '.') return null;
    i += 1;
  }
  return segments.length > 0 ? segments : null;
}

function parseSimpleTomlStringValue(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

function parseSimpleTomlStringArray(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i]!)) i += 1;
    if (i >= inner.length) break;
    const quote = inner[i];
    if (quote !== '"' && quote !== "'") return undefined;
    let end = i + 1;
    while (end < inner.length) {
      if (quote === '"' && inner[end] === '\\') {
        end += 2;
        continue;
      }
      if (inner[end] === quote) {
        end += 1;
        break;
      }
      end += 1;
    }
    const parsed = parseSimpleTomlStringValue(inner.slice(i, end));
    if (parsed === undefined) return undefined;
    items.push(parsed);
    i = end;
  }
  return items;
}

/**
 * Finds `mcp_servers` keys in Codex `config.toml` that name or launch IM.codes memory MCP
 * so incognito app-server processes can explicitly disable them via `-c mcp_servers.<key>.enabled=false`.
 */
export function collectCodexTomlMcpServerKeysForIncognito(tomlText: string): string[] {
  const tracked = new Map<string, { directName: boolean; command?: string; args?: string[] }>();
  const ensureEntry = (name: string) => {
    let entry = tracked.get(name);
    if (!entry) {
      entry = { directName: name === IMCODES_MEMORY_MCP_SERVER_NAME };
      tracked.set(name, entry);
    }
    return entry;
  };
  let sectionPath: string[] = [];
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const clean = stripTomlComment(rawLine).trim();
    if (!clean) continue;
    if (clean.startsWith('[[') && clean.endsWith(']]')) {
      const parsed = parseTomlKeySegments(clean.slice(2, -2));
      sectionPath = parsed ?? [];
      continue;
    }
    if (clean.startsWith('[') && clean.endsWith(']')) {
      const parsed = parseTomlKeySegments(clean.slice(1, -1));
      sectionPath = parsed ?? [];
      if (sectionPath.length >= 2 && sectionPath[0] === 'mcp_servers') {
        ensureEntry(sectionPath[1]!);
      }
      continue;
    }
    const eqIdx = clean.indexOf('=');
    if (eqIdx <= 0) continue;
    const keyPart = parseTomlKeySegments(clean.slice(0, eqIdx));
    if (!keyPart) continue;
    const valuePart = clean.slice(eqIdx + 1).trim();
    const fullPath = [...sectionPath, ...keyPart];
    if (fullPath[0] !== 'mcp_servers' || fullPath.length < 2) continue;
    const serverName = fullPath[1]!;
    const entry = ensureEntry(serverName);
    if (fullPath.length === 3 && fullPath[2] === 'command') {
      const cmd = parseSimpleTomlStringValue(valuePart);
      if (cmd !== undefined) entry.command = cmd;
    } else if (fullPath.length === 3 && fullPath[2] === 'args') {
      const args = parseSimpleTomlStringArray(valuePart);
      if (args !== undefined) entry.args = args;
    }
  }
  const result: string[] = [];
  for (const [name, info] of tracked) {
    if (info.directName || (info.command && info.args && isImcodesMemoryMcpLaunch(info.command, info.args))) {
      result.push(name);
    }
  }
  return result;
}

/**
 * Inspects Codex `config/read` `config.mcp_servers` output and returns any server names
 * representing `imcodes-memory` (by canonical name or launch command/args) that are not disabled.
 */
export function findEnabledImcodesMcpKeysFromConfig(mcpServers: unknown): string[] {
  if (!mcpServers || typeof mcpServers !== 'object') return [];
  const enabled: string[] = [];
  for (const [name, rawEntry] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    if (entry.enabled === false) continue;
    if (name === IMCODES_MEMORY_MCP_SERVER_NAME || isImcodesMemoryMcpLaunch(entry.command, entry.args)) {
      enabled.push(name);
    }
  }
  return enabled;
}

/**
 * App-server argv for incognito Codex sessions.
 *
 * Intentionally omits `getDefaultCodexMcpArgs()` so IM.codes memory MCP is never
 * injected at the process boundary, and disables any user/workspace-configured
 * `imcodes-memory` server keys so global `~/.codex/config.toml` cannot leak in.
 */
export function getCodexIncognitoAppServerArgs(disabledMcpServers: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const disableArgs: string[] = [];
  for (const name of disabledMcpServers) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    disableArgs.push('-c', `mcp_servers.${formatTomlKeySegment(name)}.enabled=false`);
  }
  return [...disableArgs, '-c', CODEX_DEFAULT_USER_INPUT_CONFIG, 'app-server'];
}

export function getDefaultCodexMcpArgs(): string[] {
  const prefix = `mcp_servers.${IMCODES_MEMORY_MCP_SERVER_NAME}`;
  return [
    '-c',
    `${prefix}.command=${tomlString(IMCODES_MEMORY_MCP_LAUNCH_COMMAND)}`,
    '-c',
    `${prefix}.args=${tomlStringArray(IMCODES_MEMORY_MCP_LAUNCH_ARGS)}`,
    '-c',
    `${prefix}.env.${IMCODES_MCP_TOOL_CATALOG_MODE_ENV}=${tomlString(MCP_TOOL_CATALOG_MODES.STATIC_FULL)}`,
  ];
}

/**
 * Full argv for the IM.codes-managed Codex app-server.
 *
 * No process-wide native-agent disabling flag here. The app-server is ONE process for every
 * session, so a flag could only remove native multi-agent from all sessions at
 * once, genuinely unmanaged ones included. The fence is per session instead:
 * `CodexSdkProvider.startNewThread` creates a managed session's thread with
 * `config.features.{multi_agent,multi_agent_v2}=false`, which Codex keeps for
 * that thread's whole life (verified against codex-cli 0.153: neither resume
 * config nor `--disable` process flags change an existing thread, and every
 * turn records `turn_context.multi_agent_version`). Supervised dispatch is
 * admitted only for a thread whose fence is proven
 * (src/daemon/native-agent-admission.ts). The MCP catalog stays static_full,
 * so IM send_message and the supervision tools remain the authoritative route.
 */
export function getCodexAppServerArgs(): string[] {
  // Native questions are otherwise Plan-only. Enable the actual Codex tool in
  // Default mode too; do not invent or override its provider-owned schema.
  return [...getDefaultCodexMcpArgs(), '-c', CODEX_DEFAULT_USER_INPUT_CONFIG, 'app-server'];
}
