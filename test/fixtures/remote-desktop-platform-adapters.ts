import {
  REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
  type RemoteDesktopAdapterCapability,
} from '../../shared/remote-desktop-access.js';

export const REMOTE_DESKTOP_ADAPTER_CONTRACT_BEHAVIOR = {
  CANONICAL_BRANDING: 'canonical_branding',
  ACCOUNT_LOGIN_STEP_UP: 'account_login_step_up',
  PRIVACY_FRAME_INPUT_FENCING: 'privacy_frame_input_fencing',
  CONSENT_DEADLINE: 'consent_deadline',
  APPROVAL_DENY_CANCEL: 'approval_deny_cancel',
  SECRET_LIFECYCLE: 'secret_lifecycle',
  LOCAL_DISCLOSURE: 'local_disclosure',
  LOCAL_STOP: 'local_stop',
  LEASE_LOSS: 'lease_loss',
  GENERATION_REPLACEMENT: 'generation_replacement',
} as const;

export type RemoteDesktopAdapterContractBehavior = typeof REMOTE_DESKTOP_ADAPTER_CONTRACT_BEHAVIOR[
  keyof typeof REMOTE_DESKTOP_ADAPTER_CONTRACT_BEHAVIOR
];

export interface RemoteDesktopPlatformAdapterFixture {
  platform: 'windows' | 'macos' | 'linux';
  implementation: 'partial' | 'contract_only';
  /** Runtime facts, not aspirational requirements. */
  advertisedCapabilities: readonly RemoteDesktopAdapterCapability[];
  /** Every future adapter must pass the same behavioral contract. */
  requiredBehaviors: readonly RemoteDesktopAdapterContractBehavior[];
  /** Documentation only; tests never claim these permissions were granted. */
  requiredOsPermissions: readonly string[];
  permissionsQualified: false;
}

const REQUIRED_BEHAVIORS = Object.freeze(
  Object.values(REMOTE_DESKTOP_ADAPTER_CONTRACT_BEHAVIOR),
) as readonly RemoteDesktopAdapterContractBehavior[];

export const REMOTE_DESKTOP_PLATFORM_ADAPTER_FIXTURES = Object.freeze([
  {
    platform: 'windows',
    implementation: 'partial',
    advertisedCapabilities: Object.freeze([
      REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
      REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
    ]),
    requiredBehaviors: REQUIRED_BEHAVIORS,
    requiredOsPermissions: Object.freeze([
      'interactive desktop presentation',
      'desktop capture',
      'input injection',
      'protected-desktop detection',
    ]),
    permissionsQualified: false,
  },
  {
    platform: 'macos',
    implementation: 'contract_only',
    advertisedCapabilities: Object.freeze([]),
    requiredBehaviors: REQUIRED_BEHAVIORS,
    requiredOsPermissions: Object.freeze([
      'Screen Recording',
      'Accessibility',
      'interactive user notification or agent UI',
      'Keychain protected account-session storage',
    ]),
    permissionsQualified: false,
  },
  {
    platform: 'linux',
    implementation: 'contract_only',
    advertisedCapabilities: Object.freeze([]),
    requiredBehaviors: REQUIRED_BEHAVIORS,
    requiredOsPermissions: Object.freeze([
      'compositor-approved screen capture or desktop portal',
      'compositor-approved input injection',
      'interactive user notification or agent UI',
      'desktop-session protected account-session storage',
    ]),
    permissionsQualified: false,
  },
] satisfies readonly RemoteDesktopPlatformAdapterFixture[]);
