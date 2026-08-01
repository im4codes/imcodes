import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MACHINE_DIRECT_FILE_TRANSFER_ERROR,
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
  MACHINE_DIRECT_FRAME_TYPE,
  MACHINE_DIRECT_HANDSHAKE_MSG,
  isPrivateMachineDirectAddress,
  validateMachineDirectTargetHello,
  type MachineDirectUploadRequest,
} from '../../shared/machine-direct-file-transfer.js';
import {
  createMachineDirectProof,
  deriveMachineDirectTransferKey,
  encryptMachineDirectFrame,
  receiveMachineDirectUpload,
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
      if (address.family === 'IPv4' && !address.internal && isPrivateMachineDirectAddress(address.address)) return address.address;
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
