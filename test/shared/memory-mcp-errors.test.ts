import { describe, expect, it } from 'vitest';
import {
  MCP_ERROR_REASONS,
  RECOVERABLE_MCP_ERROR_REASONS,
  isRecoverableMcpErrorReason,
  type MCPErrorReason,
} from '../../shared/memory-mcp-errors.js';

describe('memory MCP error reasons', () => {
  it('pins the exact ordered reason set (incl. machine remote-exec reasons)', () => {
    expect(Object.values(MCP_ERROR_REASONS)).toEqual([
      'invalid_namespace',
      'feature_disabled',
      'identity_rejected',
      'write_quota_exceeded',
      'scope_forbidden',
      'projection_unavailable',
      'validation_failed',
      'rate_limited',
      'internal_error',
      // Machine remote-exec (list_machines / exec_remote) — controlled-node-remote-exec 10.12.
      'machine_not_found',
      'machine_ambiguous',
      'exec_offline',
      'exec_disabled',
      // A bound daemon's machine control plane (list/exec API) is unreachable or
      // returned an unusable response — distinct from "no machines"/"not found".
      'control_plane_unavailable',
    ] satisfies MCPErrorReason[]);
  });

  it('pins recoverable reasons and rejects terminal or unknown values', () => {
    expect([...RECOVERABLE_MCP_ERROR_REASONS]).toEqual([
      'feature_disabled',
      'projection_unavailable',
      'rate_limited',
      'control_plane_unavailable',
    ]);
    for (const reason of Object.values(MCP_ERROR_REASONS)) {
      expect(isRecoverableMcpErrorReason(reason)).toBe(RECOVERABLE_MCP_ERROR_REASONS.has(reason));
    }
    for (const value of [undefined, null, 1, '', 'quick_search_disabled', 'send_disabled']) {
      expect(isRecoverableMcpErrorReason(value)).toBe(false);
    }
  });
});
