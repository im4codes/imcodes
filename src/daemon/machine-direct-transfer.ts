import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { open, lstat, readFile, realpath, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { createServer, connect, isIP, type Server, type Socket } from 'node:net';
import { basename, join, resolve } from 'node:path';
import {
  MACHINE_DIRECT_FILE_TRANSFER_ERROR,
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
  MACHINE_DIRECT_FRAME_TYPE,
  MACHINE_DIRECT_HANDSHAKE_MSG,
  MACHINE_DIRECT_RESUME_FILE_PREFIX,
  isRoutableMachineDirectAddress,
  isValidMachineDirectEncryptedFrameLength,
  validateMachineDirectSourceHello,
  validateMachineDirectTargetHello,
  validateMachineDirectFetchStart,
  type MachineDirectCandidate,
  type MachineDirectFetchRequest,
  type MachineDirectFetchResponse,
  type MachineDirectFetchStart,
  type MachineDirectUploadRequest,
  type MachineDirectUploadResponse,
} from '../../shared/machine-direct-file-transfer.js';
import {
  validateFileTransferSourceIdentity,
  type FileTransferSourceIdentity,
} from '../../shared/transport/file-transfer.js';
import { isFilePreviewPathAllowed } from './file-preview-path-policy.js';
import {
  createDirectUploadFilename,
  finalizeDirectUploadedFile,
  initFileTransfer,
  lookupAttachmentByClientUploadId,
  releaseClientUploadClaim,
  resolveUploadPath,
  tryClaimClientUpload,
} from './file-transfer-handler.js';

class MachineDirectProtocolError extends Error {}

class SocketReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private failure: Error | null = null;
  private paused = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
      if (!this.paused && this.buffer.length >= MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_BUFFERED_SOCKET_BYTES) {
        this.paused = true;
        socket.pause();
      }
      this.wake();
    });
    socket.on('end', () => { this.ended = true; this.wake(); });
    socket.on('close', () => { this.ended = true; this.wake(); });
    socket.on('error', (error) => { this.failure = error; this.wake(); });
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private async waitForData(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.ended) throw new MachineDirectProtocolError('socket_closed');
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private resumeIfDrained(): void {
    if (this.paused && this.buffer.length < MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_BUFFERED_SOCKET_BYTES / 2) {
      this.paused = false;
      this.socket.resume();
    }
  }

  async readLine(maxBytes: number): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        if (newline > maxBytes) throw new MachineDirectProtocolError('line_too_large');
        const line = this.buffer.subarray(0, newline).toString('utf8');
        this.buffer = this.buffer.subarray(newline + 1);
        this.resumeIfDrained();
        return line;
      }
      if (this.buffer.length > maxBytes) throw new MachineDirectProtocolError('line_too_large');
      await this.waitForData();
    }
  }

  async readExact(size: number): Promise<Buffer> {
    while (this.buffer.length < size) await this.waitForData();
    const value = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    this.resumeIfDrained();
    return value;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MachineDirectProtocolError(label)), timeoutMs);
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function parseJsonLine(line: string): unknown {
  try { return JSON.parse(line) as unknown; } catch { throw new MachineDirectProtocolError('invalid_json'); }
}

function capabilityBytes(capability: string): Buffer {
  const decoded = Buffer.from(capability, 'base64url');
  if (decoded.length !== 32) throw new MachineDirectProtocolError('invalid_capability');
  return decoded;
}

function hmac(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function createMachineDirectProof(
  capability: string,
  role: 'target' | 'source',
  requestId: string,
  targetNonce: string,
  sourceNonce?: string,
  resumeOffset = 0,
): string {
  const secret = capabilityBytes(capability);
  const base = role === 'target'
    ? `target:${requestId}:${targetNonce}`
    : `source:${requestId}:${targetNonce}:${sourceNonce ?? ''}`;
  // Keep offset zero wire-compatible with v1 peers. A non-zero resume
  // boundary is authority-bearing and therefore part of both proofs.
  const proofInput = resumeOffset > 0 ? `${base}:resume:${resumeOffset}` : base;
  return hmac(secret, proofInput);
}

function proofMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function deriveMachineDirectTransferKey(
  capability: string,
  targetNonce: string,
  sourceNonce: string,
  requestId: string,
): Buffer {
  const secret = capabilityBytes(capability);
  return Buffer.from(hkdfSync(
    'sha256',
    secret,
    Buffer.from(`${targetNonce}:${sourceNonce}`),
    Buffer.from(`imcodes-machine-direct-v1:${requestId}`),
    32,
  ));
}

function frameIv(key: Buffer, counter: bigint): Buffer {
  return createHmac('sha256', key).update('iv:').update(String(counter)).digest().subarray(0, 12);
}

function frameAad(requestId: string, counter: bigint): Buffer {
  return Buffer.from(`${requestId}:${counter}`);
}

export function encryptMachineDirectFrame(key: Buffer, requestId: string, counter: bigint, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, frameIv(key, counter));
  cipher.setAAD(frameAad(requestId, counter));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(ciphertext.length);
  return Buffer.concat([length, ciphertext]);
}

export function decryptMachineDirectFrame(key: Buffer, requestId: string, counter: bigint, ciphertext: Buffer): Buffer {
  const tagBytes = MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FRAME_AUTH_TAG_BYTES;
  if (ciphertext.length < tagBytes + 1) throw new MachineDirectProtocolError('invalid_frame');
  const body = ciphertext.subarray(0, -tagBytes);
  const tag = ciphertext.subarray(-tagBytes);
  const decipher = createDecipheriv('aes-256-gcm', key, frameIv(key, counter));
  decipher.setAAD(frameAad(requestId, counter));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new MachineDirectProtocolError('frame_auth_failed');
  }
}

async function writeSocket(socket: Socket, data: Buffer | string): Promise<void> {
  if (socket.destroyed) throw new MachineDirectProtocolError('socket_closed');
  if (socket.write(data)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { socket.off('drain', onDrain); socket.off('error', onError); };
    socket.once('drain', onDrain);
    socket.once('error', onError);
  });
}

function collectPrivateCandidates(port: number): MachineDirectCandidate[] {
  const seen = new Set<string>();
  const candidates: MachineDirectCandidate[] = [];
  for (const values of Object.values(networkInterfaces())) {
    for (const address of values ?? []) {
      const host = address.address.split('%')[0]!;
      // The receiver below intentionally binds an IPv4 wildcard. Advertising
      // an IPv6 interface here creates a candidate that can never reach that
      // listener and needlessly delays direct-first transfers.
      if (address.internal
        || isIP(host) !== 4
        || !isRoutableMachineDirectAddress(host)
        || seen.has(host)) continue;
      seen.add(host);
      candidates.push({ host, port });
      if (candidates.length >= MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '0.0.0.0', port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new MachineDirectProtocolError('listen_failed');
  return address.port;
}

interface MachineDirectCryptoContext {
  requestId: string;
  capability: string;
}

type MachineDirectSourceIdentity = FileTransferSourceIdentity;

const MACHINE_FETCH_RESUME_IDENTITY_SUFFIX = '.identity.json';

function machineFileSourceIdentityEquals(
  left: FileTransferSourceIdentity | null | undefined,
  right: FileTransferSourceIdentity | null | undefined,
): boolean {
  return Boolean(left && right
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.device === right.device
    && left.inode === right.inode);
}

export function machineFetchResumeIdentityPath(tempPath: string): string {
  return `${tempPath}${MACHINE_FETCH_RESUME_IDENTITY_SUFFIX}`;
}

export async function readMachineFetchResumeIdentity(tempPath: string): Promise<FileTransferSourceIdentity | null> {
  const raw = await readFile(machineFetchResumeIdentityPath(tempPath), 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    return validateFileTransferSourceIdentity(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function writeMachineFetchResumeIdentity(
  tempPath: string,
  identity: FileTransferSourceIdentity,
): Promise<void> {
  const identityPath = machineFetchResumeIdentityPath(tempPath);
  const stagingPath = `${identityPath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(stagingPath, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
    await rename(stagingPath, identityPath);
  } finally {
    await unlink(stagingPath).catch(() => {});
  }
}

export async function removeMachineFetchResumeIdentity(tempPath: string): Promise<void> {
  await unlink(machineFetchResumeIdentityPath(tempPath)).catch(() => {});
}

export async function discardMachineFetchResume(tempPath: string): Promise<void> {
  await Promise.all([
    unlink(tempPath).catch(() => {}),
    removeMachineFetchResumeIdentity(tempPath),
  ]);
}

export async function bindMachineFetchResumeIdentity(
  tempPath: string,
  identity: FileTransferSourceIdentity,
): Promise<void> {
  const existing = await readMachineFetchResumeIdentity(tempPath);
  if (machineFileSourceIdentityEquals(existing, identity)) return;
  await removeMachineFetchResumeIdentity(tempPath);
  await writeMachineFetchResumeIdentity(tempPath, identity);
}

function machineDirectSourceIdentityMatches(
  actual: Awaited<ReturnType<FileHandle['stat']>>,
  expected: MachineDirectSourceIdentity,
): boolean {
  return actual.isFile()
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.dev === expected.device
    && actual.ino === expected.inode;
}

interface AuthenticatedMachineDirectSocket {
  reader: SocketReader;
  key: Buffer;
  resumeOffset: number;
}

async function authenticateMachineDirectSource(
  socket: Socket,
  request: MachineDirectCryptoContext,
): Promise<AuthenticatedMachineDirectSocket> {
  const reader = new SocketReader(socket);
  const targetHello = parseJsonLine(await withTimeout(
    reader.readLine(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.HANDSHAKE_LINE_MAX_BYTES),
    MACHINE_DIRECT_FILE_TRANSFER_LIMITS.HANDSHAKE_TIMEOUT_MS,
    'handshake_timeout',
  ));
  const validatedTargetHello = validateMachineDirectTargetHello(targetHello);
  const resumeOffset = validatedTargetHello?.resumeOffset ?? 0;
  if (!validatedTargetHello
    || validatedTargetHello.requestId !== request.requestId
    || !proofMatches(
      createMachineDirectProof(request.capability, 'target', request.requestId, validatedTargetHello.nonce, undefined, resumeOffset),
      validatedTargetHello.proof,
    )) {
    throw new MachineDirectProtocolError('auth_failed');
  }
  const sourceNonce = randomBytes(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.NONCE_BYTES).toString('base64url');
  await writeSocket(socket, `${JSON.stringify({
    type: MACHINE_DIRECT_HANDSHAKE_MSG.SOURCE_HELLO,
    requestId: request.requestId,
    nonce: sourceNonce,
    proof: createMachineDirectProof(request.capability, 'source', request.requestId, validatedTargetHello.nonce, sourceNonce, resumeOffset),
  })}\n`);
  return {
    reader,
    key: deriveMachineDirectTransferKey(request.capability, validatedTargetHello.nonce, sourceNonce, request.requestId),
    resumeOffset,
  };
}

async function authenticateMachineDirectTarget(
  socket: Socket,
  request: MachineDirectCryptoContext,
  resumeOffset = 0,
): Promise<AuthenticatedMachineDirectSocket> {
  const reader = new SocketReader(socket);
  const targetNonce = randomBytes(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.NONCE_BYTES).toString('base64url');
  await writeSocket(socket, `${JSON.stringify({
    type: MACHINE_DIRECT_HANDSHAKE_MSG.TARGET_HELLO,
    requestId: request.requestId,
    nonce: targetNonce,
    proof: createMachineDirectProof(request.capability, 'target', request.requestId, targetNonce, undefined, resumeOffset),
    ...(resumeOffset > 0 ? { resumeOffset } : {}),
  })}\n`);
  const sourceHello = parseJsonLine(await withTimeout(
    reader.readLine(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.HANDSHAKE_LINE_MAX_BYTES),
    MACHINE_DIRECT_FILE_TRANSFER_LIMITS.HANDSHAKE_TIMEOUT_MS,
    'handshake_timeout',
  ));
  const validatedSourceHello = validateMachineDirectSourceHello(sourceHello);
  if (!validatedSourceHello
    || validatedSourceHello.requestId !== request.requestId
    || !proofMatches(
      createMachineDirectProof(request.capability, 'source', request.requestId, targetNonce, validatedSourceHello.nonce, resumeOffset),
      validatedSourceHello.proof,
    )) {
    throw new MachineDirectProtocolError('auth_failed');
  }
  return {
    reader,
    key: deriveMachineDirectTransferKey(request.capability, targetNonce, validatedSourceHello.nonce, request.requestId),
    resumeOffset,
  };
}

async function readEncryptedMachineDirectFrame(
  authenticated: AuthenticatedMachineDirectSocket,
  requestId: string,
  counter: bigint,
  timeoutMs: number,
): Promise<Buffer> {
  const lengthHeader = await withTimeout(
    authenticated.reader.readExact(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FRAME_LENGTH_HEADER_BYTES),
    timeoutMs,
    'transfer_timeout',
  );
  const length = lengthHeader.readUInt32BE(0);
  if (!isValidMachineDirectEncryptedFrameLength(length)) {
    throw new MachineDirectProtocolError('invalid_frame_length');
  }
  const encrypted = await withTimeout(authenticated.reader.readExact(length), timeoutMs, 'transfer_timeout');
  return decryptMachineDirectFrame(authenticated.key, requestId, counter, encrypted);
}

function encodeMachineDirectFetchStart(start: MachineDirectFetchStart): Buffer {
  const encoded = Buffer.from(JSON.stringify(start));
  if (encoded.length > MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_START_METADATA_BYTES) {
    throw new MachineDirectProtocolError('start_too_large');
  }
  return Buffer.concat([Buffer.from([MACHINE_DIRECT_FRAME_TYPE.START]), encoded]);
}

function decodeMachineDirectFetchStart(plaintext: Buffer): MachineDirectFetchStart {
  if (plaintext[0] !== MACHINE_DIRECT_FRAME_TYPE.START
    || plaintext.length < 2
    || plaintext.length > MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_START_METADATA_BYTES + 1) {
    throw new MachineDirectProtocolError('invalid_start');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(plaintext.subarray(1).toString('utf8')) as unknown; } catch { throw new MachineDirectProtocolError('invalid_start'); }
  const start = validateMachineDirectFetchStart(parsed);
  if (!start) throw new MachineDirectProtocolError('invalid_start');
  return start;
}

async function sendEncryptedFile(
  socket: Socket,
  sourceFile: string | FileHandle,
  request: MachineDirectCryptoContext,
  totalSize: number,
  start?: MachineDirectFetchStart,
  expectedSourceIdentity?: MachineDirectSourceIdentity,
): Promise<number> {
  const { key, resumeOffset } = await authenticateMachineDirectSource(socket, request);
  if (!Number.isSafeInteger(resumeOffset) || resumeOffset < 0 || resumeOffset > totalSize) {
    throw new MachineDirectProtocolError('size_mismatch');
  }
  let counter = 0n;
  let total = resumeOffset;
  const source = typeof sourceFile === 'string' ? await open(sourceFile, 'r') : sourceFile;
  try {
    const sourceStat = await source.stat();
    if (!sourceStat.isFile() || sourceStat.size !== totalSize) throw new MachineDirectProtocolError('source_changed');
    if (expectedSourceIdentity && !machineDirectSourceIdentityMatches(sourceStat, expectedSourceIdentity)) {
      throw new MachineDirectProtocolError('source_changed');
    }
    if (start) {
      await writeSocket(socket, encryptMachineDirectFrame(
        key,
        request.requestId,
        counter++,
        encodeMachineDirectFetchStart({ ...start, ...(resumeOffset > 0 ? { resumeOffset } : {}) }),
      ));
    }
    for await (const chunk of source.createReadStream({
      autoClose: false,
      highWaterMark: MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_FRAME_PLAINTEXT_BYTES - 1,
      start: resumeOffset,
    })) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      await writeSocket(socket, encryptMachineDirectFrame(
        key,
        request.requestId,
        counter++,
        Buffer.concat([Buffer.from([MACHINE_DIRECT_FRAME_TYPE.DATA]), bytes]),
      ));
    }
    const completedStat = await source.stat();
    if ((expectedSourceIdentity && !machineDirectSourceIdentityMatches(completedStat, expectedSourceIdentity))
      || completedStat.size !== sourceStat.size
      || completedStat.mtimeMs !== sourceStat.mtimeMs
      || completedStat.dev !== sourceStat.dev
      || completedStat.ino !== sourceStat.ino) {
      throw new MachineDirectProtocolError('source_changed');
    }
  } finally {
    await source.close().catch(() => {});
  }
  const finish = Buffer.allocUnsafe(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FINISH_FRAME_PLAINTEXT_BYTES);
  finish[0] = MACHINE_DIRECT_FRAME_TYPE.FINISH;
  finish.writeBigUInt64BE(BigInt(total), 1);
  await writeSocket(socket, encryptMachineDirectFrame(key, request.requestId, counter, finish));
  socket.end();
  return total;
}

export interface MachineDirectSender {
  candidates: MachineDirectCandidate[];
  completion: Promise<void>;
  close(): void;
}

export async function startMachineDirectSender(options: {
  sourcePath: string;
  request: Omit<MachineDirectUploadRequest, 'candidates'>;
  expectedSourceIdentity?: MachineDirectSourceIdentity;
}): Promise<MachineDirectSender | null> {
  let activeConnections = 0;
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  const sockets = new Set<Socket>();
  let candidates: MachineDirectCandidate[] = [];
  const server = createServer((socket) => {
    if (settled || activeConnections >= MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_ACCEPT_ATTEMPTS) {
      socket.destroy();
      return;
    }
    activeConnections += 1;
    sockets.add(socket);
    const request: MachineDirectUploadRequest = { ...options.request, candidates };
    void sendEncryptedFile(
      socket,
      options.sourcePath,
      request,
      request.size,
      undefined,
      options.expectedSourceIdentity,
    ).then(() => {
      if (settled) return;
      settled = true;
      server.close();
      for (const candidate of sockets) if (candidate !== socket) candidate.destroy();
      resolveCompletion();
    }, (error) => {
      sockets.delete(socket);
      activeConnections = Math.max(0, activeConnections - 1);
      socket.destroy();
      void error;
    });
  });
  const port = await listen(server).catch(() => 0);
  candidates = port ? collectPrivateCandidates(port) : [];
  if (!port || candidates.length === 0) {
    server.close();
    return null;
  }
  const expiryTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close();
    for (const socket of sockets) socket.destroy();
    rejectCompletion(new MachineDirectProtocolError('direct_timeout'));
  }, MACHINE_DIRECT_FILE_TRANSFER_LIMITS.TRANSFER_TIMEOUT_MS);
  expiryTimer.unref?.();
  completion.finally(() => clearTimeout(expiryTimer)).catch(() => {});
  return {
    candidates,
    completion,
    close() {
      if (!settled) {
        settled = true;
        rejectCompletion(new MachineDirectProtocolError('direct_closed'));
      }
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

async function connectCandidate(candidate: MachineDirectCandidate): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: candidate.host, port: candidate.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new MachineDirectProtocolError('connect_timeout'));
    }, MACHINE_DIRECT_FILE_TRANSFER_LIMITS.CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function connectAny(candidates: MachineDirectCandidate[]): Promise<Socket> {
  const routableCandidates = candidates.filter((candidate) => isRoutableMachineDirectAddress(candidate.host));
  if (routableCandidates.length === 0) {
    throw new MachineDirectProtocolError(MACHINE_DIRECT_FILE_TRANSFER_ERROR.CONNECT_FAILED);
  }
  const sockets: Socket[] = [];
  return new Promise<Socket>((resolve, reject) => {
    let failures = 0;
    let done = false;
    for (const candidate of routableCandidates) {
      void connectCandidate(candidate).then((socket) => {
        sockets.push(socket);
        if (done) { socket.destroy(); return; }
        done = true;
        for (const other of sockets) if (other !== socket) other.destroy();
        resolve(socket);
      }, (error) => {
        failures += 1;
        if (!done && failures === routableCandidates.length) reject(error instanceof Error ? error : new Error(String(error)));
      });
    }
  });
}

async function openValidatedMachineDirectSource(sourcePath: string): Promise<{
  handle: FileHandle;
  start: MachineDirectFetchStart;
}> {
  const requested = resolve(sourcePath);
  const before = await lstat(requested);
  if (before.isSymbolicLink() || !before.isFile()) throw new MachineDirectProtocolError('source_invalid');
  const canonical = await realpath(requested);
  if (!isFilePreviewPathAllowed(canonical)) throw new MachineDirectProtocolError('source_invalid');
  const handle = await open(canonical, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()
      || opened.size !== before.size
      || opened.dev !== before.dev
      || (before.ino !== 0 && opened.ino !== before.ino)
      || !Number.isSafeInteger(opened.size)
      || opened.size < 0) {
      throw new MachineDirectProtocolError('source_invalid');
    }
    return {
      handle,
      start: {
        size: opened.size,
        originalName: basename(canonical),
        sourceIdentity: {
          size: opened.size,
          mtimeMs: opened.mtimeMs,
          device: opened.dev,
          inode: opened.ino,
        },
      },
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function machineDirectFetchError(
  requestId: string,
  error: (typeof MACHINE_DIRECT_FILE_TRANSFER_ERROR)[keyof typeof MACHINE_DIRECT_FILE_TRANSFER_ERROR],
): MachineDirectFetchResponse {
  return { type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_ERROR, requestId, error };
}

export async function sendMachineDirectFetch(request: MachineDirectFetchRequest): Promise<MachineDirectFetchResponse> {
  if (Date.now() > request.expiresAt) {
    return machineDirectFetchError(request.requestId, MACHINE_DIRECT_FILE_TRANSFER_ERROR.EXPIRED);
  }
  let socket: Socket | undefined;
  let source: Awaited<ReturnType<typeof openValidatedMachineDirectSource>> | undefined;
  try {
    source = await openValidatedMachineDirectSource(request.sourcePath);
    socket = await connectAny(request.candidates);
    const total = await sendEncryptedFile(socket, source.handle, request, source.start.size, source.start);
    if (total !== source.start.size) throw new MachineDirectProtocolError('size_mismatch');
    return { type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE, requestId: request.requestId, size: total };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return machineDirectFetchError(
      request.requestId,
      message.includes('source') ? MACHINE_DIRECT_FILE_TRANSFER_ERROR.SOURCE_INVALID
        : message.includes('auth') ? MACHINE_DIRECT_FILE_TRANSFER_ERROR.AUTH_FAILED
          : message.includes('connect') ? MACHINE_DIRECT_FILE_TRANSFER_ERROR.CONNECT_FAILED
            : message.includes('timeout') ? MACHINE_DIRECT_FILE_TRANSFER_ERROR.TIMEOUT
              : message.includes('size') ? MACHINE_DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH
                : MACHINE_DIRECT_FILE_TRANSFER_ERROR.TRANSFER_FAILED,
    );
  } finally {
    socket?.destroy();
    await source?.handle.close().catch(() => {});
  }
}

export interface MachineDirectFetchReceiver {
  candidates: MachineDirectCandidate[];
  completion: Promise<MachineDirectFetchStart>;
  close(): void;
}

export async function startMachineDirectFetchReceiver(options: {
  tempPath: string;
  request: Omit<MachineDirectFetchRequest, 'candidates' | 'sourcePath'>;
  transferTimeoutMs?: number;
}): Promise<MachineDirectFetchReceiver | null> {
  let activeConnections = 0;
  let settled = false;
  let resolveCompletion!: (start: MachineDirectFetchStart) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<MachineDirectFetchStart>((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = rejectPromise;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (settled || activeConnections >= MACHINE_DIRECT_FILE_TRANSFER_LIMITS.MAX_ACCEPT_ATTEMPTS) {
      socket.destroy();
      return;
    }
    activeConnections += 1;
    sockets.add(socket);
    void (async () => {
      let authenticated = false;
      let file: FileHandle | undefined;
      let tempCreated = false;
      let succeeded = false;
      let preservePartial = false;
      try {
        let existing = await stat(options.tempPath).catch(() => null);
        if (existing && !existing.isFile()) throw new MachineDirectProtocolError('invalid_partial');
        let storedIdentity = existing ? await readMachineFetchResumeIdentity(options.tempPath) : null;
        // A partial without an exact durable source identity can never be
        // authenticated as a prefix of the next source version.
        if (existing && !storedIdentity) {
          await discardMachineFetchResume(options.tempPath);
          existing = null;
        } else if (!existing) {
          await removeMachineFetchResumeIdentity(options.tempPath);
          storedIdentity = null;
        }
        const resumeOffset = existing?.size ?? 0;
        const channel = await authenticateMachineDirectTarget(socket, options.request, resumeOffset);
        authenticated = true;
        let counter = 0n;
        const timeoutMs = options.transferTimeoutMs ?? MACHINE_DIRECT_FILE_TRANSFER_LIMITS.TRANSFER_TIMEOUT_MS;
        const start = decodeMachineDirectFetchStart(await readEncryptedMachineDirectFrame(
          channel,
          options.request.requestId,
          counter++,
          timeoutMs,
        ));
        if (!start.sourceIdentity) {
          throw new MachineDirectProtocolError('source_identity_missing');
        }
        if ((start.resumeOffset ?? 0) !== resumeOffset || resumeOffset > start.size) {
          throw new MachineDirectProtocolError('size_mismatch');
        }
        if (resumeOffset > 0 && !machineFileSourceIdentityEquals(storedIdentity, start.sourceIdentity)) {
          await discardMachineFetchResume(options.tempPath);
          throw new MachineDirectProtocolError('source_identity_mismatch');
        }
        if (resumeOffset === 0) {
          await bindMachineFetchResumeIdentity(options.tempPath, start.sourceIdentity);
        }
        file = await open(options.tempPath, existing ? 'r+' : 'wx', 0o600);
        tempCreated = true;
        let loaded = resumeOffset;
        for (;;) {
          const plaintext = await readEncryptedMachineDirectFrame(
            channel,
            options.request.requestId,
            counter++,
            timeoutMs,
          );
          if (plaintext[0] === MACHINE_DIRECT_FRAME_TYPE.DATA) {
            loaded += plaintext.length - 1;
            if (loaded > start.size) throw new MachineDirectProtocolError('size_mismatch');
            const data = plaintext.subarray(1);
            let offset = 0;
            while (offset < data.length) {
              const { bytesWritten } = await file.write(data, offset, data.length - offset, loaded - data.length + offset);
              if (bytesWritten <= 0) throw new MachineDirectProtocolError('write_failed');
              offset += bytesWritten;
            }
            continue;
          }
          if (plaintext[0] !== MACHINE_DIRECT_FRAME_TYPE.FINISH
            || plaintext.length !== MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FINISH_FRAME_PLAINTEXT_BYTES) {
            throw new MachineDirectProtocolError('invalid_finish');
          }
          const declared = Number(plaintext.readBigUInt64BE(1));
          if (!Number.isSafeInteger(declared) || declared !== start.size || loaded !== start.size) {
            throw new MachineDirectProtocolError('size_mismatch');
          }
          await file.sync();
          await file.close();
          file = undefined;
          if (settled) return;
          settled = true;
          succeeded = true;
          server.close();
          for (const candidate of sockets) if (candidate !== socket) candidate.destroy();
          resolveCompletion(start);
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        preservePartial = authenticated
          && !message.includes('auth')
          && !message.includes('size')
          && !message.includes('identity')
          && !message.includes('invalid_');
        if (authenticated && !settled) {
          await file?.close().catch(() => {});
          file = undefined;
          if (tempCreated && !preservePartial) {
            await discardMachineFetchResume(options.tempPath);
            tempCreated = false;
          }
          settled = true;
          server.close();
          for (const candidate of sockets) candidate.destroy();
          rejectCompletion(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        sockets.delete(socket);
        activeConnections = Math.max(0, activeConnections - 1);
        socket.destroy();
        await file?.close().catch(() => {});
        if (tempCreated && !succeeded && !preservePartial) await discardMachineFetchResume(options.tempPath);
      }
    })();
  });
  const port = await listen(server).catch(() => 0);
  const candidates = port ? collectPrivateCandidates(port) : [];
  if (!port || candidates.length === 0) {
    server.close();
    return null;
  }
  const expiryTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close();
    for (const socket of sockets) socket.destroy();
    rejectCompletion(new MachineDirectProtocolError('direct_timeout'));
  }, options.transferTimeoutMs ?? MACHINE_DIRECT_FILE_TRANSFER_LIMITS.TRANSFER_TIMEOUT_MS);
  expiryTimer.unref?.();
  completion.finally(() => clearTimeout(expiryTimer)).catch(() => {});
  return {
    candidates,
    completion,
    close() {
      if (!settled) {
        settled = true;
        rejectCompletion(new MachineDirectProtocolError('direct_closed'));
      }
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

export async function receiveMachineDirectUpload(
  request: MachineDirectUploadRequest,
  options: { transferTimeoutMs?: number } = {},
): Promise<MachineDirectUploadResponse> {
  const existing = lookupAttachmentByClientUploadId(request.clientUploadId);
  if (existing) return { type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE, requestId: request.requestId, attachment: existing };
  if (Date.now() > request.expiresAt) {
    return {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
      requestId: request.requestId,
      error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.EXPIRED,
    };
  }
  const claim = tryClaimClientUpload(request.clientUploadId);
  if (!claim) {
    return {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
      requestId: request.requestId,
      error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.TRANSFER_FAILED,
    };
  }
  let socket: Socket | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let temp = '';
  let resumeMetaPath = '';
  let promoted = '';
  let discardPartial = false;
  try {
    await initFileTransfer();
    const resumeBase = `${MACHINE_DIRECT_RESUME_FILE_PREFIX}${request.clientUploadId}`;
    temp = join(homedir(), '.imcodes', 'uploads', `${resumeBase}.part`);
    resumeMetaPath = join(homedir(), '.imcodes', 'uploads', `${resumeBase}.json`);
    type ResumeMeta = {
      version: 1;
      filename: string;
      originalName: string;
      mime?: string;
      size: number;
    };
    let resumeMeta: ResumeMeta | null = null;
    try { resumeMeta = JSON.parse(await readFile(resumeMetaPath, 'utf8')) as ResumeMeta; } catch { /* first attempt */ }
    if (!resumeMeta) {
      resumeMeta = {
        version: 1,
        filename: createDirectUploadFilename(request.originalName),
        originalName: request.originalName,
        ...(request.mime ? { mime: request.mime } : {}),
        size: request.size,
      };
      await writeFile(temp, new Uint8Array(0), { flag: 'wx', mode: 0o600 }).catch(async (error) => {
        const existing = await stat(temp).catch(() => null);
        if (!existing?.isFile()) throw error;
      });
      await writeFile(resumeMetaPath, JSON.stringify(resumeMeta), { flag: 'wx', mode: 0o600 }).catch(async (error) => {
        const existing = await readFile(resumeMetaPath, 'utf8').catch(() => null);
        if (!existing) throw error;
        resumeMeta = JSON.parse(existing) as ResumeMeta;
      });
    }
    if (resumeMeta.version !== 1
      || resumeMeta.originalName !== request.originalName
      || (resumeMeta.mime ?? '') !== (request.mime ?? '')
      || resumeMeta.size !== request.size) {
      throw new MachineDirectProtocolError('upload_identity_mismatch');
    }
    const partial = await stat(temp);
    if (!partial.isFile() || partial.size > request.size) {
      discardPartial = true;
      throw new MachineDirectProtocolError('size_mismatch');
    }
    socket = await connectAny(request.candidates);
    const channel = await authenticateMachineDirectTarget(socket, request, partial.size);
    const filename = resumeMeta.filename;
    const resolved = resolveUploadPath(filename);
    file = await open(temp, 'r+', 0o600);
    let counter = 0n;
    let loaded = partial.size;
    for (;;) {
      const transferTimeoutMs = options.transferTimeoutMs ?? MACHINE_DIRECT_FILE_TRANSFER_LIMITS.TRANSFER_TIMEOUT_MS;
      const plaintext = await readEncryptedMachineDirectFrame(channel, request.requestId, counter++, transferTimeoutMs);
      if (plaintext[0] === MACHINE_DIRECT_FRAME_TYPE.DATA) {
        loaded += plaintext.length - 1;
        if (loaded > request.size) throw new MachineDirectProtocolError('size_mismatch');
        const data = plaintext.subarray(1);
        let offset = 0;
        while (offset < data.length) {
          const { bytesWritten } = await file.write(data, offset, data.length - offset, loaded - data.length + offset);
          if (bytesWritten <= 0) throw new MachineDirectProtocolError('write_failed');
          offset += bytesWritten;
        }
        continue;
      }
      if (plaintext[0] !== MACHINE_DIRECT_FRAME_TYPE.FINISH
        || plaintext.length !== MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FINISH_FRAME_PLAINTEXT_BYTES) {
        throw new MachineDirectProtocolError('invalid_finish');
      }
      const declared = Number(plaintext.readBigUInt64BE(1));
      if (!Number.isSafeInteger(declared) || declared !== request.size || loaded !== request.size) {
        throw new MachineDirectProtocolError('size_mismatch');
      }
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temp, resolved);
      temp = '';
      await unlink(resumeMetaPath).catch(() => {});
      resumeMetaPath = '';
      promoted = resolved;
      const attachment = await finalizeDirectUploadedFile({
        clientUploadId: request.clientUploadId,
        filename,
        originalName: request.originalName,
        ...(request.mime ? { mime: request.mime } : {}),
        resolved,
        size: loaded,
      });
      promoted = '';
      return { type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE, requestId: request.requestId, attachment };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('size_mismatch')) discardPartial = true;
    if (!discardPartial && temp) {
      const partialSize = await stat(temp).then((entry) => entry.size).catch(() => 0);
      if (partialSize === 0) discardPartial = true;
    }
    const directError: MachineDirectUploadResponse = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
      requestId: request.requestId,
      error: message.includes('auth') ? MACHINE_DIRECT_FILE_TRANSFER_ERROR.AUTH_FAILED
        : message.includes('connect') ? MACHINE_DIRECT_FILE_TRANSFER_ERROR.CONNECT_FAILED
          : message.includes('timeout') ? MACHINE_DIRECT_FILE_TRANSFER_ERROR.TIMEOUT
            : message.includes('size') ? MACHINE_DIRECT_FILE_TRANSFER_ERROR.SIZE_MISMATCH
              : MACHINE_DIRECT_FILE_TRANSFER_ERROR.TRANSFER_FAILED,
    };
    return directError;
  } finally {
    socket?.destroy();
    await file?.close().catch(() => {});
    if (temp && discardPartial) await unlink(temp).catch(() => {});
    if (resumeMetaPath && discardPartial) await unlink(resumeMetaPath).catch(() => {});
    if (promoted) {
      await unlink(promoted).catch(() => {});
      await unlink(`${promoted}.meta.json`).catch(() => {});
    }
    releaseClientUploadClaim(request.clientUploadId, claim);
  }
}
