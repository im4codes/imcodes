// Manages ~/.imcodes/openclaw.json for persistent connection config
// AND auto-reads token from ~/.openclaw/openclaw.json (OC's own config)

import { readFile, writeFile, unlink, chmod } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const IMCODES_DIR = join(homedir(), '.imcodes');
const CONFIG_PATH = join(IMCODES_DIR, 'openclaw.json');
const OC_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

export interface OpenClawConnectionConfig {
  url: string;
  token: string;
  agentId?: string;
}

/** Save connection config with 0600 permissions */
export async function saveConfig(config: OpenClawConnectionConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  await chmod(CONFIG_PATH, 0o600);
}

/** Load saved connection config (returns null if not found) */
export async function loadConfig(): Promise<OpenClawConnectionConfig | null> {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as OpenClawConnectionConfig;
  } catch {
    return null;
  }
}

/** Remove saved connection config */
export async function removeConfig(): Promise<void> {
  if (existsSync(CONFIG_PATH)) {
    await unlink(CONFIG_PATH);
  }
}

/**
 * Auto-detect OC gateway token from ~/.openclaw/openclaw.json → gateway.auth.token
 * Returns null if not found.
 */
export function readLocalOCToken(): string | null {
  if (!existsSync(OC_CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(OC_CONFIG_PATH, 'utf8');
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
