import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
// Manages ~/.imcodes/openclaw.json for persistent connection config
// AND auto-reads token from ~/.openclaw/openclaw.json (OC's own config)

import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function imcodesDir(): string { return resolveImcodesHome(); }
function configPath(): string { return join(imcodesDir(), 'openclaw.json'); }
function ocConfigPath(): string { return join(homedir(), '.openclaw', 'openclaw.json'); }

export interface OpenClawConnectionConfig {
  url: string;
  token: string;
  agentId?: string;
}

/** Save connection config with 0600 permissions */
export async function saveConfig(config: OpenClawConnectionConfig): Promise<void> {
  await mkdir(imcodesDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Load saved connection config (returns null if not found) */
export async function loadConfig(): Promise<OpenClawConnectionConfig | null> {
  if (!existsSync(configPath())) return null;
  try {
    const raw = await readFile(configPath(), 'utf8');
    return JSON.parse(raw) as OpenClawConnectionConfig;
  } catch {
    return null;
  }
}

/** Remove saved connection config */
export async function removeConfig(): Promise<void> {
  if (existsSync(configPath())) {
    await unlink(configPath());
  }
}

/**
 * Auto-detect OC gateway token from ~/.openclaw/openclaw.json → gateway.auth.token
 * Returns null if not found.
 */
export function readLocalOCToken(): string | null {
  if (!existsSync(ocConfigPath())) return null;
  try {
    const raw = readFileSync(ocConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const gateway = parsed['gateway'] as Record<string, unknown> | undefined;
    if (!gateway) return null;
    const auth = gateway['auth'] as Record<string, unknown> | undefined;
    if (!auth) return null;
    const token = auth['token'];
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

/**
 * Resolve token from multiple sources (priority order):
 * 1. --token CLI flag
 * 2. OPENCLAW_GATEWAY_TOKEN env var
 * 3. ~/.openclaw/openclaw.json → gateway.auth.token
 */
export function resolveToken(cliToken?: string): string | null {
  if (cliToken) return cliToken;
  const envToken = process.env['OPENCLAW_GATEWAY_TOKEN'];
  if (envToken) return envToken;
  return readLocalOCToken();
}
