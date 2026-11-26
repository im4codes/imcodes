#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  LOCALE_DEFAULT_SERVERS_ENV_VAR,
  parseLocaleDefaultServers,
} from '../../../shared/locale-default-servers.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PC_APP_DIR = resolve(SCRIPT_DIR, '..');
export const DEFAULT_PC_APP_BUILD_CONFIG_PATH = join(PC_APP_DIR, 'dist', 'build-config.json');

export function writePcAppBuildConfig({
  env = process.env,
  outFile = DEFAULT_PC_APP_BUILD_CONFIG_PATH,
  onWarning = (msg) => console.warn(`[pc-app build] ${msg}`),
} = {}) {
  const raw = env[LOCALE_DEFAULT_SERVERS_ENV_VAR] ?? env.VITE_LOCALE_DEFAULT_SERVERS;
  const localeDefaultServers = parseLocaleDefaultServers(raw, { onWarning });
  const payload = { localeDefaultServers };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writePcAppBuildConfig();
}
