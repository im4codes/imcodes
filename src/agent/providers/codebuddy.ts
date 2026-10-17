import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ProviderConfig, SessionConfig } from '../transport-provider.js';
import type {
  ProviderDelegationNotification,
} from '../transport-provider.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import {
  CODEBUDDY_CHINA_DEFAULT_MODEL,
  CODEBUDDY_CLI_PATH_ENVIRONMENT_VARIABLE,
  CODEBUDDY_ENVIRONMENT_VARIABLE,
  CODEBUDDY_PROVIDER_IDS,
  CODEBUDDY_REGIONS,
  type CodeBuddyProviderId,
  type CodeBuddyRegion,
} from '../../../shared/codebuddy.js';
import { KimiSdkProvider, type AcpCliProviderProfile } from './kimi-sdk.js';

const CODEBUDDY_CLI_NAME = 'codebuddy';
const WORKBUDDY_MACOS_CLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
const CODEBUDDY_DEFERRED_QUEUE_ENVIRONMENT_VARIABLE = 'CODEBUDDY_CODE_MESSAGE_QUEUE_DEFERRED_DISPATCH';

function profile(providerId: CodeBuddyProviderId, displayName: string): AcpCliProviderProfile {
  return {
    id: providerId,
    displayName,
    binary: CODEBUDDY_CLI_NAME,
    args: ['--acp'],
    approval: 'bridge',
    loadFailure: 'error',
    privacySafeErrors: true,
    compact: {
      execution: 'slash-command',
      providerCommand: '/compact',
      verified: true,
      completion: 'command-result',
      cancellation: 'provider-cancel',
      reason: 'The official CodeBuddy CLI advertises /compact through its ACP command catalog.',
    },
  };
}

function configuredBinaryPath(config: ProviderConfig): string | undefined {
  const direct = typeof config.binaryPath === 'string' ? config.binaryPath.trim() : '';
  if (direct) return direct;
  const configured = process.env[CODEBUDDY_CLI_PATH_ENVIRONMENT_VARIABLE]?.trim();
  return configured || undefined;
}

function bundledChinaCli(): string | undefined {
  if (process.platform === 'darwin' && existsSync(WORKBUDDY_MACOS_CLI)) return WORKBUDDY_MACOS_CLI;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      const candidates = [
        path.join(localAppData, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy.exe'),
        path.join(localAppData, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy.exe'),
      ];
      const found = candidates.find((candidate) => existsSync(candidate));
      if (found) return found;
    }
  }
  return undefined;
}

function installedUserCli(): string | undefined {
  const name = process.platform === 'win32' ? 'codebuddy.exe' : CODEBUDDY_CLI_NAME;
  const candidate = path.join(homedir(), '.local', 'bin', name);
  return existsSync(candidate) ? candidate : undefined;
}

export function resolveCodeBuddyBinaryPath(region: CodeBuddyRegion, config: ProviderConfig): string {
  const configured = configuredBinaryPath(config);
  if (configured) return configured;
  // The China WorkBuddy desktop login is intentionally separate from the
  // international standalone CLI login. Prefer its bundled CLI only for the
  // China provider so selecting one region can never consume the other's auth.
  if (region === CODEBUDDY_REGIONS.CHINA) {
    const bundled = bundledChinaCli();
    if (bundled) return bundled;
  }
  return installedUserCli() ?? CODEBUDDY_CLI_NAME;
}

abstract class CodeBuddyProvider extends KimiSdkProvider {
  protected constructor(
    providerId: CodeBuddyProviderId,
    displayName: string,
    private readonly region: CodeBuddyRegion,
    private readonly defaultModel?: string,
  ) {
    super(profile(providerId, displayName));
    this.capabilities.activeDelegationNotification = AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE;
  }

  override async connect(config: ProviderConfig): Promise<void> {
    const env = config.env && typeof config.env === 'object'
      ? config.env as Record<string, string>
      : {};
    await super.connect({
      ...config,
      binaryPath: resolveCodeBuddyBinaryPath(this.region, config),
      env: {
        ...env,
        [CODEBUDDY_ENVIRONMENT_VARIABLE]: this.region,
        // ACP submits an active-turn append as a second prompt. CodeBuddy's
        // deferred rich-queue mode accepts that prompt but does not drain it
        // through the ACP tool-continuation path. Its standard queue keeps the
        // documented "next" behavior and drains at the next model boundary.
        [CODEBUDDY_DEFERRED_QUEUE_ENVIRONMENT_VARIABLE]: 'false',
      },
    });
  }

  override createSession(config: SessionConfig): Promise<string> {
    return super.createSession({
      ...config,
      agentId: config.agentId ?? this.defaultModel,
    });
  }

  notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    return this.queueActiveAcpPrompt(sessionId, notification);
  }
}

export class CodeBuddyChinaProvider extends CodeBuddyProvider {
  constructor() {
    super(
      CODEBUDDY_PROVIDER_IDS.CHINA,
      'CodeBuddy China',
      CODEBUDDY_REGIONS.CHINA,
      CODEBUDDY_CHINA_DEFAULT_MODEL,
    );
  }
}

export class CodeBuddyInternationalProvider extends CodeBuddyProvider {
  constructor() {
    super(
      CODEBUDDY_PROVIDER_IDS.INTERNATIONAL,
      'CodeBuddy International',
      CODEBUDDY_REGIONS.INTERNATIONAL,
    );
  }
}
