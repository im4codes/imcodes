/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mintControlledNodeExecutableTicket = vi.fn();
vi.mock('../src/api/machines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/machines.js')>();
  return {
    ...actual,
    mintControlledNodeExecutableTicket: (...args: unknown[]) => mintControlledNodeExecutableTicket(...args),
    buildControlledNodeBootstrapUrl: (ticket: string) =>
      `https://example.test/api/enroll/v2/bootstrap#ticket=${encodeURIComponent(ticket)}`,
  };
});

import {
  beginControlledNodeDesktopDownload,
  controlledNodeDownloadErrorKey,
  downloadControlledNodeExecutable,
  ApiError,
} from '../src/api.js';
import { buildControlledNodeDownloadTargets } from '../src/api/machines.js';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const VALID_SHA256 = 'a'.repeat(64);

const ticketResponse = {
  version: 2 as const,
  ticket: 'deadbeef',
  ticketId: 'tid-42',
  os: 'win' as const,
  arch: 'x64' as const,
  filename: 'imcodes-node.exe',
  sizeBytes: 1000,
  sha256: VALID_SHA256,
  expiresAt: Date.now() + 60_000,
};

describe('buildControlledNodeDownloadTargets', () => {
  it('returns only canonical artifacts with explicit arch', () => {
    const targets = buildControlledNodeDownloadTargets({
      available: ['win', 'mac', 'linux'],
      artifacts: [
        { os: 'linux', arch: 'x64', filename: 'imcodes-node-linux', sizeBytes: 1, sha256: VALID_SHA256 },
        { os: 'win', arch: 'x64', filename: 'imcodes-node.exe', sizeBytes: 1, sha256: VALID_SHA256 },
        { os: 'mac', arch: 'arm64', filename: 'imcodes-node-macos', sizeBytes: 1, sha256: VALID_SHA256 },
      ],
    });
    expect(targets).toEqual([
      { os: 'win', arch: 'x64' },
      { os: 'mac', arch: 'arm64' },
      { os: 'linux', arch: 'x64' },
    ]);
  });

  it('skips artifacts missing arch metadata', () => {
    const targets = buildControlledNodeDownloadTargets({
      available: ['win', 'mac'],
      artifacts: [
        { os: 'win', arch: 'x64', filename: 'imcodes-node.exe', sizeBytes: 1, sha256: VALID_SHA256 },
        { os: 'mac', filename: 'imcodes-node-macos', sizeBytes: 1, sha256: null } as never,
      ],
    });
    expect(targets).toEqual([{ os: 'win', arch: 'x64' }]);
  });

  it('skips non-canonical os+arch pairs', () => {
    const targets = buildControlledNodeDownloadTargets({
      available: ['win'],
      artifacts: [
        { os: 'win', arch: 'arm64', filename: 'imcodes-node.exe', sizeBytes: 1, sha256: VALID_SHA256 },
      ],
    });
    expect(targets).toEqual([]);
  });

  it('returns empty when only legacy available os list is present', () => {
    expect(buildControlledNodeDownloadTargets({ available: ['win', 'mac'], artifacts: [] })).toEqual([]);
  });
});

describe('controlledNodeDownloadErrorKey', () => {
  it('maps mint error codes to i18n keys', () => {
    expect(controlledNodeDownloadErrorKey(new ApiError(503, '{"error":"executable_not_built"}')))
      .toBe('controlled_nodes.mint_executable_not_built');
    expect(controlledNodeDownloadErrorKey(new ApiError(403, '{"error":"canonical_server_url_required"}')))
      .toBe('controlled_nodes.mint_canonical_server_url_required');
    expect(controlledNodeDownloadErrorKey(new ApiError(401, '{"error":"invalid_or_expired_ticket"}')))
      .toBe('controlled_nodes.ticket_expired');
    expect(controlledNodeDownloadErrorKey(new Error('popup_blocked')))
      .toBe('controlled_nodes.download_popup_blocked');
  });
});

describe('controlled-node desktop download', () => {
  it('uses the desktop flow when the Capacitor web shim is present', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    const callOrder: string[] = [];
    const mockWin = {
      location: { href: 'about:blank' },
      closed: false,
      close: vi.fn(),
    };
    vi.spyOn(window, 'open').mockImplementation(() => {
      callOrder.push('open');
      return mockWin as unknown as Window;
    });
    mintControlledNodeExecutableTicket.mockImplementation(async () => {
      callOrder.push('mint');
      return ticketResponse;
    });

    const desktopWindow = beginControlledNodeDesktopDownload();
    await downloadControlledNodeExecutable({ os: 'win', arch: 'x64' }, { desktopWindow });

    expect(callOrder).toEqual(['open', 'mint']);
    expect(mockWin.location.href).toBe('https://example.test/api/enroll/v2/bootstrap#ticket=deadbeef');
    expect(mintControlledNodeExecutableTicket).toHaveBeenCalledWith({ os: 'win', arch: 'x64' });
  });

  it('closes the pre-opened window when ticket mint fails', async () => {
    const mockWin = {
      location: { href: 'about:blank' },
      closed: false,
      close: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(mockWin as unknown as Window);
    mintControlledNodeExecutableTicket.mockRejectedValue(new Error('mint_failed'));

    const desktopWindow = beginControlledNodeDesktopDownload();
    await expect(
      downloadControlledNodeExecutable({ os: 'linux', arch: 'x64' }, { desktopWindow }),
    ).rejects.toThrow('mint_failed');
    expect(mockWin.close).toHaveBeenCalled();
  });

  it('throws popup_blocked when synchronous pre-open is denied', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => beginControlledNodeDesktopDownload()).toThrow('popup_blocked');
  });
});
