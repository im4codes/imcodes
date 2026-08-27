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

import { daemonRemoteDesktopMachine, listAvailableExecutables, listControllableMachines, mintControlledNodeExecutableTicket } from '../src/api/machines.js';
import { configureExpectedUserId } from '../src/api.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import { CONTROLLED_NODE_ID_MIN } from '../../shared/controlled-node-identity.js';
import { REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY } from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY,
} from '../../shared/remote-desktop-platform.js';

const VALID_SHA256 = 'a'.repeat(64);
const withNodeIds = <T extends Record<string, unknown>>(machines: T[]) => machines.map((machine, index) => ({
  ...machine,
  nodeId: String(BigInt(CONTROLLED_NODE_ID_MIN) + BigInt(index)),
}));

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
  it('accepts an absent legacy alias, makes nodeId the display fallback, and never projects raw serverId', async () => {
    apiFetch.mockResolvedValueOnce({
      machines: [{
        serverId: 'internal-routing-secret',
        nodeId: CONTROLLED_NODE_ID_MIN,
        online: true,
        execEnabled: true,
      }],
    });
    const [machine] = await listControllableMachines();
    expect(machine).toMatchObject({
      serverId: 'internal-routing-secret',
      nodeId: CONTROLLED_NODE_ID_MIN,
      refName: '',
      displayName: CONTROLLED_NODE_ID_MIN,
    });
    expect([machine?.refName, machine?.displayName]).not.toContain('internal-routing-secret');

    const synthetic = daemonRemoteDesktopMachine('full-daemon-routing-secret', null);
    expect(synthetic.refName).toBe('');
    expect(synthetic.displayName).toBe('—');
    expect(synthetic.os).toBeUndefined();
    expect([synthetic.refName, synthetic.displayName]).not.toContain('full-daemon-routing-secret');
  });

  it('requires and preserves the canonical string nodeId projection', async () => {
    apiFetch.mockResolvedValueOnce({
      machines: [
        { serverId: 'valid', nodeId: CONTROLLED_NODE_ID_MIN, refName: 'legacy-valid', online: true, execEnabled: true },
        { serverId: 'missing', refName: 'legacy-missing', online: true, execEnabled: true },
        { serverId: 'numeric', nodeId: 1234567890, refName: 'legacy-numeric', online: true, execEnabled: true },
        { serverId: 'leading-zero', nodeId: '0123456789', refName: 'legacy-zero', online: true, execEnabled: true },
      ],
    });
    expect(await listControllableMachines()).toEqual([
      expect.objectContaining({ serverId: 'valid', nodeId: CONTROLLED_NODE_ID_MIN, refName: 'legacy-valid' }),
    ]);
  });

  it('preserves valid shared roles, defaults an old-server omission to owner, and fails malformed roles closed', async () => {
    apiFetch.mockResolvedValueOnce({
      machines: withNodeIds([
        { serverId: 'participant', remoteDesktopHostId: 'host-p', refName: 'p', displayName: 'P', online: true, execEnabled: true, accessRole: 'participant' },
        { serverId: 'legacy-owner', refName: 'o', displayName: 'O', online: true, execEnabled: true },
        { serverId: 'malformed', refName: 'm', displayName: 'M', online: true, execEnabled: true, accessRole: 'administrator' },
      ]),
    });

    expect((await listControllableMachines()).map((machine) => [machine.serverId, machine.accessRole]))
      .toEqual([
        ['participant', 'participant'],
        ['legacy-owner', 'owner'],
        ['malformed', 'viewer'],
      ]);
  });

  it('preserves only a non-empty canonical remote-desktop host identity', async () => {
    apiFetch.mockResolvedValueOnce({
      machines: withNodeIds([
        { serverId: 'canonical', remoteDesktopHostId: 'host-canonical', refName: 'c', online: true, execEnabled: true },
        { serverId: 'empty', remoteDesktopHostId: '', refName: 'e', online: true, execEnabled: true },
        { serverId: 'malformed', remoteDesktopHostId: 42, refName: 'm', online: true, execEnabled: true },
      ]),
    });

    const machines = await listControllableMachines();
    expect(machines[0]?.remoteDesktopHostId).toBe('host-canonical');
    expect(machines[1]).not.toHaveProperty('remoteDesktopHostId');
    expect(machines[2]).not.toHaveProperty('remoteDesktopHostId');
  });

  it('surfaces a reported node version and the Server-computed upgrade flag', async () => {
    apiFetch.mockResolvedValueOnce({
      machines: withNodeIds([
        {
          serverId: 'current', refName: 'current', online: true, execEnabled: true,
          daemonVersion: '2026.8.3447-dev.3884',
        },
        {
          serverId: 'stale', refName: 'stale', online: true, execEnabled: true,
          daemonVersion: '2026.8.3400-dev.3800', updateAvailable: true,
        },
        { serverId: 'silent', refName: 'silent', online: true, execEnabled: true },
        {
          serverId: 'malformed', refName: 'malformed', online: true, execEnabled: true,
          daemonVersion: 42, updateAvailable: 'yes',
        },
      ]),
    });

    const machines = await listControllableMachines();
    expect(machines.map((m) => [m.serverId, m.daemonVersion, m.updateAvailable])).toEqual([
      ['current', '2026.8.3447-dev.3884', undefined],
      ['stale', '2026.8.3400-dev.3800', true],
      ['silent', undefined, undefined],
      // A non-string version and a truthy-but-not-true flag both fall away
      // rather than reaching the row as `42` or a bogus upgrade badge.
      ['malformed', undefined, undefined],
    ]);
  });

  it('keeps only an exact, known remote-desktop capability list', async () => {
    apiFetch.mockResolvedValueOnce({
      machines: withNodeIds([
        { serverId: 'exact', refName: 'exact', online: true, execEnabled: true, capabilities: [REMOTE_DESKTOP_CAPABILITY] },
        { serverId: 'future', refName: 'future', online: true, execEnabled: true, capabilities: ['remote.desktop.windows.h264.v3'] },
      ]),
    });

    const machines = await listControllableMachines();
    expect(machines[0]?.capabilities).toEqual([REMOTE_DESKTOP_CAPABILITY]);
    expect(machines[1]).not.toHaveProperty('capabilities');
  });

  it('retains the Server-persisted unsupported-profile sentinel for Web fail-closed UI', async () => {
    apiFetch.mockResolvedValueOnce({
      machines: withNodeIds([{
        serverId: 'future-mac',
        refName: 'future-mac',
        online: true,
        execEnabled: true,
        capabilities: [
          REMOTE_DESKTOP_SESSION_CAPABILITY,
          REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
          REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
          REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
          REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
          REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY,
        ],
      }]),
    });

    expect((await listControllableMachines())[0]?.capabilities).toEqual([
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
      REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY,
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
