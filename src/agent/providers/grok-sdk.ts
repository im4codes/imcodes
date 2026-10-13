import type { Agent as AcpAgent, NewSessionResponse } from '@agentclientprotocol/sdk';
import type {
  ProviderConfig,
  ProviderDelegationNotification,
} from '../transport-provider.js';
import { PROVIDER_ERROR_CODES } from '../transport-provider.js';
import { normalizeTransportCwd, resolveGrokPathForSdk } from '../transport-paths.js';
import { KimiSdkProvider, type AcpCliProviderProfile } from './kimi-sdk.js';
import {
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_PROVIDERS,
} from '../../../shared/sdk-subagent-status.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';

export const GROK_CLI_PATH_ENV = 'GROK_CLI_PATH';
export const GROK_CLI_BINARY = 'grok';

/** Resolve the `grok` executable to spawn, honoring `config.binaryPath`, `GROK_CLI_PATH`, candidate directories, and PATH. */
export function resolveGrokBinaryPath(config?: ProviderConfig | { binaryPath?: string } | null): string {
  const direct = typeof config?.binaryPath === 'string' ? config.binaryPath.trim() : '';
  const raw = direct || process.env[GROK_CLI_PATH_ENV]?.trim() || GROK_CLI_BINARY;
  return resolveGrokPathForSdk(raw);
}

const GROK_PROFILE: AcpCliProviderProfile = {
  id: 'grok-sdk',
  displayName: 'Grok',
  binary: GROK_CLI_BINARY,
  args: ['--no-auto-update', 'agent', 'stdio'],
  approval: 'bridge',
  loadFailure: 'error',
  compact: {
    execution: 'slash-command',
    providerCommand: '/compact',
    verified: true,
    completion: 'command-result',
    cancellation: 'provider-cancel',
    reason: 'Negotiated from the official Grok Build ACP availableCommands list.',
  },
  probeOnConnect: true,
  privacySafeErrors: true,
  runtimeSubagent: {
    provider: SDK_SUBAGENT_PROVIDERS.GROK_SDK,
    providerKind: SDK_SUBAGENT_PROVIDER_KINDS.GROK_RUNTIME_AGENT,
    action: 'grok-runtime-subagent',
  },
};

/**
 * Official xAI Grok Build transport. The protocol mechanics are shared with
 * the mature ACP implementation used by Kimi, while this profile deliberately
 * changes authentication validation, permission handling, resume failures,
 * process arguments, and prerequisite messages.
 */
export class GrokSdkProvider extends KimiSdkProvider {
  constructor() {
    super(GROK_PROFILE);
    this.capabilities.activeDelegationNotification = AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE;
  }

  override async connect(config: ProviderConfig): Promise<void> {
    await super.connect({
      ...config,
      binaryPath: resolveGrokBinaryPath(config),
    });
  }

  protected override resolveBinaryPath(config: ProviderConfig | null): string {
    return resolveGrokBinaryPath(config);
  }

  notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    return this.queueActiveAcpPrompt(sessionId, notification);
  }

  protected override async validateConnectedAgent(
    initializeResult: Record<string, unknown>,
    config: ProviderConfig,
  ): Promise<void> {
    if (initializeResult.protocolVersion !== 1) {
      throw {
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: 'The installed Grok CLI does not support the required ACP protocol version.',
        recoverable: false,
      };
    }

    const agentCapabilities = asRecord(initializeResult.agentCapabilities);
    if (agentCapabilities.loadSession !== true) {
      throw {
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: 'The installed Grok CLI does not advertise ACP session restore support.',
        recoverable: false,
      };
    }

    const meta = asRecord(initializeResult._meta);
    const commands = Array.isArray(meta.availableCommands) ? meta.availableCommands : [];
    if (!commands.some((entry) => asRecord(entry).name === 'compact')) {
      this.capabilities.compact = {
        execution: 'unsupported',
        verified: true,
        completion: 'none',
        cancellation: 'none',
        reason: 'The effective Grok ACP server did not advertise the compact command.',
      };
    }

    const methods = Array.isArray(initializeResult.authMethods)
      ? initializeResult.authMethods.map((method) => asRecord(method).id).filter((id): id is string => typeof id === 'string')
      : [];
    const configuredMethod = typeof config.authMethodId === 'string' ? config.authMethodId : undefined;
    if (configuredMethod && !methods.includes(configuredMethod)) {
      throw {
        code: PROVIDER_ERROR_CODES.AUTH_FAILED,
        message: 'The configured Grok authentication method is not advertised by the installed CLI.',
        recoverable: false,
      };
    }

    const apiKey = (config.env as Record<string, string> | undefined)?.XAI_API_KEY ?? process.env.XAI_API_KEY;
    if (apiKey && methods.includes('xai.api_key')) {
      const authenticate = (this.connection as AcpAgent).authenticate;
      if (typeof authenticate === 'function') {
        await authenticate.call(this.connection, { methodId: 'xai.api_key' });
      }
    }

    // A temporary MCP-free session is the only reliable cross-auth-method
    // readiness check: initialize intentionally advertises login methods even
    // when cached Grok credentials are already valid.
    try {
      const probe: NewSessionResponse = await this.connection!.newSession({
        cwd: normalizeTransportCwd(process.cwd()) ?? process.cwd(),
        mcpServers: [],
      });
      this.cacheModelsFromSessionResponse(probe);
      const closer = (this.connection as AcpAgent).closeSession;
      if (typeof closer === 'function') {
        await closer.call(this.connection, { sessionId: probe.sessionId }).catch(() => {});
      }
    } catch {
      throw {
        code: PROVIDER_ERROR_CODES.AUTH_FAILED,
        message: 'Grok authentication is required. Run `grok login` or configure XAI_API_KEY using an authentication method advertised by the official CLI.',
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
