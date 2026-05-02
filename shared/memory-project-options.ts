export const MEMORY_PROJECT_RESOLUTION_STATUSES = [
  'resolved',
  'needs_resolution',
  'canonical_only',
  'directory_only',
  'no_repo',
  'multiple_remotes',
  'unauthorized',
  'invalid_dir',
  'mismatch',
  'error',
] as const;

export type MemoryProjectResolutionStatus = (typeof MEMORY_PROJECT_RESOLUTION_STATUSES)[number];

export const MEMORY_PROJECT_OPTION_SOURCES = [
  'active_session',
  'recent_session',
  'enterprise_enrollment',
  'resolved_directory',
  'manual_resolved',
] as const;

export type MemoryProjectOptionSource = (typeof MEMORY_PROJECT_OPTION_SOURCES)[number];

export interface MemoryProjectOption {
  id: string;
  displayName: string;
  canonicalRepoId?: string;
  projectDir?: string;
  source: MemoryProjectOptionSource;
  status: MemoryProjectResolutionStatus;
  lastSeenAt?: number;
}

export interface MemoryProjectCapabilities {
  canFilterMemory: boolean;
  canRunLocalTools: boolean;
}

export function deriveMemoryProjectCapabilities(option: MemoryProjectOption | null | undefined): MemoryProjectCapabilities {
  const hasCanonicalRepoId = Boolean(option?.canonicalRepoId?.trim());
  const hasProjectDir = Boolean(option?.projectDir?.trim());
  const resolved = option?.status === 'resolved';
  return {
    canFilterMemory: hasCanonicalRepoId,
    canRunLocalTools: hasCanonicalRepoId && hasProjectDir && resolved,
  };
}

export interface MemoryProjectResolveResponsePayload {
  requestId?: string;
  success: boolean;
  projectDir?: string;
  canonicalRepoId?: string;
  displayName?: string;
  status: MemoryProjectResolutionStatus;
  error?: string;
  errorCode?: string;
}
