import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Socket as DgramSocket, RemoteInfo } from 'node:dgram';
import {
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_MUX_TYPE,
  PORT_FORWARD_ROLE,
  PortForwardMuxAccumulator,
  encodePortForwardMuxFrame,
  isPrivateRoutableIpv4,
  type PortForwardCandidate,
  type PortForwardMuxFrame,
  type PortForwardRole,
} from '../../shared/port-forward.js';

export const UDP_P2P_MAGIC = 0x50 as const;

export const UDP_P2P_PKT = {
  PUNCH_REQ: 0x01,
  PUNCH_ACK: 0x02,
  ARQ_DATA: 0x03,
  ARQ_ACK: 0x04,
  ARQ_PING: 0x05,
  ARQ_CLOSE: 0x06,
} as const;

const ROLE_BYTE_LISTEN = 0x4c; // 'L'
const ROLE_BYTE_TARGET = 0x54; // 'T'
const NONCE_BYTES = 16;
const PUNCH_HMAC_BYTES = 16;
const PUNCH_REQ_BYTES = 2 + 1 + NONCE_BYTES + 8 + PUNCH_HMAC_BYTES; // 43
const PUNCH_ACK_BYTES = 2 + 1 + NONCE_BYTES + NONCE_BYTES + PUNCH_HMAC_BYTES; // 51
const ARQ_OUTER_HEADER_BYTES = 10; // magic(1) + type(1) + counter(8)
const ARQ_DATA_INNER_HEADER_BYTES = 12; // seq(4) + ackSeq(4) + sackMask(4)
const ARQ_ACK_INNER_BYTES = 10; // ackSeq(4) + sackMask(4) + rwndPackets(2)
const ARQ_PING_CLOSE_INNER_BYTES = 16; // ackSeq(4) + sackMask(4) + tsMs(8)
const MAX_REORDER_GAP = 256;
const MAX_ARQ_RETRIES = 12;
const INITIAL_RTO_MS = 120;
const MIN_RTO_MS = 60;
const MAX_RTO_MS = 1_500;
const SEND_WINDOW_PACKETS = 64;
const MAX_BUFFERED_OUTGOING_PACKETS = 512;

export interface TunnelCryptoKeys {
  punchMacKey: Buffer;
  listenToTargetKey: Buffer;
  targetToListenKey: Buffer;
}

export function deriveTunnelCryptoKeys(capability: string, tunnelId: string): TunnelCryptoKeys {
  const secret = Buffer.from(capability, 'base64url');
  if (secret.length !== 32) throw new Error('invalid_capability');
  const salt = Buffer.from(tunnelId, 'utf8');
  return {
    punchMacKey: Buffer.from(hkdfSync('sha256', secret, salt, Buffer.from('imcodes-pf-v1:punch'), 32)),
    listenToTargetKey: Buffer.from(hkdfSync('sha256', secret, salt, Buffer.from('imcodes-pf-v1:listen->target'), 32)),
    targetToListenKey: Buffer.from(hkdfSync('sha256', secret, salt, Buffer.from('imcodes-pf-v1:target->listen'), 32)),
  };
}

function roleToByte(role: PortForwardRole): number {
  return role === PORT_FORWARD_ROLE.LISTEN ? ROLE_BYTE_LISTEN : ROLE_BYTE_TARGET;
}

function expectedPeerRoleByte(role: PortForwardRole): number {
  return role === PORT_FORWARD_ROLE.LISTEN ? ROLE_BYTE_TARGET : ROLE_BYTE_LISTEN;
}

function computePunchMac(key: Buffer, body: Buffer): Buffer {
  return createHmac('sha256', key).update(body).digest().subarray(0, PUNCH_HMAC_BYTES);
}

function verifyPunchMac(key: Buffer, body: Buffer, tag: Buffer): boolean {
  const expected = computePunchMac(key, body);
  return tag.length === expected.length && timingSafeEqual(expected, tag);
}

function encodePunchReq(key: Buffer, role: PortForwardRole, epochNonce: Buffer): Buffer {
  const bodyLen = 2 + 1 + NONCE_BYTES + 8;
  const pkt = Buffer.allocUnsafe(bodyLen + PUNCH_HMAC_BYTES);
  pkt[0] = UDP_P2P_MAGIC;
  pkt[1] = UDP_P2P_PKT.PUNCH_REQ;
  pkt[2] = roleToByte(role);
  epochNonce.copy(pkt, 3);
  pkt.writeBigUInt64BE(BigInt(Date.now()), 3 + NONCE_BYTES);
  computePunchMac(key, pkt.subarray(0, bodyLen)).copy(pkt, bodyLen);
  return pkt;
}

function encodePunchAck(
  key: Buffer,
  role: PortForwardRole,
  peerNonce: Buffer,
  ownNonce: Buffer,
): Buffer {
  const bodyLen = 2 + 1 + NONCE_BYTES + NONCE_BYTES;
  const pkt = Buffer.allocUnsafe(bodyLen + PUNCH_HMAC_BYTES);
  pkt[0] = UDP_P2P_MAGIC;
  pkt[1] = UDP_P2P_PKT.PUNCH_ACK;
  pkt[2] = roleToByte(role);
  peerNonce.copy(pkt, 3);
  ownNonce.copy(pkt, 3 + NONCE_BYTES);
  computePunchMac(key, pkt.subarray(0, bodyLen)).copy(pkt, bodyLen);
  return pkt;
}

function makeDirectionalIv(dirTag: number, counter: bigint): Buffer {
  const iv = Buffer.allocUnsafe(12);
  iv.writeUInt32BE(dirTag >>> 0, 0);
  iv.writeBigUInt64BE(counter, 4);
  return iv;
}

function makePacketAad(tunnelId: string, pktType: number, counter: bigint): Buffer {
  return Buffer.from(`${tunnelId}:${pktType}:${counter.toString()}`);
}

export function encryptUdpArqPacket(
  key: Buffer,
  dirTag: number,
  tunnelId: string,
  pktType: number,
  counter: bigint,
  plaintext: Buffer,
): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, makeDirectionalIv(dirTag, counter));
  cipher.setAAD(makePacketAad(tunnelId, pktType, counter));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const out = Buffer.allocUnsafe(ARQ_OUTER_HEADER_BYTES + encrypted.length);
  out[0] = UDP_P2P_MAGIC;
  out[1] = pktType;
  out.writeBigUInt64BE(counter, 2);
  encrypted.copy(out, ARQ_OUTER_HEADER_BYTES);
  return out;
}

export function decryptUdpArqPacket(
  key: Buffer,
  dirTag: number,
  tunnelId: string,
  pkt: Buffer,
): { pktType: number; counter: bigint; plaintext: Buffer } | null {
  if (pkt.length < ARQ_OUTER_HEADER_BYTES + PORT_FORWARD_LIMITS.FRAME_AUTH_TAG_BYTES) {
    return null;
  }
  if (pkt[0] !== UDP_P2P_MAGIC) return null;
  const pktType = pkt[1]!;
  if (pktType < UDP_P2P_PKT.ARQ_DATA || pktType > UDP_P2P_PKT.ARQ_CLOSE) return null;
  const counter = pkt.readBigUInt64BE(2);
  const body = pkt.subarray(ARQ_OUTER_HEADER_BYTES, -PORT_FORWARD_LIMITS.FRAME_AUTH_TAG_BYTES);
  const tag = pkt.subarray(-PORT_FORWARD_LIMITS.FRAME_AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, makeDirectionalIv(dirTag, counter));
  decipher.setAAD(makePacketAad(tunnelId, pktType, counter));
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    return { pktType, counter, plaintext };
  } catch {
    return null;
  }
}

class CounterReplayWindow {
  private maxCounter = 0n;
  private bitmap = 0n; // bit 0 = maxCounter, bit i = maxCounter - i (for i < 64)

  accept(counter: bigint): boolean {
    if (counter <= 0n) return false;
    if (counter > this.maxCounter) return true;
    const diff = this.maxCounter - counter;
    if (diff >= 64n) return false;
    const bit = 1n << diff;
    return (this.bitmap & bit) === 0n;
  }

  markSeen(counter: bigint): void {
    if (counter > this.maxCounter) {
      const shift = counter - this.maxCounter;
      this.bitmap = shift >= 64n ? 1n : ((this.bitmap << shift) | 1n) & ((1n << 64n) - 1n);
      this.maxCounter = counter;
      return;
    }
    const diff = this.maxCounter - counter;
    if (diff < 64n) {
      this.bitmap |= 1n << diff;
    }
  }
}

export interface UdpHolePunchResult {
  peerHost: string;
  peerPort: number;
  bufferedArqPackets: Array<{ packet: Buffer; rinfo: RemoteInfo }>;
}

export interface UdpHolePunchOptions {
  socket: DgramSocket;
  tunnelId: string;
  role: PortForwardRole;
  keys: TunnelCryptoKeys;
  peerCandidates: readonly PortForwardCandidate[];
  punchIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Run UDP simultaneous hole punching on an already-bound udp4 socket.
 * Resolves with the confirmed bidirectional NAT endpoint `(peerHost, peerPort)`
 * or null if timeout / abort occurs before a bidirectional proof completes.
 */
export function runUdpHolePunch(options: UdpHolePunchOptions): Promise<UdpHolePunchResult | null> {
  const {
    socket,
    tunnelId,
    role,
    keys,
    peerCandidates,
    punchIntervalMs = PORT_FORWARD_LIMITS.UDP_PUNCH_INTERVAL_MS,
    timeoutMs = PORT_FORWARD_LIMITS.UDP_PUNCH_TIMEOUT_MS,
    signal,
  } = options;

  const udpTargets = new Map<string, { host: string; port: number }>();
  for (const c of peerCandidates) {
    if (c.transport !== 'udp') continue;
    udpTargets.set(`${c.host}:${c.port}`, { host: c.host, port: c.port });
  }

  // Even when peerCandidates initially has 0 UDP entries, if peer punches us we cannot learn
  // without sending outbound too unless one side has targets; if zero candidates everywhere, fail fast.
  if (udpTargets.size === 0) return Promise.resolve(null);
  if (signal?.aborted) return Promise.resolve(null);

  const ownNonce = randomBytes(NONCE_BYTES);
  const peerRoleByte = expectedPeerRoleByte(role);
  const peerCryptoDirTag = role === PORT_FORWARD_ROLE.LISTEN ? 0x544c0002 : 0x4c540001;
  const peerDecryptionKey = role === PORT_FORWARD_ROLE.LISTEN
    ? keys.targetToListenKey
    : keys.listenToTargetKey;

  return new Promise<UdpHolePunchResult | null>((resolve) => {
    let settled = false;
    let sentAck = false;
    let receivedAck = false;
    let ackEndpoint: { host: string; port: number } | null = null;
    let confirmedEndpoint: { host: string; port: number } | null = null;
    let lanPreferenceTimer: ReturnType<typeof setTimeout> | null = null;
    const bufferedArqPackets: Array<{ packet: Buffer; rinfo: RemoteInfo }> = [];

    const cleanup = () => {
      clearInterval(punchTimer);
      clearTimeout(deadlineTimer);
      if (lanPreferenceTimer) clearTimeout(lanPreferenceTimer);
      socket.off('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (res: UdpHolePunchResult | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };

    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });

    const commitEndpoint = (host: string, port: number, forceCommit = false) => {
      if (!forceCommit && (!sentAck || !receivedAck)) return;
      if (isPrivateRoutableIpv4(host)) {
        confirmedEndpoint = { host, port };
        finish({ peerHost: host, peerPort: port, bufferedArqPackets });
        return;
      }
      if (!confirmedEndpoint) {
        confirmedEndpoint = { host, port };
        const hasPrivateCandidate = [...udpTargets.values()].some((t) => isPrivateRoutableIpv4(t.host));
        if (!hasPrivateCandidate) {
          finish({ peerHost: host, peerPort: port, bufferedArqPackets });
          return;
        }
        // Briefly give a LAN punch ACK a chance to arrive if private candidates exist.
        lanPreferenceTimer = setTimeout(() => {
          if (confirmedEndpoint) {
            finish({
              peerHost: confirmedEndpoint.host,
              peerPort: confirmedEndpoint.port,
              bufferedArqPackets,
            });
          }
        }, 40);
        lanPreferenceTimer.unref?.();
      }
    };

    const sendPunchBurst = () => {
      if (settled) return;
      const req = encodePunchReq(keys.punchMacKey, role, ownNonce);
      for (const target of udpTargets.values()) {
        try {
          socket.send(req, target.port, target.host, () => {});
        } catch {
          // Ignore synchronous send errors when socket is closing.
        }
      }
    };

    const onMessage = (msg: Buffer, rinfo: RemoteInfo) => {
      if (settled || msg.length < 3 || msg[0] !== UDP_P2P_MAGIC) return;
      const pktType = msg[1]!;

      if (pktType === UDP_P2P_PKT.PUNCH_REQ && msg.length === PUNCH_REQ_BYTES) {
        if (msg[2] !== peerRoleByte) return;
        const bodyLen = PUNCH_REQ_BYTES - PUNCH_HMAC_BYTES;
        if (!verifyPunchMac(keys.punchMacKey, msg.subarray(0, bodyLen), msg.subarray(bodyLen))) {
          return;
        }
        const peerNonce = msg.subarray(3, 3 + NONCE_BYTES);
        // Remember observed NAT-mapped endpoint as an active target too.
        udpTargets.set(`${rinfo.address}:${rinfo.port}`, { host: rinfo.address, port: rinfo.port });
        sentAck = true;
        const ack = encodePunchAck(keys.punchMacKey, role, peerNonce, ownNonce);
        try {
          socket.send(ack, rinfo.port, rinfo.address, () => {});
        } catch {
          // Ignore send errors if closing.
        }
        if (!receivedAck) {
          // Immediately probe back along the discovered NAT pinhole so the peer
          // receives our PUNCH_REQ and can send us PUNCH_ACK without waiting a timer tick.
          const req = encodePunchReq(keys.punchMacKey, role, ownNonce);
          try {
            socket.send(req, rinfo.port, rinfo.address, () => {});
          } catch {
            // Ignore send errors if closing.
          }
        }
        if (receivedAck) {
          const ep = ackEndpoint ?? { host: rinfo.address, port: rinfo.port };
          commitEndpoint(ep.host, ep.port);
        }
        return;
      }

      if (pktType === UDP_P2P_PKT.PUNCH_ACK && msg.length === PUNCH_ACK_BYTES) {
        if (msg[2] !== peerRoleByte) return;
        const bodyLen = PUNCH_ACK_BYTES - PUNCH_HMAC_BYTES;
        if (!verifyPunchMac(keys.punchMacKey, msg.subarray(0, bodyLen), msg.subarray(bodyLen))) {
          return;
        }
        const echoedNonce = msg.subarray(3, 3 + NONCE_BYTES);
        if (!echoedNonce.equals(ownNonce)) return;
        receivedAck = true;
        if (!ackEndpoint || isPrivateRoutableIpv4(rinfo.address)) {
          ackEndpoint = { host: rinfo.address, port: rinfo.port };
        }
        if (sentAck) {
          commitEndpoint(ackEndpoint.host, ackEndpoint.port);
        }
        return;
      }

      // If peer already confirmed and moved on to ARQ packets before our PUNCH_ACK arrived,
      // decrypting a valid ARQ packet proves bidirectional capability.
      if (pktType >= UDP_P2P_PKT.ARQ_DATA && pktType <= UDP_P2P_PKT.ARQ_PING) {
        const decrypted = decryptUdpArqPacket(peerDecryptionKey, peerCryptoDirTag, tunnelId, msg);
        if (decrypted) {
          bufferedArqPackets.push({ packet: Buffer.from(msg), rinfo });
          commitEndpoint(rinfo.address, rinfo.port, true);
        }
      }
    };

    socket.on('message', onMessage);
    const punchTimer = setInterval(sendPunchBurst, punchIntervalMs);
    punchTimer.unref?.();
    const deadlineTimer = setTimeout(() => finish(null), timeoutMs);
    deadlineTimer.unref?.();

    // Send first burst immediately.
    sendPunchBurst();
  });
}

export interface PortForwardCarrier {
  readonly mode: 'direct_tcp' | 'direct_udp_p2p' | 'relay';
  sendMuxFrame(frame: Buffer): boolean;
  onMuxFrame(listener: (frame: PortForwardMuxFrame) => void): () => void;
  onDrain(listener: () => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  isWritable(): boolean;
  close(reason?: string): void;
}

interface OutboundArqPacket {
  seq: number;
  chunk: Buffer;
  sentAt: number;
  lastSentAt: number;
  nextRetryAt: number;
  retries: number;
  sackSkipped: number;
}

export interface ReliableUdpTransportOptions {
  socket: DgramSocket;
  tunnelId: string;
  role: PortForwardRole;
  keys: TunnelCryptoKeys;
  peerHost: string;
  peerPort: number;
  heartbeatIntervalMs?: number;
  deadLinkTimeoutMs?: number;
  maxRetries?: number;
  sendWindowPackets?: number;
  ownsSocket?: boolean;
  initialPackets?: Array<{ packet: Buffer; rinfo: RemoteInfo }>;
}

/**
 * Reliable ordered AES-256-GCM encrypted transport over a UDP hole-punched socket.
 * Splits mux frames into <= 1080B chunks so every wire UDP packet stays <= 1200B.
 */
export class ReliableUdpTransport implements PortForwardCarrier {
  readonly mode = 'direct_udp_p2p' as const;

  private readonly socket: DgramSocket;
  private readonly tunnelId: string;
  private readonly sendKey: Buffer;
  private readonly recvKey: Buffer;
  private readonly sendDirTag: number;
  private readonly recvDirTag: number;
  private readonly punchMacKey: Buffer;
  private readonly role: PortForwardRole;
  private peerHost: string;
  private peerPort: number;
  private readonly ownsSocket: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly deadLinkTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly sendWindowPackets: number;

  private txCounter = 1n;
  private readonly rxReplay = new CounterReplayWindow();
  private txNextSeq = 0;
  private txUnackedSeq = 0;
  private readonly pendingChunks: Buffer[] = [];
  private readonly inFlight = new Map<number, OutboundArqPacket>();

  private rxNextSeq = 0;
  private readonly rxReorder = new Map<number, Buffer>();
  private readonly muxAccumulator = new PortForwardMuxAccumulator();
  private rxSinceAck = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private rtoMs = INITIAL_RTO_MS;
  private lastInboundAt = Date.now();
  private closed = false;

  private readonly muxListeners = new Set<(frame: PortForwardMuxFrame) => void>();
  private readonly drainListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly retxTimer: ReturnType<typeof setInterval>;
  private readonly pingTimer: ReturnType<typeof setInterval>;

  private readonly onSocketMessage = (msg: Buffer, rinfo: RemoteInfo) => {
    this.handleDatagram(msg, rinfo);
  };

  private readonly onSocketClose = () => {
    this.close('udp_socket_closed');
  };

  constructor(options: ReliableUdpTransportOptions) {
    this.socket = options.socket;
    this.tunnelId = options.tunnelId;
    this.role = options.role;
    this.punchMacKey = options.keys.punchMacKey;
    if (options.role === PORT_FORWARD_ROLE.LISTEN) {
      this.sendKey = options.keys.listenToTargetKey;
      this.recvKey = options.keys.targetToListenKey;
      this.sendDirTag = 0x4c540001;
      this.recvDirTag = 0x544c0002;
    } else {
      this.sendKey = options.keys.targetToListenKey;
      this.recvKey = options.keys.listenToTargetKey;
      this.sendDirTag = 0x544c0002;
      this.recvDirTag = 0x4c540001;
    }
    this.peerHost = options.peerHost;
    this.peerPort = options.peerPort;
    this.ownsSocket = options.ownsSocket ?? true;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? PORT_FORWARD_LIMITS.UDP_HEARTBEAT_INTERVAL_MS;
    this.deadLinkTimeoutMs = options.deadLinkTimeoutMs ?? PORT_FORWARD_LIMITS.UDP_DEAD_LINK_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? MAX_ARQ_RETRIES;
    this.sendWindowPackets = options.sendWindowPackets ?? SEND_WINDOW_PACKETS;

    this.socket.on('message', this.onSocketMessage);
    this.socket.on('close', this.onSocketClose);

    this.retxTimer = setInterval(() => this.onRetransmitTick(), 25);
    this.retxTimer.unref?.();

    this.pingTimer = setInterval(() => this.onPingTick(), Math.min(this.heartbeatIntervalMs, 5_000));
    this.pingTimer.unref?.();

    if (options.initialPackets && options.initialPackets.length > 0) {
      queueMicrotask(() => {
        if (this.closed) return;
        for (const item of options.initialPackets!) {
          this.handleDatagram(item.packet, item.rinfo);
        }
      });
    }
  }

  onMuxFrame(listener: (frame: PortForwardMuxFrame) => void): () => void {
    this.muxListeners.add(listener);
    return () => this.muxListeners.delete(listener);
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  isWritable(): boolean {
    return !this.closed && (this.inFlight.size + this.pendingChunks.length) < MAX_BUFFERED_OUTGOING_PACKETS;
  }

  sendMuxFrame(frame: Buffer): boolean {
    if (this.closed) return false;
    const maxChunk = PORT_FORWARD_LIMITS.MAX_UDP_CHUNK_BYTES;
    for (let offset = 0; offset < frame.length; offset += maxChunk) {
      const slice = Buffer.from(frame.subarray(offset, Math.min(offset + maxChunk, frame.length)));
      this.pendingChunks.push(slice);
    }
    this.flushSendQueue();
    return this.isWritable();
  }

  sendKeepalivePing(): void {
    if (this.closed) return;
    this.sendControlPacket(UDP_P2P_PKT.ARQ_PING);
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    // Best-effort notify peer of clean close before tearing down socket.
    try {
      this.sendControlPacket(UDP_P2P_PKT.ARQ_CLOSE);
    } catch {
      // Ignore send failures on teardown.
    }
    clearInterval(this.retxTimer);
    clearInterval(this.pingTimer);
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    this.socket.off('message', this.onSocketMessage);
    this.socket.off('close', this.onSocketClose);
    this.pendingChunks.length = 0;
    this.inFlight.clear();
    this.rxReorder.clear();
    this.muxAccumulator.reset();
    if (this.ownsSocket) {
      try { this.socket.close(); } catch { /* ignore */ }
    }
    for (const listener of [...this.closeListeners]) listener(reason);
  }

  private buildAckState(): { ackSeq: number; sackMask: number } {
    let sackMask = 0;
    for (let bit = 0; bit < 32; bit++) {
      if (this.rxReorder.has((this.rxNextSeq + 1 + bit) >>> 0)) {
        sackMask |= (1 << bit);
      }
    }
    return { ackSeq: this.rxNextSeq >>> 0, sackMask: sackMask >>> 0 };
  }

  private sendPacketRaw(pkt: Buffer, host = this.peerHost, port = this.peerPort): void {
    try {
      this.socket.send(pkt, port, host, () => {});
    } catch {
      // Socket closed/destroyed handled by close event or dead-link timer.
    }
  }

  private sendControlPacket(
    pktType: typeof UDP_P2P_PKT.ARQ_ACK | typeof UDP_P2P_PKT.ARQ_PING | typeof UDP_P2P_PKT.ARQ_CLOSE,
  ): void {
    const { ackSeq, sackMask } = this.buildAckState();
    let inner: Buffer;
    if (pktType === UDP_P2P_PKT.ARQ_ACK) {
      inner = Buffer.allocUnsafe(ARQ_ACK_INNER_BYTES);
      inner.writeUInt32BE(ackSeq, 0);
      inner.writeUInt32BE(sackMask, 4);
      const rwnd = Math.max(1, MAX_REORDER_GAP - this.rxReorder.size);
      inner.writeUInt16BE(rwnd, 8);
    } else {
      inner = Buffer.allocUnsafe(ARQ_PING_CLOSE_INNER_BYTES);
      inner.writeUInt32BE(ackSeq, 0);
      inner.writeUInt32BE(sackMask, 4);
      inner.writeBigUInt64BE(BigInt(Date.now()), 8);
    }
    const encrypted = encryptUdpArqPacket(
      this.sendKey,
      this.sendDirTag,
      this.tunnelId,
      pktType,
      this.txCounter++,
      inner,
    );
    this.sendPacketRaw(encrypted);
  }

  private transmitDataPacket(entry: OutboundArqPacket, now: number): void {
    const { ackSeq, sackMask } = this.buildAckState();
    const inner = Buffer.allocUnsafe(ARQ_DATA_INNER_HEADER_BYTES + entry.chunk.length);
    inner.writeUInt32BE(entry.seq >>> 0, 0);
    inner.writeUInt32BE(ackSeq, 4);
    inner.writeUInt32BE(sackMask, 8);
    entry.chunk.copy(inner, ARQ_DATA_INNER_HEADER_BYTES);
    const pkt = encryptUdpArqPacket(
      this.sendKey,
      this.sendDirTag,
      this.tunnelId,
      UDP_P2P_PKT.ARQ_DATA,
      this.txCounter++,
      inner,
    );
    entry.lastSentAt = now;
    const backoff = Math.min(MAX_RTO_MS, Math.round(this.rtoMs * Math.pow(1.5, Math.min(entry.retries, 5))));
    entry.nextRetryAt = now + backoff;
    this.sendPacketRaw(pkt);
  }

  private flushSendQueue(): void {
    if (this.closed) return;
    const now = Date.now();
    while (this.pendingChunks.length > 0 && this.inFlight.size < this.sendWindowPackets) {
      const chunk = this.pendingChunks.shift()!;
      const seq = this.txNextSeq;
      this.txNextSeq = (this.txNextSeq + 1) >>> 0;
      const entry: OutboundArqPacket = {
        seq,
        chunk,
        sentAt: now,
        lastSentAt: now,
        nextRetryAt: now + this.rtoMs,
        retries: 0,
        sackSkipped: 0,
      };
      this.inFlight.set(seq, entry);
      this.transmitDataPacket(entry, now);
    }
  }

  private processAck(ackSeq: number, sackMask: number): void {
    const now = Date.now();
    const wasWritable = this.isWritable();
    let ackedAny = false;

    while (seqBefore(this.txUnackedSeq, ackSeq)) {
      const entry = this.inFlight.get(this.txUnackedSeq);
      if (entry) {
        if (entry.retries === 0) {
          const sampleRtt = Math.max(10, now - entry.sentAt);
          this.rtoMs = Math.max(MIN_RTO_MS, Math.min(MAX_RTO_MS, Math.round(this.rtoMs * 0.75 + sampleRtt * 0.5)));
        }
        this.inFlight.delete(this.txUnackedSeq);
        ackedAny = true;
      }
      this.txUnackedSeq = (this.txUnackedSeq + 1) >>> 0;
    }

    if (sackMask !== 0) {
      for (let bit = 0; bit < 32; bit++) {
        if ((sackMask & (1 << bit)) === 0) continue;
        const sackedSeq = (ackSeq + 1 + bit) >>> 0;
        if (this.inFlight.delete(sackedSeq)) {
          ackedAny = true;
        }
      }
      // Fast retransmit for the earliest missing hole if 2+ later packets are SACKed.
      const baseEntry = this.inFlight.get(ackSeq);
      if (baseEntry && countBits(sackMask) >= 2 && now - baseEntry.lastSentAt >= 20) {
        baseEntry.retries += 1;
        this.transmitDataPacket(baseEntry, now);
      }
    }

    if (ackedAny) {
      this.flushSendQueue();
      if (!wasWritable && this.isWritable()) {
        for (const listener of [...this.drainListeners]) listener();
      }
    }
  }

  private scheduleAck(immediate: boolean): void {
    if (this.closed) return;
    if (immediate) {
      if (this.ackTimer) {
        clearTimeout(this.ackTimer);
        this.ackTimer = null;
      }
      this.rxSinceAck = 0;
      this.sendControlPacket(UDP_P2P_PKT.ARQ_ACK);
      return;
    }
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.rxSinceAck = 0;
      if (!this.closed) this.sendControlPacket(UDP_P2P_PKT.ARQ_ACK);
    }, 12);
    this.ackTimer.unref?.();
  }

  private deliverMuxData(chunk: Buffer): void {
    try {
      const frames = this.muxAccumulator.push(chunk);
      for (const frame of frames) {
        for (const listener of [...this.muxListeners]) listener(frame);
      }
    } catch {
      this.close('invalid_mux_stream');
    }
  }

  private handleDatagram(msg: Buffer, rinfo: RemoteInfo): void {
    if (this.closed || msg.length < 3 || msg[0] !== UDP_P2P_MAGIC) return;
    const pktType = msg[1]!;

    // Still answer late PUNCH_REQ packets cleanly if peer's punch ack got lost!
    if (pktType === UDP_P2P_PKT.PUNCH_REQ && msg.length === PUNCH_REQ_BYTES) {
      if (msg[2] !== expectedPeerRoleByte(this.role)) return;
      const bodyLen = PUNCH_REQ_BYTES - PUNCH_HMAC_BYTES;
      if (!verifyPunchMac(this.punchMacKey, msg.subarray(0, bodyLen), msg.subarray(bodyLen))) return;
      const peerNonce = msg.subarray(3, 3 + NONCE_BYTES);
      const ack = encodePunchAck(this.punchMacKey, this.role, peerNonce, randomBytes(NONCE_BYTES));
      this.sendPacketRaw(ack, rinfo.address, rinfo.port);
      return;
    }

    const decoded = decryptUdpArqPacket(this.recvKey, this.recvDirTag, this.tunnelId, msg);
    if (!decoded) return;
    if (!this.rxReplay.accept(decoded.counter)) return;
    this.rxReplay.markSeen(decoded.counter);

    // Update NAT-mapped peer tuple in case peer port rebound.
    this.peerHost = rinfo.address;
    this.peerPort = rinfo.port;
    this.lastInboundAt = Date.now();

    if (decoded.pktType === UDP_P2P_PKT.ARQ_CLOSE) {
      this.close('peer_closed');
      return;
    }

    if (decoded.pktType === UDP_P2P_PKT.ARQ_ACK) {
      if (decoded.plaintext.length < ARQ_ACK_INNER_BYTES) return;
      const ackSeq = decoded.plaintext.readUInt32BE(0);
      const sackMask = decoded.plaintext.readUInt32BE(4);
      this.processAck(ackSeq, sackMask);
      return;
    }

    if (decoded.pktType === UDP_P2P_PKT.ARQ_PING) {
      if (decoded.plaintext.length < ARQ_PING_CLOSE_INNER_BYTES) return;
      const ackSeq = decoded.plaintext.readUInt32BE(0);
      const sackMask = decoded.plaintext.readUInt32BE(4);
      this.processAck(ackSeq, sackMask);
      this.scheduleAck(true);
      return;
    }

    if (decoded.pktType === UDP_P2P_PKT.ARQ_DATA) {
      if (decoded.plaintext.length < ARQ_DATA_INNER_HEADER_BYTES) return;
      const seq = decoded.plaintext.readUInt32BE(0);
      const ackSeq = decoded.plaintext.readUInt32BE(4);
      const sackMask = decoded.plaintext.readUInt32BE(8);
      const data = decoded.plaintext.subarray(ARQ_DATA_INNER_HEADER_BYTES);
      this.processAck(ackSeq, sackMask);

      if (seq === this.rxNextSeq) {
        this.deliverMuxData(data);
        this.rxNextSeq = (this.rxNextSeq + 1) >>> 0;
        while (this.rxReorder.has(this.rxNextSeq)) {
          const nextData = this.rxReorder.get(this.rxNextSeq)!;
          this.rxReorder.delete(this.rxNextSeq);
          this.deliverMuxData(nextData);
          this.rxNextSeq = (this.rxNextSeq + 1) >>> 0;
        }
        this.rxSinceAck += 1;
        // Ack promptly on every few packets or if pending data is empty.
        this.scheduleAck(this.rxSinceAck >= 4);
      } else if (seqAfter(seq, this.rxNextSeq) && seqDiff(seq, this.rxNextSeq) < MAX_REORDER_GAP) {
        if (!this.rxReorder.has(seq)) {
          this.rxReorder.set(seq, Buffer.from(data));
        }
        // Out-of-order arrival: trigger immediate SACK so sender fast-retransmits gap.
        this.scheduleAck(true);
      } else {
        // Duplicate/old packet: re-ack so peer clears its inFlight entry.
        this.scheduleAck(true);
      }
    }
  }

  private onRetransmitTick(): void {
    if (this.closed || this.inFlight.size === 0) return;
    const now = Date.now();
    for (const entry of this.inFlight.values()) {
      if (now < entry.nextRetryAt) continue;
      entry.retries += 1;
      if (entry.retries > this.maxRetries) {
        this.close('udp_arq_max_retries');
        return;
      }
      this.transmitDataPacket(entry, now);
    }
  }

  private onPingTick(): void {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastInboundAt > this.deadLinkTimeoutMs) {
      this.close('udp_dead_link');
      return;
    }
    this.sendControlPacket(UDP_P2P_PKT.ARQ_PING);
  }
}

export function createPortForwardPingMuxFrame(): Buffer {
  return encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.PING, 0);
}

function seqBefore(a: number, b: number): boolean {
  return ((a - b) | 0) < 0;
}

function seqAfter(a: number, b: number): boolean {
  return ((a - b) | 0) > 0;
}

function seqDiff(a: number, b: number): number {
  return (a - b) >>> 0;
}

function countBits(n: number): number {
  let v = n >>> 0;
  let c = 0;
  while (v !== 0) {
    v &= v - 1;
    c += 1;
  }
  return c;
}
