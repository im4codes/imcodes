import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  ProviderConfig,
  ProviderDelegationNotification,
  ProviderModelList,
} from '../transport-provider.js';
import { PROVIDER_ERROR_CODES } from '../transport-provider.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../../shared/hermes-agent.js';
import { KimiSdkProvider, type AcpCliProviderProfile } from './kimi-sdk.js';

const HERMES_CLI_NAME = 'hermes';

const HERMES_PROFILE: AcpCliProviderProfile = {
  id: HERMES_AGENT_PROVIDER_ID,
  displayName: 'Hermes Agent',
  binary: HERMES_CLI_NAME,
  args: ['acp'],
  approval: 'bridge',
  loadFailure: 'error',
  privacySafeErrors: true,
  // Hermes 0.20.x persists session/new but does not advertise session/close.
  // Populate the catalogue from real new/load/resume responses instead of
  // manufacturing uncloseable probe conversations from the model picker.
  modelDiscovery: 'session-metadata-only',
  resourceLinkAttachments: true,
  activePromptPrefix: '/steer ',
  compact: {
    execution: 'slash-command',
    providerCommand: '/compress',
    verified: true,
    completion: 'command-result',
    cancellation: 'provider-cancel',
    reason: 'The official Hermes ACP server advertises and handles /compress locally.',
  },
};

function configuredBinaryPath(config: ProviderConfig): string | undefined {
  const direct = typeof config.binaryPath === 'string' ? config.binaryPath.trim() : '';
  if (direct) return direct;
  const configured = process.env.HERMES_CLI_PATH?.trim();
  return configured || undefined;
}

/** Resolve official installer layouts even when a partial install completed
 *  before creating its PATH wrapper. */
export function resolveHermesBinaryPath(config: ProviderConfig): string {
  const configured = configuredBinaryPath(config);
  if (configured) return configured;

  const userHome = homedir();
  const executable = process.platform === 'win32' ? 'hermes.exe' : HERMES_CLI_NAME;
  const candidates = process.platform === 'win32'
    ? [
        path.join(userHome, '.hermes', 'hermes-agent', 'venv', 'Scripts', executable),
        path.join(userHome, '.hermes', 'bin', executable),
        path.join(userHome, '.local', 'bin', executable),
      ]
    : [
        path.join(userHome, '.hermes', 'bin', executable),
        path.join(userHome, '.local', 'bin', executable),
        path.join(userHome, '.hermes', 'hermes-agent', 'venv', 'bin', executable),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? HERMES_CLI_NAME;
}

/** Official Nous Research Hermes Agent transport over its stdio ACP server. */
export class HermesAcpProvider extends KimiSdkProvider {
  constructor() {
    super(HERMES_PROFILE);
    this.capabilities.activeDelegationNotification = AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE;
  }

  override async connect(config: ProviderConfig): Promise<void> {
    await super.connect({
      ...config,
      binaryPath: resolveHermesBinaryPath(config),
    });
  }

  notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    return this.queueActiveAcpPrompt(sessionId, notification);
  }

  override async listModels(force?: boolean): Promise<ProviderModelList> {
    const result = await super.listModels(force);
    if (result.models.length > 0) return result;
    return {
      ...result,
      isAuthenticated: false,
      error: 'No Hermes model is configured. Run `hermes model` and complete an official OAuth or provider setup, then refresh.',
    };
  }

  protected override async validateConnectedAgent(
    initializeResult: Record<string, unknown>,
    _config: ProviderConfig,
  ): Promise<void> {
    if (initializeResult.protocolVersion !== 1) {
      throw {
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: 'The installed Hermes Agent does not support the required ACP protocol version.',
        recoverable: false,
      };
    }
    const agentInfo = asRecord(initializeResult.agentInfo);
    if (agentInfo.name !== 'hermes-agent') {
      throw {
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: 'The configured executable is not the official Hermes Agent ACP server.',
        recoverable: false,
      };
    }
    const capabilities = asRecord(initializeResult.agentCapabilities);
    const sessionCapabilities = asRecord(capabilities.sessionCapabilities);
    if (capabilities.loadSession !== true
      || !isCapabilityObject(sessionCapabilities.list)
      || !isCapabilityObject(sessionCapabilities.resume)) {
      throw {
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: 'The installed Hermes Agent lacks required ACP session restore capabilities. Upgrade Hermes Agent and retry.',
        recoverable: false,
      };
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isCapabilityObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
