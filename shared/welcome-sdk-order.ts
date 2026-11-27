import { AGY_SDK_PROVIDER_ID } from './agy-agent.js';
import { CODEBUDDY_PROVIDER_IDS } from './codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from './hermes-agent.js';

export const WELCOME_FALLBACK_PROVIDER_ID = 'opencode-sdk' as const;

/**
 * Exact New Session dialog transport SDK probe priority order:
 * Antigravity -> Codex SDK -> Claude Code SDK -> remaining visible transport SDKs
 * (excluding hidden providers and OpenCode, which serves as the keyless fallback).
 */
export const WELCOME_SDK_PROBE_ORDER = [
  AGY_SDK_PROVIDER_ID,
  'codex-sdk',
  'claude-code-sdk',
  'qoder-sdk',
  'copilot-sdk',
  'cursor-headless',
  'grok-sdk',
  'kimi-sdk',
  'muse-code-sdk',
  HERMES_AGENT_PROVIDER_ID,
  'deepseek-harness',
  'pi',
  CODEBUDDY_PROVIDER_IDS.CHINA,
  CODEBUDDY_PROVIDER_IDS.INTERNATIONAL,
] as const;

export type WelcomePrimarySdkId = typeof WELCOME_SDK_PROBE_ORDER[number];
export type WelcomeCandidateSdkId = WelcomePrimarySdkId | typeof WELCOME_FALLBACK_PROVIDER_ID;
