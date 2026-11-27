import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { Socket as DgramSocket, RemoteInfo } from 'node:dgram';
import { isIP } from 'node:net';
import type { DirectFileTransferIceServerConfig } from '../../shared/direct-file-transfer.js';
import { PORT_FORWARD_LIMITS } from '../../shared/port-forward.js';

const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_SUCCESS_RESPONSE = 0x0101;
const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_HEADER_BYTES = 20;
const STUN_ATTR_MAPPED_ADDRESS = 0x0001;
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020;

export interface StunServerTarget {
  host: string;
  port: number;
  url: string;
}

export interface StunMappedEndpoint {
  host: string;
  port: number;
  stunServer: string;
}

export function parseStunServerUrl(raw: string): StunServerTarget | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith('stun:')) return null;
  let rest = trimmed.slice('stun:'.length);
  const queryIdx = rest.indexOf('?');
  if (queryIdx >= 0) {
    const query = rest.slice(queryIdx + 1).toLowerCase();
    if (query.includes('transport=tcp')) return null;
    rest = rest.slice(0, queryIdx);
  }
  if (!rest) return null;
  let host: string;
  let port = 3478;
  if (rest.startsWith('[')) {
    const closeBracket = rest.indexOf(']');
    if (closeBracket < 0) return null;
    host = rest.slice(1, closeBracket);
    const tail = rest.slice(closeBracket + 1);
    if (tail) {
      if (!tail.startsWith(':')) return null;
      const parsedPort = Number(tail.slice(1));
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return null;
      port = parsedPort;
    }
  } else {
    const lastColon = rest.lastIndexOf(':');
    if (lastColon > 0) {
      host = rest.slice(0, lastColon);
      const parsedPort = Number(rest.slice(lastColon + 1));
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return null;
      port = parsedPort;
    } else {
      host = rest;
    }
  }
  if (!host || /[\s/]/.test(host)) return null;
  return { host, port, url: trimmed };
}

export function extractStunServers(iceServers: readonly DirectFileTransferIceServerConfig[]): StunServerTarget[] {
  const seen = new Set<string>();
  const targets: StunServerTarget[] = [];
  for (const server of iceServers) {
    const urls = typeof server === 'string'
      ? [server]
      : Array.isArray(server.urls)
        ? server.urls
        : [server.urls];
    for (const url of urls) {
      const parsed = parseStunServerUrl(url);
      if (!parsed) continue;
      const key = `${parsed.host.toLowerCase()}:${parsed.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(parsed);
      if (targets.length >= 4) return targets;
    }
  }
  return targets;
}

export function buildStunBindingRequest(
  transactionId: Buffer = randomBytes(12),
): { packet: Buffer; transactionId: Buffer } {
  if (transactionId.length !== 12) throw new Error('invalid_stun_transaction_id');
  const packet = Buffer.allocUnsafe(STUN_HEADER_BYTES);
  packet.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  packet.writeUInt16BE(0, 2);
  packet.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(packet, 8);
  return { packet, transactionId };
}

function formatIpv4(bytes: Buffer): string {
  return `${bytes[0]!}.${bytes[1]!}.${bytes[2]!}.${bytes[3]!}`;
}

function formatIpv6(bytes: Buffer): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(bytes.readUInt16BE(i).toString(16));
  }
  return parts.join(':');
}

function decodeMappedAddress(
  value: Buffer,
  xor: boolean,
  headerCookieAndTx: Buffer,
): { host: string; port: number } | null {
  if (value.length < 4) return null;
  const family = value[1]!;
  const rawPort = value.readUInt16BE(2);
  const port = xor ? rawPort ^ (STUN_MAGIC_COOKIE >>> 16) : rawPort;
  if (port < 1 || port > 65535) return null;

  if (family === 0x01) {
    if (value.length < 8) return null;
    const addr = Buffer.from(value.subarray(4, 8));
    if (xor) {
      for (let i = 0; i < 4; i++) addr[i] = addr[i]! ^ headerCookieAndTx[i]!;
    }
    const host = formatIpv4(addr);
    return isIP(host) === 4 ? { host, port } : null;
  }

  if (family === 0x02) {
    if (value.length < 20) return null;
    const addr = Buffer.from(value.subarray(4, 20));
    if (xor) {
      for (let i = 0; i < 16; i++) addr[i] = addr[i]! ^ headerCookieAndTx[i]!;
    }
    const host = formatIpv6(addr);
    return isIP(host) === 6 ? { host, port } : null;
  }

  return null;
}

export function parseStunBindingResponse(
  packet: Buffer,
  expectedTxId: Buffer,
): { host: string; port: number } | null {
  if (packet.length < STUN_HEADER_BYTES) return null;
  const msgType = packet.readUInt16BE(0);
  if (msgType !== STUN_BINDING_SUCCESS_RESPONSE) return null;
  const msgLen = packet.readUInt16BE(2);
  const cookie = packet.readUInt32BE(4);
  if (cookie !== STUN_MAGIC_COOKIE) return null;
  const txId = packet.subarray(8, 20);
  if (!txId.equals(expectedTxId)) return null;
  if (packet.length < STUN_HEADER_BYTES + msgLen) return null;

  const end = STUN_HEADER_BYTES + msgLen;
  const headerCookieAndTx = packet.subarray(4, 20);
  let mappedFallback: { host: string; port: number } | null = null;
  let offset = STUN_HEADER_BYTES;

  while (offset + 4 <= end) {
    const attrType = packet.readUInt16BE(offset);
    const attrLen = packet.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + attrLen > end) break;
    const value = packet.subarray(offset, offset + attrLen);
    if (attrType === STUN_ATTR_XOR_MAPPED_ADDRESS) {
      const parsed = decodeMappedAddress(value, true, headerCookieAndTx);
      if (parsed) return parsed;
    } else if (attrType === STUN_ATTR_MAPPED_ADDRESS && !mappedFallback) {
      const parsed = decodeMappedAddress(value, false, headerCookieAndTx);
      if (parsed) mappedFallback = parsed;
    }
    offset += (attrLen + 3) & ~3;
  }

  return mappedFallback;
}

export async function probeStunCandidates(
  socket: DgramSocket,
  iceServers: readonly DirectFileTransferIceServerConfig[],
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    lookup?: (hostname: string) => Promise<string>;
  } = {},
): Promise<StunMappedEndpoint[]> {
  const servers = extractStunServers(iceServers);
  if (servers.length === 0 || options.signal?.aborted) return [];
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? PORT_FORWARD_LIMITS.STUN_PROBE_TIMEOUT_MS;
  const resolveHost = options.lookup ?? (async (hostname: string) => {
    if (isIP(hostname) === 4) return hostname;
    const res = await dnsLookup(hostname, { family: 4 });
    return res.address;
  });

  const pending = new Map<string, {
    txId: Buffer;
    stunServer: string;
    resolve: (ep: StunMappedEndpoint | null) => void;
    settled: boolean;
  }>();

  const onMessage = (msg: Buffer, _rinfo: RemoteInfo) => {
    if (signal?.aborted) return;
    if (msg.length < STUN_HEADER_BYTES) return;
    if (msg.readUInt16BE(0) !== STUN_BINDING_SUCCESS_RESPONSE) return;
    if (msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return;
    const txHex = msg.subarray(8, 20).toString('hex');
    const entry = pending.get(txHex);
    if (!entry || entry.settled) return;
    const parsed = parseStunBindingResponse(msg, entry.txId);
    if (!parsed) return;
    entry.settled = true;
    pending.delete(txHex);
    entry.resolve({ host: parsed.host, port: parsed.port, stunServer: entry.stunServer });
  };

  socket.on('message', onMessage);
  const abortResolvers = new Set<() => void>();
  const onAbort = () => {
    socket.off('message', onMessage);
    for (const finishNull of [...abortResolvers]) {
      finishNull();
    }
    abortResolvers.clear();
    pending.clear();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const results = await Promise.all(servers.map((server) => new Promise<StunMappedEndpoint | null>((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      const { packet, transactionId } = buildStunBindingRequest();
      const txHex = transactionId.toString('hex');
      let finished = false;
      const finish = (value: StunMappedEndpoint | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        pending.delete(txHex);
        abortResolvers.delete(finishAbort);
        resolve(value);
      };
      const finishAbort = () => finish(null);
      abortResolvers.add(finishAbort);

      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();

      pending.set(txHex, {
        txId: transactionId,
        stunServer: server.url,
        resolve: finish,
        settled: false,
      });

      void resolveHost(server.host)
        .then((ip) => {
          if (finished || signal?.aborted) {
            finish(null);
            return;
          }
          socket.send(packet, server.port, ip, (err) => {
            if (err) finish(null);
          });
        })
        .catch(() => finish(null));
    })));

    const deduped: StunMappedEndpoint[] = [];
    const seen = new Set<string>();
    for (const item of results) {
      if (!item) continue;
      if (item.host === '0.0.0.0' || item.host === '::') continue;
      const key = `${item.host}:${item.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    return deduped;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    socket.off('message', onMessage);
  }
}
