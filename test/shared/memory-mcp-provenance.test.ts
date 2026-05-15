import { describe, expect, it } from 'vitest';
import {
  MEMORY_MCP_SOURCE_FIELDS,
  attachMemoryMcpSourceProvenance,
  buildMemoryMcpSourceProvenance,
} from '../../shared/memory-mcp-provenance.js';

describe('memory MCP source provenance', () => {
  it('normalizes runtime source fields and omits absent values', () => {
    expect(buildMemoryMcpSourceProvenance({
      sessionName: ' deck_sub_worker ',
      projectName: 'proj',
      serverId: '',
    })).toEqual({
      sourceSessionName: 'deck_sub_worker',
      sourceProjectName: 'proj',
    });
  });

  it('attaches source fields through shared field-name constants', () => {
    expect(attachMemoryMcpSourceProvenance({ text: 'remember' }, {
      sourceSessionName: 'deck_sub_worker',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-1',
    })).toEqual({
      text: 'remember',
      [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SESSION_NAME]: 'deck_sub_worker',
      [MEMORY_MCP_SOURCE_FIELDS.SOURCE_PROJECT_NAME]: 'proj',
      [MEMORY_MCP_SOURCE_FIELDS.SOURCE_SERVER_ID]: 'srv-1',
    });
  });
});
