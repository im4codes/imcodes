import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetch(...args),
    getApiBaseUrl: () => 'https://im.example.test',
  };
});

import {
  buildControlledNodeBootstrapUrl,
  mintControlledNodeExecutableTicket,
  mintControlledNodeRemoteInstallLink,
  revokeControlledNodeRemoteInstallLink,
} from '../src/api/machines.js';
import { configureExpectedUserId } from '../src/api.js';
import {
  CONTROLLED_NODE_TICKET_DELIVERY,
  CONTROLLED_NODE_TICKET_TTL_MS,
} from '../../shared/controlled-node-artifacts.js';

const VALID_SHA256 = 'a'.repeat(64);
const NOW = 1_800_000_000_000;

function ticketResponse(extra: Record<string, unknown> = {}) {
  return {
    version: 2,
    ticket: 'raw-ticket-value',
    ticketId: 'ticket-1',
    os: 'win',
    arch: 'x64',
    filename: 'imcodes-node.exe',
    sizeBytes: 81_471_184,
    sha256: VALID_SHA256,
    expiresAt: NOW + CONTROLLED_NODE_TICKET_TTL_MS[CONTROLLED_NODE_TICKET_DELIVERY.BROWSER],
    ownerUserId: 'user-rock',
    ...extra,
  };
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String((apiFetch.mock.calls[0]?.[1] as { body: string }).body));
}

beforeEach(() => { configureExpectedUserId('user-rock'); });
afterEach(() => { configureExpectedUserId(null); vi.clearAllMocks(); });

describe('controlled-node remote install link', () => {
  it('asks the server for a remote-link ticket and returns a pasteable URL', async () => {
    apiFetch.mockResolvedValueOnce(ticketResponse({
      delivery: CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK,
      expiresAt: null,
    }));
    const link = await mintControlledNodeRemoteInstallLink({ os: 'win', arch: 'x64' });

    expect(sentBody().delivery).toBe(CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK);
    expect(link.ticketId).toBe('ticket-1');
    expect(link.expiresAt).toBeNull();
    expect(link.url).toBe(buildControlledNodeBootstrapUrl('raw-ticket-value'));
  });

  it('carries the secret in the fragment, never in the request line', async () => {
    apiFetch.mockResolvedValueOnce(ticketResponse({
      delivery: CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK,
    }));
    const { url } = await mintControlledNodeRemoteInstallLink({ os: 'win', arch: 'x64' });
    const parsed = new URL(url);
    // A query string would reach the server, and from there access logs and
    // Referer headers. The fragment never leaves the browser.
    expect(parsed.search).toBe('');
    expect(parsed.hash).toContain('raw-ticket-value');
    expect(`${parsed.origin}${parsed.pathname}`).not.toContain('raw-ticket-value');
  });

  it('omits the delivery key entirely for the default, so older servers still mint', async () => {
    // The server body schema is strict; sending `delivery: 'browser'` to a
    // deployment that predates the field would be rejected outright.
    apiFetch.mockResolvedValueOnce(ticketResponse());
    await mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' });
    expect(Object.hasOwn(sentBody(), 'delivery')).toBe(false);
  });

  it('treats a response with no delivery as the short browser window', async () => {
    apiFetch.mockResolvedValueOnce(ticketResponse());
    const ticket = await mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' });
    expect(ticket.delivery).toBe(CONTROLLED_NODE_TICKET_DELIVERY.BROWSER);
  });

  it('does not let an unrecognized delivery widen the reported lifetime', async () => {
    apiFetch.mockResolvedValueOnce(ticketResponse({ delivery: 'forever' }));
    const ticket = await mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' });
    expect(ticket.delivery).toBe(CONTROLLED_NODE_TICKET_DELIVERY.BROWSER);
  });

  it('accepts a null expiry only for an explicitly stable remote link', async () => {
    apiFetch.mockResolvedValueOnce(ticketResponse({ expiresAt: null }));
    await expect(mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' }))
      .rejects.toThrow('invalid_ticket_response');

    apiFetch.mockResolvedValueOnce(ticketResponse({
      delivery: CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK,
      expiresAt: null,
    }));
    await expect(mintControlledNodeRemoteInstallLink({ os: 'win', arch: 'x64' }))
      .resolves.toMatchObject({ expiresAt: null });
  });

  it('revokes only the exact remote-link binding through the owner-authenticated API', async () => {
    apiFetch.mockResolvedValueOnce({ revoked: true });
    await expect(revokeControlledNodeRemoteInstallLink(
      { os: 'win', arch: 'x64' }, 'host-7',
    )).resolves.toBe(true);
    expect(apiFetch).toHaveBeenCalledWith('/api/enroll/v2/ticket', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({
        version: 2, os: 'win', arch: 'x64', delivery: 'remote_link', hostServerId: 'host-7',
      }),
    }));
  });
});
