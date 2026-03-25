import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import yaml from 'yaml';

const DEFAULT_CONFIG_PATH = join(__dirname, '../..', 'config', 'default.yaml');
function userConfigPath(): string {
  return join(homedir(), '.imcodes', 'config.yaml');
}

export interface Config {
  daemon: {
    pollInterval: number;
    signalCheckInterval: number;
    streamFps: number;
    streamIdleFps: number;
    maxRestarts: number;
    restartWindow: number;
    heartbeatInterval: number;
    reconnectBase: number;
    reconnectMax: number;
  };
  agents: {
    defaultType: string;
    supportedTypes: string[];
  };
  sessions: {
    storePath: string;
    signalDir: string;
  };
  projects: {
    storePath: string;
  };
  autofix: {
    defaultCoder: string;
    defaultAuditor: string;
    maxDiscussionRounds: number;
    autoMerge: boolean;
  };
  tracker: {
    type: 'github' | 'gitlab';
    apiUrl: string;
    tokenEnv: string;
    repo: string;
    projectId: string;
    baseBranch: string;
  };
  memory: {
    claudeMemUrl: string;
  };
  cf?: {
    workerUrl?: string;
    apiKey?: string;
    credentialsPath: string;
  };
  log: {
    level: string;
    pretty: boolean;
  };
}

/** Expand ${ENV_VAR} and ${ENV_VAR:-default} patterns in string values */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const [name, fallback] = expr.split(':-');
    return process.env[name.trim()] ?? fallback ?? '';
  });
}

function expandConfig(obj: unknown): unknown {
  if (typeof obj === 'string') return expandEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(expandConfig);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, expandConfig(v)]),
    );
  }
  return obj;
}

function expandPaths(obj: unknown): unknown {
  if (typeof obj === 'string' && obj.startsWith('~/')) {
    return join(homedir(), obj.slice(2));
  }
  if (Array.isArray(obj)) return obj.map(expandPaths);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, expandPaths(v)]),
    );
  }
  return obj;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && result[k] && typeof result[k] === 'object') {
      result[k] = deepMerge(result[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

let cachedConfig: Config | null = null;

export async function loadConfig(): Promise<Config> {
  if (cachedConfig) return cachedConfig;

  const defaultRaw = await readFile(DEFAULT_CONFIG_PATH, 'utf8');
  let config = yaml.parse(defaultRaw) as Record<string, unknown>;

  // Map server section to cf on defaults before user merge
  if (config.server) {
    const s = config.server as Record<string, unknown>;
    config.cf = {
      workerUrl: s.cfWorkerUrl,
      apiKey: s.cfApiKey ?? s.apiKey,
      credentialsPath: s.credentialsPath ?? join(homedir(), '.imcodes', 'server.json'),
    };
    delete config.server;
  }

  try {
    const userRaw = await readFile(userConfigPath(), 'utf8');
    const userConfig = yaml.parse(userRaw) as Record<string, unknown>;
    if (userConfig) config = deepMerge(config, userConfig);
  } catch {
    // No user config — use defaults
  }

  config = expandConfig(config) as Record<string, unknown>;
  config = expandPaths(config) as Record<string, unknown>;

  cachedConfig = config as unknown as Config;
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}
