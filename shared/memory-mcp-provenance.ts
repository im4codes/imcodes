export const MEMORY_MCP_SOURCE_FIELDS = {
  SOURCE_SESSION_NAME: 'sourceSessionName',
  SOURCE_PROJECT_NAME: 'sourceProjectName',
  SOURCE_SERVER_ID: 'sourceServerId',
} as const;

export interface MemoryMcpSourceProvenance {
  readonly sourceSessionName?: string;
  readonly sourceProjectName?: string;
  readonly sourceServerId?: string;
}

export interface MemoryMcpSourceProvenanceInput {
  readonly sessionName?: string | null;
  readonly projectName?: string | null;
  readonly serverId?: string | null;
  readonly sourceSessionName?: string | null;
  readonly sourceProjectName?: string | null;
  readonly sourceServerId?: string | null;
}

function cleanOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildMemoryMcpSourceProvenance(input: MemoryMcpSourceProvenanceInput): MemoryMcpSourceProvenance {
  const sourceSessionName = cleanOptional(input.sourceSessionName) ?? cleanOptional(input.sessionName);
  const sourceProjectName = cleanOptional(input.sourceProjectName) ?? cleanOptional(input.projectName);
  const sourceServerId = cleanOptional(input.sourceServerId) ?? cleanOptional(input.serverId);
  return {
    ...(sourceSessionName ? { sourceSessionName } : {}),
    ...(sourceProjectName ? { sourceProjectName } : {}),
    ...(sourceServerId ? { sourceServerId } : {}),
  };
}

export function attachMemoryMcpSourceProvenance<T extends Record<string, unknown>>(
  content: T,
  provenance: MemoryMcpSourceProvenance,
): T & Record<string, unknown> & MemoryMcpSourceProvenance {
  return {
    ...content,
    ...(provenance.sourceSessionName ? { [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SESSION_NAME]: provenance.sourceSessionName } : {}),
    ...(provenance.sourceProjectName ? { [MEMORY_MCP_SOURCE_FIELDS.SOURCE_PROJECT_NAME]: provenance.sourceProjectName } : {}),
    ...(provenance.sourceServerId ? { [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SERVER_ID]: provenance.sourceServerId } : {}),
  };
}

export function stripMemoryMcpSourceProvenance<T extends Record<string, unknown>>(content: T): T {
  const {
    [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SESSION_NAME]: _sourceSessionName,
    [MEMORY_MCP_SOURCE_FIELDS.SOURCE_PROJECT_NAME]: _sourceProjectName,
    [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SERVER_ID]: _sourceServerId,
    ...rest
  } = content;
  return rest as T;
}
