import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetch(...args),
    getApiBaseUrl: () => 'https://example.test',
  };
});

import { listAvailableExecutables, listControllableMachines, mintControlledNodeExecutableTicket } from '../src/api/machines.js';
import { configureExpectedUserId } from '../src/api.js';

const VALID_SHA256 = 'a'.repeat(64);

beforeEach(() => { configureExpectedUserId('user-rock'); });
afterEach(() => {
  configureExpectedUserId(null);
  vi.clearAllMocks();
});

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

describe('controlled-node access-role normalization', () => {
  it('preserves valid shared roles, defaults an old-server omission to owner, and fails malformed roles closed', async () => {
    apiFetch.mockResolvedValueOnce({
      machines: [
        { serverId: 'participant', refName: 'p', displayName: 'P', online: true, execEnabled: true, accessRole: 'participant' },
        { serverId: 'legacy-owner', refName: 'o', displayName: 'O', online: true, execEnabled: true },
        { serverId: 'malformed', refName: 'm', displayName: 'M', online: true, execEnabled: true, accessRole: 'administrator' },
      ],
    });

    expect((await listControllableMachines()).map((machine) => [machine.serverId, machine.accessRole]))
      .toEqual([
        ['participant', 'participant'],
        ['legacy-owner', 'owner'],
        ['malformed', 'viewer'],
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
      ownerUserId: 'user-rock',
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
      ownerUserId: 'user-rock',
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
      ownerUserId: 'user-rock',
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
      ownerUserId: 'user-rock',
    });
    const ticket = await mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' });
    expect(ticket.version).toBe(2);
    expect(ticket.ticketId).toBe('id');
    expect(ticket.ownerUserId).toBe('user-rock');
  });

  it('rejects a ticket bound to a different owner than the rendered account', async () => {
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
      ownerUserId: 'user-emma',
    });
    await expect(mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' }))
      .rejects.toThrow('auth_identity_changed');
  });

  it('rejects non-canonical mint selection before calling the server', async () => {
    await expect(mintControlledNodeExecutableTicket({ os: 'win', arch: 'arm64' }))
      .rejects.toThrow('controlled_node_non_canonical_pair');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('refuses to mint without a rendered account expectation', async () => {
    configureExpectedUserId(null);
    await expect(mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' }))
      .rejects.toThrow('auth_identity_expectation_required');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
