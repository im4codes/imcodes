import { describe, it, expect } from 'vitest';
import {
  PREVIEW_MSG,
  PREVIEW_BINARY_FRAME,
  PREVIEW_LIMITS,
  packPreviewWsFrame,
  parsePreviewWsFrame,
  parsePreviewBinaryFrame,
} from '../../shared/preview-types.js';

// ── Constants ────────────────────────────────────────────────────────────────

describe('PREVIEW_MSG WS tunnel constants', () => {
  it('exports WS_OPEN', () => {
    expect(PREVIEW_MSG.WS_OPEN).toBe('preview.ws.open');
  });

  it('exports WS_OPENED', () => {
    expect(PREVIEW_MSG.WS_OPENED).toBe('preview.ws.opened');
  });

  it('exports WS_CLOSE', () => {
    expect(PREVIEW_MSG.WS_CLOSE).toBe('preview.ws.close');
  });

  it('exports WS_ERROR', () => {
    expect(PREVIEW_MSG.WS_ERROR).toBe('preview.ws.error');
  });

  it('WS constants have no duplicate values', () => {
    const wsValues = [PREVIEW_MSG.WS_OPEN, PREVIEW_MSG.WS_OPENED, PREVIEW_MSG.WS_CLOSE, PREVIEW_MSG.WS_ERROR];
    expect(new Set(wsValues).size).toBe(wsValues.length);
  });
});

describe('PREVIEW_BINARY_FRAME.WS_DATA constant', () => {
  it('exports WS_DATA as 0x04', () => {
    expect(PREVIEW_BINARY_FRAME.WS_DATA).toBe(0x04);
  });

  it('WS_DATA is distinct from REQUEST_BODY and RESPONSE_BODY', () => {
    expect(PREVIEW_BINARY_FRAME.WS_DATA).not.toBe(PREVIEW_BINARY_FRAME.REQUEST_BODY);
    expect(PREVIEW_BINARY_FRAME.WS_DATA).not.toBe(PREVIEW_BINARY_FRAME.RESPONSE_BODY);
  });
});

describe('PREVIEW_LIMITS WS constants', () => {
  it('exports MAX_WS_PER_PREVIEW as 8', () => {
    expect(PREVIEW_LIMITS.MAX_WS_PER_PREVIEW).toBe(8);
  });

  it('exports MAX_WS_PER_SERVER as 16', () => {
    expect(PREVIEW_LIMITS.MAX_WS_PER_SERVER).toBe(16);
  });

  it('exports MAX_WS_MESSAGE_BYTES as 1MB', () => {
    expect(PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES).toBe(1_048_576);
  });

  it('exports WS_IDLE_TIMEOUT_MS as 5 minutes', () => {
    expect(PREVIEW_LIMITS.WS_IDLE_TIMEOUT_MS).toBe(300_000);
  });

  it('exports WS_OPEN_TIMEOUT_MS as 15 seconds', () => {
    expect(PREVIEW_LIMITS.WS_OPEN_TIMEOUT_MS).toBe(15_000);
  });

  it('exports MAX_WS_PENDING_QUEUE_BYTES as 64KB', () => {
    expect(PREVIEW_LIMITS.MAX_WS_PENDING_QUEUE_BYTES).toBe(65_536);
  });
});

// ── packPreviewWsFrame / parsePreviewWsFrame round-trip ──────────────────────

describe('packPreviewWsFrame / parsePreviewWsFrame', () => {
  const dashlessId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

  it('round-trips dashless hex wsId, text flag, non-empty payload', () => {
    const payload = Buffer.from('hello world');
    const frame = packPreviewWsFrame(dashlessId, false, payload);
    const result = parsePreviewWsFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.wsId).toBe(dashlessId);
    expect(result!.isBinary).toBe(false);
    expect(result!.payload).toEqual(payload);
  });

  it('round-trips binary flag correctly', () => {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const frame = packPreviewWsFrame(dashlessId, true, payload);
    const result = parsePreviewWsFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.isBinary).toBe(true);
    expect(result!.payload).toEqual(payload);
  });

  it('round-trips text flag correctly (isBinary = false)', () => {
    const payload = Buffer.from('text message');
    const frame = packPreviewWsFrame(dashlessId, false, payload);
    const result = parsePreviewWsFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.isBinary).toBe(false);
  });

  it('round-trips empty payload', () => {
    const payload = new Uint8Array(0);
    const frame = packPreviewWsFrame(dashlessId, false, payload);
    const result = parsePreviewWsFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.wsId).toBe(dashlessId);
    expect(result!.payload.length).toBe(0);
  });

  it('round-trips large payload (256KB)', () => {
    const payload = Buffer.alloc(256 * 1024, 0xab);
    const frame = packPreviewWsFrame(dashlessId, true, payload);
    const result = parsePreviewWsFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.payload.length).toBe(256 * 1024);
    expect(result!.payload[0]).toBe(0xab);
    expect(result!.payload[result!.payload.length - 1]).toBe(0xab);
  });

  it('handles UUID wsId with dashes (strips dashes before encoding)', () => {
    const uuidId = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';
    const payload = Buffer.from('data');
    const frame = packPreviewWsFrame(uuidId, false, payload);
    const result = parsePreviewWsFrame(frame);
    expect(result).not.toBeNull();
    // parsePreviewWsFrame returns dashless hex
    expect(result!.wsId).toBe(dashlessId);
    expect(result!.payload).toEqual(payload);
  });

  it('frame starts with 0x04 byte', () => {
    const payload = Buffer.from('x');
    const frame = packPreviewWsFrame(dashlessId, false, payload);
    expect(frame[0]).toBe(0x04);
  });

  it('frame header is exactly 18 bytes (1 type + 16 id + 1 flags)', () => {
    const payload = Buffer.from('abc');
    const frame = packPreviewWsFrame(dashlessId, false, payload);
    expect(frame.length).toBe(18 + 3);
  });

  it('returns null for buffer shorter than 18 bytes', () => {
    expect(parsePreviewWsFrame(Buffer.alloc(17))).toBeNull();
  });

  it('returns null for buffer with wrong frame type byte', () => {
    const buf = Buffer.alloc(20, 0x00);
    buf[0] = 0x02; // REQUEST_BODY, not WS_DATA
    expect(parsePreviewWsFrame(buf)).toBeNull();
  });
});

// ── parsePreviewBinaryFrame rejects WS_DATA (0x04) ──────────────────────────

describe('parsePreviewBinaryFrame rejects 0x04 frames', () => {
  it('returns null for a buffer with first byte 0x04', () => {
    const payload = Buffer.from('some data');
    // Build a minimal 0x04-prefixed buffer (even if not a properly packed WS frame)
    const buf = Buffer.concat([Buffer.from([0x04, 0x00, 0x00]), payload]);
    expect(parsePreviewBinaryFrame(buf)).toBeNull();
  });

  it('returns null for a properly packed WS_DATA frame', () => {
    const wsId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const frame = packPreviewWsFrame(wsId, false, Buffer.from('hello'));
    expect(parsePreviewBinaryFrame(frame)).toBeNull();
  });

  it('still parses REQUEST_BODY (0x02) frames normally', () => {
    const requestId = 'req-abc';
    const payload = Buffer.from('body data');
    // Build a REQUEST_BODY frame manually
    const idBytes = Buffer.from(requestId, 'utf8');
    const header = Buffer.allocUnsafe(3 + idBytes.length);
    header[0] = 0x02;
    header.writeUInt16BE(idBytes.length, 1);
    idBytes.copy(header, 3);
    const frame = Buffer.concat([header, payload]);
    const result = parsePreviewBinaryFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe(requestId);
  });

  it('still parses RESPONSE_BODY (0x03) frames normally', () => {
    const requestId = 'req-xyz';
    const payload = Buffer.from('response body');
    const idBytes = Buffer.from(requestId, 'utf8');
    const header = Buffer.allocUnsafe(3 + idBytes.length);
    header[0] = 0x03;
    header.writeUInt16BE(idBytes.length, 1);
    idBytes.copy(header, 3);
    const frame = Buffer.concat([header, payload]);
    const result = parsePreviewBinaryFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe(requestId);
  });
});
