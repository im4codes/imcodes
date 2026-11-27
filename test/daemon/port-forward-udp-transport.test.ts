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
  deriveTunnelCryptoKeys,
  runUdpHolePunch,
} from '../../src/daemon/port-forward-udp-transport.js';

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
});
