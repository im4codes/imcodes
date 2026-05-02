export const MEMORY_WS = {
  SEARCH: 'memory.search',
  SEARCH_RESPONSE: 'memory.search_response',
  ARCHIVE: 'memory.archive',
  ARCHIVE_RESPONSE: 'memory.archive_response',
  RESTORE: 'memory.restore',
  RESTORE_RESPONSE: 'memory.restore_response',
  DELETE: 'memory.delete',
  DELETE_RESPONSE: 'memory.delete_response',
  PERSONAL_QUERY: 'shared_context.personal_memory.query',
  PERSONAL_RESPONSE: 'shared_context.personal_memory.response',
  PROJECT_RESOLVE: 'memory.project.resolve',
  PROJECT_RESOLVE_RESPONSE: 'memory.project.resolve_response',
  FEATURES_QUERY: 'memory.features.query',
  FEATURES_RESPONSE: 'memory.features.response',
  PREF_QUERY: 'memory.preferences.query',
  PREF_RESPONSE: 'memory.preferences.response',
  PREF_CREATE: 'memory.preferences.create',
  PREF_CREATE_RESPONSE: 'memory.preferences.create_response',
  PREF_DELETE: 'memory.preferences.delete',
  PREF_DELETE_RESPONSE: 'memory.preferences.delete_response',
  SKILL_QUERY: 'memory.skills.query',
  SKILL_RESPONSE: 'memory.skills.response',
  SKILL_REBUILD: 'memory.skills.rebuild',
  SKILL_REBUILD_RESPONSE: 'memory.skills.rebuild_response',
  SKILL_READ: 'memory.skills.read',
  SKILL_READ_RESPONSE: 'memory.skills.read_response',
  SKILL_DELETE: 'memory.skills.delete',
  SKILL_DELETE_RESPONSE: 'memory.skills.delete_response',
  MD_INGEST_RUN: 'memory.md_ingest.run',
  MD_INGEST_RUN_RESPONSE: 'memory.md_ingest.run_response',
  OBSERVATION_QUERY: 'memory.observations.query',
  OBSERVATION_RESPONSE: 'memory.observations.response',
  OBSERVATION_PROMOTE: 'memory.observations.promote',
  OBSERVATION_PROMOTE_RESPONSE: 'memory.observations.promote_response',
} as const;

export type MemoryWsType = typeof MEMORY_WS[keyof typeof MEMORY_WS];

export const MEMORY_MANAGEMENT_REQUEST_TYPES = [
  MEMORY_WS.SEARCH,
  MEMORY_WS.ARCHIVE,
  MEMORY_WS.RESTORE,
  MEMORY_WS.DELETE,
  MEMORY_WS.PERSONAL_QUERY,
  MEMORY_WS.PROJECT_RESOLVE,
  MEMORY_WS.FEATURES_QUERY,
  MEMORY_WS.PREF_QUERY,
  MEMORY_WS.PREF_CREATE,
  MEMORY_WS.PREF_DELETE,
  MEMORY_WS.SKILL_QUERY,
  MEMORY_WS.SKILL_REBUILD,
  MEMORY_WS.SKILL_READ,
  MEMORY_WS.SKILL_DELETE,
  MEMORY_WS.MD_INGEST_RUN,
  MEMORY_WS.OBSERVATION_QUERY,
  MEMORY_WS.OBSERVATION_PROMOTE,
] as const satisfies readonly MemoryWsType[];

export const MEMORY_MANAGEMENT_RESPONSE_TYPES = [
  MEMORY_WS.ARCHIVE_RESPONSE,
  MEMORY_WS.RESTORE_RESPONSE,
  MEMORY_WS.DELETE_RESPONSE,
  MEMORY_WS.PERSONAL_RESPONSE,
  MEMORY_WS.PROJECT_RESOLVE_RESPONSE,
  MEMORY_WS.FEATURES_RESPONSE,
  MEMORY_WS.PREF_RESPONSE,
  MEMORY_WS.PREF_CREATE_RESPONSE,
  MEMORY_WS.PREF_DELETE_RESPONSE,
  MEMORY_WS.SKILL_RESPONSE,
  MEMORY_WS.SKILL_REBUILD_RESPONSE,
  MEMORY_WS.SKILL_READ_RESPONSE,
  MEMORY_WS.SKILL_DELETE_RESPONSE,
  MEMORY_WS.MD_INGEST_RUN_RESPONSE,
  MEMORY_WS.OBSERVATION_RESPONSE,
  MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE,
  MEMORY_WS.SEARCH_RESPONSE,
] as const;

const MEMORY_MANAGEMENT_REQUEST_TYPE_SET: ReadonlySet<string> = new Set(MEMORY_MANAGEMENT_REQUEST_TYPES);
const MEMORY_MANAGEMENT_RESPONSE_TYPE_SET: ReadonlySet<string> = new Set(MEMORY_MANAGEMENT_RESPONSE_TYPES);

export function isMemoryManagementRequestType(type: unknown): type is (typeof MEMORY_MANAGEMENT_REQUEST_TYPES)[number] {
  return typeof type === 'string' && MEMORY_MANAGEMENT_REQUEST_TYPE_SET.has(type);
}

export function isMemoryManagementResponseType(type: unknown): type is (typeof MEMORY_MANAGEMENT_RESPONSE_TYPES)[number] {
  return typeof type === 'string' && MEMORY_MANAGEMENT_RESPONSE_TYPE_SET.has(type);
}
