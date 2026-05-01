import type { MemoryFeatureFlag } from './feature-flags.js';
import type { MemoryScope } from './memory-scope.js';
import type { ObservationClass, ObservationState } from './memory-observation.js';
import type { MemoryOrigin } from './memory-origin.js';
import type { SkillRegistryEntry } from './skill-registry-types.js';

export const MEMORY_MANAGEMENT_ERROR_CODES = {
  ACTION_FAILED: 'action_failed',
  FEATURE_DISABLED: 'feature_disabled',
  MISSING_PREFERENCE_TEXT: 'missing_preference_text',
  MISSING_ID: 'missing_id',
  PREFERENCE_NOT_FOUND: 'preference_not_found',
  PREFERENCE_FORBIDDEN_OWNER: 'preference_forbidden_owner',
  MISSING_PROJECT_DIR: 'missing_project_dir',
  MISSING_PROJECT_IDENTITY: 'missing_project_identity',
  INVALID_PROJECT_DIR: 'invalid_project_dir',
  PROJECT_IDENTITY_MISMATCH: 'project_identity_mismatch',
  INVALID_TARGET_SCOPE: 'invalid_target_scope',
  PROMOTION_REQUIRES_AUTHORIZATION: 'promotion_requires_authorization',
  MISSING_EXPECTED_FROM_SCOPE: 'missing_expected_from_scope',
  OBSERVATION_FROM_SCOPE_MISMATCH: 'observation_from_scope_mismatch',
  OBSERVATION_QUERY_FORBIDDEN: 'observation_query_forbidden',
  UNSUPPORTED_MD_INGEST_SCOPE: 'unsupported_md_ingest_scope',
  MANAGEMENT_REQUEST_UNROUTED: 'management_request_unrouted',
  SKILL_PATH_NOT_READABLE: 'skill_path_not_readable',
  SKILL_FILE_TOO_LARGE: 'skill_file_too_large',
  SKILL_NOT_FOUND: 'skill_not_found',
  SKILL_OUTSIDE_MANAGED_ROOTS: 'skill_outside_managed_roots',
  REGISTRY_FILE_TOO_LARGE: 'registry_file_too_large',
  REGISTRY_ENTRY_LIMIT_EXCEEDED: 'registry_entry_limit_exceeded',
} as const;

export type MemoryManagementErrorCode = (typeof MEMORY_MANAGEMENT_ERROR_CODES)[keyof typeof MEMORY_MANAGEMENT_ERROR_CODES];

export const MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES = {
  UNAUTHENTICATED: 'memory_management_unauthenticated',
  TOO_MANY_PENDING_REQUESTS: 'too_many_memory_management_requests',
  MISSING_REQUEST_ID: 'missing_request_id',
  DUPLICATE_REQUEST_ID: 'duplicate_request_id',
  CONTEXT_INJECTION_FAILED: 'context_injection_failed',
} as const;

export type MemoryManagementBridgeErrorCode = (typeof MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES)[keyof typeof MEMORY_MANAGEMENT_BRIDGE_ERROR_CODES];

export interface MemoryFeatureAdminRecord {
  flag: MemoryFeatureFlag;
  enabled: boolean;
  disabledBehavior: string;
}

export interface MemoryFeatureAdminResponse {
  requestId?: string;
  records: MemoryFeatureAdminRecord[];
}

export interface MemoryPreferenceAdminRecord {
  id: string;
  userId: string;
  text: string;
  fingerprint: string;
  origin: MemoryOrigin;
  state: ObservationState;
  updatedAt: number;
  createdAt: number;
}

export interface MemoryPreferenceAdminResponse {
  requestId?: string;
  records: MemoryPreferenceAdminRecord[];
  featureEnabled?: boolean;
}

export interface MemorySkillAdminRecord {
  key: string;
  layer: string;
  name: string;
  category: string;
  description?: string;
  displayPath: string;
  uri: string;
  fingerprint: string;
  updatedAt: number;
  enforcement?: string;
  project?: SkillRegistryEntry['project'];
}

export interface MemorySkillAdminResponse {
  requestId?: string;
  entries: MemorySkillAdminRecord[];
  sourceCounts?: Record<string, number>;
  featureEnabled?: boolean;
}

export interface MemoryObservationAdminRecord {
  id: string;
  scope: MemoryScope;
  class: ObservationClass;
  origin: MemoryOrigin;
  state: ObservationState;
  text: string;
  fingerprint: string;
  namespaceId: string;
  projectionId?: string;
  updatedAt: number;
  createdAt: number;
}

export interface MemoryObservationAdminResponse {
  requestId?: string;
  records: MemoryObservationAdminRecord[];
  featureEnabled?: boolean;
}
