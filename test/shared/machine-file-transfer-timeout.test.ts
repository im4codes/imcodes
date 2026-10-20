import { describe, expect, it } from 'vitest';
import {
  FILE_TRANSFER_MCP_TIMEOUT,
  fileTransferMcpTimeoutMs,
} from '../../shared/transport/file-transfer.js';

describe('machine file MCP timeout budget', () => {
  it('keeps the old short request timeout from expiring a 30 MB transfer', () => {
    const timeout = fileTransferMcpTimeoutMs(30 * 1024 * 1024);
    expect(timeout).toBeGreaterThan(120_000);
    expect(timeout).toBeGreaterThanOrEqual(FILE_TRANSFER_MCP_TIMEOUT.MIN_MS);
  });

  it('scales with payload size and remains capped for a stalled transfer', () => {
    const small = fileTransferMcpTimeoutMs(1 * 1024 * 1024);
    const large = fileTransferMcpTimeoutMs(200 * 1024 * 1024);
    expect(large).toBeGreaterThan(small);
    expect(fileTransferMcpTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(FILE_TRANSFER_MCP_TIMEOUT.MAX_MS);
    expect(fileTransferMcpTimeoutMs(undefined)).toBe(FILE_TRANSFER_MCP_TIMEOUT.MIN_MS);
  });
});
