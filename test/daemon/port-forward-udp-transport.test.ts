import { createHash } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket as DgramSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PORT_FORWARD_LIMITS,
  PORT_FORWARD_MUX_TYPE,
  PORT_FORWARD_ROLE,
  encodePortForwardMuxFrame,
} from '../../shared/port-forward.js';
import {
  buildStunBindingRequest,
  parseStunBindingResponse,
  probeStunCandidates,
} from '../../src/daemon/port-forward-stun.js';
import {
  ReliableUdpTransport,
  UDP_P2P_MAGIC,
  UDP_P2P_PKT,
  decryptUdpArqPacket,
  deriveTunnelCryptoKeys,
  encryptUdpArqPacket,
  runUdpHolePunch,
} from '../../src/daemon/port-forward-udp-transport.js';
import {
  computeEcdhSharedSecret,
  computeKeyConfirmationMac,
  deriveAdmissionMacKey,
  deriveE2eTransportKeys,
  generateEphemeralEcdhKeyPair,
  verifyKeyConfirmationMac,
} from '../../src/daemon/port-forward-crypto.js';

const socketsToClose: DgramSocket[] = [];
const transportsToClose: ReliableUdpTransport[] = [];

afterEach(async () => {
  for (const t of transportsToClose.splice(0)) t.close('test_cleanup');
  await Promise.all(socketsToClose.splice(0).map((s) => new Promise<void>((resolve) => {
    try { s.close(() => resolve()); } catch { resolve(); }
  })));
});

function bindUdp(): Promise<{ socket: DgramSocket; port: number }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socketsToClose.push(socket);
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      const addr = socket.address();
      if (typeof addr === 'string') return reject(new Error('unexpected unix address'));
      resolve({ socket, port: addr.port });
    });
  });
}

function buildMockStunSuccessResponse(txId: Buffer, mappedHost: string, mappedPort: number): Buffer {
  const magic = 0x2112a442;
  const xPort = mappedPort ^ (magic >>> 16);
  const ipParts = mappedHost.split('.').map(Number);
  const cookieBytes = Buffer.allocUnsafe(4);
  cookieBytes.writeUInt32BE(magic, 0);

  const attr = Buffer.allocUnsafe(12);
  attr.writeUInt16BE(0x0020, 0); // XOR-MAPPED-ADDRESS
  attr.writeUInt16BE(8, 2);
  attr[4] = 0;
  attr[5] = 0x01; // IPv4
  attr.writeUInt16BE(xPort, 6);
  for (let i = 0; i < 4; i++) {
    attr[8 + i] = (ipParts[i]! ^ cookieBytes[i]!) & 0xff;
  }

  const header = Buffer.allocUnsafe(20);
  header.writeUInt16BE(0x0101, 0); // Binding Success Response
  header.writeUInt16BE(attr.length, 2);
  header.writeUInt32BE(magic, 4);
  txId.copy(header, 8);
  return Buffer.concat([header, attr]);
}

describe('RFC 5389 STUN client + UDP simultaneous hole punching + ARQ reliable transport', () => {
  it('probes STUN binding response XOR-MAPPED-ADDRESS on the bound UDP socket', async () => {
    const stun = await bindUdp();
    stun.socket.on('message', (msg, rinfo) => {
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001) return;
      const txId = msg.subarray(8, 20);
      const resp = buildMockStunSuccessResponse(txId, '203.0.113.42', 51820);
      stun.socket.send(resp, rinfo.port, rinfo.address);
    });

    const client = await bindUdp();
    const { packet, transactionId } = buildStunBindingRequest();
    expect(parseStunBindingResponse(packet, transactionId)).toBeNull();

    const mapped = await probeStunCandidates(
      client.socket,
      [`stun:127.0.0.1:${stun.port}`, 'turn:ignored.example.com:3478?transport=udp'],
      { timeoutMs: 800 },
    );

    expect(mapped).toEqual([
      { host: '203.0.113.42', port: 51820, stunServer: `stun:127.0.0.1:${stun.port}` },
    ]);
  });

  it('returns empty candidates gracefully on unreachable/timed-out STUN servers', async () => {
    const client = await bindUdp();
    const unusedPort = 59991;
    const mapped = await probeStunCandidates(
      client.socket,
      [`stun:127.0.0.1:${unusedPort}`],
      { timeoutMs: 120 },
    );
    expect(mapped).toEqual([]);
  });

  it('punches through simulated dual port-restricted NATs where packets are dropped until outbound pinhole exists', async () => {
    // Two peers behind simulated stateful NAT routers (natA / natB):
    // natA only forwards packets to peerA from peerB's NAT port AFTER peerA sends to natB;
    // natB only forwards packets to peerB from peerA's NAT port AFTER peerB sends to natA.
    const natA = await bindUdp();
    const natB = await bindUdp();
    const peerA = await bindUdp();
    const peerB = await bindUdp();

    let aOpenedForB = false;
    let bOpenedForA = false;

    natA.socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
      if (rinfo.port === peerA.port) {
        // Outbound from A -> open A's NAT pinhole and forward to natB as if from natA.port
        aOpenedForB = true;
        natA.socket.send(msg, natB.port, '127.0.0.1');
      } else if (rinfo.port === natB.port && aOpenedForB) {
        // Inbound to A from B -> allowed only once A opened pinhole
        natA.socket.send(msg, peerA.port, '127.0.0.1');
      }
    });

    natB.socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
      if (rinfo.port === peerB.port) {
        bOpenedForA = true;
        natB.socket.send(msg, natA.port, '127.0.0.1');
      } else if (rinfo.port === natA.port && bOpenedForA) {
        natB.socket.send(msg, peerB.port, '127.0.0.1');
      }
    });

    const tunnelId = 'pf_dual_nat_test_0001';
    const capability = Buffer.alloc(32, 0x42).toString('base64url');
    const keys = deriveTunnelCryptoKeys(capability, tunnelId);

    // Start B slightly later (simulating realistic timing skew during simultaneous open)
    const punchA = runUdpHolePunch({
      socket: peerA.socket,
      tunnelId,
      role: PORT_FORWARD_ROLE.LISTEN,
      keys,
      peerCandidates: [{ host: '127.0.0.1', port: natA.port, transport: 'udp', kind: 'srflx' }],
      punchIntervalMs: 30,
      timeoutMs: 2_000,
    });

    await new Promise((r) => setTimeout(r, 70));

    const punchB = runUdpHolePunch({
      socket: peerB.socket,
      tunnelId,
      role: PORT_FORWARD_ROLE.TARGET,
      keys,
      peerCandidates: [{ host: '127.0.0.1', port: natB.port, transport: 'udp', kind: 'srflx' }],
      punchIntervalMs: 30,
      timeoutMs: 2_000,
    });

    const [resA, resB] = await Promise.all([punchA, punchB]);
    expect(resA).not.toBeNull();
    expect(resB).not.toBeNull();
    expect(resA!.peerPort).toBe(natA.port);
    expect(resB!.peerPort).toBe(natB.port);
  });

  it('delivers >= 2 MiB ordered SHA-256 verified payload under 15% packet loss, reordering, duplicates, and <1200B MTU', async () => {
    const relayAtoB = await bindUdp();
    const relayBtoA = await bindUdp();
    const peerA = await bindUdp();
    const peerB = await bindUdp();

    let maxWireBytes = 0;
    let packetIndex = 0;
    let delayedPkt: { msg: Buffer; destPort: number; sock: DgramSocket } | null = null;

    // Lossy + reordering UDP impairment forwarder (always keeps packets strictly <= 1200B).
    const impairAndForward = (sock: DgramSocket, msg: Buffer, destPort: number) => {
      maxWireBytes = Math.max(maxWireBytes, msg.length);
      packetIndex += 1;
      // Drop every 7th packet (~14% loss) on first send of a packet batch, except very first handshake
      if (packetIndex > 4 && packetIndex % 7 === 0) {
        return;
      }
      // Reorder every 11th packet
      if (packetIndex > 6 && packetIndex % 11 === 0) {
        if (delayedPkt) {
          sock.send(delayedPkt.msg, delayedPkt.destPort, '127.0.0.1');
        }
        delayedPkt = { msg: Buffer.from(msg), destPort, sock };
        return;
      }
      sock.send(msg, destPort, '127.0.0.1');
      if (delayedPkt && packetIndex % 5 === 0) {
        sock.send(delayedPkt.msg, delayedPkt.destPort, '127.0.0.1');
        // Duplicate send to verify anti-replay + dedup
        sock.send(delayedPkt.msg, delayedPkt.destPort, '127.0.0.1');
        delayedPkt = null;
      }
    };

    relayAtoB.socket.on('message', (msg, rinfo) => {
      if (rinfo.port === peerA.port) impairAndForward(relayAtoB.socket, msg, peerB.port);
      else if (rinfo.port === peerB.port) impairAndForward(relayAtoB.socket, msg, peerA.port);
    });
    relayBtoA.socket.on('message', (msg, rinfo) => {
      if (rinfo.port === peerB.port) impairAndForward(relayBtoA.socket, msg, peerA.port);
      else if (rinfo.port === peerA.port) impairAndForward(relayBtoA.socket, msg, peerB.port);
    });

    const tunnelId = 'pf_lossy_arq_test_0001';
    const capability = Buffer.alloc(32, 0x99).toString('base64url');
    const keys = deriveTunnelCryptoKeys(capability, tunnelId);

    const tA = new ReliableUdpTransport({
      socket: peerA.socket,
      tunnelId,
      role: PORT_FORWARD_ROLE.LISTEN,
      keys,
      peerHost: '127.0.0.1',
      peerPort: relayAtoB.port,
      heartbeatIntervalMs: 5_000,
      deadLinkTimeoutMs: 20_000,
      maxRetries: 20,
    });
    const tB = new ReliableUdpTransport({
      socket: peerB.socket,
      tunnelId,
      role: PORT_FORWARD_ROLE.TARGET,
      keys,
      peerHost: '127.0.0.1',
      peerPort: relayBtoA.port,
      heartbeatIntervalMs: 5_000,
      deadLinkTimeoutMs: 20_000,
      maxRetries: 20,
    });
    transportsToClose.push(tA, tB);

    const totalBytes = 2 * 1024 * 1024 + 13_337;
    const sourceData = Buffer.allocUnsafe(totalBytes);
    for (let i = 0; i < totalBytes; i++) sourceData[i] = (i * 31 + 7) & 0xff;
    const expectedHash = createHash('sha256').update(sourceData).digest('hex');

    const receivedChunks: Buffer[] = [];
    let receivedBytes = 0;
    const completed = new Promise<void>((resolve) => {
      tB.onMuxFrame((frame) => {
        if (frame.type === PORT_FORWARD_MUX_TYPE.DATA) {
          receivedChunks.push(frame.payload);
          receivedBytes += frame.payload.length;
        } else if (frame.type === PORT_FORWARD_MUX_TYPE.EOF) {
          resolve();
        }
      });
    });

    const chunkSize = PORT_FORWARD_LIMITS.MAX_DATA_CHUNK_BYTES;
    for (let off = 0; off < sourceData.length; off += chunkSize) {
      while (!tA.isWritable()) {
        await new Promise<void>((r) => {
          const offDrain = tA.onDrain(() => {
            offDrain();
            r();
          });
        });
      }
      tA.sendMuxFrame(encodePortForwardMuxFrame(
        PORT_FORWARD_MUX_TYPE.DATA,
        1,
        sourceData.subarray(off, Math.min(off + chunkSize, sourceData.length)),
      ));
    }
    tA.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.EOF, 1));

    await completed;
    const actualHash = createHash('sha256').update(Buffer.concat(receivedChunks)).digest('hex');
    expect(receivedBytes).toBe(totalBytes);
    expect(actualHash).toBe(expectedHash);
    expect(maxWireBytes).toBeLessThanOrEqual(PORT_FORWARD_LIMITS.MAX_UDP_PAYLOAD_BYTES);
  }, 30_000);

  it('closes transport on dead-link timeout when peer stops responding', async () => {
    const peerA = await bindUdp();
    const keys = deriveTunnelCryptoKeys(Buffer.alloc(32, 0x11).toString('base64url'), 'pf_deadlink_test_0001');
    const tA = new ReliableUdpTransport({
      socket: peerA.socket,
      tunnelId: 'pf_deadlink_test_0001',
      role: PORT_FORWARD_ROLE.LISTEN,
      keys,
      peerHost: '127.0.0.1',
      peerPort: 59998,
      heartbeatIntervalMs: 30,
      deadLinkTimeoutMs: 120,
    });
    transportsToClose.push(tA);

    const closedReason = await new Promise<string>((resolve) => {
      tA.onClose((reason) => resolve(reason));
    });
    expect(closedReason).toBe('udp_dead_link');
  });

  it('derives E2E-exclusive per-transport X25519 keys opaque to relay capability and bounds UDP send/ACK windows', async () => {
    const alice = generateEphemeralEcdhKeyPair();
    const bob = generateEphemeralEcdhKeyPair();
    const secretA = computeEcdhSharedSecret(alice.privateKey, bob.publicKeyB64);
    const secretB = computeEcdhSharedSecret(bob.privateKey, alice.publicKeyB64);
    expect(secretA.equals(secretB)).toBe(true);

    const capability = Buffer.alloc(32, 0x55).toString('base64url');
    const tunnelId = 'pf_e2e_separation_01';
    const admissionKey = deriveAdmissionMacKey(capability, tunnelId);

    const udpKeysA = deriveE2eTransportKeys({
      ecdhSecret: secretA,
      capability,
      tunnelId,
      listenServerId: 'srv_listen',
      targetServerId: 'srv_target',
      listenPublicKey: alice.publicKeyB64,
      targetPublicKey: bob.publicKeyB64,
      transportMode: 'direct_udp_p2p',
    });
    const relayKeysA = deriveE2eTransportKeys({
      ecdhSecret: secretA,
      capability,
      tunnelId,
      listenServerId: 'srv_listen',
      targetServerId: 'srv_target',
      listenPublicKey: alice.publicKeyB64,
      targetPublicKey: bob.publicKeyB64,
      transportMode: 'relay',
    });

    // Different transports and directions never share keys; admission capability cannot derive E2E traffic keys.
    expect(udpKeysA.listenToTargetKey.equals(udpKeysA.targetToListenKey)).toBe(false);
    expect(udpKeysA.listenToTargetKey.equals(relayKeysA.listenToTargetKey)).toBe(false);
    expect(udpKeysA.listenToTargetKey.equals(admissionKey)).toBe(false);

    const tag = computeKeyConfirmationMac(udpKeysA.confirmListenToTargetKey, {
      tunnelId,
      listenServerId: 'srv_listen',
      targetServerId: 'srv_target',
      listenPublicKey: alice.publicKeyB64,
      targetPublicKey: bob.publicKeyB64,
      transportMode: 'direct_udp_p2p',
      direction: 'l2t',
    });
    expect(verifyKeyConfirmationMac(relayKeysA.confirmListenToTargetKey, {
      tunnelId,
      listenServerId: 'srv_listen',
      targetServerId: 'srv_target',
      listenPublicKey: alice.publicKeyB64,
      targetPublicKey: bob.publicKeyB64,
      transportMode: 'relay',
      direction: 'l2t',
    }, tag)).toBe(false);

    // Server attacker possessing capability + tunnelId alone cannot decrypt E2E ARQ packet.
    const encrypted = encryptUdpArqPacket(udpKeysA.listenToTargetKey, 0x4c540001, tunnelId, UDP_P2P_PKT.ARQ_DATA, 1n, Buffer.from('secret'));
    const serverGuessedKeys = deriveTunnelCryptoKeys(capability, tunnelId);
    expect(decryptUdpArqPacket(serverGuessedKeys.listenToTargetKey, 0x4c540001, tunnelId, encrypted)).toBeNull();

    // High-water write pause & forged out-of-window ARQ_ACK rejection + hard-cap overflow close.
    const senderSock = await bindUdp();
    const attackerSock = await bindUdp();
    const tA = new ReliableUdpTransport({
      socket: senderSock.socket,
      tunnelId,
      role: PORT_FORWARD_ROLE.LISTEN,
      keys: {
        punchMacKey: admissionKey,
        listenToTargetKey: udpKeysA.listenToTargetKey,
        targetToListenKey: udpKeysA.targetToListenKey,
      },
      peerHost: '127.0.0.1',
      peerPort: attackerSock.port,
      heartbeatIntervalMs: 5_000,
      deadLinkTimeoutMs: 20_000,
    });
    transportsToClose.push(tA);

    // Send 260 single-packet frames -> crosses UDP_HIGH_WATER_PACKETS (256), making isWritable() false.
    let becameUnwritable = false;
    for (let i = 0; i < 260; i++) {
      if (!tA.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.DATA, 1, Buffer.alloc(100, i & 0xff)))) {
        becameUnwritable = true;
      }
    }
    expect(becameUnwritable).toBe(true);
    expect(tA.isWritable()).toBe(false);

    // Inject forged ACK for out-of-window future sequence 0x0fffffff -> must be ignored without clearing inFlight.
    const forgedAckInner = Buffer.allocUnsafe(10);
    forgedAckInner.writeUInt32BE(0x0fffffff, 0);
    forgedAckInner.writeUInt32BE(0xffffffff, 4);
    forgedAckInner.writeUInt16BE(256, 8);
    const forgedAckPkt = encryptUdpArqPacket(udpKeysA.targetToListenKey, 0x544c0002, tunnelId, UDP_P2P_PKT.ARQ_ACK, 1n, forgedAckInner);
    attackerSock.socket.send(forgedAckPkt, senderSock.port, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 30));
    expect(tA.isWritable()).toBe(false);

    // Pushing past UDP_HARD_CAP_PACKETS (1024) closes cleanly with udp_send_queue_overflow.
    const closePromise = new Promise<string>((resolve) => tA.onClose(resolve));
    for (let i = 0; i < 900; i++) {
      tA.sendMuxFrame(encodePortForwardMuxFrame(PORT_FORWARD_MUX_TYPE.DATA, 1, Buffer.alloc(100, 1)));
    }
    expect(await closePromise).toBe('udp_send_queue_overflow');
  });
});
