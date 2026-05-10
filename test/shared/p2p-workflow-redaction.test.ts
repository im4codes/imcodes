import { describe, expect, it } from 'vitest';
import {
  redactP2pWorkflowObjectForProjection,
  redactP2pWorkflowTextForProjection,
} from '../../shared/p2p-workflow-redaction.js';

describe('p2p workflow redaction facade', () => {
  it('applies raw cap, redaction, then projection cap', () => {
    const redacted = redactP2pWorkflowTextForProjection(
      `Bearer ${'a'.repeat(40)} tail`,
      { rawCaptureMaxBytes: 100, projectionSnippetMaxBytes: 80 },
    );
    expect(redacted).toContain('[REDACTED:bearer]');
    expect(redacted).not.toContain('Bearer');
    expect(new TextEncoder().encode(redacted).byteLength).toBeLessThanOrEqual(80);
  });

  it('redacts sensitive object keys using shared logging redaction', () => {
    const redacted = redactP2pWorkflowObjectForProjection({
      keep: 'value',
      access_token: 'secret',
      nested: { api_key: 'secret' },
    });
    expect(redacted).toEqual({
      keep: 'value',
      access_token: '[REDACTED]',
      nested: { api_key: '[REDACTED]' },
    });
  });
});
