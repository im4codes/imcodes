import type {
  ProviderConfig, ProviderDelegationNotification, SessionConfig, TransportProvider,
} from '../transport-provider.js';
import { PROVIDER_ERROR_CODES } from '../transport-provider.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import {
  AGY_SDK_PROVIDER_ID, AGY_CLI_BINARY, AGY_CLI_FLAG, AGY_NATIVE_START_NOT_ATTEMPTED,
  AGY_ACP_AGENT_NAME, AGY_ACP_COMMAND, AGY_DEFAULT_MODEL_ID,
} from '../../../shared/agy-agent.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';
import { execFileOffMain } from '../../util/exec-helper.js';
import logger from '../../util/logger.js';
import { AgySdkProvider, resolveAgyBinary } from './agy-sdk.js';
import { KimiSdkProvider, type AcpCliProviderProfile } from './kimi-sdk.js';

const PROFILE: AcpCliProviderProfile = {
  id: AGY_SDK_PROVIDER_ID,
  displayName: 'Antigravity',
  binary: AGY_CLI_BINARY,
  args: [AGY_ACP_COMMAND, '--process-per-session', AGY_CLI_FLAG.SKIP_PERMISSIONS],
  defaultModel: AGY_DEFAULT_MODEL_ID,
  approval: 'auto-allow',
  loadFailure: 'error',
  resumeWithoutReplay: true,
  steeringPrompts: true,
  strictModelSelection: true,
  privacySafeErrors: true,
  modelDiscovery: 'session-metadata-only',
  // Keep the existing text-only attachment contract. Native ACP images can be
  // enabled separately once local attachment encoding has been verified.
  compact: {
    execution: 'slash-command', providerCommand: '/compact', verified: true,
    completion: 'command-result', cancellation: 'provider-cancel', reassertsSessionSystemText: true,
    reason: 'AG 1.5.6 ACP advertises compact and a real isolated RPC produces a native SYSTEM compaction checkpoint.',
  },
};

export function supportsAgyAcp(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(version.trim());
  return !!match && (Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 5));
}

/** Official AG ACP. Older stream-json stays a separate implementation, never
 * a retry after ACP authentication, resume, network or prompt failures. */
export class AgyAcpProvider extends KimiSdkProvider {
  constructor(private readonly probedBinary?: ReturnType<typeof resolveAgyBinary>) {
    super(PROFILE);
    this.capabilities.nativeAgentAdmission = NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE;
  }

  protected override resolveAcpExecutable(config: ProviderConfig): ReturnType<typeof resolveAgyBinary> {
    // Freeze the complete entrypoint/argv chosen for --version, including any
    // Windows shim's Node script argument. Direct adapter use shares AG's
    // existing env/HOME candidate resolver as well.
    return this.probedBinary ?? resolveAgyBinary(config);
  }

  protected override async validateConnectedAgent(result: Record<string, unknown>): Promise<void> {
    const agent = result.agentInfo as { name?: unknown; version?: unknown } | undefined;
    const caps = result.agentCapabilities as { loadSession?: unknown; sessionCapabilities?: { resume?: unknown } } | undefined;
    if (result.protocolVersion !== 1 || agent?.name !== AGY_ACP_AGENT_NAME
      || typeof agent.version !== 'string' || !supportsAgyAcp(agent.version)
      || caps?.loadSession !== true || !caps.sessionCapabilities?.resume) {
      throw { code: PROVIDER_ERROR_CODES.CONFIG_ERROR, message: 'The installed Antigravity ACP server lacks the required version or restore capabilities.', recoverable: false };
    }
    // Published only after a real handshake with the supported native server.
    this.capabilities.activeDelegationNotification = AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE;
  }

  override async createSession(config: SessionConfig): Promise<string> {
    const barrier = config.beforeNativeSessionStart;
    return super.createSession({ ...config, ...(barrier ? {
      beforeNativeSessionStart: async () => {
        try { await barrier(); }
        catch {
          throw {
            code: PROVIDER_ERROR_CODES.CANCELLED,
            message: 'AG native session start was not attempted because its durable owner check failed.',
            recoverable: false,
            details: { [AGY_NATIVE_START_NOT_ATTEMPTED]: true },
          };
        }
      },
    } : {}) });
  }

  applySessionModel(sessionId: string, model: string) {
    return this.applyStrictSessionModel(sessionId, model);
  }

  notifyActiveDelegation(sessionId: string, notification: ProviderDelegationNotification): Promise<AgentDelegationNotificationResult> {
    return this.queueActiveAcpPrompt(sessionId, notification);
  }
}

export async function createAgyProvider(config: ProviderConfig): Promise<TransportProvider> {
  const binary = resolveAgyBinary(config);
  // Version-only detection makes NO native session. Unknown/old installations
  // retain their old FIFO rather than claiming steering or retrying a prompt.
  const { stdout } = await execFileOffMain(binary.executable, [...binary.prependArgs, '--version'], {
    timeout: 15_000, env: { ...process.env, ...(config.env as Record<string, string> | undefined) },
  });
  if (supportsAgyAcp(stdout)) return new AgyAcpProvider(binary);
  logger.warn({ provider: AGY_SDK_PROVIDER_ID }, 'Antigravity CLI has no verified ACP steering support; retaining stream-json FIFO');
  return new AgySdkProvider();
}
