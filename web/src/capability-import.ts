import {
  CAPABILITY_LIMITS,
  CAPABILITY_SOURCE_KIND,
  normalizeCapabilityMcpDefinition,
  type CapabilityMcpDefinition,
  type CapabilitySource,
} from '@shared/capability-management.js';

export interface CapabilityMcpImportResult {
  definitions: CapabilityMcpDefinition[];
  invalidEntries: number;
}

function isSafeConfigKey(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized !== '__proto__' && normalized !== 'prototype' && normalized !== 'constructor';
}

function stripJsonComments(input: string): string {
  let result = '';
  let quote: '"' | null = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!;
    const next = input[index + 1];
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"') {
      quote = current;
      result += current;
      continue;
    }
    if (current === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    result += current;
  }
  if (quote) throw new Error('unterminated_json_string');
  return result;
}

function stripTrailingJsonCommas(input: string): string {
  let result = '';
  let quote: '"' | null = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!;
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"') {
      quote = current;
      result += current;
      continue;
    }
    if (current === ',') {
      let cursor = index + 1;
      while (/\s/.test(input[cursor] ?? '')) cursor += 1;
      if (input[cursor] === '}' || input[cursor] === ']') continue;
    }
    result += current;
  }
  return result;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const current = line[index]!;
    if (quote) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && current === '\\') escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") quote = current;
    else if (current === '#') return line.slice(0, index);
  }
  return line;
}

function splitTomlList(input: string): string[] {
  const values: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let braces = 0;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]!;
    if (quote) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && current === '\\') escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") quote = current;
    else if (current === '{') braces += 1;
    else if (current === '}') braces -= 1;
    else if (current === ',' && braces === 0) {
      values.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) values.push(tail);
  return values;
}

function parseTomlValue(input: string): unknown {
  const value = input.trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as unknown;
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitTomlList(value.slice(1, -1)).map(parseTomlValue);
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const record = Object.create(null) as Record<string, unknown>;
    for (const entry of splitTomlList(value.slice(1, -1))) {
      const separator = entry.indexOf('=');
      if (separator <= 0) throw new Error('invalid_toml_inline_table');
      const key = entry.slice(0, separator).trim().replace(/^['"]|['"]$/g, '');
      if (!isSafeConfigKey(key)) throw new Error('unsafe_toml_key');
      record[key] = parseTomlValue(entry.slice(separator + 1));
    }
    return record;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  throw new Error('unsupported_toml_value');
}

function parseTomlServers(input: string): Record<string, Record<string, unknown>> {
  const servers = Object.create(null) as Record<string, Record<string, unknown>>;
  let current: { server: string; subsection?: 'env' | 'headers' } | null = null;
  for (const rawLine of input.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const section = /^\[mcp_servers\.([A-Za-z0-9_-]{1,96})(?:\.(env|headers))?\]$/.exec(line);
    if (section) {
      current = { server: section[1]!, subsection: section[2] as 'env' | 'headers' | undefined };
      if (!isSafeConfigKey(current.server)) throw new Error('unsafe_toml_server');
      servers[current.server] ??= Object.create(null) as Record<string, unknown>;
      if (current.subsection) servers[current.server]![current.subsection] ??= Object.create(null) as Record<string, unknown>;
      continue;
    }
    if (!current) throw new Error('toml_assignment_outside_server');
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('invalid_toml_assignment');
    const key = line.slice(0, separator).trim().replace(/^['"]|['"]$/g, '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || !isSafeConfigKey(key)) throw new Error('invalid_toml_key');
    const target = current.subsection
      ? servers[current.server]![current.subsection] as Record<string, unknown>
      : servers[current.server]!;
    const normalizedKey = key === 'tool_allowlist' ? 'toolAllowlist' : key;
    if (Object.prototype.hasOwnProperty.call(target, normalizedKey)) throw new Error('duplicate_toml_key');
    target[normalizedKey] = parseTomlValue(line.slice(separator + 1));
  }
  if (Object.keys(servers).length === 0) throw new Error('missing_mcp_servers');
  return servers;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function candidateEntries(parsed: unknown): Array<{ name?: string; value: Record<string, unknown> | null }> {
  const root = recordValue(parsed);
  if (!root) return [{ value: null }];
  const collection = recordValue(root.mcpServers) ?? recordValue(root.mcp_servers);
  if (collection) {
    const entries = Object.entries(collection);
    if (entries.length > CAPABILITY_LIMITS.MCP_IMPORT_ENTRIES) {
      throw new Error('capability_import_too_many_entries');
    }
    return entries.map(([name, value]) => ({ name, value: recordValue(value) }));
  }
  return [{ name: typeof root.name === 'string' ? root.name : undefined, value: root }];
}

function inferredName(raw: Record<string, unknown>, hint?: string): string | undefined {
  if (typeof raw.name === 'string' && raw.name.trim()) return raw.name.trim();
  if (hint?.trim()) return hint.trim();
  if (typeof raw.url === 'string') {
    try { return new URL(raw.url).hostname; } catch { return undefined; }
  }
  if (typeof raw.command === 'string') {
    const parts = raw.command.split(/[\\/]/);
    return parts[parts.length - 1]?.slice(0, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS);
  }
  return undefined;
}

export function parseCapabilityMcpImport(input: string, fileName?: string): CapabilityMcpImportResult {
  if (new TextEncoder().encode(input).length > CAPABILITY_LIMITS.AUDIT_ENVELOPE_BYTES) {
    throw new Error('capability_import_too_large');
  }
  const trimmed = input.replace(/^\uFEFF/, '').trim();
  if (!trimmed) throw new Error('capability_import_empty');
  const toml = fileName?.toLowerCase().endsWith('.toml') || /^\[mcp_servers\./m.test(trimmed);
  const parsed = toml
    ? { mcp_servers: parseTomlServers(trimmed) }
    : JSON.parse(stripTrailingJsonCommas(stripJsonComments(trimmed))) as unknown;
  const definitions: CapabilityMcpDefinition[] = [];
  let invalidEntries = 0;
  for (const candidate of candidateEntries(parsed)) {
    if (!candidate.value || (candidate.name !== undefined && !isSafeConfigKey(candidate.name))) {
      invalidEntries += 1;
      continue;
    }
    const name = inferredName(candidate.value, candidate.name);
    const source: CapabilitySource = {
      kind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
      mcpConfig: { ...candidate.value, ...(name ? { name } : {}) },
    };
    const normalized = normalizeCapabilityMcpDefinition(source);
    if (normalized) definitions.push(normalized);
    else invalidEntries += 1;
  }
  return { definitions, invalidEntries };
}
