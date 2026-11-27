import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
  type KeyObject,
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
import {
  computeEcdhSharedSecret,
  computeEphemeralKeyProof,
  computeKeyConfirmationMac,
  deriveAdmissionMacKey,
  deriveE2eTransportKeys,
  generateEphemeralEcdhKeyPair,
  generateEndpointIdentityKeyPair,
  loadOrCreatePortForwardIdentity,
  loadTrustedPeerPublicKeys,
  signPortForwardTranscript,
  verifyEphemeralKeyProof,
  verifyKeyConfirmationMac,
  verifyPortForwardTranscript,
  type E2eTransportKeys,
  type EndpointIdentityKeyPair,
} from './port-forward-crypto.js';
import { probeStunCandidates } from './port-forward-stun.js';
import {
  ReliableUdpTransport,
  UDP_P2P_MAGIC,
  UDP_P2P_PKT,
  decryptUdpArqPacket,
  runUdpHolePunch,
  type PortForwardCarrier,
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
  sendWs: (message: PortForwardWireMessage) => boolean | void;
  getWsBufferedAmount?: () => number;
  collectInterfaceAddresses?: () => string[];
  probeStun?: typeof probeStunCandidates;
  timeouts?: Partial<PortForwardEngineTimeouts>;
  /** Local long-term Ed25519 identity keypair or persistent file path (private key never leaves node). */
  identityKeyPair?: EndpointIdentityKeyPair;
  identityFilePath?: string;
  /** Out-of-band relay-independent trusted peer public key resolver or JSON map file. */
  resolveTrustedPeerPublicKey?: (peerServerId: string) => Promise<string | null> | string | null;
  trustedPeersFilePath?: string;
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

interface E2eIdentityContext {
  tunnelId: string;
  listenServerId: string;
  targetServerId: string;
  listenPublicKey: string;
  targetPublicKey: string;
  listenIdentityPublicKey?: string;
  targetIdentityPublicKey?: string;
  transportMode: PortForwardTransport;
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

function closeNetServer(server: NetServer | null): void {
  if (!server) return;
  try { server.close(); } catch { /* ignore */ }
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

function hmacB64(key: Buffer, text: string): string {
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
  selfServerId: string;
  peerServerId: string;
  admissionKey: Buffer;
  ecdhSecret: Buffer;
  capability: string;
  listenPublicKey: string;
  targetPublicKey: string;
  isInitiator: boolean;
  handshakeMs: number;
}): Promise<{
  socket: NetSocket;
  transportKeys: E2eTransportKeys;
  sendKey: Buffer;
  recvKey: Buffer;
  sendDirTag: number;
  recvDirTag: number;
  initialBytes: Buffer;
}> {
  const {
    socket,
    tunnelId,
    role,
    selfServerId,
    peerServerId,
    admissionKey,
    ecdhSecret,
    capability,
    listenPublicKey,
    targetPublicKey,
    isInitiator,
    handshakeMs,
  } = options;
  const expectedPeerRole = role === PORT_FORWARD_ROLE.LISTEN ? PORT_FORWARD_ROLE.TARGET : PORT_FORWARD_ROLE.LISTEN;
  const reader = new TcpSocketLineReader(socket);
  socket.resume();
  let nonce1: string;
  let nonce2: string;

  try {
    if (isInitiator) {
      nonce1 = hmacB64(admissionKey, `nonce:${Date.now()}:${Math.random()}`).slice(0, 24);
      const proof1 = hmacB64(admissionKey, `pf-tcp-hello1:${tunnelId}:${role}:${selfServerId}:${peerServerId}:${nonce1}`);
      socket.write(`${JSON.stringify({ kind: 'hello1', tunnelId, role, nonce: nonce1, proof: proof1 })}\n`);
      const line2 = await reader.readLine(PORT_FORWARD_LIMITS.HANDSHAKE_LINE_MAX_BYTES, handshakeMs);
      const msg2 = JSON.parse(line2) as Record<string, unknown>;
      if (msg2.kind !== 'hello2'
        || msg2.tunnelId !== tunnelId
        || msg2.role !== expectedPeerRole
        || typeof msg2.nonce !== 'string'
        || !proofEquals(
          hmacB64(admissionKey, `pf-tcp-hello2:${tunnelId}:${expectedPeerRole}:${peerServerId}:${selfServerId}:${nonce1}:${msg2.nonce}`),
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
          hmacB64(admissionKey, `pf-tcp-hello1:${tunnelId}:${expectedPeerRole}:${peerServerId}:${selfServerId}:${msg1.nonce}`),
          msg1.proof,
        )) {
        throw new Error('tcp_auth_failed');
      }
      nonce1 = msg1.nonce;
      nonce2 = hmacB64(admissionKey, `nonce2:${Date.now()}:${Math.random()}`).slice(0, 24);
      const proof2 = hmacB64(admissionKey, `pf-tcp-hello2:${tunnelId}:${role}:${selfServerId}:${peerServerId}:${nonce1}:${nonce2}`);
      socket.write(`${JSON.stringify({ kind: 'hello2', tunnelId, role, nonce: nonce2, proof: proof2 })}\n`);
    }
  } catch (err) {
    reader.detach();
    throw err;
  }

  const initialBytes = reader.detach();
  const listenServerId = role === PORT_FORWARD_ROLE.LISTEN ? selfServerId : peerServerId;
  const targetServerId = role === PORT_FORWARD_ROLE.TARGET ? selfServerId : peerServerId;
  const transportKeys = deriveE2eTransportKeys({
    ecdhSecret,
    capability,
    tunnelId,
    listenServerId,
    targetServerId,
    listenPublicKey,
    targetPublicKey,
    transportMode: PORT_FORWARD_TRANSPORT.DIRECT_TCP,
    sessionSalt: `${nonce1}:${nonce2}`,
  });

  // Also mix TCP socket random nonces for per-connection session freshness.
  const mix = (key: Buffer, dir: string) => Buffer.from(hkdfSync(
    'sha256',
    key,
    Buffer.from(`${nonce1}:${nonce2}`, 'utf8'),
    Buffer.from(`imcodes-pf-tcp-sock-v2:${dir}`),
    32,
  ));

  return role === PORT_FORWARD_ROLE.LISTEN
    ? {
        socket,
        transportKeys,
        sendKey: mix(transportKeys.listenToTargetKey, 'l2t'),
        recvKey: mix(transportKeys.targetToListenKey, 't2l'),
        sendDirTag: TCP_DIR_L2T,
        recvDirTag: TCP_DIR_T2L,
        initialBytes,
      }
    : {
        socket,
        transportKeys,
        sendKey: mix(transportKeys.targetToListenKey, 't2l'),
        recvKey: mix(transportKeys.listenToTargetKey, 'l2t'),
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
  private writePaused = false;
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
      if (this.closed) return;
      this.writePaused = false;
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
    return !this.closed
      && !this.socket.destroyed
      && !this.writePaused
      && !this.socket.writableNeedDrain
      && this.socket.writableLength < PORT_FORWARD_LIMITS.CARRIER_HIGH_WATER_BYTES;
  }

  sendMuxFrame(frame: Buffer): boolean {
    if (this.closed || this.socket.destroyed) return false;
    if (this.socket.writableLength >= PORT_FORWARD_LIMITS.CARRIER_HARD_CAP_BYTES) {
      this.close('tcp_send_buffer_overflow');
      return false;
    }
    this.sendEncryptedInner(Buffer.concat([Buffer.from([TCP_INNER_MUX]), frame]));
    const writable = this.isWritable();
    if (!writable) this.writePaused = true;
    return writable;
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
    const ok = this.socket.write(frame);
    if (!ok || this.socket.writableLength >= PORT_FORWARD_LIMITS.CARRIER_HIGH_WATER_BYTES) {
      this.writePaused = true;
    }
    return ok;
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
  private nextRxCounter = 1n;
  private readonly reorderBuffer = new Map<bigint, Buffer>();
  private readonly muxAccumulator = new PortForwardMuxAccumulator();
  private readonly muxListeners = new Set<(frame: PortForwardMuxFrame) => void>();
  private readonly drainListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private txCounter = 1n;
  private closed = false;
  private wsBackpressured = false;
  private clusterBackpressured = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private seqGapTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SEQ_GAP_TIMEOUT_MS = 10_000;

  constructor(
    private readonly tunnelId: string,
    role: PortForwardRole,
    keys: E2eTransportKeys,
    private readonly sendRelayWs: (base64Ciphertext: string) => boolean | void,
    private readonly getWsBufferedAmount: () => number = () => 0,
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

  setClusterBackpressured(paused: boolean): void {
    if (this.closed || this.clusterBackpressured === paused) return;
    this.clusterBackpressured = paused;
    if (!paused && this.isWritable()) {
      for (const listener of [...this.drainListeners]) listener();
    }
  }

  isWritable(): boolean {
    if (this.closed || this.clusterBackpressured) return false;
    const buffered = this.getWsBufferedAmount();
    if (this.wsBackpressured) {
      return buffered <= PORT_FORWARD_LIMITS.RELAY_WS_LOW_WATER_BYTES;
    }
    return buffered < PORT_FORWARD_LIMITS.RELAY_WS_HIGH_WATER_BYTES;
  }

  sendMuxFrame(frame: Buffer): boolean {
    if (this.closed) return false;
    const buffered = this.getWsBufferedAmount();
    if (buffered >= PORT_FORWARD_LIMITS.RELAY_WS_HARD_CAP_BYTES) {
      this.close('relay_ws_buffer_overflow');
      return false;
    }
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
    const sendOk = this.sendRelayWs(pkt.toString('base64'));
    if (sendOk === false || this.getWsBufferedAmount() >= PORT_FORWARD_LIMITS.RELAY_WS_HIGH_WATER_BYTES) {
      this.armBackpressure();
    }
    return this.isWritable();
  }

  deliverRelayData(base64Data: string): boolean {
    if (this.closed) return false;
    const pkt = Buffer.from(base64Data, 'base64');
    if (pkt.length <= RELAY_HEADER_BYTES + PORT_FORWARD_LIMITS.FRAME_AUTH_TAG_BYTES) {
      return false;
    }
    const counter = pkt.readBigUInt64BE(0);
    // Reject duplicates/replays or gaps beyond bounded reorder window BEFORE decrypt/buffering.
    if (counter < this.nextRxCounter || counter >= this.nextRxCounter + 64n) {
      return false;
    }
    if (this.reorderBuffer.has(counter)) return false;
    const plaintext = decryptAesGcm(
      this.recvKey,
      this.recvDirTag,
      counter,
      `${this.tunnelId}:relay:${counter.toString()}`,
      pkt.subarray(RELAY_HEADER_BYTES),
    );
    if (!plaintext) return false;

    if (counter > this.nextRxCounter) {
      if (this.reorderBuffer.size >= 64) {
        this.close('relay_reorder_overflow');
        return false;
      }
      this.reorderBuffer.set(counter, plaintext);
      this.armSeqGapTimer();
      return true;
    }

    // Strict in-order delivery for counter === nextRxCounter and any contiguous buffered frames.
    try {
      let current: Buffer | undefined = plaintext;
      while (current) {
        const frames = this.muxAccumulator.push(current);
        for (const frame of frames) {
          for (const listener of [...this.muxListeners]) listener(frame);
        }
        this.nextRxCounter += 1n;
        current = this.reorderBuffer.get(this.nextRxCounter);
        if (current) this.reorderBuffer.delete(this.nextRxCounter);
      }
      if (this.reorderBuffer.size > 0) {
        this.armSeqGapTimer(true);
      } else {
        this.clearSeqGapTimer();
      }
      return true;
    } catch {
      this.close('invalid_mux_stream');
      return false;
    }
  }

  private armSeqGapTimer(reset = false): void {
    if (this.closed) return;
    if (reset) this.clearSeqGapTimer();
    if (this.seqGapTimer) return;
    this.seqGapTimer = setTimeout(() => {
      this.seqGapTimer = null;
      if (!this.closed && this.reorderBuffer.size > 0) {
        this.close('relay_seq_gap_timeout');
      }
    }, RelayTransport.SEQ_GAP_TIMEOUT_MS);
    this.seqGapTimer.unref?.();
  }

  private clearSeqGapTimer(): void {
    if (this.seqGapTimer) {
      clearTimeout(this.seqGapTimer);
      this.seqGapTimer = null;
    }
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.reorderBuffer.clear();
    this.clearSeqGapTimer();
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    this.muxAccumulator.reset();
    for (const listener of [...this.closeListeners]) listener(reason);
  }

  private armBackpressure(): void {
    if (this.wsBackpressured || this.closed) return;
    this.wsBackpressured = true;
    this.drainTimer = setInterval(() => {
      if (this.closed) {
        if (this.drainTimer) {
          clearInterval(this.drainTimer);
          this.drainTimer = null;
        }
        return;
      }
      if (this.getWsBufferedAmount() <= PORT_FORWARD_LIMITS.RELAY_WS_LOW_WATER_BYTES) {
        this.wsBackpressured = false;
        if (this.drainTimer) {
          clearInterval(this.drainTimer);
          this.drainTimer = null;
        }
        if (this.isWritable()) {
          for (const listener of [...this.drainListeners]) listener();
        }
      }
    }, 15);
    this.drainTimer.unref?.();
  }
}

interface MuxStreamState {
  streamId: number;
  socket: NetSocket;
  openConfirmed: boolean;
  sendCredit: number;
  pendingReadChunks: Buffer[];
  pendingReadBytes: number;
  localReadEnded: boolean;
  eofSent: boolean;
  eofReceived: boolean;
  localWriteEnded: boolean;
  localFinished: boolean;
  closed: boolean;
  remoteAvailableCredit: number;
  pendingWindowAckBytes: number;
  drainingWriteBytes: number;
  recvBufferedBytes: number;
  waitingDrain: boolean;
  pendingWrites: Buffer[];
}

class PortForwardMuxSession {
  private readonly streams = new Map<number, MuxStreamState>();
  private nextStreamId = 1;
  private closed = false;
  private keyConfirmed = false;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  bytesSent = 0;
  bytesReceived = 0;

  constructor(
    private readonly role: PortForwardRole,
    private readonly carrier: PortForwardCarrier,
    private readonly transportKeys: E2eTransportKeys,
    private readonly identity: E2eIdentityContext,
    private readonly targetHost: string | undefined,
    private readonly targetPort: number | undefined,
    private readonly handshakeMs: number,
    private readonly onKeyConfirmed: () => void,
    private readonly onStatsChanged?: () => void,
  ) {
    carrier.onMuxFrame((frame) => this.handleMuxFrame(frame));
    carrier.onDrain(() => this.resumeWritableStreams());
    carrier.onClose((reason) => this.closeAll(reason));
  }

  isKeyConfirmed(): boolean {
    return this.keyConfirmed;
  }

  startKeyConfirmation(): void {
    if (this.closed || this.keyConfirmed || this.role !== PORT_FORWARD_ROLE.LISTEN) return;
    if (!this.confirmTimer) {
      this.confirmTimer = setTimeout(() => {
        if (!this.keyConfirmed && !this.closed) {
          this.carrier.close('key_confirm_timeout');
        }
      }, this.handshakeMs);
      this.confirmTimer.unref?.();
    }
    const tag = computeKeyConfirmationMac(this.transportKeys.confirmListenToTargetKey, {
      ...this.identity,
      direction: 'l2t',
    });
    this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.KEY_CONFIRM, 0, tag));
  }

  activeConnections(): number {
    return this.streams.size;
  }

  acceptClientSocket(socket: NetSocket): void {
    if (this.closed || !this.keyConfirmed || this.role !== PORT_FORWARD_ROLE.LISTEN) {
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
      pendingReadChunks: [],
      pendingReadBytes: 0,
      localReadEnded: false,
      eofSent: false,
      eofReceived: false,
      localWriteEnded: false,
      localFinished: false,
      closed: false,
      remoteAvailableCredit: PORT_FORWARD_LIMITS.STREAM_WINDOW_BYTES,
      pendingWindowAckBytes: 0,
      drainingWriteBytes: 0,
      recvBufferedBytes: 0,
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
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
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
      if (chunk.length > 0) {
        state.pendingReadChunks.push(Buffer.from(chunk));
        state.pendingReadBytes += chunk.length;
      }
      this.flushOutgoingReadChunks(state);
    });

    socket.on('end', () => {
      if (this.closed || state.closed) return;
      state.localReadEnded = true;
      this.flushOutgoingReadChunks(state);
    });

    socket.on('drain', () => {
      if (this.closed || state.closed) return;
      state.waitingDrain = false;
      if (state.drainingWriteBytes > 0) {
        state.pendingWindowAckBytes += state.drainingWriteBytes;
        state.drainingWriteBytes = 0;
      }
      this.flushIncomingWrites(state);
    });

    socket.on('finish', () => {
      if (this.closed || state.closed) return;
      state.localFinished = true;
      this.maybeCloseHalfOpenStream(state);
    });

    socket.on('error', () => {
      if (this.closed || state.closed) return;
      this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.RST, streamId));
      this.destroyLocalStream(state);
    });

    socket.on('close', (hadError: boolean) => {
      if (this.closed || state.closed) return;
      if (hadError) {
        this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.RST, streamId));
      } else if (!state.eofSent) {
        state.localReadEnded = true;
        this.flushOutgoingReadChunks(state);
        if (!state.eofSent) {
          state.eofSent = true;
          this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.EOF, streamId));
        }
      }
      this.destroyLocalStream(state);
    });
  }

  private flushOutgoingReadChunks(state: MuxStreamState): void {
    if (this.closed || state.closed || !state.openConfirmed) return;
    while (state.pendingReadChunks.length > 0 && state.sendCredit > 0 && this.carrier.isWritable()) {
      const head = state.pendingReadChunks[0]!;
      const maxSend = Math.min(head.length, PORT_FORWARD_LIMITS.MAX_DATA_CHUNK_BYTES, state.sendCredit);
      if (maxSend <= 0) break;
      const slice = head.subarray(0, maxSend);
      if (maxSend < head.length) {
        state.pendingReadChunks[0] = head.subarray(maxSend);
      } else {
        state.pendingReadChunks.shift();
      }
      state.pendingReadBytes -= slice.length;
      state.sendCredit -= slice.length;
      this.bytesSent += slice.length;
      this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.DATA, state.streamId, slice));
    }

    if (state.pendingReadChunks.length > 0 || state.sendCredit <= 0 || !this.carrier.isWritable()) {
      state.socket.pause();
    } else if (state.openConfirmed && !state.localReadEnded) {
      state.socket.resume();
    }

    if (state.localReadEnded && state.pendingReadChunks.length === 0 && !state.eofSent) {
      state.eofSent = true;
      this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.EOF, state.streamId));
      this.maybeCloseHalfOpenStream(state);
    }
  }

  private flushIncomingWrites(state: MuxStreamState): void {
    if (this.closed || state.closed) return;
    while (state.pendingWrites.length > 0 && !state.waitingDrain) {
      const next = state.pendingWrites.shift()!;
      state.recvBufferedBytes -= next.length;
      const ok = state.socket.write(next);
      if (!ok) {
        state.waitingDrain = true;
        state.drainingWriteBytes += next.length;
        break;
      }
      state.pendingWindowAckBytes += next.length;
    }

    // Flush flow-control refill only once bytes are actually written to the OS socket without backpressure,
    // or immediately after drain clears all backlogged writes so a paused sender wakes promptly.
    if (!state.waitingDrain && state.pendingWindowAckBytes > 0 && (
      state.pendingWindowAckBytes >= PORT_FORWARD_LIMITS.STREAM_WINDOW_REFILL_THRESHOLD_BYTES
      || (state.pendingWrites.length === 0 && state.remoteAvailableCredit < PORT_FORWARD_LIMITS.STREAM_WINDOW_REFILL_THRESHOLD_BYTES)
    )) {
      this.flushWindowUpdate(state);
    }

    if (!state.waitingDrain && state.pendingWrites.length === 0 && state.eofReceived && !state.localWriteEnded) {
      state.localWriteEnded = true;
      state.socket.end();
    }
  }

  private resumeWritableStreams(): void {
    if (this.closed || !this.carrier.isWritable()) return;
    for (const state of this.streams.values()) {
      if (!state.closed && state.openConfirmed) {
        this.flushOutgoingReadChunks(state);
      }
    }
  }

  private flushWindowUpdate(state: MuxStreamState): void {
    if (this.closed || state.closed || state.pendingWindowAckBytes <= 0) return;
    const credit = Math.min(
      state.pendingWindowAckBytes,
      Math.max(0, PORT_FORWARD_LIMITS.STREAM_WINDOW_BYTES - state.remoteAvailableCredit),
    );
    state.pendingWindowAckBytes = 0;
    if (credit <= 0) return;
    state.remoteAvailableCredit += credit;
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt32BE(credit >>> 0, 0);
    this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.WINDOW_UPDATE, state.streamId, payload));
  }

  private maybeCloseHalfOpenStream(state: MuxStreamState): void {
    if (state.closed) return;
    if (state.eofSent && state.eofReceived && state.localFinished && state.pendingWrites.length === 0) {
      this.destroyLocalStream(state);
    }
  }

  private destroyLocalStream(state: MuxStreamState): void {
    if (state.closed) return;
    state.closed = true;
    state.pendingWrites.length = 0;
    state.pendingReadChunks.length = 0;
    state.pendingReadBytes = 0;
    state.recvBufferedBytes = 0;
    this.streams.delete(state.streamId);
    try { state.socket.destroy(); } catch { /* ignore */ }
    this.onStatsChanged?.();
  }

  private handleMuxFrame(frame: PortForwardMuxFrame): void {
    if (this.closed) return;
    const { type, streamId, payload } = frame;

    if (type === PORT_FORWARD_MUX_TYPE.KEY_CONFIRM) {
      if (this.role !== PORT_FORWARD_ROLE.TARGET || this.keyConfirmed) {
        this.carrier.close('unexpected_key_confirm');
        return;
      }
      if (!verifyKeyConfirmationMac(this.transportKeys.confirmListenToTargetKey, {
        ...this.identity,
        direction: 'l2t',
      }, payload)) {
        this.carrier.close('key_confirm_failed');
        return;
      }
      this.keyConfirmed = true;
      const ackTag = computeKeyConfirmationMac(this.transportKeys.confirmTargetToListenKey, {
        ...this.identity,
        direction: 't2l',
      });
      this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.KEY_CONFIRM_ACK, 0, ackTag));
      this.onKeyConfirmed();
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.KEY_CONFIRM_ACK) {
      if (this.role !== PORT_FORWARD_ROLE.LISTEN || this.keyConfirmed) {
        this.carrier.close('unexpected_key_confirm_ack');
        return;
      }
      if (!verifyKeyConfirmationMac(this.transportKeys.confirmTargetToListenKey, {
        ...this.identity,
        direction: 't2l',
      }, payload)) {
        this.carrier.close('key_confirm_failed');
        return;
      }
      if (this.confirmTimer) {
        clearTimeout(this.confirmTimer);
        this.confirmTimer = null;
      }
      this.keyConfirmed = true;
      this.onKeyConfirmed();
      return;
    }

    if (!this.keyConfirmed) {
      // Never accept or process business frames before explicit mutual E2E key confirmation!
      this.carrier.close('unconfirmed_mux_frame');
      return;
    }

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
      const targetSocket = tcpConnect({
        host: this.targetHost,
        port: this.targetPort,
        allowHalfOpen: true,
      });
      const state: MuxStreamState = {
        streamId,
        socket: targetSocket,
        openConfirmed: false,
        sendCredit: PORT_FORWARD_LIMITS.STREAM_WINDOW_BYTES,
        pendingReadChunks: [],
        pendingReadBytes: 0,
        localReadEnded: false,
        eofSent: false,
        eofReceived: false,
        localWriteEnded: false,
        localFinished: false,
        closed: false,
        remoteAvailableCredit: PORT_FORWARD_LIMITS.STREAM_WINDOW_BYTES,
        pendingWindowAckBytes: 0,
        drainingWriteBytes: 0,
        recvBufferedBytes: 0,
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
      this.flushOutgoingReadChunks(state);
      if (state.socket.readableEnded && !state.localReadEnded) {
        state.localReadEnded = true;
        this.flushOutgoingReadChunks(state);
      }
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.OPEN_ERR) {
      this.destroyLocalStream(state);
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.DATA) {
      state.remoteAvailableCredit -= payload.length;
      if (state.remoteAvailableCredit < -PORT_FORWARD_LIMITS.MAX_DATA_CHUNK_BYTES
        || state.recvBufferedBytes + payload.length > PORT_FORWARD_LIMITS.MAX_STREAM_RECV_BUFFER_BYTES) {
        this.carrier.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.RST, streamId));
        this.destroyLocalStream(state);
        return;
      }
      this.bytesReceived += payload.length;
      state.pendingWrites.push(payload);
      state.recvBufferedBytes += payload.length;
      this.flushIncomingWrites(state);
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.WINDOW_UPDATE) {
      if (payload.length < 4) return;
      const credit = payload.readUInt32BE(0);
      if (credit <= 0) return;
      state.sendCredit = Math.min(PORT_FORWARD_LIMITS.STREAM_WINDOW_BYTES * 2, state.sendCredit + credit);
      if (state.openConfirmed) {
        this.flushOutgoingReadChunks(state);
      }
      return;
    }

    if (type === PORT_FORWARD_MUX_TYPE.EOF) {
      state.eofReceived = true;
      this.flushIncomingWrites(state);
      this.maybeCloseHalfOpenStream(state);
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
  selfServerId: string;
  peerServerId: string;
  admissionMacKey: Buffer;
  ecdhPrivateKey: KeyObject | null;
  localPublicKey: string;
  peerPublicKey: string | null;
  localIdentityPublicKey: string;
  peerIdentityPublicKey: string | null;
  ecdhSecret: Buffer | null;
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
  preConnectTcpSockets: NetSocket[];
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
  private readonly recentClosedRoles = new Map<string, PortForwardRole>();
  private readonly timeouts: PortForwardEngineTimeouts;
  private readonly collectAddresses: () => string[];
  private readonly probeStun: typeof probeStunCandidates;
  private readonly identityKeyPair: EndpointIdentityKeyPair;

  constructor(private readonly options: PortForwardEngineOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.collectAddresses = options.collectInterfaceAddresses ?? defaultCollectInterfaceAddresses;
    this.probeStun = options.probeStun ?? probeStunCandidates;
    this.identityKeyPair = options.identityKeyPair
      ?? (options.identityFilePath
        ? loadOrCreatePortForwardIdentity(options.identityFilePath)
        : generateEndpointIdentityKeyPair());
  }

  getIdentityPublicKey(): string {
    return this.identityKeyPair.publicKeyB64;
  }

  private async lookupTrustedPeerPublicKey(peerServerId: string): Promise<string | null> {
    if (this.options.resolveTrustedPeerPublicKey) {
      const resolved = await this.options.resolveTrustedPeerPublicKey(peerServerId);
      if (resolved) return resolved;
    }
    if (this.options.trustedPeersFilePath) {
      const map = loadTrustedPeerPublicKeys(this.options.trustedPeersFilePath);
      return map.get(peerServerId) ?? null;
    }
    return null;
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
      case PORT_FORWARD_MSG.CLOSE: {
        const closed = this.closeTunnel(msg.tunnelId, msg.reason ?? 'remote_close', false);
        if (!closed) {
          const ackRole = this.recentClosedRoles.get(msg.tunnelId) ?? msg.role;
          if (ackRole) {
            this.options.sendWs({
              type: PORT_FORWARD_MSG.CLOSE_ACK,
              tunnelId: msg.tunnelId,
              role: ackRole,
            });
          }
        }
        return true;
      }
      case PORT_FORWARD_MSG.RELAY_FRAME:
        this.handleRelayFrame(msg.tunnelId, msg.data);
        return true;
      case PORT_FORWARD_MSG.RELAY_BACKPRESSURE:
        this.tunnels.get(msg.tunnelId)?.relayFallbackHandle?.setClusterBackpressured(msg.paused);
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
    this.recentClosedRoles.set(tunnelId, tunnel.role);
    if (this.recentClosedRoles.size > 512) {
      const oldest = this.recentClosedRoles.keys().next().value;
      if (oldest) this.recentClosedRoles.delete(oldest);
    }
    clearTimeout(tunnel.ttlTimer);
    if (tunnel.statsTimer) {
      clearInterval(tunnel.statsTimer);
      tunnel.statsTimer = null;
    }
    tunnel.abortController.abort(new Error(reason));
    for (const sock of tunnel.pendingClientSockets.splice(0)) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    const localServer = tunnel.localServer;
    tunnel.localServer = null;
    this.cleanupPreparationResources(tunnel, true);
    tunnel.mux?.closeAll(reason);
    tunnel.carrier?.close(reason);
    if (tunnel.ecdhSecret) {
      tunnel.ecdhSecret.fill(0);
      tunnel.ecdhSecret = null;
    }
    tunnel.admissionMacKey.fill(0);
    tunnel.ecdhPrivateKey = null;
    if (notifyServer) {
      this.options.sendWs({ type: PORT_FORWARD_MSG.CLOSE, tunnelId, reason });
    }
    const emitCloseAck = () => {
      this.options.sendWs({
        type: PORT_FORWARD_MSG.CLOSE_ACK,
        tunnelId,
        role: tunnel.role,
      });
    };
    if (localServer) {
      try {
        localServer.close(() => emitCloseAck());
      } catch {
        emitCloseAck();
      }
    } else {
      emitCloseAck();
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
      closeNetServer(tunnel.tcpAcceptServer);
      tunnel.tcpAcceptServer = null;
    }
    for (const sock of tunnel.preConnectTcpSockets.splice(0)) {
      if (tunnel.carrier && tunnel.carrier.mode === PORT_FORWARD_TRANSPORT.DIRECT_TCP) {
        if (sock === (tunnel.carrier as DirectTcpTransport).rawSocket) continue;
      }
      try { sock.destroy(); } catch { /* ignore */ }
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

  private buildIdentityContext(tunnel: ActiveTunnel, transportMode: PortForwardTransport): E2eIdentityContext {
    const isListen = tunnel.role === PORT_FORWARD_ROLE.LISTEN;
    return {
      tunnelId: tunnel.tunnelId,
      listenServerId: isListen ? tunnel.selfServerId : tunnel.peerServerId,
      targetServerId: isListen ? tunnel.peerServerId : tunnel.selfServerId,
      listenPublicKey: isListen ? tunnel.localPublicKey : tunnel.peerPublicKey!,
      targetPublicKey: isListen ? tunnel.peerPublicKey! : tunnel.localPublicKey,
      listenIdentityPublicKey: isListen ? tunnel.localIdentityPublicKey : tunnel.peerIdentityPublicKey!,
      targetIdentityPublicKey: isListen ? tunnel.peerIdentityPublicKey! : tunnel.localIdentityPublicKey,
      transportMode,
    };
  }

  private deriveTransportKeys(tunnel: ActiveTunnel, transportMode: PortForwardTransport): E2eTransportKeys {
    if (!tunnel.ecdhSecret || !tunnel.peerPublicKey) {
      throw new Error('ecdh_not_ready');
    }
    const id = this.buildIdentityContext(tunnel, transportMode);
    return deriveE2eTransportKeys({
      ecdhSecret: tunnel.ecdhSecret,
      capability: tunnel.capability,
      ...id,
    });
  }

  private async handlePrepare(msg: PortForwardPrepareMessage): Promise<void> {
    if (this.tunnels.has(msg.tunnelId)) {
      this.closeTunnel(msg.tunnelId, 'replaced', false);
    }
    if (this.tunnels.size >= PORT_FORWARD_LIMITS.MAX_TUNNELS_PER_NODE) {
      this.emitError(msg.tunnelId, PORT_FORWARD_ERRORS.LIMIT_EXCEEDED, 'node tunnel limit exceeded');
      return;
    }

    let admissionMacKey: Buffer;
    try {
      admissionMacKey = deriveAdmissionMacKey(msg.capability, msg.tunnelId);
    } catch {
      this.emitError(msg.tunnelId, PORT_FORWARD_ERRORS.INVALID_REQUEST, 'invalid tunnel capability');
      return;
    }

    const ecdh = generateEphemeralEcdhKeyPair();
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
      selfServerId: msg.selfServerId,
      peerServerId: msg.peerServerId,
      admissionMacKey,
      ecdhPrivateKey: ecdh.privateKey,
      localPublicKey: ecdh.publicKeyB64,
      peerPublicKey: null,
      localIdentityPublicKey: this.identityKeyPair.publicKeyB64,
      peerIdentityPublicKey: null,
      ecdhSecret: null,
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
      preConnectTcpSockets: [],
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

    // 1. Bind loopback listener early on listen role (register localServer synchronously to close safely on cancel).
    if (msg.role === PORT_FORWARD_ROLE.LISTEN) {
      const bound = await this.bindLoopbackListener(tunnel, msg.listenPort ?? 0);
      if (!bound.ok) {
        this.closeTunnel(msg.tunnelId, bound.reason, false);
        this.emitError(msg.tunnelId, bound.reason, bound.error);
        return;
      }
      if (tunnel.closed) return;
      tunnel.listenPort = bound.port;
    }

    if (tunnel.closed) return;

    // 2. Gather direct TCP + UDP (host + STUN srflx) candidates when P2P may be used.
    const candidates: PortForwardCandidate[] = [];
    if (msg.transport !== PORT_FORWARD_TRANSPORT_PREF.RELAY) {
      const addresses = this.collectAddresses().filter((addr) => isIP(addr) === 4 && addr !== '0.0.0.0');

      if (!this.options.disableDirectTcp && !tunnel.closed) {
        const tcpServer = createTcpServer();
        // Register synchronously BEFORE async listen() so any close/cancel closes even a slow-binding server.
        tunnel.tcpAcceptServer = tcpServer;
        tcpServer.on('connection', (sock: NetSocket) => {
          if (tunnel.ecdhSecret) {
            return;
          }
          if (tunnel.closed || tunnel.carrier) {
            sock.destroy();
            return;
          }
          if (tunnel.preConnectTcpSockets.length >= PORT_FORWARD_LIMITS.MAX_PRECONNECT_TCP_SOCKETS) {
            sock.destroy();
            return;
          }
          sock.pause();
          tunnel.preConnectTcpSockets.push(sock);
          tunnel.tcpAcceptSockets.add(sock);
          sock.once('close', () => {
            tunnel.tcpAcceptSockets.delete(sock);
            const idx = tunnel.preConnectTcpSockets.indexOf(sock);
            if (idx >= 0) tunnel.preConnectTcpSockets.splice(idx, 1);
          });
        });

        const tcpPort = await new Promise<number>((resolve) => {
          tcpServer.once('error', () => resolve(0));
          tcpServer.listen({ host: '0.0.0.0', port: 0, exclusive: true }, () => {
            if (tunnel.closed) {
              closeNetServer(tcpServer);
              resolve(0);
              return;
            }
            const addr = tcpServer.address();
            resolve(addr && typeof addr !== 'string' ? addr.port : 0);
          });
        });
        if (tcpPort > 0 && !tunnel.closed) {
          for (const host of addresses) {
            candidates.push({ host, port: tcpPort, transport: 'tcp', kind: 'host' });
          }
        } else {
          if (tunnel.tcpAcceptServer === tcpServer) tunnel.tcpAcceptServer = null;
          closeNetServer(tcpServer);
        }
      }

      if (!this.options.disableDirectUdp && !tunnel.closed) {
        const udpSock = createSocket('udp4');
        // Register synchronously BEFORE async bind().
        tunnel.udpSocket = udpSock;
        const udpPort = await new Promise<number>((resolve) => {
          udpSock.once('error', () => resolve(0));
          udpSock.bind(0, '0.0.0.0', () => {
            if (tunnel.closed) {
              try { udpSock.close(); } catch { /* ignore */ }
              resolve(0);
              return;
            }
            const addr = udpSock.address();
            resolve(addr && typeof addr !== 'string' ? addr.port : 0);
          });
        });
        if (udpPort > 0 && !tunnel.closed) {
          for (const host of addresses) {
            candidates.push({ host, port: udpPort, transport: 'udp', kind: 'host' });
          }
          const stunEndpoints = await this.probeStun(udpSock, msg.iceServers, {
            timeoutMs: this.timeouts.stunProbeMs,
            signal: tunnel.abortController.signal,
          }).catch(() => []);
          if (!tunnel.closed) {
            for (const ep of stunEndpoints) {
              candidates.push({ host: ep.host, port: ep.port, transport: 'udp', kind: 'srflx' });
            }
          }
        } else {
          if (tunnel.udpSocket === udpSock) tunnel.udpSocket = null;
          try { udpSock.close(); } catch { /* ignore */ }
        }
      }
    }

    if (tunnel.closed) return;

    const keyProof = computeEphemeralKeyProof(tunnel.admissionMacKey, {
      tunnelId: tunnel.tunnelId,
      role: tunnel.role,
      selfServerId: tunnel.selfServerId,
      peerServerId: tunnel.peerServerId,
      publicKey: tunnel.localPublicKey,
    });
    const dedupedCandidates = deduplicateCandidates(candidates, PORT_FORWARD_LIMITS.MAX_CANDIDATES);
    const identitySignature = signPortForwardTranscript(this.identityKeyPair.privateKey, {
      tunnelId: tunnel.tunnelId,
      role: tunnel.role,
      selfServerId: tunnel.selfServerId,
      peerServerId: tunnel.peerServerId,
      capability: tunnel.capability,
      ecdhPublicKey: tunnel.localPublicKey,
      candidates: dedupedCandidates,
    });

    this.options.sendWs({
      type: PORT_FORWARD_MSG.READY,
      tunnelId: tunnel.tunnelId,
      role: tunnel.role,
      ...(tunnel.role === PORT_FORWARD_ROLE.LISTEN ? { listenPort: tunnel.listenPort! } : {}),
      candidates: dedupedCandidates,
      publicKey: tunnel.localPublicKey,
      keyProof,
      identityPublicKey: tunnel.localIdentityPublicKey,
      identitySignature,
    });
  }

  private async bindLoopbackListener(
    tunnel: ActiveTunnel,
    requestedPort: number,
  ): Promise<{ ok: true; port: number } | { ok: false; reason: PortForwardErrorCode; error: string }> {
    const server = createTcpServer({ allowHalfOpen: true }, (clientSocket) => {
      if (tunnel.closed) {
        clientSocket.destroy();
        return;
      }
      if (tunnel.mux && tunnel.mux.isKeyConfirmed()) {
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
    // Register localServer BEFORE async listen() so closeTunnel() closes it even if cancelled mid-bind!
    tunnel.localServer = server;

    return new Promise((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (tunnel.localServer === server) tunnel.localServer = null;
        closeNetServer(server);
        const reason = err.code === 'EADDRINUSE'
          ? PORT_FORWARD_ERRORS.LISTEN_PORT_IN_USE
          : PORT_FORWARD_ERRORS.INTERNAL_ERROR;
        resolve({ ok: false, reason, error: err.message });
      });
      // Boundary requirement: ALWAYS bind strictly on 127.0.0.1, never 0.0.0.0 / ::.
      server.listen({ host: PORT_FORWARD_LIMITS.LISTEN_HOST, port: requestedPort, exclusive: true }, () => {
        if (tunnel.closed) {
          if (tunnel.localServer === server) tunnel.localServer = null;
          closeNetServer(server);
          resolve({ ok: false, reason: PORT_FORWARD_ERRORS.INTERNAL_ERROR, error: 'tunnel closed during listen' });
          return;
        }
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          if (tunnel.localServer === server) tunnel.localServer = null;
          closeNetServer(server);
          resolve({ ok: false, reason: PORT_FORWARD_ERRORS.INTERNAL_ERROR, error: 'failed to read loopback port' });
          return;
        }
        resolve({ ok: true, port: addr.port });
      });
    });
  }

  private async handleConnect(msg: PortForwardConnectMessage): Promise<void> {
    const tunnel = this.tunnels.get(msg.tunnelId);
    if (!tunnel || tunnel.closed || tunnel.carrier) return;
    if (msg.role !== tunnel.role || !tunnel.ecdhPrivateKey) return;

    const peerRole = tunnel.role === PORT_FORWARD_ROLE.LISTEN
      ? PORT_FORWARD_ROLE.TARGET
      : PORT_FORWARD_ROLE.LISTEN;

    if (!verifyEphemeralKeyProof(tunnel.admissionMacKey, {
      tunnelId: tunnel.tunnelId,
      role: peerRole,
      selfServerId: tunnel.peerServerId,
      peerServerId: tunnel.selfServerId,
      publicKey: msg.peerPublicKey,
    }, msg.peerKeyProof)) {
      this.closeTunnel(tunnel.tunnelId, PORT_FORWARD_ERRORS.SCOPED_AUTH, false);
      this.emitError(tunnel.tunnelId, PORT_FORWARD_ERRORS.SCOPED_AUTH, 'peer key proof verification failed');
      return;
    }

    // Relay-independent peer identity verification: look up trusted Ed25519 public key locally.
    const trustedPeerPublicKey = await this.lookupTrustedPeerPublicKey(tunnel.peerServerId);
    if (!trustedPeerPublicKey) {
      this.closeTunnel(tunnel.tunnelId, PORT_FORWARD_ERRORS.SCOPED_AUTH, false);
      this.emitError(
        tunnel.tunnelId,
        PORT_FORWARD_ERRORS.SCOPED_AUTH,
        `untrusted_peer_identity: missing local trusted public key for peer "${tunnel.peerServerId}"`,
      );
      return;
    }

    if (msg.peerIdentityPublicKey !== trustedPeerPublicKey || !verifyPortForwardTranscript(trustedPeerPublicKey, {
      tunnelId: tunnel.tunnelId,
      role: peerRole,
      selfServerId: tunnel.peerServerId,
      peerServerId: tunnel.selfServerId,
      capability: tunnel.capability,
      ecdhPublicKey: msg.peerPublicKey,
      candidates: msg.peerCandidates,
    }, msg.peerIdentitySignature)) {
      this.closeTunnel(tunnel.tunnelId, PORT_FORWARD_ERRORS.SCOPED_AUTH, false);
      this.emitError(
        tunnel.tunnelId,
        PORT_FORWARD_ERRORS.SCOPED_AUTH,
        `peer identity signature verification failed for "${tunnel.peerServerId}"`,
      );
      return;
    }

    if (tunnel.closed || !tunnel.ecdhPrivateKey) return;

    try {
      tunnel.peerIdentityPublicKey = trustedPeerPublicKey;
      tunnel.peerPublicKey = msg.peerPublicKey;
      tunnel.ecdhSecret = computeEcdhSharedSecret(tunnel.ecdhPrivateKey, msg.peerPublicKey);
      // Ephemeral private key is no longer needed once shared secret is computed.
      tunnel.ecdhPrivateKey = null;
    } catch {
      this.closeTunnel(tunnel.tunnelId, PORT_FORWARD_ERRORS.SCOPED_AUTH, false);
      this.emitError(tunnel.tunnelId, PORT_FORWARD_ERRORS.SCOPED_AUTH, 'invalid peer ephemeral public key');
      return;
    }

    if (msg.transport === PORT_FORWARD_TRANSPORT_PREF.RELAY) {
      if (tunnel.role === PORT_FORWARD_ROLE.LISTEN) {
        const relay = this.createRelayCarrier(tunnel);
        const mux = await this.confirmListenCarrier(tunnel, relay, PORT_FORWARD_TRANSPORT.RELAY);
        if (!mux || tunnel.closed) {
          relay.close('relay_confirm_failed');
          if (!tunnel.closed) {
            this.closeTunnel(tunnel.tunnelId, PORT_FORWARD_ERRORS.TIMEOUT, false);
            this.emitError(tunnel.tunnelId, PORT_FORWARD_ERRORS.TIMEOUT, 'relay key confirmation timed out');
          }
          return;
        }
        this.commitConfirmedCarrier(tunnel, relay, mux, true);
        this.options.sendWs({
          type: PORT_FORWARD_MSG.ESTABLISHED,
          tunnelId: tunnel.tunnelId,
          role: PORT_FORWARD_ROLE.LISTEN,
          transportMode: PORT_FORWARD_TRANSPORT.RELAY,
          listenPort: tunnel.listenPort!,
        });
      } else {
        // Signal coordinator that target has ECDH keys and relay responder armed BEFORE listen starts KEY_CONFIRM.
        this.options.sendWs({
          type: PORT_FORWARD_MSG.TARGET_READY,
          tunnelId: tunnel.tunnelId,
        });
      }
      return;
    }

    if (tunnel.role === PORT_FORWARD_ROLE.LISTEN) {
      await this.connectAsListenArbiter(tunnel, msg);
    } else {
      const targetPromise = this.connectAsTargetResponder(tunnel, msg);
      this.options.sendWs({
        type: PORT_FORWARD_MSG.TARGET_READY,
        tunnelId: tunnel.tunnelId,
      });
      await targetPromise;
    }
  }

  private createRelayCarrier(tunnel: ActiveTunnel): RelayTransport {
    const relayKeys = this.deriveTransportKeys(tunnel, PORT_FORWARD_TRANSPORT.RELAY);
    const relay = new RelayTransport(
      tunnel.tunnelId,
      tunnel.role,
      relayKeys,
      (data) => {
        if (tunnel.closed) return false;
        return this.options.sendWs({
          type: PORT_FORWARD_MSG.RELAY_FRAME,
          tunnelId: tunnel.tunnelId,
          data,
        });
      },
      this.options.getWsBufferedAmount,
    );
    tunnel.relayFallbackHandle = relay;
    return relay;
  }

  private handleRelayFrame(tunnelId: string, data: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel || tunnel.closed) return;

    // On target in auto/relay mode, receiving first authentic RELAY_FRAME initializes RelayTransport + Mux
    // BEFORE delivering the frame, ensuring KEY_CONFIRM and subsequent business frames are never dropped!
    if (!tunnel.carrier
      && tunnel.role === PORT_FORWARD_ROLE.TARGET
      && tunnel.ecdhSecret
      && tunnel.transportPref !== PORT_FORWARD_TRANSPORT_PREF.P2P_ONLY) {
      const relay = tunnel.relayFallbackHandle ?? this.createRelayCarrier(tunnel);
      const relayKeys = this.deriveTransportKeys(tunnel, PORT_FORWARD_TRANSPORT.RELAY);
      const identity = this.buildIdentityContext(tunnel, PORT_FORWARD_TRANSPORT.RELAY);
      let muxConfirmed = false;
      const mux = new PortForwardMuxSession(
        PORT_FORWARD_ROLE.TARGET,
        relay,
        relayKeys,
        identity,
        tunnel.targetHost,
        tunnel.targetPort,
        this.timeouts.handshakeMs,
        () => {
          muxConfirmed = true;
          this.commitConfirmedCarrier(tunnel, relay, mux, true);
          this.options.sendWs({
            type: PORT_FORWARD_MSG.ESTABLISHED,
            tunnelId: tunnel.tunnelId,
            role: PORT_FORWARD_ROLE.TARGET,
            transportMode: PORT_FORWARD_TRANSPORT.RELAY,
          });
        },
        () => this.pushStats(tunnel),
      );
      if (!relay.deliverRelayData(data) || !muxConfirmed) {
        if (!tunnel.carrier) {
          mux.closeAll('relay_unconfirmed');
          relay.close('relay_unconfirmed');
          if (tunnel.relayFallbackHandle === relay) tunnel.relayFallbackHandle = null;
        }
      }
      return;
    }

    if (tunnel.relayFallbackHandle && (!tunnel.carrier || tunnel.carrier.mode === PORT_FORWARD_TRANSPORT.RELAY)) {
      tunnel.relayFallbackHandle.deliverRelayData(data);
    }
  }

  private confirmListenCarrier(
    tunnel: ActiveTunnel,
    carrier: PortForwardCarrier,
    transportMode: PortForwardTransport,
    overrideKeys?: E2eTransportKeys,
  ): Promise<PortForwardMuxSession | null> {
    if (tunnel.closed) return Promise.resolve(null);
    const transportKeys = overrideKeys ?? this.deriveTransportKeys(tunnel, transportMode);
    const identity = this.buildIdentityContext(tunnel, transportMode);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (res: PortForwardMuxSession | null) => {
        if (settled) return;
        settled = true;
        tunnel.abortController.signal.removeEventListener('abort', onAbort);
        resolve(res);
      };
      const onAbort = () => finish(null);
      tunnel.abortController.signal.addEventListener('abort', onAbort, { once: true });

      const mux = new PortForwardMuxSession(
        PORT_FORWARD_ROLE.LISTEN,
        carrier,
        transportKeys,
        identity,
        tunnel.targetHost,
        tunnel.targetPort,
        this.timeouts.handshakeMs,
        () => finish(mux),
        () => this.pushStats(tunnel),
      );
      carrier.onClose(() => finish(null));
      mux.startKeyConfirmation();
    });
  }

  private pushStats(tunnel: ActiveTunnel): void {
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
  }

  private commitConfirmedCarrier(
    tunnel: ActiveTunnel,
    carrier: PortForwardCarrier,
    mux: PortForwardMuxSession,
    closeUdp: boolean,
  ): void {
    if (tunnel.closed || tunnel.carrier) {
      mux.closeAll('duplicate_carrier');
      carrier.close('duplicate_carrier');
      return;
    }
    tunnel.carrier = carrier;
    tunnel.mux = mux;
    tunnel.transportMode = carrier.mode;
    tunnel.abortController.abort(new Error(`carrier_committed:${carrier.mode}`));

    if (tunnel.tcpAcceptServer) {
      closeNetServer(tunnel.tcpAcceptServer);
      tunnel.tcpAcceptServer = null;
    }
    for (const sock of tunnel.preConnectTcpSockets.splice(0)) {
      if (tunnel.carrier && tunnel.carrier.mode === PORT_FORWARD_TRANSPORT.DIRECT_TCP) {
        if (sock === (tunnel.carrier as DirectTcpTransport).rawSocket) continue;
      }
      try { sock.destroy(); } catch { /* ignore */ }
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

    if (tunnel.role === PORT_FORWARD_ROLE.LISTEN) {
      const statsTimer = setInterval(() => this.pushStats(tunnel), 2_000);
      statsTimer.unref?.();
      tunnel.statsTimer = statsTimer;
    }
    carrier.onClose((reason) => {
      if (!tunnel.closed) this.closeTunnel(tunnel.tunnelId, reason, true);
    });

    // Release pending loopback client sockets ONLY after mutual E2E key confirmation!
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

      const udpKeys = udpCandidates.length > 0 ? this.deriveTransportKeys(tunnel, PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P) : null;

      const tcpPromise = !this.options.disableDirectTcp && (tcpCandidates.length > 0 || tunnel.tcpAcceptServer !== null)
        ? this.attemptDirectTcpAsListen(tunnel, tcpCandidates, raceController.signal)
        : Promise.resolve(null);

      const udpPromise = udpCandidates.length > 0 && tunnel.udpSocket && udpKeys
        ? runUdpHolePunch({
            socket: tunnel.udpSocket,
            tunnelId: tunnel.tunnelId,
            role: PORT_FORWARD_ROLE.LISTEN,
            keys: {
              punchMacKey: tunnel.admissionMacKey,
              listenToTargetKey: udpKeys.listenToTargetKey,
              targetToListenKey: udpKeys.targetToListenKey,
            },
            peerCandidates: udpCandidates,
            punchIntervalMs: this.timeouts.udpPunchIntervalMs,
            timeoutMs: this.timeouts.udpPunchMs,
            signal: raceController.signal,
          })
        : Promise.resolve(null);

      let tcpDone = false;
      let tcpWinner: { carrier: DirectTcpTransport; keys: E2eTransportKeys } | null = null;
      const tcpSettled = tcpPromise.then((res) => {
        tcpDone = true;
        tcpWinner = res;
        return res;
      });

      const first = await Promise.race([
        tcpSettled.then((res) => ({ kind: 'tcp' as const, res })),
        udpPromise.then((res) => ({ kind: 'udp' as const, res })),
      ]);

      if (tunnel.closed) return;

      const tryCommitTcp = async (winner: { carrier: DirectTcpTransport; keys: E2eTransportKeys }): Promise<boolean> => {
        const mux = await this.confirmListenCarrier(tunnel, winner.carrier, PORT_FORWARD_TRANSPORT.DIRECT_TCP, winner.keys);
        if (!mux || tunnel.closed) {
          winner.carrier.close('tcp_confirm_failed');
          return false;
        }
        raceController.abort(new Error('tcp_won'));
        this.commitConfirmedCarrier(tunnel, winner.carrier, mux, true);
        this.options.sendWs({
          type: PORT_FORWARD_MSG.ESTABLISHED,
          tunnelId: tunnel.tunnelId,
          role: PORT_FORWARD_ROLE.LISTEN,
          transportMode: PORT_FORWARD_TRANSPORT.DIRECT_TCP,
          listenPort: tunnel.listenPort!,
        });
        return true;
      };

      if (first.kind === 'tcp' && first.res) {
        if (await tryCommitTcp(first.res)) return;
      }

      if (first.kind === 'udp' && first.res && !tcpDone) {
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
          if (await tryCommitTcp(tcpWinner)) return;
        }
      }

      const udpResult = first.kind === 'udp' ? first.res : await udpPromise;
      if (tunnel.closed) return;

      if (tcpWinner) {
        if (await tryCommitTcp(tcpWinner)) return;
      }

      if (udpResult && tunnel.udpSocket && udpKeys) {
        raceController.abort(new Error('udp_won'));
        const udpCarrier = new ReliableUdpTransport({
          socket: tunnel.udpSocket,
          tunnelId: tunnel.tunnelId,
          role: PORT_FORWARD_ROLE.LISTEN,
          keys: {
            punchMacKey: tunnel.admissionMacKey,
            listenToTargetKey: udpKeys.listenToTargetKey,
            targetToListenKey: udpKeys.targetToListenKey,
          },
          peerHost: udpResult.peerHost,
          peerPort: udpResult.peerPort,
          heartbeatIntervalMs: this.timeouts.udpHeartbeatMs,
          deadLinkTimeoutMs: this.timeouts.udpDeadLinkMs,
          initialPackets: udpResult.bufferedArqPackets,
          ownsSocket: true,
        });
        const mux = await this.confirmListenCarrier(tunnel, udpCarrier, PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P, udpKeys);
        if (mux && !tunnel.closed) {
          this.commitConfirmedCarrier(tunnel, udpCarrier, mux, false);
          this.options.sendWs({
            type: PORT_FORWARD_MSG.ESTABLISHED,
            tunnelId: tunnel.tunnelId,
            role: PORT_FORWARD_ROLE.LISTEN,
            transportMode: PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P,
            listenPort: tunnel.listenPort!,
          });
          return;
        }
        udpCarrier.close('udp_confirm_failed');
        // Clear reference since udpCarrier owned/closed the socket
        tunnel.udpSocket = null;
      }

      if (tunnel.closed) return;

      if (msg.transport === PORT_FORWARD_TRANSPORT_PREF.P2P_ONLY) {
        this.closeTunnel(tunnel.tunnelId, PORT_FORWARD_ERRORS.P2P_FAILED, false);
        this.emitError(tunnel.tunnelId, PORT_FORWARD_ERRORS.P2P_FAILED, 'direct TCP and UDP P2P hole punching both failed');
        return;
      }

      const relay = this.createRelayCarrier(tunnel);
      const relayMux = await this.confirmListenCarrier(tunnel, relay, PORT_FORWARD_TRANSPORT.RELAY);
      if (!relayMux || tunnel.closed) {
        relay.close('relay_confirm_failed');
        if (!tunnel.closed) {
          this.closeTunnel(tunnel.tunnelId, PORT_FORWARD_ERRORS.TIMEOUT, false);
          this.emitError(tunnel.tunnelId, PORT_FORWARD_ERRORS.TIMEOUT, 'relay fallback key confirmation failed');
        }
        return;
      }
      this.commitConfirmedCarrier(tunnel, relay, relayMux, true);
      this.options.sendWs({
        type: PORT_FORWARD_MSG.ESTABLISHED,
        tunnelId: tunnel.tunnelId,
        role: PORT_FORWARD_ROLE.LISTEN,
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

    if (!this.options.disableDirectTcp) {
      void this.acceptAndDialDirectTcpAsTarget(tunnel, tcpCandidates, raceController.signal);
    }

    if (udpCandidates.length > 0 && tunnel.udpSocket) {
      const sock = tunnel.udpSocket;
      const udpKeys = this.deriveTransportKeys(tunnel, PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P);
      void runUdpHolePunch({
        socket: sock,
        tunnelId: tunnel.tunnelId,
        role: PORT_FORWARD_ROLE.TARGET,
        keys: {
          punchMacKey: tunnel.admissionMacKey,
          listenToTargetKey: udpKeys.listenToTargetKey,
          targetToListenKey: udpKeys.targetToListenKey,
        },
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
            keys: {
              punchMacKey: tunnel.admissionMacKey,
              listenToTargetKey: udpKeys.listenToTargetKey,
              targetToListenKey: udpKeys.targetToListenKey,
            },
            peerHost,
            peerPort,
            heartbeatIntervalMs: this.timeouts.udpHeartbeatMs,
            deadLinkTimeoutMs: this.timeouts.udpDeadLinkMs,
            initialPackets: packets,
            ownsSocket: true,
          });
          const identity = this.buildIdentityContext(tunnel, PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P);
          const mux = new PortForwardMuxSession(
            PORT_FORWARD_ROLE.TARGET,
            udpCarrier,
            udpKeys,
            identity,
            tunnel.targetHost,
            tunnel.targetPort,
            this.timeouts.handshakeMs,
            () => {
              this.commitConfirmedCarrier(tunnel, udpCarrier, mux, false);
              raceController.abort(new Error('udp_won'));
              this.options.sendWs({
                type: PORT_FORWARD_MSG.ESTABLISHED,
                tunnelId: tunnel.tunnelId,
                role: PORT_FORWARD_ROLE.TARGET,
                transportMode: PORT_FORWARD_TRANSPORT.DIRECT_UDP_P2P,
              });
            },
            () => this.pushStats(tunnel),
          );
        };

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
            udpKeys.listenToTargetKey,
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
  }

  private attemptDirectTcpAsListen(
    tunnel: ActiveTunnel,
    candidates: readonly PortForwardCandidate[],
    signal: AbortSignal,
  ): Promise<{ carrier: DirectTcpTransport; keys: E2eTransportKeys } | null> {
    if (signal.aborted || !tunnel.ecdhSecret || !tunnel.peerPublicKey) return Promise.resolve(null);
    const ecdhSecret = tunnel.ecdhSecret;
    const listenPublicKey = tunnel.localPublicKey;
    const targetPublicKey = tunnel.peerPublicKey;

    return new Promise((resolve) => {
      let settled = false;
      const pendingSockets = new Set<NetSocket>();
      const pendingPromises: Promise<void>[] = [];

      const finish = (winner: { carrier: DirectTcpTransport; keys: E2eTransportKeys } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        tunnel.tcpAcceptServer?.off('connection', onIncoming);
        for (const s of pendingSockets) {
          if (winner && s === winner.carrier.rawSocket) continue;
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
        finish({ carrier: transport, keys: auth.transportKeys });
      };

      const handleAccepted = (socket: NetSocket, isPreConnect: boolean) => {
        if (settled || signal.aborted || tunnel.closed) {
          socket.destroy();
          return;
        }
        pendingSockets.add(socket);
        if (!isPreConnect) {
          tunnel.tcpAcceptSockets.add(socket);
          socket.once('close', () => {
            pendingSockets.delete(socket);
            tunnel.tcpAcceptSockets.delete(socket);
          });
        } else {
          socket.once('close', () => pendingSockets.delete(socket));
        }
        void authenticateTcpSocket({
          socket,
          tunnelId: tunnel.tunnelId,
          role: PORT_FORWARD_ROLE.LISTEN,
          selfServerId: tunnel.selfServerId,
          peerServerId: tunnel.peerServerId,
          admissionKey: tunnel.admissionMacKey,
          ecdhSecret,
          capability: tunnel.capability,
          listenPublicKey,
          targetPublicKey,
          isInitiator: false,
          handshakeMs: this.timeouts.handshakeMs,
        }).then(adoptAuthenticated, () => {
          socket.destroy();
        });
      };

      const onIncoming = (socket: NetSocket) => handleAccepted(socket, false);
      tunnel.tcpAcceptServer?.on('connection', onIncoming);
      for (const preSock of tunnel.preConnectTcpSockets.splice(0)) {
        handleAccepted(preSock, true);
      }

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
              selfServerId: tunnel.selfServerId,
              peerServerId: tunnel.peerServerId,
              admissionKey: tunnel.admissionMacKey,
              ecdhSecret,
              capability: tunnel.capability,
              listenPublicKey,
              targetPublicKey,
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
    if (signal.aborted || tunnel.closed || !tunnel.ecdhSecret || !tunnel.peerPublicKey) return;
    const ecdhSecret = tunnel.ecdhSecret;
    const listenPublicKey = tunnel.peerPublicKey;
    const targetPublicKey = tunnel.localPublicKey;
    const activeCandidates = new Set<DirectTcpTransport>();

    const handleAuthenticated = (auth: Awaited<ReturnType<typeof authenticateTcpSocket>>) => {
      if (signal.aborted || tunnel.closed || tunnel.carrier) {
        auth.socket.destroy();
        return;
      }
      let transport: DirectTcpTransport;
      const muxIdentity = this.buildIdentityContext(tunnel, PORT_FORWARD_TRANSPORT.DIRECT_TCP);
      let mux: PortForwardMuxSession;
      transport = new DirectTcpTransport(
        auth.socket,
        tunnel.tunnelId,
        PORT_FORWARD_ROLE.TARGET,
        auth.sendKey,
        auth.recvKey,
        auth.sendDirTag,
        auth.recvDirTag,
        auth.initialBytes,
        () => {
          // Wait for listen's KEY_CONFIRM inside PortForwardMuxSession before committing!
        },
      );
      mux = new PortForwardMuxSession(
        PORT_FORWARD_ROLE.TARGET,
        transport,
        auth.transportKeys,
        muxIdentity,
        tunnel.targetHost,
        tunnel.targetPort,
        this.timeouts.handshakeMs,
        () => {
          activeCandidates.delete(transport);
          for (const other of activeCandidates) other.close('superseded');
          activeCandidates.clear();
          this.commitConfirmedCarrier(tunnel, transport, mux, true);
          this.options.sendWs({
            type: PORT_FORWARD_MSG.ESTABLISHED,
            tunnelId: tunnel.tunnelId,
            role: PORT_FORWARD_ROLE.TARGET,
            transportMode: PORT_FORWARD_TRANSPORT.DIRECT_TCP,
          });
        },
        () => this.pushStats(tunnel),
      );
      activeCandidates.add(transport);
      transport.onClose(() => {
        activeCandidates.delete(transport);
        if (!mux.isKeyConfirmed()) mux.closeAll('unconfirmed_close');
      });
    };

    const handleAccepted = (socket: NetSocket, isPreConnect: boolean) => {
      if (signal.aborted || tunnel.closed || tunnel.carrier) {
        socket.destroy();
        return;
      }
      if (!isPreConnect) {
        tunnel.tcpAcceptSockets.add(socket);
        socket.once('close', () => tunnel.tcpAcceptSockets.delete(socket));
      }
      void authenticateTcpSocket({
        socket,
        tunnelId: tunnel.tunnelId,
        role: PORT_FORWARD_ROLE.TARGET,
        selfServerId: tunnel.selfServerId,
        peerServerId: tunnel.peerServerId,
        admissionKey: tunnel.admissionMacKey,
        ecdhSecret,
        capability: tunnel.capability,
        listenPublicKey,
        targetPublicKey,
        isInitiator: false,
        handshakeMs: this.timeouts.handshakeMs,
      }).then(handleAuthenticated, () => {
        socket.destroy();
      });
    };

    const onIncoming = (socket: NetSocket) => handleAccepted(socket, false);
    tunnel.tcpAcceptServer?.on('connection', onIncoming);
    for (const preSock of tunnel.preConnectTcpSockets.splice(0)) {
      handleAccepted(preSock, true);
    }

    const onAbort = () => {
      tunnel.tcpAcceptServer?.off('connection', onIncoming);
      clearTimeout(dialDelayTimer);
      for (const other of activeCandidates) other.close('aborted');
      activeCandidates.clear();
    };
    signal.addEventListener('abort', onAbort, { once: true });

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
            selfServerId: tunnel.selfServerId,
            peerServerId: tunnel.peerServerId,
            admissionKey: tunnel.admissionMacKey,
            ecdhSecret,
            capability: tunnel.capability,
            listenPublicKey,
            targetPublicKey,
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
