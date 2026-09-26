import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
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
const resumeArtifacts = new Set<string>();
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const uploadDir = join(homedir(), '.imcodes', 'uploads');
  await Promise.all([...resumeArtifacts].flatMap((clientUploadId) => [
    rm(join(uploadDir, `.machine-resume-${clientUploadId}.part`), { force: true }),
    rm(join(uploadDir, `.machine-resume-${clientUploadId}.json`), { force: true }),
  ]));
  resumeArtifacts.clear();
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
  sendFrames: (socket: Socket, key: Buffer, resumeOffset: number) => void | Promise<void>,
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
        proof: createMachineDirectProof(
          request.capability,
          'source',
          request.requestId,
          targetHello.nonce,
          sourceNonce,
          targetHello.resumeOffset ?? 0,
        ),
      })}\n`);
      const key = deriveMachineDirectTransferKey(request.capability, targetHello.nonce, sourceNonce, request.requestId);
      await sendFrames(socket, key, targetHello.resumeOffset ?? 0);
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
  const clientUploadId = randomBytes(24).toString('base64url');
  resumeArtifacts.add(clientUploadId);
  return {
    type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
    requestId: randomBytes(24).toString('base64url'),
    clientUploadId,
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
    expect(start).toMatchObject({
      size: content.length,
      originalName: 'controlled-source.bin',
      sourceIdentity: { size: content.length, device: expect.any(Number), inode: expect.any(Number) },
    });
    await expect(readFile(tempPath)).resolves.toEqual(content);
    receiver!.close();
  });

  it('resumes a reverse machine-direct fetch after a connection loss without rewriting its prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-resume-'));
    cleanup.push(dir);
    const sourcePath = join(dir, 'controlled-source.bin');
    const tempPath = join(dir, '.full-destination.part');
    await writeFile(sourcePath, 'abcdef');
    const sourceStat = await stat(sourcePath);
    const sourceIdentity = {
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
      device: sourceStat.dev,
      inode: sourceStat.ino,
    };
    const firstRequest = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    } as const;
    const first = await startMachineDirectFetchReceiver({ tempPath, request: firstRequest, transferTimeoutMs: 1_000 });
    expect(first).not.toBeNull();
    const candidate = first!.candidates[0]!;
    const socket = connect({ host: candidate.host, port: candidate.port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const targetHello = validateMachineDirectTargetHello(await readJsonLine(socket));
    expect(targetHello?.resumeOffset).toBeUndefined();
    const sourceNonce = randomBytes(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.NONCE_BYTES).toString('base64url');
    socket.write(`${JSON.stringify({
      type: MACHINE_DIRECT_HANDSHAKE_MSG.SOURCE_HELLO,
      requestId: firstRequest.requestId,
      nonce: sourceNonce,
      proof: createMachineDirectProof(firstRequest.capability, 'source', firstRequest.requestId, targetHello!.nonce, sourceNonce),
    })}\n`);
    const key = deriveMachineDirectTransferKey(firstRequest.capability, targetHello!.nonce, sourceNonce, firstRequest.requestId);
    socket.write(encryptMachineDirectFrame(key, firstRequest.requestId, 0n, Buffer.concat([
      Buffer.from([MACHINE_DIRECT_FRAME_TYPE.START]),
      Buffer.from(JSON.stringify({ size: 6, originalName: 'controlled-source.bin', sourceIdentity })),
    ])));
    socket.end(encryptMachineDirectFrame(
      key,
      firstRequest.requestId,
      1n,
      Buffer.concat([Buffer.from([MACHINE_DIRECT_FRAME_TYPE.DATA]), Buffer.from('abc')]),
    ));
    await expect(first!.completion).rejects.toThrow();
    await expect(readFile(tempPath, 'utf8')).resolves.toBe('abc');

    const retryRequest = {
      ...firstRequest,
      requestId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
    };
    const retry = await startMachineDirectFetchReceiver({ tempPath, request: retryRequest });
    expect(retry).not.toBeNull();
    const response = await sendMachineDirectFetch({
      ...retryRequest,
      sourcePath,
      candidates: retry!.candidates,
    });
    await expect(retry!.completion).resolves.toEqual({
      size: 6,
      originalName: 'controlled-source.bin',
      sourceIdentity,
      resumeOffset: 3,
    });
    expect(response).toEqual({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE,
      requestId: retryRequest.requestId,
      size: 6,
    });
    await expect(readFile(tempPath, 'utf8')).resolves.toBe('abcdef');
    retry!.close();
  });

  it('rejects a reverse-direct partial when the source was replaced, then restarts from zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-fetch-source-replaced-'));
    cleanup.push(dir);
    const sourcePath = join(dir, 'controlled-source.bin');
    const tempPath = join(dir, '.full-destination.part');
    await writeFile(sourcePath, 'AAAAA');
    const oldStat = await stat(sourcePath);
    const oldIdentity = {
      size: oldStat.size,
      mtimeMs: oldStat.mtimeMs,
      device: oldStat.dev,
      inode: oldStat.ino,
    };
    const firstRequest = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    } as const;
    const first = await startMachineDirectFetchReceiver({ tempPath, request: firstRequest, transferTimeoutMs: 1_000 });
    expect(first).not.toBeNull();
    const socket = connect({ host: first!.candidates[0]!.host, port: first!.candidates[0]!.port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const targetHello = validateMachineDirectTargetHello(await readJsonLine(socket));
    expect(targetHello).not.toBeNull();
    const sourceNonce = randomBytes(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.NONCE_BYTES).toString('base64url');
    socket.write(`${JSON.stringify({
      type: MACHINE_DIRECT_HANDSHAKE_MSG.SOURCE_HELLO,
      requestId: firstRequest.requestId,
      nonce: sourceNonce,
      proof: createMachineDirectProof(
        firstRequest.capability,
        'source',
        firstRequest.requestId,
        targetHello!.nonce,
        sourceNonce,
      ),
    })}\n`);
    const key = deriveMachineDirectTransferKey(firstRequest.capability, targetHello!.nonce, sourceNonce, firstRequest.requestId);
    socket.write(encryptMachineDirectFrame(key, firstRequest.requestId, 0n, Buffer.concat([
      Buffer.from([MACHINE_DIRECT_FRAME_TYPE.START]),
      Buffer.from(JSON.stringify({ size: 5, originalName: 'controlled-source.bin', sourceIdentity: oldIdentity })),
    ])));
    socket.end(encryptMachineDirectFrame(
      key,
      firstRequest.requestId,
      1n,
      Buffer.concat([Buffer.from([MACHINE_DIRECT_FRAME_TYPE.DATA]), Buffer.from('AA')]),
    ));
    await expect(first!.completion).rejects.toThrow();
    await expect(readFile(tempPath, 'utf8')).resolves.toBe('AA');

    await unlink(sourcePath);
    await writeFile(sourcePath, 'hello');
    const replacementRequest = {
      ...firstRequest,
      requestId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
    };
    const replacement = await startMachineDirectFetchReceiver({ tempPath, request: replacementRequest });
    expect(replacement).not.toBeNull();
    const replacementSend = sendMachineDirectFetch({
      ...replacementRequest,
      sourcePath,
      candidates: replacement!.candidates,
    });
    await expect(replacement!.completion).rejects.toThrow('source_identity_mismatch');
    // The source may finish writing into the kernel before it observes the
    // receiver close. Receiver identity validation is the commit authority.
    await expect(replacementSend).resolves.toMatchObject({ requestId: replacementRequest.requestId });
    await expect(readFile(tempPath)).rejects.toThrow();

    const freshRequest = {
      ...replacementRequest,
      requestId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
    };
    const fresh = await startMachineDirectFetchReceiver({ tempPath, request: freshRequest });
    expect(fresh).not.toBeNull();
    await expect(sendMachineDirectFetch({
      ...freshRequest,
      sourcePath,
      candidates: fresh!.candidates,
    })).resolves.toMatchObject({ type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE, size: 5 });
    await expect(fresh!.completion).resolves.toMatchObject({ size: 5 });
    await expect(readFile(tempPath, 'utf8')).resolves.toBe('hello');
    fresh!.close();
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
      Buffer.from(JSON.stringify({
        size: failure === 'size-mismatch' ? 4 : 3,
        originalName: 'bad.bin',
        sourceIdentity: {
          size: failure === 'size-mismatch' ? 4 : 3,
          mtimeMs: 1,
          device: 1,
          inode: 1,
        },
      })),
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

  it('fails closed when the upload source changes after its resume identity was bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-machine-direct-source-change-'));
    cleanup.push(dir);
    const sourcePath = join(dir, 'source.txt');
    await writeFile(sourcePath, 'first');
    const sourceStat = await stat(sourcePath);
    const base: Omit<MachineDirectUploadRequest, 'candidates'> = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
      requestId: randomBytes(24).toString('base64url'),
      clientUploadId: randomBytes(24).toString('base64url'),
      capability: randomBytes(32).toString('base64url'),
      originalName: 'source.txt',
      size: 5,
      expiresAt: Date.now() + 15_000,
    };
    resumeArtifacts.add(base.clientUploadId);
    const sender = await startMachineDirectSender({
      sourcePath,
      request: base,
      expectedSourceIdentity: {
        size: sourceStat.size,
        mtimeMs: sourceStat.mtimeMs,
        device: sourceStat.dev,
        inode: sourceStat.ino,
      },
    });
    expect(sender).not.toBeNull();
    await unlink(sourcePath);
    await writeFile(sourcePath, 'other');

    await expect(receiveMachineDirectUpload({ ...base, candidates: sender!.candidates })).resolves.toMatchObject({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
      error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.TRANSFER_FAILED,
    });
    sender!.close();
    await expect(sender!.completion).rejects.toThrow('direct_closed');
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

  it.each(['tamper', 'replay'] as const)('rejects %s frames without trusting unauthenticated bytes', async (failure) => {
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
    const after = await machinePartFiles();
    if (failure === 'tamper') {
      expect(after).toEqual(before);
    } else {
      expect([...after].filter((file) => !before.has(file))).toEqual([
        `.machine-resume-${base.clientUploadId}.part`,
      ]);
    }
  });

  it('resumes an authenticated machine-direct upload from the receiver-owned durable offset', async () => {
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
    const afterFailure = await machinePartFiles();
    expect([...afterFailure].filter((file) => !before.has(file))).toEqual([
      `.machine-resume-${base.clientUploadId}.part`,
    ]);

    const retry = { ...base, requestId: randomBytes(24).toString('base64url') };
    const retryCandidate = await startProtocolSource(retry, (socket, key, resumeOffset) => {
      expect(resumeOffset).toBe(3);
      socket.write(encryptMachineDirectFrame(
        key,
        retry.requestId,
        0n,
        Buffer.concat([Buffer.from([MACHINE_DIRECT_FRAME_TYPE.DATA]), Buffer.from('def')]),
      ));
      const finish = Buffer.alloc(MACHINE_DIRECT_FILE_TRANSFER_LIMITS.FINISH_FRAME_PLAINTEXT_BYTES);
      finish[0] = MACHINE_DIRECT_FRAME_TYPE.FINISH;
      finish.writeBigUInt64BE(6n, 1);
      socket.end(encryptMachineDirectFrame(key, retry.requestId, 1n, finish));
    });
    const completed = await receiveMachineDirectUpload({ ...retry, candidates: [retryCandidate] });
    expect(completed.type).toBe(MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE);
    if (completed.type !== MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE) throw new Error(completed.error);
    await expect(readFile(completed.attachment.daemonPath, 'utf8')).resolves.toBe('abcdef');
    await unlink(completed.attachment.daemonPath).catch(() => {});
    await unlink(`${completed.attachment.daemonPath}.meta.json`).catch(() => {});
  });
});
