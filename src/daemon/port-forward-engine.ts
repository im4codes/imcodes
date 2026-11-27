import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createSocket, type Socket as DgramSocket } from 'node:dgram';
import {
  connect as tcpConnect,
  createServer as createTcpServer,
  isIP,
  type Server as NetServer,
  type Socket as NetSocket,
} from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  PORT_FORWARD_ERRORS,
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_MSG,
  PORT_FORWARD_MUX_TYPE,
  PORT_FORWARD_ROLE,
  PORT_FORWARD_TRANSPORT,
  PORT_FORWARD_TRANSPORT_PREF,
  PortForwardMuxAccumulator,
  encodePortForwardMuxFrame,
  validatePortForwardWireMessage,
  type PortForwardCandidate,
  type PortForwardConnectMessage,
  type PortForwardErrorCode,
  type PortForwardMuxFrame,
  type PortForwardPrepareMessage,
  type PortForwardRole,
  type PortForwardTransport,
  type PortForwardTransportPref,
  type PortForwardWireMessage,
} from '../../shared/port-forward.js';
import { probeStunCandidates } from './port-forward-stun.js';
import {
  ReliableUdpTransport,
  UDP_P2P_MAGIC,
  UDP_P2P_PKT,
  createPortForwardPingMuxFrame,
  decryptUdpArqPacket,
  deriveTunnelCryptoKeys,
  runUdpHolePunch,
  type PortForwardCarrier,
  type TunnelCryptoKeys,
} from './port-forward-udp-transport.js';

const TCP_INNER_MUX = 0x01;
const TCP_INNER_CHOSEN = 0xfe;
const TCP_DIR_L2T = 0x54434c54; // 'TCLT'
const TCP_DIR_T2L = 0x5443544c; // 'TCTL'
const RELAY_DIR_L2T = 0x524c4c54; // 'RLLT'
const RELAY_DIR_T2L = 0x524c544c; // 'RLTL'
const RELAY_HEADER_BYTES = 8; // counter(8B uint64BE)

export interface PortForwardEngineTimeouts {
  directTcpMs: number;
  directTcpPreferenceWaitMs: number;
  directTcpTargetDialDelayMs: number;
  udpPunchMs: number;
  udpPunchIntervalMs: number;
  stunProbeMs: number;
  handshakeMs: number;
  udpHeartbeatMs: number;
  udpDeadLinkMs: number;
}

const DEFAULT_TIMEOUTS: PortForwardEngineTimeouts = {
  directTcpMs: PORT_FORWARD_LIMITS.DIRECT_TCP_CONNECT_TIMEOUT_MS,
  directTcpPreferenceWaitMs: PORT_FORWARD_LIMITS.DIRECT_TCP_PREFERENCE_WAIT_MS,
  directTcpTargetDialDelayMs: PORT_FORWARD_LIMITS.DIRECT_TCP_TARGET_DIAL_DELAY_MS,
  udpPunchMs: PORT_FORWARD_LIMITS.UDP_PUNCH_TIMEOUT_MS,
  udpPunchIntervalMs: PORT_FORWARD_LIMITS.UDP_PUNCH_INTERVAL_MS,
  stunProbeMs: PORT_FORWARD_LIMITS.STUN_PROBE_TIMEOUT_MS,
  handshakeMs: PORT_FORWARD_LIMITS.HANDSHAKE_TIMEOUT_MS,
  udpHeartbeatMs: PORT_FORWARD_LIMITS.UDP_HEARTBEAT_INTERVAL_MS,
  udpDeadLinkMs: PORT_FORWARD_LIMITS.UDP_DEAD_LINK_TIMEOUT_MS,
};

export interface PortForwardEngineOptions {
  sendWs: (message: PortForwardWireMessage) => void;
  collectInterfaceAddresses?: () => string[];
  probeStun?: typeof probeStunCandidates;
  timeouts?: Partial<PortForwardEngineTimeouts>;
  /** Test seam to disallow direct TCP/UDP and force relay or p2p_only failure. */
  disableDirectTcp?: boolean;
  disableDirectUdp?: boolean;
}

export interface PortForwardEngineTunnelSnapshot {
  tunnelId: string;
  role: PortForwardRole;
  transportMode: PortForwardTransport | null;
  listenPort?: number;
  targetHost?: string;
  targetPort?: number;
  activeConnections: number;
  bytesSent: number;
  bytesReceived: number;
  createdAt: number;
  expiresAt: number;
}

class TcpSocketLineReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private failure: Error | null = null;
  private waiters: Array<() => void> = [];
  private attached = true;

  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    this.wake();
  };

  private readonly onEnd = () => {
    this.ended = true;
    this.wake();
  };

  private readonly onError = (err: Error) => {
    this.failure = err;
    this.wake();
  };

  constructor(private readonly socket: NetSocket) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private wait(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.reject(new Error('socket_closed'));
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async readLine(maxBytes: number, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.buffer.indexOf(0x0a);
      if (idx >= 0) {
        if (idx > maxBytes) throw new Error('line_too_large');
        const line = this.buffer.subarray(0, idx).toString('utf8');
        this.buffer = this.buffer.subarray(idx + 1);
        return line;
      }
      if (this.buffer.length > maxBytes) throw new Error('line_too_large');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('handshake_timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.wait(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('handshake_timeout')), remaining);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  detach(): Buffer {
    if (!this.attached) return this.buffer;
    this.attached = false;
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    this.socket.off('error', this.onError);
    const leftover = this.buffer;
    this.buffer = Buffer.alloc(0);
    return leftover;
  }
}

function defaultCollectInterfaceAddresses(): string[] {
  const seen = new Set<string>();
  const addrs: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const host = entry.address.split('%')[0]!;
      if (entry.internal || isIP(host) !== 4) continue;
      if (host === '0.0.0.0') continue;
      const parts = host.split('.').map(Number);
      if (parts[0] === 127) continue;
      if (parts[0] === 169 && parts[1] === 254) continue;
      if (seen.has(host)) continue;
      seen.add(host);
      addrs.push(host);
    }
  }
  return addrs;
}

function makeDirectionalIv(dirTag: number, counter: bigint): Buffer {
  const iv = Buffer.allocUnsafe(12);
  iv.writeUInt32BE(dirTag >>> 0, 0);
  iv.writeBigUInt64BE(counter, 4);
  return iv;
}

function encryptAesGcm(
  key: Buffer,
  dirTag: number,
  counter: bigint,
  aad: string,
  plaintext: Buffer,
): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, makeDirectionalIv(dirTag, counter));
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function decryptAesGcm(
  key: Buffer,
  dirTag: number,
  counter: bigint,
  aad: string,
  encrypted: Buffer,
): Buffer | null {
  if (encrypted.length < PORT_FORWARD_LIMITS.FRAME_AUTH_TAG_BYTES + 1) return null;
  const body = encrypted.subarray(0, -PORT_FORWARD_LIMITS.FRAME_AUTH_TAG_BYTES);
  const tag = encrypted.subarray(-PORT_FORWARD_LIMITS.FRAME_AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, makeDirectionalIv(dirTag, counter));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

class CounterReplayWindow {
  private maxCounter = 0n;
  private bitmap = 0n;

  accept(counter: bigint): boolean {
    if (counter <= 0n) return false;
    if (counter > this.maxCounter) return true;
    const diff = this.maxCounter - counter;
    if (diff >= 64n) return false;
    return (this.bitmap & (1n << diff)) === 0n;
  }

  markSeen(counter: bigint): void {
    if (counter > this.maxCounter) {
      const shift = counter - this.maxCounter;
      this.bitmap = shift >= 64n ? 1n : ((this.bitmap << shift) | 1n) & ((1n << 64n) - 1n);
      this.maxCounter = counter;
      return;
    }
    const diff = this.maxCounter - counter;
    if (diff < 64n) this.bitmap |= 1n << diff;
  }
}

function deriveTcpSessionKeys(
  capability: string,
  tunnelId: string,
  nonce1: string,
  nonce2: string,
): { listenToTargetKey: Buffer; targetToListenKey: Buffer } {
  const secret = Buffer.from(capability, 'base64url');
  const salt = Buffer.from(`${tunnelId}:${nonce1}:${nonce2}`, 'utf8');
  return {
    listenToTargetKey: Buffer.from(hkdfSync('sha256', secret, salt, Buffer.from('imcodes-pf-tcp-v1:listen->target'), 32)),
    targetToListenKey: Buffer.from(hkdfSync('sha256', secret, salt, Buffer.from('imcodes-pf-tcp-v1:target->listen'), 32)),
  };
}

function hmacHex(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text).digest('base64url');
}

function proofEquals(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function authenticateTcpSocket(options: {
  socket: NetSocket;
  tunnelId: string;
  role: PortForwardRole;
  authKey: Buffer;
  capability: string;
  isInitiator: boolean;
  handshakeMs: number;
}): Promise<{
  socket: NetSocket;
  sendKey: Buffer;
  recvKey: Buffer;
  sendDirTag: number;
  recvDirTag: number;
  initialBytes: Buffer;
}> {
  const { socket, tunnelId, role, authKey, capability, isInitiator, handshakeMs } = options;
  const expectedPeerRole = role === PORT_FORWARD_ROLE.LISTEN ? PORT_FORWARD_ROLE.TARGET : PORT_FORWARD_ROLE.LISTEN;
  const reader = new TcpSocketLineReader(socket);
  let nonce1: string;
  let nonce2: string;

  try {
    if (isInitiator) {
      nonce1 = randomBytes(18).toString('base64url');
      const proof1 = hmacHex(authKey, `pf-tcp-hello1:${tunnelId}:${role}:${nonce1}`);
      socket.write(`${JSON.stringify({ kind: 'hello1', tunnelId, role, nonce: nonce1, proof: proof1 })}\n`);
      const line2 = await reader.readLine(PORT_FORWARD_LIMITS.HANDSHAKE_LINE_MAX_BYTES, handshakeMs);
      const msg2 = JSON.parse(line2) as Record<string, unknown>;
      if (msg2.kind !== 'hello2'
        || msg2.tunnelId !== tunnelId
        || msg2.role !== expectedPeerRole
        || typeof msg2.nonce !== 'string'
        || !proofEquals(
          hmacHex(authKey, `pf-tcp-hello2:${tunnelId}:${expectedPeerRole}:${nonce1}:${msg2.nonce}`),
          msg2.proof,
        )) {
        throw new Error('tcp_auth_failed');
      }
      nonce2 = msg2.nonce;
    } else {
      const line1 = await reader.readLine(PORT_FORWARD_LIMITS.HANDSHAKE_LINE_MAX_BYTES, handshakeMs);
      const msg1 = JSON.parse(line1) as Record<string, unknown>;
      if (msg1.kind !== 'hello1'
        || msg1.tunnelId !== tunnelId
        || msg1.role !== expectedPeerRole
        || typeof msg1.nonce !== 'string'
        || !proofEquals(
          hmacHex(authKey, `pf-tcp-hello1:${tunnelId}:${expectedPeerRole}:${msg1.nonce}`),
          msg1.proof,
        )) {
        throw new Error('tcp_auth_failed');
      }
      nonce1 = msg1.nonce;
      nonce2 = randomBytes(18).toString('base64url');
      const proof2 = hmacHex(authKey, `pf-tcp-hello2:${tunnelId}:${role}:${nonce1}:${nonce2}`);
      socket.write(`${JSON.stringify({ kind: 'hello2', tunnelId, role, nonce: nonce2, proof: proof2 })}\n`);
    }
  } catch (err) {
    reader.detach();
    throw err;
  }

  const initialBytes = reader.detach();
  const keys = deriveTcpSessionKeys(capability, tunnelId, nonce1, nonce2);
  return role === PORT_FORWARD_ROLE.LISTEN
    ? {
        socket,
        sendKey: keys.listenToTargetKey,
        recvKey: keys.targetToListenKey,
        sendDirTag: TCP_DIR_L2T,
        recvDirTag: TCP_DIR_T2L,
        initialBytes,
      }
    : {
        socket,
        sendKey: keys.targetToListenKey,
        recvKey: keys.listenToTargetKey,
        sendDirTag: TCP_DIR_T2L,
        recvDirTag: TCP_DIR_L2T,
        initialBytes,
      };
}

class DirectTcpTransport implements PortForwardCarrier {
  readonly mode = PORT_FORWARD_TRANSPORT.DIRECT_TCP;
  private readonly muxAccumulator = new PortForwardMuxAccumulator();
  private readonly muxListeners = new Set<(frame: PortForwardMuxFrame) => void>();
  private readonly drainListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readBuf: Buffer;
  private txCounter = 1n;
  private rxCounter = 1n;
  private closed = false;
  private chosenConfirmed = false;
  private readonly onChosenConfirmed?: () => void;

  get rawSocket(): NetSocket {
    return this.socket;
  }

  constructor(
    private readonly socket: NetSocket,
    private readonly tunnelId: string,
    private readonly role: PortForwardRole,
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
    private readonly sendDirTag: number,
    private readonly recvDirTag: number,
    initialBytes: Buffer,
    onTargetChosen?: () => void,
  ) {
    this.readBuf = initialBytes.length > 0 ? Buffer.from(initialBytes) : Buffer.alloc(0);
    this.onChosenConfirmed = onTargetChosen;
    this.chosenConfirmed = role === PORT_FORWARD_ROLE.LISTEN;

    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onSocketData(chunk));
    socket.on('drain', () => {
      for (const listener of [...this.drainListeners]) listener();
    });
    socket.on('end', () => this.close('tcp_peer_ended'));
    socket.on('close', () => this.close('tcp_socket_closed'));
    socket.on('error', () => this.close('tcp_socket_error'));

    if (this.role === PORT_FORWARD_ROLE.LISTEN) {
      // Listen side explicitly commits this socket by sending encrypted CHOSEN control frame.
      this.sendEncryptedInner(Buffer.from([TCP_INNER_CHOSEN]));
    }
    if (this.readBuf.length > 0) {
      queueMicrotask(() => {
        if (!this.closed) this.processReadBuffer();
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
    return !this.closed && !this.socket.destroyed && !this.socket.writableNeedDrain;
  }

  sendMuxFrame(frame: Buffer): boolean {
    if (this.closed || this.socket.destroyed) return false;
    return this.sendEncryptedInner(Buffer.concat([Buffer.from([TCP_INNER_MUX]), frame]));
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.readBuf = Buffer.alloc(0);
    this.muxAccumulator.reset();
    try { this.socket.destroy(); } catch { /* ignore */ }
    for (const listener of [...this.closeListeners]) listener(reason);
  }

  private sendEncryptedInner(inner: Buffer): boolean {
    const counter = this.txCounter++;
    const ciphertext = encryptAesGcm(
      this.sendKey,
      this.sendDirTag,
      counter,
      `${this.tunnelId}:tcp:${counter.toString()}`,
      inner,
    );
    const frame = Buffer.allocUnsafe(4 + ciphertext.length);
    frame.writeUInt32BE(ciphertext.length, 0);
    ciphertext.copy(frame, 4);
    return this.socket.write(frame);
  }

  private onSocketData(chunk: Buffer): void {
    if (this.closed) return;
    this.readBuf = this.readBuf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.readBuf, chunk]);
    this.processReadBuffer();
  }

  private processReadBuffer(): void {
    while (!this.closed && this.readBuf.length >= 4) {
      const len = this.readBuf.readUInt32BE(0);
      if (len < PORT_FORWARD_LIMITS.FRAME_AUTH_TAG_BYTES + 1 || len > PORT_FORWARD_LIMITS.MAX_TCP_ENCRYPTED_FRAME_BYTES) {
        this.close('invalid_tcp_frame_length');
        return;
      }
      if (this.readBuf.length < 4 + len) break;
      const encrypted = this.readBuf.subarray(4, 4 + len);
      this.readBuf = this.readBuf.subarray(4 + len);
      const counter = this.rxCounter++;
      const plaintext = decryptAesGcm(
        this.recvKey,
        this.recvDirTag,
        counter,
        `${this.tunnelId}:tcp:${counter.toString()}`,
        encrypted,
      );
      if (!plaintext || plaintext.length < 1) {
        this.close('tcp_frame_auth_failed');
        return;
      }
      const innerType = plaintext[0]!;
      if (innerType === TCP_INNER_CHOSEN) {
        if (!this.chosenConfirmed) {
          this.chosenConfirmed = true;
          this.onChosenConfirmed?.();
        }
        continue;
      }
      if (innerType !== TCP_INNER_MUX) {
        this.close('invalid_tcp_inner_type');
        return;
      }
      try {
        const muxFrames = this.muxAccumulator.push(plaintext.subarray(1));
        for (const frame of muxFrames) {
          for (const listener of [...this.muxListeners]) listener(frame);
        }
      } catch {
        this.close('invalid_mux_stream');
        return;
      }
    }
  }
}

class RelayTransport implements PortForwardCarrier {
  readonly mode = PORT_FORWARD_TRANSPORT.RELAY;
  private readonly sendKey: Buffer;
  private readonly recvKey: Buffer;
  private readonly sendDirTag: number;
  private readonly recvDirTag: number;
  private readonly rxReplay = new CounterReplayWindow();
  private readonly muxAccumulator = new PortForwardMuxAccumulator();
  private readonly muxListeners = new Set<(frame: PortForwardMuxFrame) => void>();
  private readonly drainListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private txCounter = 1n;
  private closed = false;

  constructor(
    private readonly tunnelId: string,
    role: PortForwardRole,
    keys: TunnelCryptoKeys,
    private readonly sendRelayWs: (base64Ciphertext: string) => void,
  ) {
    if (role === PORT_FORWARD_ROLE.LISTEN) {
      this.sendKey = keys.listenToTargetKey;
      this.recvKey = keys.targetToListenKey;
      this.sendDirTag = RELAY_DIR_L2T;
      this.recvDirTag = RELAY_DIR_T2L;
    } else {
      this.sendKey = keys.targetToListenKey;
      this.recvKey = keys.listenToTargetKey;
      this.sendDirTag = RELAY_DIR_T2L;
      this.recvDirTag = RELAY_DIR_L2T;
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
    return !this.closed;
  }

  sendMuxFrame(frame: Buffer): boolean {
    if (this.closed) return false;
    const counter = this.txCounter++;
    const encrypted = encryptAesGcm(
      this.sendKey,
      this.sendDirTag,
      counter,
      `${this.tunnelId}:relay:${counter.toString()}`,
      frame,
    );
    const pkt = Buffer.allocUnsafe(RELAY_HEADER_BYTES + encrypted.length);
    pkt.writeBigUInt64BE(counter, 0);
    encrypted.copy(pkt, RELAY_HEADER_BYTES);
    this.sendRelayWs(pkt.toString('base64'));
    return true;
  }

  deliverRelayData(base64Data: string): boolean {
    if (this.closed) return false;
    const pkt = Buffer.from(base64Data, 'base64');
    if (pkt.length <= RELAY_HEADER_BYTES + PORT_FORWARD_LIMITS.FRAME_AUTH_TAG_BYTES) {
      return false;
    }
    const counter = pkt.readBigUInt64BE(0);
    if (!this.rxReplay.accept(counter)) return false;
    const plaintext = decryptAesGcm(
      this.recvKey,
      this.recvDirTag,
      counter,
      `${this.tunnelId}:relay:${counter.toString()}`,
      pkt.subarray(RELAY_HEADER_BYTES),
    );
    if (!plaintext) return false;
    this.rxReplay.markSeen(counter);
    try {
      const frames = this.muxAccumulator.push(plaintext);
      for (const frame of frames) {
        for (const listener of [...this.muxListeners]) listener(frame);
      }
      return true;
    } catch {
      this.close('invalid_mux_stream');
      return false;
    }
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.muxAccumulator.reset();
    for (const listener of [...this.closeListeners]) listener(reason);
  }
}

interface MuxStreamState {
  streamId: number;
  socket: NetSocket;
  openConfirmed: boolean;
  sendCredit: number;
  eofSent: boolean;
  eofReceived: boolean;
  closed: boolean;
  pendingWindowAckBytes: number;
  waitingDrain: boolean;
  pendingWrites: Buffer[];
}

class PortForwardMuxSession {
  private readonly streams = new Map<number, MuxStreamState>();
  private nextStreamId = 1;
  private closed = false;
  bytesSent = 0;
  bytesReceived = 0;

  constructor(
    private readonly role: PortForwardRole,
    private readonly carrier: PortForwardCarrier,
    private readonly targetHost: string | undefined,
    private readonly targetPort: number | undefined,
    private readonly onStatsChanged?: () => void,
  ) {
    carrier.onMuxFrame((frame) => this.handleMuxFrame(frame));
    carrier.onDrain(() => this.resumeWritableStreams());
    carrier.onClose((reason) => this.closeAll(reason));
  }

  activeConnections(): number {
    return this.streams.size;
  }

  acceptClientSocket(socket: NetSocket): void {
    if (this.closed || this.role !== PORT_FORWARD_ROLE.LISTEN) {
      socket.destroy();
      return;
    }
    if (this.streams.size >= PORT_FORWARD_LIMITS.MAX_CONCURRENT_STREAMS_PER_TUNNEL) {
      socket.destroy();
      return;
    }
    const streamId = this.nextStreamId++;
    const state: MuxStreamState = {
      streamId,
      socket,
      openConfirmed: false,
      sendCredit: PORT_FORWARD_LIMITS.STREAM_WINDOW_BYTES,
      eofSent: false,
      eofReceived: false,
      closed: false,
      pendingWindowAckBytes: 0,
      waitingDrain: false,
      pendingWrites: [],
    };
    this.streams.set(streamId, state);
    socket.pause();
    socket.setNoDelay(true);
    this.attachLocalSocketHandlers(state);
    this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.OPEN, streamId));
    this.onStatsChanged?.();
  }

  closeAll(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of [...this.streams.values()]) {
      this.destroyLocalStream(state);
    }
    this.streams.clear();
    void reason;
  }

  private attachLocalSocketHandlers(state: MuxStreamState): void {
    const { socket, streamId } = state;

    socket.on('data', (chunk: Buffer) => {
      if (this.closed || state.closed) return;
      let offset = 0;
      while (offset < chunk.length) {
        const sliceLen = Math.min(PORT_FORWARD_LIMITS.MAX_DATA_CHUNK_BYTES, chunk.length - offset);
        const slice = chunk.subarray(offset, offset + sliceLen);
        offset += sliceLen;
        state.sendCredit -= slice.length;
        this.bytesSent += slice.length;
        this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.DATA, streamId, slice));
      }
      if (state.sendCredit <= 0 || !this.carrier.isWritable()) {
        socket.pause();
      }
    });

    socket.on('end', () => {
      if (this.closed || state.closed || state.eofSent) return;
      state.eofSent = true;
      this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.EOF, streamId));
      this.maybeCleanupStream(state);
    });

    socket.on('drain', () => {
      if (this.closed || state.closed) return;
      state.waitingDrain = false;
      while (state.pendingWrites.length > 0 && !state.waitingDrain) {
        const next = state.pendingWrites.shift()!;
        const ok = socket.write(next);
        state.pendingWindowAckBytes += next.length;
        if (!ok) {
          state.waitingDrain = true;
          break;
        }
      }
      if (!state.waitingDrain && state.pendingWindowAckBytes >= PORT_FORWARD_LIMITS.STREAM_WINDOW_REFILL_THRESHOLD_BYTES) {
        this.flushWindowUpdate(state);
      }
      if (!state.waitingDrain && state.pendingWrites.length === 0 && state.eofReceived) {
        socket.end();
      }
    });

    socket.on('error', () => {
      if (this.closed || state.closed) return;
      this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.RST, streamId));
      this.destroyLocalStream(state);
    });

    socket.on('close', (hadError: boolean) => {
      if (this.closed || state.closed) return;
      if (!hadError && !state.eofSent) {
        state.eofSent = true;
        this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.EOF, streamId));
      }
      this.destroyLocalStream(state);
    });
  }

  private resumeWritableStreams(): void {
    if (this.closed || !this.carrier.isWritable()) return;
    for (const state of this.streams.values()) {
      if (!state.closed && state.openConfirmed && state.sendCredit > 0) {
        state.socket.resume();
      }
    }
  }

  private flushWindowUpdate(state: MuxStreamState): void {
    if (this.closed || state.closed || state.pendingWindowAckBytes <= 0) return;
    const credit = state.pendingWindowAckBytes;
    state.pendingWindowAckBytes = 0;
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt32BE(credit >>> 0, 0);
    this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.WINDOW_UPDATE, state.streamId, payload));
  }

  private maybeCleanupStream(state: MuxStreamState): void {
    if (state.eofSent && state.eofReceived && state.pendingWrites.length === 0) {
      // Both sides reached EOF; wait for socket finish or destroy cleanly on close.
    }
  }

  private destroyLocalStream(state: MuxStreamState): void {
    if (state.closed) return;
    state.closed = true;
    state.pendingWrites.length = 0;
    this.streams.delete(state.streamId);
    try { state.socket.destroy(); } catch { /* ignore */ }
    this.onStatsChanged?.();
  }

  private handleMuxFrame(frame: PortForwardMuxFrame): void {
    if (this.closed) return;
    const { type, streamId, payload } = frame;

    if (type === PORT_FORWARD_MUX_TYPE.PING) {
      this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.PONG, streamId, payload));
      return;
    }
    if (type === PORT_FORWARD_MUX_TYPE.PONG) {
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.OPEN) {
      if (this.role !== PORT_FORWARD_ROLE.TARGET
        || this.targetHost === undefined
        || this.targetPort === undefined) {
        return;
      }
      if (this.streams.has(streamId)
        || this.streams.size >= PORT_FORWARD_LIMITS.MAX_CONCURRENT_STREAMS_PER_TUNNEL) {
        this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.OPEN_ERR, streamId));
        return;
      }
      const targetSocket = tcpConnect({ host: this.targetHost, port: this.targetPort });
      const state: MuxStreamState = {
        streamId,
        socket: targetSocket,
        openConfirmed: false,
        sendCredit: PORT_FORWARD_LIMITS.STREAM_WINDOW_BYTES,
        eofSent: false,
        eofReceived: false,
        closed: false,
        pendingWindowAckBytes: 0,
        waitingDrain: false,
        pendingWrites: [],
      };
      this.streams.set(streamId, state);
      targetSocket.setNoDelay(true);
      targetSocket.pause();

      let connected = false;
      const onInitialError = () => {
        if (!connected && !state.closed) {
          this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.OPEN_ERR, streamId));
          this.destroyLocalStream(state);
        }
      };
      targetSocket.once('error', onInitialError);
      targetSocket.once('connect', () => {
        connected = true;
        targetSocket.off('error', onInitialError);
        if (this.closed || state.closed) {
          targetSocket.destroy();
          return;
        }
        state.openConfirmed = true;
        this.attachLocalSocketHandlers(state);
        this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.OPEN_OK, streamId));
        targetSocket.resume();
      });
      return;
    }

    const state = this.streams.get(streamId);
    if (!state || state.closed) return;

    if (type === PORT_FORWARD_MUX_TYPE.OPEN_OK) {
      if (this.role !== PORT_FORWARD_ROLE.LISTEN || state.openConfirmed) return;
      state.openConfirmed = true;
      if (state.sendCredit > 0 && this.carrier.isWritable()) {
        state.socket.resume();
      }
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.OPEN_ERR) {
      this.destroyLocalStream(state);
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.DATA) {
      this.bytesReceived += payload.length;
      if (state.waitingDrain) {
        state.pendingWrites.push(payload);
        return;
      }
      const ok = state.socket.write(payload);
      state.pendingWindowAckBytes += payload.length;
      if (!ok) {
        state.waitingDrain = true;
      } else if (state.pendingWindowAckBytes >= PORT_FORWARD_LIMITS.STREAM_WINDOW_REFILL_THRESHOLD_BYTES) {
        this.flushWindowUpdate(state);
      }
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.WINDOW_UPDATE) {
      if (payload.length < 4) return;
      const credit = payload.readUInt32BE(0);
      state.sendCredit += credit;
      if (state.openConfirmed && state.sendCredit > 0 && this.carrier.isWritable()) {
        state.socket.resume();
      }
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.EOF) {
      state.eofReceived = true;
      if (!state.waitingDrain && state.pendingWrites.length === 0) {
        state.socket.end();
      }
      this.maybeCleanupStream(state);
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.RST) {
      this.destroyLocalStream(state);
      return;
    }
  }
}

interface ActiveTunnel {
  tunnelId: string;
  role: PortForwardRole;
  capability: string;
  keys: TunnelCryptoKeys;
  transportPref: PortForwardTransportPref;
  listenHost?: typeof PORT_FORWARD_LIMITS.LISTEN_HOST;
  listenPort?: number;
  targetHost?: string;
  targetPort?: number;
  createdAt: number;
  expiresAt: number;
  ttlTimer: ReturnType<typeof setTimeout>;
  statsTimer: ReturnType<typeof setInterval> | null;
  lastStatsKey: string;
  localServer: NetServer | null;
  pendingClientSockets: NetSocket[];
  tcpAcceptServer: NetServer | null;
  tcpAcceptSockets: Set<NetSocket>;
  udpSocket: DgramSocket | null;
  abortController: AbortController;
  carrier: PortForwardCarrier | null;
  mux: PortForwardMuxSession | null;
  transportMode: PortForwardTransport | null;
  relayFallbackHandle: RelayTransport | null;
  closed: boolean;
}

export class PortForwardEngine {
  private readonly tunnels = new Map<string, ActiveTunnel>();
  private readonly timeouts: PortForwardEngineTimeouts;
  private readonly collectAddresses: () => string[];
  private readonly probeStun: typeof probeStunCandidates;

  constructor(private readonly options: PortForwardEngineOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.collectAddresses = options.collectInterfaceAddresses ?? defaultCollectInterfaceAddresses;
    this.probeStun = options.probeStun ?? probeStunCandidates;
  }

  listTunnels(): PortForwardEngineTunnelSnapshot[] {
    const out: PortForwardEngineTunnelSnapshot[] = [];
    for (const t of this.tunnels.values()) {
      out.push({
        tunnelId: t.tunnelId,
        role: t.role,
        transportMode: t.transportMode,
        ...(t.listenPort !== undefined ? { listenPort: t.listenPort } : {}),
        ...(t.targetHost !== undefined ? { targetHost: t.targetHost } : {}),
        ...(t.targetPort !== undefined ? { targetPort: t.targetPort } : {}),
        activeConnections: t.mux?.activeConnections() ?? 0,
        bytesSent: t.mux?.bytesSent ?? 0,
        bytesReceived: t.mux?.bytesReceived ?? 0,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
      });
    }
    return out;
  }

  async handleMessage(raw: unknown): Promise<boolean> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const type = (raw as { type?: unknown }).type;
    if (typeof type !== 'string' || !type.startsWith('port_forward.')) return false;

    const parsed = validatePortForwardWireMessage(raw);
    if (!parsed.ok) return true;
    const msg = parsed.value;

    switch (msg.type) {
      case PORT_FORWARD_MSG.PREPARE:
        await this.handlePrepare(msg);
        return true;
      case PORT_FORWARD_MSG.CONNECT:
        await this.handleConnect(msg);
        return true;
      case PORT_FORWARD_MSG.CLOSE:
        this.closeTunnel(msg.tunnelId, msg.reason ?? 'remote_close', false);
        return true;
      case PORT_FORWARD_MSG.RELAY_FRAME:
        this.handleRelayFrame(msg.tunnelId, msg.data);
        return true;
      default:
        return true;
    }
  }

  closeTunnel(tunnelId: string, reason = 'closed', notifyServer = true): boolean {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel || tunnel.closed) return false;
    tunnel.closed = true;
    this.tunnels.delete(tunnelId);
    clearTimeout(tunnel.ttlTimer);
    if (tunnel.statsTimer) {
      clearInterval(tunnel.statsTimer);
      tunnel.statsTimer = null;
    }
    tunnel.abortController.abort(new Error(reason));
    for (const sock of tunnel.pendingClientSockets.splice(0)) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    if (tunnel.localServer) {
      try { tunnel.localServer.close(); } catch { /* ignore */ }
      tunnel.localServer = null;
    }
    this.cleanupPreparationResources(tunnel, true);
    tunnel.mux?.closeAll(reason);
    tunnel.carrier?.close(reason);
    if (notifyServer) {
      this.options.sendWs({ type: PORT_FORWARD_MSG.CLOSE, tunnelId, reason });
    }
    return true;
  }

  closeAll(reason = 'shutdown'): void {
    for (const tunnelId of [...this.tunnels.keys()]) {
      this.closeTunnel(tunnelId, reason, false);
    }
  }

  private emitError(tunnelId: string, reason: PortForwardErrorCode, error: string): void {
    this.options.sendWs({ type: PORT_FORWARD_MSG.ERROR, tunnelId, reason, error });
  }

  private cleanupPreparationResources(tunnel: ActiveTunnel, forceCloseUdp: boolean): void {
    if (tunnel.tcpAcceptServer) {
      try { tunnel.tcpAcceptServer.close(); } catch { /* ignore */ }
      tunnel.tcpAcceptServer = null;
    }
    for (const sock of tunnel.tcpAcceptSockets) {
      if (tunnel.carrier && tunnel.carrier.mode === PORT_FORWARD_TRANSPORT.DIRECT_TCP) {
        if (sock === (tunnel.carrier as DirectTcpTransport).rawSocket) continue;
      }
      try { sock.destroy(); } catch { /* ignore */ }
    }
    tunnel.tcpAcceptSockets.clear();
    if (forceCloseUdp && tunnel.udpSocket) {
      try { tunnel.udpSocket.close(); } catch { /* ignore */ }
      tunnel.udpSocket = null;
    }
  }

  private async handlePrepare(msg: PortForwardPrepareMessage): Promise<void> {
    if (this.tunnels.has(msg.tunnelId)) {
      this.closeTunnel(msg.tunnelId, 'replaced', false);
    }
    if (this.tunnels.size >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE) {
      this.emitError(msg.tunnelId, PORT_FORWARD_ERRORS.LIMIT_EXCEEDED, 'node tunnel limit exceeded');
      return;
    }

    let keys: TunnelCryptoKeys;
    try {
      keys = deriveTunnelCryptoKeys(msg.capability, msg.tunnelId);
    } catch {
      this.emitError(msg.tunnelId, PORT_FORWARD_ERRORS.INVALID_REQUEST, 'invalid tunnel capability');
      return;
    }

    const now = Date.now();
    const abortController = new AbortController();
    const ttlTimer = setTimeout(() => {
      this.closeTunnel(msg.tunnelId, 'ttl_expired', true);
    }, msg.ttlMs);
    ttlTimer.unref?.();

    const tunnel: ActiveTunnel = {
      tunnelId: msg.tunnelId,
      role: msg.role,
      capability: msg.capability,
      keys,
      transportPref: msg.transport,
      ...(msg.role === PORT_FORWARD_ROLE.LISTEN
        ? { listenHost: PORT_FORWARD_LIMITS.LISTEN_HOST, listenPort: msg.listenPort ?? 0 }
        : { targetHost: msg.targetHost!, targetPort: msg.targetPort! }),
      createdAt: now,
      expiresAt: now + msg.ttlMs,
      ttlTimer,
      statsTimer: null,
      lastStatsKey: '',
      localServer: null,
      pendingClientSockets: [],
      tcpAcceptServer: null,
      tcpAcceptSockets: new Set(),
      udpSocket: null,
      abortController,
      carrier: null,
      mux: null,
      transportMode: null,
      relayFallbackHandle: null,
      closed: false,
    };
    this.tunnels.set(msg.tunnelId, tunnel);

    // 1. Bind loopback listener early on listen role so port availability & ephemeral port resolve immediately.
    if (msg.role === PORT_FORWARD_ROLE.LISTEN) {
      const bound = await this.bindLoopbackListener(tunnel, msg.listenPort ?? 0);
      if (!bound.ok) {
        this.closeTunnel(msg.tunnelId, bound.reason, false);
        this.emitError(msg.tunnelId, bound.reason, bound.error);
        return;
      }
      tunnel.listenPort = bound.port;
    }

    if (tunnel.closed) return;

    // 2. Gather direct TCP + UDP (host + STUN srflx) candidates when P2P may be used.
    const candidates: PortForwardCandidate[] = [];
    if (msg.transport !== PORT_FORWARD_TRANSPORT_PREF.RELAY) {
      const addresses = this.collectAddresses().filter((addr) => isIP(addr) === 4 && addr !== '0.0.0.0');

      if (!this.options.disableDirectTcp) {
        const tcpServer = createTcpServer();
        const tcpPort = await new Promise<number>((resolve) => {
          tcpServer.once('error', () => resolve(0));
          tcpServer.listen({ host: '0.0.0.0', port: 0, exclusive: true }, () => {
            const addr = tcpServer.address();
            resolve(addr && typeof addr !== 'string' ? addr.port : 0);
          });
        });
        if (tcpPort > 0 && !tunnel.closed) {
          tunnel.tcpAcceptServer = tcpServer;
          for (const host of addresses) {
            candidates.push({ host, port: tcpPort, transport: 'tcp', kind: 'host' });
          }
        } else {
          try { tcpServer.close(); } catch { /* ignore */ }
        }
      }

      if (!this.options.disableDirectUdp && !tunnel.closed) {
        const udpSock = createSocket('udp4');
        const udpPort = await new Promise<number>((resolve) => {
          udpSock.once('error', () => resolve(0));
          udpSock.bind(0, '0.0.0.0', () => {
            const addr = udpSock.address();
            resolve(addr && typeof addr !== 'string' ? addr.port : 0);
          });
        });
        if (udpPort > 0 && !tunnel.closed) {
          tunnel.udpSocket = udpSock;
          for (const host of addresses) {
            candidates.push({ host, port: udpPort, transport: 'udp', kind: 'host' });
          }
          const stunEndpoints = await this.probeStun(udpSock, msg.iceServers, {
            timeoutMs: this.timeouts.stunProbeMs,
          }).catch(() => []);
          if (!tunnel.closed) {
            for (const ep of stunEndpoints) {
              candidates.push({ host: ep.host, port: ep.port, transport: 'udp', kind: 'srflx' });
            }
          }
        } else {
          try { udpSock.close(); } catch { /* ignore */ }
        }
      }
    }

    if (tunnel.closed) return;

    this.options.sendWs({
      type: PORT_FORWARD_MSG.READY,
      tunnelId: tunnel.tunnelId,
      role: tunnel.role,
      ...(tunnel.role === PORT_FORWARD_ROLE.LISTEN ? { listenPort: tunnel.listenPort! } : {}),
      candidates: deduplicateCandidates(candidates, PORT_FORWARD_LIMITS.MAX_CANDIDATES),
    });
  }

  private async bindLoopbackListener(
    tunnel: ActiveTunnel,
    requestedPort: number,
  ): Promise<{ ok: true; port: number } | { ok: false; reason: PortForwardErrorCode; error: string }> {
    const server = createTcpServer((clientSocket) => {
      if (tunnel.closed) {
        clientSocket.destroy();
        return;
      }
      if (tunnel.mux) {
        tunnel.mux.acceptClientSocket(clientSocket);
        return;
      }
      if (tunnel.pendingClientSockets.length >= PORT_FORWARD_LIMITS.MAX_CONCURRENT_STREAMS_PER_TUNNEL) {
        clientSocket.destroy();
        return;
      }
      clientSocket.pause();
      clientSocket.once('close', () => {
        const idx = tunnel.pendingClientSockets.indexOf(clientSocket);
        if (idx >= 0) tunnel.pendingClientSockets.splice(idx, 1);
      });
      tunnel.pendingClientSockets.push(clientSocket);
    });

    return new Promise((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        try { server.close(); } catch { /* ignore */ }
        const reason = err.code === 'EADDRINUSE'
          ? PORT_FORWARD_ERRORS.LISTEN_PORT_IN_USE
          : PORT_FORWARD_ERRORS.INTERNAL_ERROR;
        resolve({ ok: false, reason, error: err.message });
      });
      // Boundary requirement: ALWAYS bind strictly on 127.0.0.1, never 0.0.0.0 / ::.
      server.listen({ host: PORT_FORWARD_LIMITS.LISTEN_HOST, port: requestedPort, exclusive: true }, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          try { server.close(); } catch { /* ignore */ }
          resolve({ ok: false, reason: PORT_FORWARD_ERRORS.INTERNAL_ERROR, error: 'failed to read loopback port' });
          return;
        }
        tunnel.localServer = server;
        resolve({ ok: true, port: addr.port });
      });
    });
  }

  private async handleConnect(msg: PortForwardConnectMessage): Promise<void> {
    const tunnel = this.tunnels.get(msg.tunnelId);
    if (!tunnel || tunnel.closed) return;
    if (tunnel.carrier) return;

    if (msg.transport === PORT_FORWARD_TRANSPORT_PREF.RELAY) {
      const relay = this.createRelayCarrier(tunnel);
      this.commitCarrier(tunnel, relay, true);
      if (tunnel.role === PORT_FORWARD_ROLE.LISTEN) {
        relay.sendMuxFrame(createPortForwardPingMuxFrame());
        this.options.sendWs({
          type: PORT_FORWARD_MSG.ESTABLISHED,
          tunnelId: tunnel.tunnelId,
          transportMode: PORT_FORWARD_TRANSPORT.RELAY,
          listenPort: tunnel.listenPort!,
        });
      }
      return;
    }

    if (tunnel.role === PORT_FORWARD_ROLE.LISTEN) {
      await this.connectAsListenArbiter(tunnel, msg);
    } else {
      await this.connectAsTargetResponder(tunnel, msg);
    }
  }

  private createRelayCarrier(tunnel: ActiveTunnel): RelayTransport {
    const relay = new RelayTransport(tunnel.tunnelId, tunnel.role, tunnel.keys, (data) => {
      if (tunnel.closed) return;
      this.options.sendWs({
        type: PORT_FORWARD_MSG.RELAY_FRAME,
        tunnelId: tunnel.tunnelId,
        data,
      });
    });
    tunnel.relayFallbackHandle = relay;
    return relay;
  }

  private handleRelayFrame(tunnelId: string, data: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel || tunnel.closed) return;

    // On target in auto mode, receiving an authentic RELAY_FRAME means listen committed to relay!
    if (!tunnel.carrier && tunnel.role === PORT_FORWARD_ROLE.TARGET && tunnel.transportPref !== PORT_FORWARD_TRANSPORT_PREF.P2P_ONLY) {
      const relay = tunnel.relayFallbackHandle ?? this.createRelayCarrier(tunnel);
      if (!relay.deliverRelayData(data)) return;
      this.commitCarrier(tunnel, relay, true);
      return;
    }

    if (tunnel.carrier?.mode === PORT_FORWARD_TRANSPORT.RELAY && tunnel.relayFallbackHandle) {
      tunnel.relayFallbackHandle.deliverRelayData(data);
    }
  }

  private commitCarrier(tunnel: ActiveTunnel, carrier: PortForwardCarrier, closeUdp: boolean): void {
    if (tunnel.closed || tunnel.carrier) {
      carrier.close('duplicate_carrier');
      return;
    }
    tunnel.carrier = carrier;
    tunnel.transportMode = carrier.mode;
    tunnel.abortController.abort(new Error(`carrier_committed:${carrier.mode}`));

    // Close unused TCP accept server / extra sockets / unused UDP socket.
    if (tunnel.tcpAcceptServer) {
      try { tunnel.tcpAcceptServer.close(); } catch { /* ignore */ }
      tunnel.tcpAcceptServer = null;
    }
    for (const sock of tunnel.tcpAcceptSockets) {
      if (carrier.mode === PORT_FORWARD_TRANSPORT.DIRECT_TCP && sock === (carrier as DirectTcpTransport).rawSocket) {
        continue;
      }
      try { sock.destroy(); } catch { /* ignore */ }
    }
    tunnel.tcpAcceptSockets.clear();
    if (closeUdp && tunnel.udpSocket && carrier.mode !== PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P) {
      try { tunnel.udpSocket.close(); } catch { /* ignore */ }
      tunnel.udpSocket = null;
    }

    const pushStats = () => {
      if (tunnel.closed || tunnel.role !== PORT_FORWARD_ROLE.LISTEN || !tunnel.mux) return;
      const activeConnections = tunnel.mux.activeConnections();
      const bytesSent = tunnel.mux.bytesSent;
      const bytesReceived = tunnel.mux.bytesReceived;
      const key = `${activeConnections}:${bytesSent}:${bytesReceived}`;
      if (key === tunnel.lastStatsKey) return;
      tunnel.lastStatsKey = key;
      this.options.sendWs({
        type: PORT_FORWARD_MSG.STATS,
        tunnelId: tunnel.tunnelId,
        activeConnections,
        bytesSent,
        bytesReceived,
      });
    };

    const mux = new PortForwardMuxSession(
      tunnel.role,
      carrier,
      tunnel.targetHost,
      tunnel.targetPort,
      pushStats,
    );
    tunnel.mux = mux;
    if (tunnel.role === PORT_FORWARD_ROLE.LISTEN) {
      const statsTimer = setInterval(pushStats, 2_000);
      statsTimer.unref?.();
      tunnel.statsTimer = statsTimer;
    }
    carrier.onClose((reason) => {
      if (!tunnel.closed) this.closeTunnel(tunnel.tunnelId, reason, true);
    });

    if (tunnel.role === PORT_FORWARD_ROLE.LISTEN) {
      for (const sock of tunnel.pendingClientSockets.splice(0)) {
        if (sock.destroyed) continue;
        mux.acceptClientSocket(sock);
      }
    }
  }

  private async connectAsListenArbiter(tunnel: ActiveTunnel, msg: PortForwardConnectMessage): Promise<void> {
    const raceController = new AbortController();
    const onParentAbort = () => raceController.abort(tunnel.abortController.signal.reason);
    tunnel.abortController.signal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const tcpCandidates = this.options.disableDirectTcp
        ? []
        : msg.peerCandidates.filter((c) => c.transport === 'tcp');
      const udpCandidates = this.options.disableDirectUdp || !tunnel.udpSocket
        ? []
        : msg.peerCandidates.filter((c) => c.transport === 'udp');

      // Start TCP attempt (both outbound dial & inbound accept) and UDP hole punch concurrently.
      const tcpPromise = !this.options.disableDirectTcp && (tcpCandidates.length > 0 || tunnel.tcpAcceptServer !== null)
        ? this.attemptDirectTcpAsListen(tunnel, tcpCandidates, raceController.signal)
        : Promise.resolve(null);

      const udpPromise = udpCandidates.length > 0 && tunnel.udpSocket
        ? runUdpHolePunch({
            socket: tunnel.udpSocket,
            tunnelId: tunnel.tunnelId,
            role: PORT_FORWARD_ROLE.LISTEN,
            keys: tunnel.keys,
            peerCandidates: udpCandidates,
            punchIntervalMs: this.timeouts.udpPunchIntervalMs,
            timeoutMs: this.timeouts.udpPunchMs,
            signal: raceController.signal,
          })
        : Promise.resolve(null);

      let tcpDone = false;
      let tcpWinner: DirectTcpTransport | null = null;
      const tcpSettled = tcpPromise.then((res) => {
        tcpDone = true;
        tcpWinner = res;
        return res;
      });

      // Wait for first completion or both.
      const first = await Promise.race([
        tcpSettled.then((res) => ({ kind: 'tcp' as const, res })),
        udpPromise.then((res) => ({ kind: 'udp' as const, res })),
      ]);

      if (tunnel.closed) return;

      if (first.kind === 'tcp' && first.res) {
        raceController.abort(new Error('tcp_won'));
        this.commitCarrier(tunnel, first.res, true);
        this.options.sendWs({
          type: PORT_FORWARD_MSG.ESTABLISHED,
          tunnelId: tunnel.tunnelId,
          transportMode: PORT_FORWARD_TRANSPORT.DIRECT_TCP,
          listenPort: tunnel.listenPort!,
        });
        return;
      }

      if (first.kind === 'udp' && first.res && !tcpDone) {
        // Give direct TCP a short preference window to win if it is about to complete.
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          tcpSettled,
          new Promise<void>((resolve) => {
            waitTimer = setTimeout(resolve, this.timeouts.directTcpPreferenceWaitMs);
            waitTimer.unref?.();
          }),
        ]);
        if (waitTimer) clearTimeout(waitTimer);
        if (tunnel.closed) return;
        if (tcpWinner) {
          raceController.abort(new Error('tcp_won'));
          this.commitCarrier(tunnel, tcpWinner, true);
          this.options.sendWs({
            type: PORT_FORWARD_MSG.ESTABLISHED,
            tunnelId: tunnel.tunnelId,
            transportMode: PORT_FORWARD_TRANSPORT.DIRECT_TCP,
            listenPort: tunnel.listenPort!,
          });
          return;
        }
      }

      // Check UDP winner (either first.kind==='udp' && first.res, or wait for udpPromise after tcp failed).
      const udpResult = first.kind === 'udp' ? first.res : await udpPromise;
      if (tunnel.closed) return;

      // Also re-check if tcpWinner completed while waiting on udp.
      if (tcpWinner) {
        raceController.abort(new Error('tcp_won'));
        this.commitCarrier(tunnel, tcpWinner, true);
        this.options.sendWs({
          type: PORT_FORWARD_MSG.ESTABLISHED,
          tunnelId: tunnel.tunnelId,
          transportMode: PORT_FORWARD_TRANSPORT.DIRECT_TCP,
          listenPort: tunnel.listenPort!,
        });
        return;
      }

      if (udpResult && tunnel.udpSocket) {
        raceController.abort(new Error('udp_won'));
        const udpCarrier = new ReliableUdpTransport({
          socket: tunnel.udpSocket,
          tunnelId: tunnel.tunnelId,
          role: PORT_FORWARD_ROLE.LISTEN,
          keys: tunnel.keys,
          peerHost: udpResult.peerHost,
          peerPort: udpResult.peerPort,
          heartbeatIntervalMs: this.timeouts.udpHeartbeatMs,
          deadLinkTimeoutMs: this.timeouts.udpDeadLinkMs,
          initialPackets: udpResult.bufferedArqPackets,
          ownsSocket: true,
        });
        this.commitCarrier(tunnel, udpCarrier, false);
        udpCarrier.sendMuxFrame(createPortForwardPingMuxFrame());
        this.options.sendWs({
          type: PORT_FORWARD_MSG.ESTABLISHED,
          tunnelId: tunnel.tunnelId,
          transportMode: PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P,
          listenPort: tunnel.listenPort!,
        });
        return;
      }

      // Neither direct TCP nor UDP P2P succeeded.
      if (msg.transport === PORT_FORWARD_TRANSPORT_PREF.P2P_ONLY) {
        this.closeTunnel(tunnel.tunnelId, PORT_FORWARD_ERRORS.P2P_FAILED, false);
        this.emitError(tunnel.tunnelId, PORT_FORWARD_ERRORS.P2P_FAILED, 'direct TCP and UDP P2P hole punching both failed');
        return;
      }

      const relay = this.createRelayCarrier(tunnel);
      this.commitCarrier(tunnel, relay, true);
      relay.sendMuxFrame(createPortForwardPingMuxFrame());
      this.options.sendWs({
        type: PORT_FORWARD_MSG.ESTABLISHED,
        tunnelId: tunnel.tunnelId,
        transportMode: PORT_FORWARD_TRANSPORT.RELAY,
        listenPort: tunnel.listenPort!,
      });
    } finally {
      raceController.abort();
      tunnel.abortController.signal.removeEventListener('abort', onParentAbort);
    }
  }

  private async connectAsTargetResponder(tunnel: ActiveTunnel, msg: PortForwardConnectMessage): Promise<void> {
    const raceController = new AbortController();
    const onParentAbort = () => raceController.abort(tunnel.abortController.signal.reason);
    tunnel.abortController.signal.addEventListener('abort', onParentAbort, { once: true });

    const tcpCandidates = this.options.disableDirectTcp
      ? []
      : msg.peerCandidates.filter((c) => c.transport === 'tcp');
    const udpCandidates = this.options.disableDirectUdp || !tunnel.udpSocket
      ? []
      : msg.peerCandidates.filter((c) => c.transport === 'udp');

    // Run TCP responder + delayed dial and UDP punch concurrently; whichever gets listen's commit first wins!
    if (!this.options.disableDirectTcp) {
      void this.acceptAndDialDirectTcpAsTarget(tunnel, tcpCandidates, raceController.signal);
    }

    if (udpCandidates.length > 0 && tunnel.udpSocket) {
      const sock = tunnel.udpSocket;
      void runUdpHolePunch({
        socket: sock,
        tunnelId: tunnel.tunnelId,
        role: PORT_FORWARD_ROLE.TARGET,
        keys: tunnel.keys,
        peerCandidates: udpCandidates,
        punchIntervalMs: this.timeouts.udpPunchIntervalMs,
        timeoutMs: this.timeouts.udpPunchMs,
        signal: raceController.signal,
      }).then((udpResult) => {
        if (!udpResult || tunnel.closed || tunnel.carrier || raceController.signal.aborted) return;

        const commitUdp = (packets: typeof udpResult.bufferedArqPackets, peerHost: string, peerPort: number) => {
          if (tunnel.closed || tunnel.carrier || raceController.signal.aborted) return;
          const udpCarrier = new ReliableUdpTransport({
            socket: sock,
            tunnelId: tunnel.tunnelId,
            role: PORT_FORWARD_ROLE.TARGET,
            keys: tunnel.keys,
            peerHost,
            peerPort,
            heartbeatIntervalMs: this.timeouts.udpHeartbeatMs,
            deadLinkTimeoutMs: this.timeouts.udpDeadLinkMs,
            initialPackets: packets,
            ownsSocket: true,
          });
          this.commitCarrier(tunnel, udpCarrier, false);
          raceController.abort(new Error('udp_won'));
        };

        // Target never commits UDP before listen's arbiter chooses a carrier:
        // either ARQ packets already arrived during punch, or we wait for
        // the first valid ARQ packet from listen while keeping TCP/relay open.
        if (udpResult.bufferedArqPackets.length > 0) {
          commitUdp(udpResult.bufferedArqPackets, udpResult.peerHost, udpResult.peerPort);
          return;
        }

        const onWaitCommit = (rawMsg: Buffer, rinfo: { address: string; port: number }) => {
          if (tunnel.closed || tunnel.carrier || raceController.signal.aborted) {
            sock.off('message', onWaitCommit);
            return;
          }
          if (rawMsg.length < 3 || rawMsg[0] !== UDP_P2P_MAGIC) return;
          const pktType = rawMsg[1]!;
          if (pktType < UDP_P2P_PKT.ARQ_DATA || pktType > UDP_P2P_PKT.ARQ_PING) return;
          const decrypted = decryptUdpArqPacket(
            tunnel.keys.listenToTargetKey,
            0x4c540001,
            tunnel.tunnelId,
            rawMsg,
          );
          if (!decrypted) return;
          sock.off('message', onWaitCommit);
          commitUdp([{ packet: Buffer.from(rawMsg), rinfo: rinfo as never }], rinfo.address, rinfo.port);
        };
        sock.on('message', onWaitCommit);
        raceController.signal.addEventListener('abort', () => sock.off('message', onWaitCommit), { once: true });
      }).catch(() => {});
    }

    // If relay frame arrives later (auto fallback), handleRelayFrame commits RelayTransport and aborts raceController!
  }

  private attemptDirectTcpAsListen(
    tunnel: ActiveTunnel,
    candidates: readonly PortForwardCandidate[],
    signal: AbortSignal,
  ): Promise<DirectTcpTransport | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const pendingSockets = new Set<NetSocket>();
      const pendingPromises: Promise<void>[] = [];

      const finish = (winner: DirectTcpTransport | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        tunnel.tcpAcceptServer?.off('connection', onIncoming);
        for (const s of pendingSockets) {
          if (winner && s === winner.rawSocket) continue;
          try { s.destroy(); } catch { /* ignore */ }
        }
        resolve(winner);
      };

      const onAbort = () => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });

      const adoptAuthenticated = (auth: Awaited<ReturnType<typeof authenticateTcpSocket>>) => {
        if (settled || signal.aborted || tunnel.closed) {
          auth.socket.destroy();
          return;
        }
        const transport = new DirectTcpTransport(
          auth.socket,
          tunnel.tunnelId,
          PORT_FORWARD_ROLE.LISTEN,
          auth.sendKey,
          auth.recvKey,
          auth.sendDirTag,
          auth.recvDirTag,
          auth.initialBytes,
        );
        finish(transport);
      };

      const onIncoming = (socket: NetSocket) => {
        if (settled || signal.aborted || tunnel.closed) {
          socket.destroy();
          return;
        }
        pendingSockets.add(socket);
        tunnel.tcpAcceptSockets.add(socket);
        socket.once('close', () => {
          pendingSockets.delete(socket);
          tunnel.tcpAcceptSockets.delete(socket);
        });
        void authenticateTcpSocket({
          socket,
          tunnelId: tunnel.tunnelId,
          role: PORT_FORWARD_ROLE.LISTEN,
          authKey: tunnel.keys.punchMacKey,
          capability: tunnel.capability,
          isInitiator: false,
          handshakeMs: this.timeouts.handshakeMs,
        }).then(adoptAuthenticated, () => {
          socket.destroy();
        });
      };
      tunnel.tcpAcceptServer?.on('connection', onIncoming);

      for (const candidate of candidates) {
        const sock = tcpConnect({ host: candidate.host, port: candidate.port });
        pendingSockets.add(sock);
        sock.once('close', () => pendingSockets.delete(sock));
        const p = new Promise<void>((done) => {
          sock.once('error', () => { sock.destroy(); done(); });
          sock.once('connect', () => {
            if (settled || signal.aborted || tunnel.closed) {
              sock.destroy();
              done();
              return;
            }
            void authenticateTcpSocket({
              socket: sock,
              tunnelId: tunnel.tunnelId,
              role: PORT_FORWARD_ROLE.LISTEN,
              authKey: tunnel.keys.punchMacKey,
              capability: tunnel.capability,
              isInitiator: true,
              handshakeMs: this.timeouts.handshakeMs,
            }).then((auth) => {
              adoptAuthenticated(auth);
              done();
            }, () => {
              sock.destroy();
              done();
            });
          });
        });
        pendingPromises.push(p);
      }

      if (candidates.length > 0 && !tunnel.tcpAcceptServer) {
        void Promise.allSettled(pendingPromises).then(() => finish(null));
      }

      const timer = setTimeout(() => finish(null), this.timeouts.directTcpMs);
      timer.unref?.();
    });
  }

  private async acceptAndDialDirectTcpAsTarget(
    tunnel: ActiveTunnel,
    candidates: readonly PortForwardCandidate[],
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || tunnel.closed) return;
    const activeCandidates = new Set<DirectTcpTransport>();

    const handleAuthenticated = (auth: Awaited<ReturnType<typeof authenticateTcpSocket>>) => {
      if (signal.aborted || tunnel.closed || tunnel.carrier) {
        auth.socket.destroy();
        return;
      }
      const transport = new DirectTcpTransport(
        auth.socket,
        tunnel.tunnelId,
        PORT_FORWARD_ROLE.TARGET,
        auth.sendKey,
        auth.recvKey,
        auth.sendDirTag,
        auth.recvDirTag,
        auth.initialBytes,
        () => {
          activeCandidates.delete(transport);
          for (const other of activeCandidates) other.close('superseded');
          activeCandidates.clear();
          this.commitCarrier(tunnel, transport, true);
        },
      );
      activeCandidates.add(transport);
      transport.onClose(() => activeCandidates.delete(transport));
    };

    const onIncoming = (socket: NetSocket) => {
      if (signal.aborted || tunnel.closed || tunnel.carrier) {
        socket.destroy();
        return;
      }
      tunnel.tcpAcceptSockets.add(socket);
      socket.once('close', () => tunnel.tcpAcceptSockets.delete(socket));
      void authenticateTcpSocket({
        socket,
        tunnelId: tunnel.tunnelId,
        role: PORT_FORWARD_ROLE.TARGET,
        authKey: tunnel.keys.punchMacKey,
        capability: tunnel.capability,
        isInitiator: false,
        handshakeMs: this.timeouts.handshakeMs,
      }).then(handleAuthenticated, () => {
        socket.destroy();
      });
    };

    tunnel.tcpAcceptServer?.on('connection', onIncoming);

    const onAbort = () => {
      tunnel.tcpAcceptServer?.off('connection', onIncoming);
      clearTimeout(dialDelayTimer);
      for (const other of activeCandidates) other.close('aborted');
      activeCandidates.clear();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    // Delay outbound dial slightly so same-LAN listen->target connect wins first without duplicate sockets.
    const dialDelayTimer = setTimeout(() => {
      if (signal.aborted || tunnel.closed || tunnel.carrier) return;
      for (const candidate of candidates) {
        const sock = tcpConnect({ host: candidate.host, port: candidate.port });
        tunnel.tcpAcceptSockets.add(sock);
        sock.once('close', () => tunnel.tcpAcceptSockets.delete(sock));
        sock.once('error', () => sock.destroy());
        sock.once('connect', () => {
          if (signal.aborted || tunnel.closed || tunnel.carrier) {
            sock.destroy();
            return;
          }
          void authenticateTcpSocket({
            socket: sock,
            tunnelId: tunnel.tunnelId,
            role: PORT_FORWARD_ROLE.TARGET,
            authKey: tunnel.keys.punchMacKey,
            capability: tunnel.capability,
            isInitiator: true,
            handshakeMs: this.timeouts.handshakeMs,
          }).then(handleAuthenticated, () => sock.destroy());
        });
      }
    }, this.timeouts.directTcpTargetDialDelayMs);
    dialDelayTimer.unref?.();
  }
}

function deduplicateCandidates(
  candidates: readonly PortForwardCandidate[],
  maxItems: number,
): PortForwardCandidate[] {
  const seen = new Set<string>();
  const out: PortForwardCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.transport}:${c.kind}:${c.host}:${c.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= maxItems) break;
  }
  return out;
}
