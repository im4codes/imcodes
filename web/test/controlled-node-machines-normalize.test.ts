import { afterEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetch(...args),
    getApiBaseUrl: () => 'https://example.test',
  };
});

import { listAvailableExecutables, mintControlledNodeExecutableTicket } from '../src/api/machines.js';

const VALID_SHA256 = 'a'.repeat(64);

afterEach(() => { vi.clearAllMocks(); });

describe('controlled-node availability normalization', () => {
  it('drops artifacts with null, short, or non-hex sha256', async () => {
    apiFetch.mockResolvedValueOnce({
      available: ['win'],
      artifacts: [
        { os: 'win', arch: 'x64', filename: 'missing.exe', sizeBytes: 1, sha256: null },
        { os: 'win', arch: 'x64', filename: 'short.exe', sizeBytes: 1, sha256: 'abc' },
        { os: 'win', arch: 'x64', filename: 'badhex.exe', sizeBytes: 1, sha256: `${'g'.repeat(64)}` },
        { os: 'win', arch: 'x64', filename: 'good.exe', sizeBytes: 1, sha256: VALID_SHA256 },
      ],
    });
    const res = await listAvailableExecutables();
    expect(res.artifacts).toEqual([
      { os: 'win', arch: 'x64', filename: 'good.exe', sizeBytes: 1, sha256: VALID_SHA256 },
    ]);
  });
});

describe('controlled-node ticket normalization', () => {
  it('rejects ticket responses when version is not exactly 2', async () => {
    apiFetch.mockResolvedValueOnce({
      ticket: 't',
      ticketId: 'id',
      os: 'win',
      arch: 'x64',
      filename: 'a.exe',
      sizeBytes: 1,
      sha256: 'x',
      expiresAt: Date.now(),
    });
    await expect(mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' }))
      .rejects.toThrow('invalid_ticket_response');
  });

  it('rejects ticket responses with invalid sha256', async () => {
    apiFetch.mockResolvedValueOnce({
      version: 2,
      ticket: 't',
      ticketId: 'id',
      os: 'win',
      arch: 'x64',
      filename: 'a.exe',
      sizeBytes: 1,
      sha256: 'abc',
      expiresAt: Date.now() + 60_000,
    });
    await expect(mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' }))
      .rejects.toThrow('invalid_ticket_response');
  });

  it('rejects ticket responses with non-canonical os+arch pair', async () => {
    apiFetch.mockResolvedValueOnce({
      version: 2,
      ticket: 't',
      ticketId: 'id',
      os: 'win',
      arch: 'arm64',
      filename: 'a.exe',
      sizeBytes: 1,
      sha256: VALID_SHA256,
      expiresAt: Date.now() + 60_000,
    });
    await expect(mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' }))
      .rejects.toThrow('invalid_ticket_response');
  });

  it('accepts ticket responses with explicit version 2', async () => {
    apiFetch.mockResolvedValueOnce({
      version: 2,
      ticket: 't',
      ticketId: 'id',
      os: 'win',
      arch: 'x64',
      filename: 'a.exe',
      sizeBytes: 1,
      sha256: VALID_SHA256,
      expiresAt: Date.now() + 60_000,
    });
    const ticket = await mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' });
    expect(ticket.version).toBe(2);
    expect(ticket.ticketId).toBe('id');
  });

  it('rejects non-canonical mint selection before calling the server', async () => {
    await expect(mintControlledNodeExecutableTicket({ os: 'win', arch: 'arm64' }))
      .rejects.toThrow('controlled_node_non_canonical_pair');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
