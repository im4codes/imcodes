import { isControlledNodeId } from './controlled-node-identity.js';

export const VERIFICATION_MACHINE_API_PATH = '/api/verification-machines';

export const VERIFICATION_MACHINE_SCOPES = {
  USER: 'user',
  PROJECT: 'project',
} as const;

export type VerificationMachineScope =
  typeof VERIFICATION_MACHINE_SCOPES[keyof typeof VERIFICATION_MACHINE_SCOPES];

export const VERIFICATION_MACHINE_SCOPE_LIST = Object.freeze(
  Object.values(VERIFICATION_MACHINE_SCOPES),
) as readonly VerificationMachineScope[];

export const VERIFICATION_MACHINE_KINDS = {
  CONTROLLED_NODE: 'controlled_node',
  SSH: 'ssh',
} as const;

export type VerificationMachineKind =
  typeof VERIFICATION_MACHINE_KINDS[keyof typeof VERIFICATION_MACHINE_KINDS];

export const VERIFICATION_MACHINE_KIND_LIST = Object.freeze(
  Object.values(VERIFICATION_MACHINE_KINDS),
) as readonly VerificationMachineKind[];

export const VERIFICATION_MACHINE_STATUSES = {
  UNVERIFIED: 'unverified',
  VERIFIED: 'verified',
  UNREACHABLE: 'unreachable',
  UNAUTHORIZED: 'unauthorized',
} as const;

export type VerificationMachineStatus =
  typeof VERIFICATION_MACHINE_STATUSES[keyof typeof VERIFICATION_MACHINE_STATUSES];

export const VERIFICATION_MACHINE_STATUS_LIST = Object.freeze(
  Object.values(VERIFICATION_MACHINE_STATUSES),
) as readonly VerificationMachineStatus[];

export const VERIFICATION_MACHINE_MCP_TOOLS = {
  LIST: 'verification_machine_list',
  SET: 'verification_machine_set',
  REMOVE: 'verification_machine_remove',
  VERIFY: 'verification_machine_verify',
} as const;

export const VERIFICATION_MACHINE_LIMITS = {
  MAX_ITEMS: 100,
  ALIAS_MAX_CHARS: 80,
  SCOPE_KEY_MAX_CHARS: 512,
  TARGET_MAX_CHARS: 255,
} as const;

export interface VerificationMachineProfile {
  id: string;
  scope: VerificationMachineScope;
  scopeKey: string;
  alias: string;
  kind: VerificationMachineKind;
  target: string;
  enabled: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
  lastVerificationStatus: VerificationMachineStatus;
  source: 'web' | 'mcp';
}

export function isVerificationMachineId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
}

export function isVerificationMachineScope(value: unknown): value is VerificationMachineScope {
  return typeof value === 'string'
    && (VERIFICATION_MACHINE_SCOPE_LIST as readonly string[]).includes(value);
}

export function isVerificationMachineKind(value: unknown): value is VerificationMachineKind {
  return typeof value === 'string'
    && (VERIFICATION_MACHINE_KIND_LIST as readonly string[]).includes(value);
}

export function verificationMachineScopeKeyError(
  scope: VerificationMachineScope,
  value: unknown,
): string | null {
  if (scope === VERIFICATION_MACHINE_SCOPES.USER) {
    return value === undefined || value === null || value === ''
      ? null
      : 'verification_machine_scope_key_forbidden';
  }
  if (typeof value !== 'string' || !value.trim()) return 'verification_machine_scope_key_required';
  const normalized = value.trim();
  return Array.from(normalized).length <= VERIFICATION_MACHINE_LIMITS.SCOPE_KEY_MAX_CHARS
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? null
    : 'verification_machine_scope_key_invalid';
}

export function normalizeVerificationMachineAlias(value: string): string {
  return value.normalize('NFC').trim();
}

export function verificationMachineAliasError(value: unknown): string | null {
  if (typeof value !== 'string' || !normalizeVerificationMachineAlias(value)) {
    return 'verification_machine_alias_required';
  }
  const normalized = normalizeVerificationMachineAlias(value);
  if (Array.from(normalized).length > VERIFICATION_MACHINE_LIMITS.ALIAS_MAX_CHARS
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return 'verification_machine_alias_invalid';
  }
  return null;
}

export function normalizeVerificationMachineTarget(value: string): string {
  return value.normalize('NFC').trim();
}

export function verificationMachineTargetError(
  kind: VerificationMachineKind,
  value: unknown,
): string | null {
  if (typeof value !== 'string' || !normalizeVerificationMachineTarget(value)) {
    return 'verification_machine_target_required';
  }
  const normalized = normalizeVerificationMachineTarget(value);
  if (Array.from(normalized).length > VERIFICATION_MACHINE_LIMITS.TARGET_MAX_CHARS) {
    return 'verification_machine_target_invalid';
  }
  if (kind === VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE) {
    return isControlledNodeId(normalized) ? null : 'verification_machine_target_invalid';
  }
  // SSH config Host token only. Never accept command-line options, whitespace,
  // paths or shell metacharacters; the daemon invokes ssh without a shell.
  return /^[A-Za-z0-9_.:@%+-]+$/u.test(normalized)
    ? null
    : 'verification_machine_target_invalid';
}
