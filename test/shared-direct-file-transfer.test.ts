import { describe, expect, it } from 'vitest';
import {
  classifyDirectConnectivityRoute,
  DIRECT_CONNECTIVITY_CANDIDATE_TYPE,
  DIRECT_CONNECTIVITY_ENDPOINT_KIND,
  DIRECT_CONNECTIVITY_ROUTE,
  DIRECT_FILE_TRANSFER_DATA_MSG,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PURPOSE,
  inferDirectConnectivityEndpointKind,
  inferDirectConnectivityEndpointKindFromTypes,
  validateDirectFileTransferBrowserMessage,
  validateDirectFileTransferDaemonCommand,
  validateDirectFileTransferDaemonMessage,
  validateDirectFileTransferDataMessage,
  isDirectFileTransferIceServerConfig,
} from '../shared/direct-file-transfer.js';

const requestId = '123e4567-e89b-12d3-a456-426614174000';
const clientUploadId = '123e4567-e89b-12d3-a456-426614174001';
const capability = 'A'.repeat(43);

describe('direct file transfer protocol', () => {
  it('accepts an unbounded safe-integer file size while rejecting extra keys', () => {
    const valid = {
      type: DIRECT_FILE_TRANSFER_MSG.INIT,
      requestId,
      clientUploadId,
      filename: 'archive.bin',
      size: 5 * 1024 * 1024 * 1024,
    };
    expect(validateDirectFileTransferBrowserMessage(valid)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferBrowserMessage({ ...valid, serverId: 'forged' })).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });

  it('accepts a bounded browser-only session authorization hint without widening daemon authority schemas', () => {
    const init = {
      type: DIRECT_FILE_TRANSFER_MSG.INIT,
      requestId,
      clientUploadId,
      filename: 'shared.bin',
      size: 100,
      sessionName: 'deck_project_brain',
    };
    expect(validateDirectFileTransferBrowserMessage(init)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferBrowserMessage({
      ...init,
      sessionName: 'x'.repeat(DIRECT_FILE_TRANSFER_LIMITS.SESSION_NAME_BYTES + 1),
    })).toEqual({ ok: false, error: 'invalid_request' });

    const prepare = {
      ...init,
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      capability,
      expiresAt: Date.now() + 60_000,
      iceServers: ['stun:stun.cloudflare.com:3478'],
    };
    expect(validateDirectFileTransferDaemonCommand(prepare)).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });

  it('keeps prepare authority and daemon results behind exact schemas', () => {
    const prepare = {
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      requestId,
      clientUploadId,
      filename: 'archive.bin',
      size: 100,
      capability,
      expiresAt: Date.now() + 60_000,
      iceServers: ['stun:stun.cloudflare.com:3478'],
    };
    expect(validateDirectFileTransferDaemonCommand(prepare)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDaemonCommand({ ...prepare, capability: 'short' })).toMatchObject({ ok: false });
    expect(validateDirectFileTransferDaemonMessage({
      type: DIRECT_FILE_TRANSFER_MSG.PROGRESS,
      requestId,
      capability,
      loaded: 51,
      total: 50,
    })).toMatchObject({ ok: false });
  });

  it('accepts strict authenticated TURN entries while preserving legacy STUN strings', () => {
    const authority = {
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      requestId,
      clientUploadId,
      filename: 'archive.bin',
      size: 100,
      capability,
      expiresAt: Date.now() + 60_000,
      iceServers: [
        'stun:stun.cloudflare.com:3478',
        {
          urls: ['turn:im.example.com:3479?transport=udp'],
          username: '1780000000:subject',
          credential: 'temporary-credential',
        },
      ],
    };
    expect(validateDirectFileTransferDaemonCommand(authority)).toMatchObject({ ok: true });
    expect(isDirectFileTransferIceServerConfig(authority.iceServers[0])).toBe(true);
    expect(isDirectFileTransferIceServerConfig(authority.iceServers[1])).toBe(true);
  });

  it('rejects malformed TURN schemes, partial credentials, mixed entries, and extra keys', () => {
    expect(isDirectFileTransferIceServerConfig({
      urls: ['turn:im.example.com:3479?transport=udp'],
      username: '1780000000:subject',
    })).toBe(false);
    expect(isDirectFileTransferIceServerConfig({
      urls: ['https://im.example.com/turn'],
      username: 'user',
      credential: 'credential',
    })).toBe(false);
    expect(isDirectFileTransferIceServerConfig({
      urls: ['stun:stun.cloudflare.com:3478', 'turn:im.example.com:3479'],
      username: 'user',
      credential: 'credential',
    })).toBe(false);
    expect(isDirectFileTransferIceServerConfig({
      urls: ['turn:im.example.com:3479'],
      username: 'user',
      credential: 'credential',
      secret: 'must-not-pass',
    })).toBe(false);
    expect(isDirectFileTransferIceServerConfig({
      urls: ['stun:stun.cloudflare.com:3478'],
      username: 'must-not-be-accepted',
      credential: 'must-not-be-accepted',
    })).toBe(false);
  });

  it('requires exact control messages on the data channel', () => {
    const start = {
      type: DIRECT_FILE_TRANSFER_DATA_MSG.START,
      protocolVersion: 1,
      requestId,
      clientUploadId,
      filename: 'archive.bin',
      size: 100,
      capability,
    };
    expect(validateDirectFileTransferDataMessage(start)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDataMessage({ ...start, protocolVersion: 2 })).toMatchObject({ ok: false });
  });

  it('accepts authenticated zero-file probes and validates bounded pong diagnostics', () => {
    expect(validateDirectFileTransferBrowserMessage({
      type: DIRECT_FILE_TRANSFER_MSG.INIT,
      purpose: DIRECT_FILE_TRANSFER_PURPOSE.PROBE,
      requestId,
      clientUploadId,
      filename: 'connectivity-probe',
      size: 0,
    })).toMatchObject({ ok: true });

    const probe = {
      type: DIRECT_FILE_TRANSFER_DATA_MSG.PROBE,
      protocolVersion: 1,
      requestId,
      capability,
      nonce: 'probe-nonce-12345678',
    };
    expect(validateDirectFileTransferDataMessage(probe)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDataMessage({ ...probe, targetIp: '192.168.2.145' })).toMatchObject({ ok: false });

    const pong = {
      type: DIRECT_FILE_TRANSFER_DATA_MSG.PONG,
      requestId,
      nonce: probe.nonce,
      rttMs: 1.4,
      localCandidate: { address: '192.168.2.145', port: 49153, type: 'host', transportType: 'udp' },
      remoteCandidate: { address: '192.168.2.59', port: 59074, type: 'prflx', transportType: 'udp' },
    };
    expect(validateDirectFileTransferDataMessage(pong)).toMatchObject({ ok: true });
    expect(validateDirectFileTransferDataMessage({ ...pong, rttMs: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false });
  });

  it('classifies routed private/SNAT candidates as LAN direct without requiring equal subnets', () => {
    expect(classifyDirectConnectivityRoute(
      { address: '192.168.2.145', port: 49153, type: 'host', transportType: 'udp' },
      { address: '172.16.253.211', port: 59074, type: 'prflx', transportType: 'udp' },
    )).toBe(DIRECT_CONNECTIVITY_ROUTE.LAN_DIRECT);
    expect(classifyDirectConnectivityRoute(
      { address: '192.168.2.145', port: 49153, type: 'host', transportType: 'udp' },
      { address: '203.0.113.8', port: 59074, type: 'srflx', transportType: 'udp' },
    )).toBe(DIRECT_CONNECTIVITY_ROUTE.DIRECT);
    expect(classifyDirectConnectivityRoute(
      { address: '192.168.2.145', port: 49153, type: 'relay', transportType: 'udp' },
      { address: '172.16.253.211', port: 59074, type: 'host', transportType: 'udp' },
    )).toBe(DIRECT_CONNECTIVITY_ROUTE.RELAY);
  });

  it('reports only candidate-based endpoint inference without claiming a cone or symmetric NAT type', () => {
    expect(inferDirectConnectivityEndpointKind(
      { address: '172.16.253.111', port: 51907, type: 'host', transportType: 'udp' },
    )).toBe(DIRECT_CONNECTIVITY_ENDPOINT_KIND.PRIVATE_ROUTED);
    expect(inferDirectConnectivityEndpointKind(
      { address: '203.0.113.8', port: 28167, type: 'srflx', transportType: 'udp' },
    )).toBe(DIRECT_CONNECTIVITY_ENDPOINT_KIND.NAT_MAPPED);
    expect(inferDirectConnectivityEndpointKind(
      { address: '192.168.2.145', port: 59501, type: 'prflx', transportType: 'udp' },
    )).toBe(DIRECT_CONNECTIVITY_ENDPOINT_KIND.PEER_REFLEXIVE);
    expect(inferDirectConnectivityEndpointKindFromTypes([
      DIRECT_CONNECTIVITY_CANDIDATE_TYPE.HOST,
      DIRECT_CONNECTIVITY_CANDIDATE_TYPE.SERVER_REFLEXIVE,
    ])).toBe(DIRECT_CONNECTIVITY_ENDPOINT_KIND.NAT_MAPPED);
    expect(inferDirectConnectivityEndpointKindFromTypes([])).toBe(DIRECT_CONNECTIVITY_ENDPOINT_KIND.UNKNOWN);
  });
});
