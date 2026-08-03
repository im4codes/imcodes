import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MACHINE_DIRECT_FILE_TRANSFER_ERROR,
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
  MACHINE_DIRECT_FRAME_TYPE,
  MACHINE_DIRECT_HANDSHAKE_MSG,
  isRoutableMachineDirectAddress,
  validateMachineDirectTargetHello,
  type MachineDirectUploadRequest,
} from '../../shared/machine-direct-file-transfer.js';
import {
  createMachineDirectProof,
  deriveMachineDirectTransferKey,
  encryptMachineDirectFrame,
  receiveMachineDirectUpload,
  sendMachineDirectFetch,
  startMachineDirectFetchReceiver,
  startMachineDirectSender,
} from '../../src/daemon/machine-direct-transfer.js';

const cleanup: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function privateIpv4Host(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && isRoutableMachineDirectAddress(address.address)) return address.address;
    }
  }
  throw new Error('private IPv4 test interface unavailable');
}

async function readJsonLine(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      cleanupListeners();
      try { resolve(JSON.parse(buffered.subarray(0, newline).toString('utf8')) as unknown); } catch (error) { reject(error); }
    };
    const onError = (error: Error) => { cleanupListeners(); reject(error); };
    const cleanupListeners = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function startProtocolSource(
  request: Omit<MachineDirectUploadRequest, 'candidates'>,
  sendFrames: (socket: Socket, key: Buffer) => void | Promise<void>,
): Promise<{ host: string; port: number }> {
  const server = createServer((socket) => {
    void (async () => {
      const targetHello = validateMachineDirectTargetHello(await readJsonLine(socket));
      if (!targetHello || targetHello.requestId !== request.requestId) throw new Error('invalid target hello');
      const sourceNonce = randomBytes(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.NONCE_BYTES).toString('base64url');
      socket.write(`${JSON.stringify({
        type: MACHINE_DIRECT_HANDSHAKE_MSG.SOURCE_HELLO,
        requestId: request.requestId,
        nonce: sourceNonce,
        proof: createMachineDirectProof(request.capability, 'source', request.requestId, targetHello.nonce, sourceNonce),
      })}\n`);
      const key = deriveMachineDirectTransferKey(request.capability, targetHello.nonce, sourceNonce, request.requestId);
      await sendFrames(socket, key);
    })().catch(() => socket.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '0.0.0.0', port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test listener unavailable');
  return { host: privateIpv4Host(), port: address.port };
}

async function machinePartFiles(): Promise<Set<string>> {
  const uploadDir = join(homedir(), '.imcodes', 'uploads');
  const files = await readdir(uploadDir).catch(() => []);
  return new Set(files.filter((file) => file.includes('.machine-') && file.endsWith('.part')));
}

function requestBase(size: number): Omit<MachineDirectUploadRequest, 'candidates'> {
  return {
    type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
    requestId: randomBytes(24).toString('base64url'),
    clientUploadId: randomBytes(24).toString('base64url'),
    capability: randomBytes(32).toString('base64url'),
    originalName: 'adversarial.bin',
    size,
    expiresAt: Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
  };
}

describe('machine direct encrypted TCP transfer', () => {
  it('reuses the encrypted sender to stream from a controlled source into a Full receiver temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-direct-'));
    cleanup.push(dir);
    const sourcePath = join(dir, 'controlled-source.bin');
    const tempPath = join(dir, '.full-destination.part');
    const content = Buffer.from(`reverse-direct-${'r'.repeat(180_000)}`);
    await writeFile(sourcePath, content);
    const request = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    } as const;
    const receiver = await startMachineDirectFetchReceiver({ tempPath, request });
    expect(receiver).not.toBeNull();
    const response = await sendMachineDirectFetch({
      ...request,
      sourcePath,
      candidates: [{ host: 'fe80::1', port: receiver!.candidates[0]!.port }, ...receiver!.candidates],
    });
    const start = await receiver!.completion;
    expect(response).toEqual({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE,
      requestId: request.requestId,
      size: content.length,
    });
    expect(start).toEqual({ size: content.length, originalName: 'controlled-source.bin' });
    await expect(readFile(tempPath)).resolves.toEqual(content);
    receiver!.close();
  });

  it('returns a correlated connect failure immediately when every legacy candidate is link-local', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-link-local-'));
    cleanup.push(dir);
    const sourcePath = join(dir, 'controlled-source.bin');
    await writeFile(sourcePath, 'link-local-only');
    const request = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
      candidates: [
        { host: '169.254.10.20', port: 45125 },
        { host: 'fe80::1', port: 45125 },
      ],
      sourcePath,
      expiresAt: Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    } as const;

    await expect(sendMachineDirectFetch(request)).resolves.toEqual({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_ERROR,
      requestId: request.requestId,
      error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.CONNECT_FAILED,
    });
  });

  it('rejects a non-regular reverse source before opening a data connection', async () => {
    const request = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
      candidates: [{ host: '192.168.2.145', port: 9 }],
      sourcePath: tmpdir(),
      expiresAt: Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    } as const;
    await expect(sendMachineDirectFetch(request)).resolves.toEqual({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_ERROR,
      requestId: request.requestId,
      error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.SOURCE_INVALID,
    });
  });

  it.each(['tamper', 'size-mismatch'] as const)('rejects reverse %s and removes the Full temp file', async (failure) => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-adversarial-'));
    cleanup.push(dir);
    const tempPath = join(dir, '.destination.part');
    const request = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    } as const;
    const receiver = await startMachineDirectFetchReceiver({ tempPath, request, transferTimeoutMs: 1_000 });
    expect(receiver).not.toBeNull();
    const candidate = receiver!.candidates[0]!;
    const socket = connect({ host: candidate.host, port: candidate.port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const targetHello = validateMachineDirectTargetHello(await readJsonLine(socket));
    expect(targetHello).not.toBeNull();
    const sourceNonce = randomBytes(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.NONCE_BYTES).toString('base64url');
    socket.write(`${JSON.stringify({
      type: MACHINE_DIRECT_HANDSHAKE_MSG.SOURCE_HELLO,
      requestId: request.requestId,
      nonce: sourceNonce,
      proof: createMachineDirectProof(request.capability, 'source', request.requestId, targetHello!.nonce, sourceNonce),
    })}\n`);
    const key = deriveMachineDirectTransferKey(request.capability, targetHello!.nonce, sourceNonce, request.requestId);
    const start = Buffer.concat([
      Buffer.from([MACHINE_DIRECT_FRAME_TYPE.START]),
      Buffer.from(JSON.stringify({ size: failure === 'size-mismatch' ? 4 : 3, originalName: 'bad.bin' })),
    ]);
    socket.write(encryptMachineDirectFrame(key, request.requestId, 0n, start));
    const data = encryptMachineDirectFrame(
      key,
      request.requestId,
      1n,
      Buffer.concat([Buffer.from([MACHINE_DIRECT_FRAME_TYPE.DATA]), Buffer.from('abc')]),
    );
    if (failure === 'tamper') data[data.length - 1] ^= 0xff;
    socket.write(data);
    if (failure === 'size-mismatch') {
      const finish = Buffer.alloc(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FINISH_FRAME_PLAINTEXT_BYTES);
      finish[0] = MACHINE_DIRECT_FRAME_TYPE.FINISH;
      finish.writeBigUInt64BE(3n, 1);
      socket.write(encryptMachineDirectFrame(key, request.requestId, 2n, finish));
    }
    socket.end();
    await expect(receiver!.completion).rejects.toThrow();
    await expect(readFile(tempPath)).rejects.toThrow();
    receiver!.close();
  });

  it('streams a file over a routed-private candidate and commits a normal attachment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-direct-'));
    cleanup.push(dir);
    const sourcePath = join(dir, 'source.txt');
    const content = Buffer.from(`direct-${'x'.repeat(160_000)}`);
    await writeFile(sourcePath, content);
    const base: Omit<MachineDirectUploadRequest, 'candidates'> = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
      requestId: randomBytes(24).toString('base64url'),
      clientUploadId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
      originalName: 'source.txt',
      mime: 'text/plain',
      size: content.length,
      expiresAt: Date.now() + 15_000,
    };
    const sender = await startMachineDirectSender({ sourcePath, request: base });
    expect(sender).not.toBeNull();
    const response = await receiveMachineDirectUpload({ ...base, candidates: sender!.candidates });
    await expect(sender!.completion).resolves.toBeUndefined();
    expect(response.type).toBe(MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE);
    if (response.type !== MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE) throw new Error(response.error);
    await expect(readFile(response.attachment.daemonPath)).resolves.toEqual(content);
    await unlink(response.attachment.daemonPath).catch(() => {});
    await unlink(`${response.attachment.daemonPath}.meta.json`).catch(() => {});
    sender!.close();
  });

  it('rejects an expired authority before opening a socket', async () => {
    const response = await receiveMachineDirectUpload({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
      requestId: randomBytes(24).toString('base64url'),
      clientUploadId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
      candidates: [{ host: '192.168.2.145', port: 9 }],
      originalName: 'expired.txt',
      size: 1,
      expiresAt: Date.now() - 1,
    });
    expect(response).toMatchObject({ type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR, error: 'expired' });
  });

  it.each(['tamper', 'replay'] as const)('rejects %s frames and removes partial data', async (failure) => {
    const before = await machinePartFiles();
    const base = requestBase(3);
    const candidate = await startProtocolSource(base, (socket, key) => {
      const frame = encryptMachineDirectFrame(
        key,
        base.requestId,
        0n,
        Buffer.concat([Buffer.from([MACHINE_DIRECT_FRAME_TYPE.DATA]), Buffer.from('abc')]),
      );
      if (failure === 'tamper') frame[frame.length - 1] ^= 0xff;
      socket.end(failure === 'replay' ? Buffer.concat([frame, frame]) : frame);
    });

    const response = await receiveMachineDirectUpload({ ...base, candidates: [candidate] });

    expect(response).toMatchObject({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
      error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.AUTH_FAILED,
    });
    expect(await machinePartFiles()).toEqual(before);
  });

  it('times out an authenticated partial stream and removes its temp file', async () => {
    const before = await machinePartFiles();
    const base = requestBase(6);
    const candidate = await startProtocolSource(base, (socket, key) => {
      socket.write(encryptMachineDirectFrame(
        key,
        base.requestId,
        0n,
        Buffer.concat([Buffer.from([MACHINE_DIRECT_FRAME_TYPE.DATA]), Buffer.from('abc')]),
      ));
    });

    const response = await receiveMachineDirectUpload(
      { ...base, candidates: [candidate] },
      { transferTimeoutMs: 25 },
    );

    expect(response).toMatchObject({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
      error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.TIMEOUT,
    });
    expect(await machinePartFiles()).toEqual(before);
  });
});
