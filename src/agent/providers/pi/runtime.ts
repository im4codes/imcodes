import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PiLlmConfig } from '../../../../shared/pi-agent.js';

export const PI_BINARY_ENV = 'IMCODES_PI_BIN';
export const PI_DEFAULT_BINARY = 'pi';
export const PI_SUPPORTED_PACKAGE = '@earendil-works/pi-coding-agent@0.84.2';
export const PI_INSTALL_COMMAND = `npm install -g --ignore-scripts ${PI_SUPPORTED_PACKAGE}`;

export function resolvePiBinary(): string {
  return process.env[PI_BINARY_ENV]?.trim() || PI_DEFAULT_BINARY;
}

export function piSessionDir(): string {
  return join(homedir(), '.imcodes', 'pi', 'sessions');
}

export function resolvePiExtensionEntry(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  const compiled = join(directory, 'extension.js');
  // Production loads the compiled module. `npm run dev` executes this source
  // tree through tsx; Pi supports TypeScript extensions, so keep local smoke
  // and development sessions working without generating files in src/.
  return existsSync(compiled) ? compiled : join(directory, 'extension.ts');
}

export function buildPiRpcArgs(options: {
  sessionId: string;
  sessionName?: string;
  requestedModel?: string;
  effort?: string;
  llm?: PiLlmConfig;
}): string[] {
  const args = [
    '--mode', 'rpc',
    '--session-id', options.sessionId,
    '--session-dir', piSessionDir(),
    '--extension', resolvePiExtensionEntry(),
  ];
  if (options.sessionName) args.push('--name', options.sessionName);
  if (options.llm?.provider) args.push('--provider', options.llm.provider);
  const model = options.requestedModel?.trim() || options.llm?.model;
  if (model) args.push('--model', model);
  if (options.effort) args.push('--thinking', options.effort);
  return args;
}

export function formatPiLaunchError(error: unknown, binary = resolvePiBinary()): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '')
    : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT' || /\bENOENT\b|not found/i.test(detail)) {
    return `Pi coding agent is not installed on this daemon host. Install it, then retry: ${PI_INSTALL_COMMAND}`;
  }
  return `failed to launch ${binary}: ${detail}`;
}
