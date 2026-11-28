import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CONTROLLED_NODE_ABI_GLIBC217,
  CONTROLLED_NODE_ABI_MODERN,
} from '../../shared/controlled-node-abi.js';
import {
  CONTROLLED_NODE_ENROLL_STDIN_FLAG,
  CONTROLLED_NODE_ENROLL_STDIN_MAX_BYTES,
  CONTROLLED_NODE_INSTALL_SUBCOMMAND,
  parseEnrollmentPayloadJson,
  validateEnrollmentPayload,
} from '../../shared/controlled-node-install.js';
import {
  parseInstallSubcommandArgs,
  readEnrollmentBlobFromStdin,
} from '../../src/node/install-cli.js';
import {
  bootstrapControlledNodeWithDisposition,
  isCurrentExecutableStable,
  withBootstrapProcessLock,
  type ControlledNodeBootstrapDeps,
} from '../../src/node/bootstrap.js';
import {
  inspectExecutableReceipt,
  loadPendingReenrollment,
  openVerifiedEnrollmentSource,
  persistPendingReenrollment,
  probeControlledNodeCredentialStatus,
  removePendingReenrollment,
  type ControlledNodeCredential,
  type PendingInstallIdentity,
  type PendingReenrollmentRecord,
  type VerifiedEnrollmentSource,
} from '../../src/node/enrollment.js';
import {
  controlledNodeEndpointsPath,
  createRuntimeEndpointSelector,
  emptyEndpointState,
  readEndpointState,
  resetEndpointStateForCredential,
  writeEndpointState,
} from '../../src/node/server-endpoints.js';
import {
  INSTALL_JOURNAL_VERSION,
  writeInstallPhase,
  type InstallJournal,
  type ServiceReceipt,
} from '../../src/node/install-journal.js';

describe('shared controlled-node stdin enrollment schema', () => {
  it('validates minimal and optional fields and strips trailing slash on serverUrl', () => {
    const res = parseEnrollmentPayloadJson(JSON.stringify({
      serverUrl: 'https://relay.example.com/',
      enrollToken: 'tok_abc123',
      ownerName: '  Alice\nDesk\t1  ',
      abiProfile: CONTROLLED_NODE_ABI_GLIBC217,
    }));
    expect(res).toEqual({
      ok: true,
      value: {
        serverUrl: 'https://relay.example.com',
        enrollToken: 'tok_abc123',
        abiProfile: CONTROLLED_NODE_ABI_GLIBC217,
        ownerName: 'Alice Desk 1',
      },
    });
  });

  it('omits modern abiProfile when canonicalized', () => {
    const res = validateEnrollmentPayload({
      serverUrl: 'http://127.0.0.1:8080',
      enrollToken: 'tok_xyz',
      abiProfile: CONTROLLED_NODE_ABI_MODERN,
    });
    expect(res).toEqual({
      ok: true,
      value: {
        serverUrl: 'http://127.0.0.1:8080',
        enrollToken: 'tok_xyz',
      },
    });
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t  '],
    ['malformed json', '{bad json'],
    ['array instead of object', '[]'],
    ['unknown field', JSON.stringify({ serverUrl: 'https://a.test', enrollToken: 't', extra: 1 })],
    ['url with path', JSON.stringify({ serverUrl: 'https://a.test/path', enrollToken: 't' })],
    ['url with credentials', JSON.stringify({ serverUrl: 'https://u:p@a.test', enrollToken: 't' })],
    ['non-http url', JSON.stringify({ serverUrl: 'file:///tmp/x', enrollToken: 't' })],
    ['empty enrollToken', JSON.stringify({ serverUrl: 'https://a.test', enrollToken: '' })],
    ['padded enrollToken', JSON.stringify({ serverUrl: 'https://a.test', enrollToken: ' tok ' })],
    ['control char in enrollToken', JSON.stringify({ serverUrl: 'https://a.test', enrollToken: 'tok\n1' })],
    ['invalid abiProfile', JSON.stringify({ serverUrl: 'https://a.test', enrollToken: 'tok', abiProfile: 'musl' })],
    ['non-string ownerName', JSON.stringify({ serverUrl: 'https://a.test', enrollToken: 'tok', ownerName: 42 })],
  ])('rejects %s', (_label, input) => {
    const res = parseEnrollmentPayloadJson(input);
    expect(res.ok).toBe(false);
  });

  it('rejects oversized payload', () => {
    const huge = JSON.stringify({
      serverUrl: 'https://a.test',
      enrollToken: 't',
      ownerName: 'x'.repeat(CONTROLLED_NODE_ENROLL_STDIN_MAX_BYTES + 100),
    });
    const res = parseEnrollmentPayloadJson(huge);
    expect(res).toEqual({ ok: false, error: 'payload_too_large' });
  });
});

describe('install CLI arg parsing and bounded stdin reading', () => {
  it('recognizes `install --enroll-stdin` and ignores non-install invocations', () => {
    expect(parseInstallSubcommandArgs(['node', 'imcodes-node'])).toBe(false);
    expect(parseInstallSubcommandArgs(['node', 'imcodes-node', '--version'])).toBe(false);
    expect(parseInstallSubcommandArgs([
      'node',
      'imcodes-node',
      CONTROLLED_NODE_INSTALL_SUBCOMMAND,
      CONTROLLED_NODE_ENROLL_STDIN_FLAG,
    ])).toBe(true);
  });

  it.each([
    ['missing flag', ['node', 'imcodes-node', 'install']],
    ['unknown flag', ['node', 'imcodes-node', 'install', '--enroll-token=secret123']],
    ['extra positional arg', ['node', 'imcodes-node', 'install', '--enroll-stdin', 'secret123']],
  ])('fails closed on %s without leaking arguments', (_label, argv) => {
    expect(() => parseInstallSubcommandArgs(argv)).toThrow(/usage:/);
  });

  it('reads chunked stdin payload and never includes enrollToken in thrown error messages', async () => {
    const validStream = Readable.from([
      Buffer.from('{"serverUrl":"https://relay.example.com",'),
      Buffer.from('"enrollToken":"tok_chunked","ownerName":"My Desk"}'),
    ]);
    await expect(readEnrollmentBlobFromStdin(validStream)).resolves.toEqual({
      serverUrl: 'https://relay.example.com',
      enrollToken: 'tok_chunked',
      ownerName: 'My Desk',
    });

    const badStream = Readable.from([
      Buffer.from('{"serverUrl":"ftp://bad","enrollToken":"SECRET_NEVER_PRINT"}'),
    ]);
    await expect(readEnrollmentBlobFromStdin(badStream)).rejects.toSatisfy((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('invalid_serverUrl') && !msg.includes('SECRET_NEVER_PRINT');
    });

    const oversizedStream = Readable.from([
      Buffer.alloc(32, 0x61),
      Buffer.alloc(32, 0x61),
    ]);
    await expect(readEnrollmentBlobFromStdin(oversizedStream, 48)).rejects.toThrow(/maximum allowed size/);
  });
});

describe('bootstrapControlledNodeWithDisposition via stdin enrollment', () => {
  function createBootstrapFixture(
    dir: string,
    sourcePath: string,
    stagedPath: string,
    sourceBytes: Buffer,
    overrides: Partial<ControlledNodeBootstrapDeps> = {},
  ): {
    deps: ControlledNodeBootstrapDeps;
    state: {
      credential: ControlledNodeCredential | null;
      identity: PendingInstallIdentity | null;
      journal: InstallJournal;
    };
  } {
    const sha = createHash('sha256').update(sourceBytes).digest('hex');
    const identity: PendingInstallIdentity = {
      installId: 'inst-stdin-1',
      nodeToken: 'node-secret-tok',
      nodeTokenHash: createHash('sha256').update('node-secret-tok', 'utf8').digest('hex'),
      sourceExePath: sourcePath,
    };
    const serviceReceipt: ServiceReceipt = {
      name: 'imcodes-node',
      platform: 'linux',
      definitionPath: join(dir, 'imcodes-node.service'),
      definitionSha256: 'c'.repeat(64),
      action: stagedPath,
    };
    const state: {
      credential: ControlledNodeCredential | null;
      identity: PendingInstallIdentity | null;
      pendingReenrollment: PendingReenrollmentRecord | null;
      journal: InstallJournal;
    } = {
      credential: null,
      identity: null,
      pendingReenrollment: null,
      journal: { version: INSTALL_JOURNAL_VERSION, phase: 'uninstalled', updatedAt: 0 },
    };
    const journalPath = join(dir, 'install.json');

    const deps: ControlledNodeBootstrapDeps = {
      loadCredential: vi.fn(async () => state.credential),
      openVerifiedEnrollmentSource: vi.fn((path?: string) => openVerifiedEnrollmentSource(path ?? sourcePath)),
      loadInstallIdentity: vi.fn(async () => state.identity),
      persistInstallIdentity: vi.fn(async (next) => { state.identity = next; }),
      generateInstallIdentity: vi.fn(() => ({ ...identity })),
      redeemEnrollmentV2: vi.fn(async (blob) => ({
        serverId: 'srv-stdin-1',
        token: 'node-secret-tok',
        serverUrl: blob.serverUrl,
        nodeRole: 'controlled' as const,
        ...(blob.abiProfile ? { abiProfile: blob.abiProfile } : {}),
      })),
      persistCredential: vi.fn(async (cred) => { state.credential = cred; }),
      loadPendingReenrollment: vi.fn(async () => state.pendingReenrollment),
      persistPendingReenrollment: vi.fn(async (rec) => { state.pendingReenrollment = rec; }),
      removePendingReenrollment: vi.fn(async () => { state.pendingReenrollment = null; }),
      withProcessLock: (fn) => withBootstrapProcessLock(join(dir, 'cred.json'), fn),
      inspectStagedReceipt: (stagedExePath) => inspectExecutableReceipt(stagedExePath, sourcePath),
      resetEndpointState: vi.fn(async (next, prev) => {
        await resetEndpointStateForCredential(controlledNodeEndpointsPath(journalPath), prev, next);
      }),
      installDefinition: vi.fn(async () => serviceReceipt),
      inspectDefinition: vi.fn(async (r) => r),
      inspectServiceState: vi.fn(async () => ({
        installed: true,
        action: stagedPath,
        effectiveAction: stagedPath,
        loadedActionMatches: true,
        loaded: true,
        bootEnabled: true,
        principal: 'root',
        restartPolicy: 'on-failure',
        observedDefinitionSha256: serviceReceipt.definitionSha256 ?? null,
        definitionMatches: true,
        runState: 'running' as const,
        errors: [],
        raw: 'running',
      })),
      startService: vi.fn(async () => {}),
      verifyStagedExecutable: vi.fn(async () => {}),
      isStableRuntime: vi.fn(async () => false),
      assertElevated: vi.fn(async () => {}),
      ensureReleasePublisherTrust: vi.fn(async () => {}),
      inspectSourceArtifact: vi.fn(async () => ({ sha256: sha, size: sourceBytes.length })),
      prepareCredentialDir: vi.fn(async () => {}),
      loadInstallJournal: vi.fn(async () => state.journal),
      writeInstallPhase: vi.fn(async (path, phase, opts) => {
        state.journal = await writeInstallPhase(path, phase, opts);
        return state.journal;
      }),
      journalPath,
      credentialPath: join(dir, 'cred.json'),
      stagedExecutablePath: stagedPath,
      sourceExecutablePath: sourcePath,
      now: 1_700_000_000_000,
      warn: vi.fn(),
      ...overrides,
    };

    return { deps, state };
  }

  it('stages unmodified executable without requiring a trailer and completes enrollment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-bootstrap-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const sourceBytes = Buffer.from('#!/bin/sh\necho unmodified-binary\n');
      await writeFile(sourcePath, sourceBytes, { mode: 0o700 });

      const enrollmentBlob = {
        serverUrl: 'https://relay.example.com',
        enrollToken: 'enroll-stdin-tok',
        ownerName: 'Workstation',
      };
      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, sourceBytes, {
        enrollmentBlob,
      });

      const result = await bootstrapControlledNodeWithDisposition(deps);
      expect(result.disposition).toBe('handoff_complete');
      expect(result.credential?.serverId).toBe('srv-stdin-1');
      expect(await readFile(stagedPath)).toEqual(sourceBytes);
      expect(deps.redeemEnrollmentV2).toHaveBeenCalledWith(enrollmentBlob, expect.objectContaining({
        installId: 'inst-stdin-1',
      }));
      expect(state.journal.phase).toBe('service_start_requested');
      expect(state.journal.stagedReceipt?.size).toBe(sourceBytes.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restages unmodified executable on re-run when already enrolled and not stable runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-rerun-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const newBytes = Buffer.from('NEW_UNMODIFIED_BINARY_BYTES');
      await writeFile(sourcePath, newBytes, { mode: 0o700 });

      const enrollmentBlob = {
        serverUrl: 'https://relay.example.com',
        enrollToken: 'enroll-stdin-tok',
      };
      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-stdin-1',
        token: 'node-secret-tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const mockSource: VerifiedEnrollmentSource = {
        sourcePath,
        identity: { size: newBytes.length, mtimeMs: 1, ctimeMs: 1 },
        statSize: vi.fn(async () => newBytes.length),
        readExactly: vi.fn(async () => Buffer.alloc(0)),
        readEnrollmentBlobWithRange: vi.fn(async () => null),
        stageTrailerFreeExecutable: vi.fn(async (dest, size) => ({
          path: dest,
          size,
          sha256: createHash('sha256').update(newBytes).digest('hex'),
          sourceIdentity: { size: newBytes.length, mtimeMs: 1, ctimeMs: 1 },
          stagedIdentity: { size, mtimeMs: 2, ctimeMs: 2 },
        })),
        cleanupEnrollmentSource: vi.fn(async () => 'cleaned' as const),
        close: vi.fn(async () => {}),
      };
      const journalDir = mkdtempSync(join(tmpdir(), 'imcodes-stdin-journal-'));
      try {
        const journalPath = join(journalDir, 'install.json');
        let currentJournal = await writeInstallPhase(journalPath, 'elevated', { now: 1_700_000_000_000 });
        currentJournal = await writeInstallPhase(journalPath, 'credential_prepared', {
          now: 1_700_000_000_001,
          previous: currentJournal,
          installId: 'inst-stdin-1',
          nodeTokenHash: 'b'.repeat(64),
          sourceExePath: sourcePath,
        });
        currentJournal = await writeInstallPhase(journalPath, 'files_staged', {
          now: 1_700_000_000_002,
          previous: currentJournal,
          stagedExePath: stagedPath,
          stagedReceipt: {
            path: stagedPath,
            size: 10,
            sha256: '0'.repeat(64),
            sourceIdentity: { size: 10, mtimeMs: 1, ctimeMs: 1 },
            stagedIdentity: { size: 10, mtimeMs: 1, ctimeMs: 1 },
          },
          sourceExePath: sourcePath,
        });
        currentJournal = await writeInstallPhase(journalPath, 'enrolled', {
          now: 1_700_000_000_003,
          previous: currentJournal,
          installId: 'inst-stdin-1',
          nodeTokenHash: 'b'.repeat(64),
          serverId: existingCred.serverId,
          stagedExePath: stagedPath,
          sourceExePath: sourcePath,
        });
        const { deps } = createBootstrapFixture(dir, sourcePath, stagedPath, newBytes, {
          now: 1_700_000_000_004,
          enrollmentBlob,
          loadCredential: vi.fn(async () => existingCred),
          openVerifiedEnrollmentSource: vi.fn(async () => mockSource),
          loadInstallJournal: vi.fn(async () => currentJournal),
          journalPath,
          writeInstallPhase: vi.fn(async (path, phase, opts) => {
            currentJournal = await writeInstallPhase(path, phase, opts);
            return currentJournal;
          }),
        });

        const result = await bootstrapControlledNodeWithDisposition(deps);
        expect(result.disposition).toBe('handoff_complete');
        expect(mockSource.stageTrailerFreeExecutable).toHaveBeenCalledWith(stagedPath, newBytes.length, undefined);
      } finally {
        await rm(journalDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects stdin enrollment when blob abiProfile mismatches executable abiProfile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-abi-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const bytes = Buffer.from('BINARY');
      await writeFile(sourcePath, bytes, { mode: 0o700 });
      const { deps } = createBootstrapFixture(dir, sourcePath, stagedPath, bytes, {
        abiProfile: CONTROLLED_NODE_ABI_MODERN,
        enrollmentBlob: {
          serverUrl: 'https://relay.example.com',
          enrollToken: 'enroll-stdin-tok',
          abiProfile: CONTROLLED_NODE_ABI_GLIBC217,
        },
      });
      await expect(bootstrapControlledNodeWithDisposition(deps)).rejects.toThrow(/ABI profile/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function seedHealthyInstallation(dir: string, sourcePath: string, stagedPath: string, oldBytes: Buffer) {
    const journalPath = join(dir, 'install.json');
    const oldSha = createHash('sha256').update(oldBytes).digest('hex');
    let j = await writeInstallPhase(journalPath, 'elevated', { now: 1_700_000_000_000 });
    j = await writeInstallPhase(journalPath, 'credential_prepared', {
      now: 1_700_000_000_001,
      previous: j,
      installId: 'inst-old',
      nodeTokenHash: 'b'.repeat(64),
      sourceExePath: join(dir, 'old-installer'),
      sourceArtifact: { sha256: oldSha, size: oldBytes.length },
    });
    j = await writeInstallPhase(journalPath, 'files_staged', {
      now: 1_700_000_000_002,
      previous: j,
      stagedExePath: stagedPath,
      stagedReceipt: {
        path: stagedPath,
        size: oldBytes.length,
        sha256: oldSha,
        sourceIdentity: { size: oldBytes.length, mtimeMs: 1, ctimeMs: 1 },
        stagedIdentity: { size: oldBytes.length, mtimeMs: 1, ctimeMs: 1 },
      },
    });
    j = await writeInstallPhase(journalPath, 'enrolled', {
      now: 1_700_000_000_003,
      previous: j,
      serverId: 'srv-old',
      cleanupStatus: 'skipped',
    });
    const receipt: ServiceReceipt = {
      name: 'imcodes-node',
      platform: 'linux',
      definitionPath: join(dir, 'imcodes-node.service'),
      definitionSha256: 'c'.repeat(64),
      action: stagedPath,
    };
    j = await writeInstallPhase(journalPath, 'service_registered', {
      now: 1_700_000_000_004,
      previous: j,
      serviceName: 'imcodes-node',
      serviceReceipt: receipt,
    });
    j = await writeInstallPhase(journalPath, 'service_start_requested', {
      now: 1_700_000_000_005,
      previous: j,
      serviceStartRequestedAt: 1_700_000_000_005,
    });
    j = await writeInstallPhase(journalPath, 'service_healthy', {
      now: 1_700_000_000_006,
      previous: j,
      healthyAt: 1_700_000_000_006,
    });
    return { journalPath, journal: j };
  }

  it('re-enrolls with fresh identity when existing credential probes revoked on server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-revoked-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node-v2');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const oldBytes = Buffer.from('OLD_BINARY_BYTES');
      const newBytes = Buffer.from('NEW_REINSTALL_BINARY_BYTES');
      await writeFile(sourcePath, newBytes, { mode: 0o700 });

      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, stagedPath, oldBytes);
      let currentJournal = initialJournal;

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        nodeId: '3225331642',
        token: 'old-revoked-tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const oldIdentity: PendingInstallIdentity = {
        installId: 'inst-old',
        nodeToken: 'old-revoked-tok',
        nodeTokenHash: 'b'.repeat(64),
        sourceExePath: join(dir, 'old-installer'),
      };
      const newIdentity: PendingInstallIdentity = {
        installId: 'inst-new-2',
        nodeToken: 'new-secret-tok-2',
        nodeTokenHash: 'd'.repeat(64),
        sourceExePath: sourcePath,
      };
      const newCred: ControlledNodeCredential = {
        serverId: 'srv-new-2',
        nodeId: '9988776655',
        token: 'new-secret-tok-2',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const enrollmentBlob = {
        serverUrl: 'https://relay.example.com',
        enrollToken: 'enroll-fresh-tok',
      };
      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, newBytes, {
        now: 1_700_000_001_000,
        enrollmentBlob,
        journalPath,
        loadCredential: vi.fn(async () => state.credential),
        loadInstallIdentity: vi.fn(async () => state.identity),
        generateInstallIdentity: vi.fn(() => ({ ...newIdentity })),
        redeemEnrollmentV2: vi.fn(async () => newCred),
        probeExistingCredential: vi.fn(async () => 'revoked' as const),
        loadInstallJournal: vi.fn(async () => currentJournal),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          currentJournal = await writeInstallPhase(p, phase, opts);
          state.journal = currentJournal;
          return currentJournal;
        }),
      });
      state.credential = existingCred;
      state.identity = oldIdentity;
      state.journal = initialJournal;

      const result = await bootstrapControlledNodeWithDisposition(deps);
      expect(result.disposition).toBe('handoff_complete');
      expect(result.credential).toEqual(newCred);
      expect(state.credential).toEqual(newCred);
      expect(state.identity).toEqual(newIdentity);
      expect(deps.probeExistingCredential).toHaveBeenCalledWith(existingCred);
      expect(deps.redeemEnrollmentV2).toHaveBeenCalledWith(enrollmentBlob, newIdentity);
      expect(deps.persistInstallIdentity).toHaveBeenCalledWith(newIdentity);
      expect(deps.persistCredential).toHaveBeenCalledWith(newCred);
      expect(state.journal.phase).toBe('service_healthy');
      expect(state.journal.installId).toBe('inst-new-2');
      expect(state.journal.nodeTokenHash).toBe('d'.repeat(64));
      expect(state.journal.serverId).toBe('srv-new-2');
      expect(state.journal.stagedReceipt?.size).toBe(newBytes.length);
      expect(deps.startService).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['valid', 'unknown'] as const)('preserves existing credential when probe returns %s', async (probeStatus) => {
    const dir = await mkdtemp(join(tmpdir(), `imcodes-stdin-${probeStatus}-`));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node-v2');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const oldBytes = Buffer.from('OLD_BINARY_BYTES');
      const newBytes = Buffer.from('NEW_BINARY_BYTES');
      await writeFile(sourcePath, newBytes, { mode: 0o700 });

      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, stagedPath, oldBytes);
      let currentJournal = initialJournal;

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        nodeId: '3225331642',
        token: 'still-valid-tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const enrollmentBlob = {
        serverUrl: 'https://relay.example.com',
        enrollToken: 'enroll-unused-tok',
      };
      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, newBytes, {
        now: 1_700_000_001_000,
        enrollmentBlob,
        journalPath,
        loadCredential: vi.fn(async () => state.credential),
        probeExistingCredential: vi.fn(async () => probeStatus),
        loadInstallJournal: vi.fn(async () => currentJournal),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          currentJournal = await writeInstallPhase(p, phase, opts);
          state.journal = currentJournal;
          return currentJournal;
        }),
      });
      state.credential = existingCred;
      state.journal = initialJournal;

      const result = await bootstrapControlledNodeWithDisposition(deps);
      expect(result.disposition).toBe('handoff_complete');
      expect(result.credential).toEqual(existingCred);
      expect(deps.probeExistingCredential).toHaveBeenCalledWith(existingCred);
      expect(deps.generateInstallIdentity).not.toHaveBeenCalled();
      expect(deps.persistInstallIdentity).not.toHaveBeenCalled();
      expect(deps.redeemEnrollmentV2).not.toHaveBeenCalled();
      expect(deps.persistCredential).not.toHaveBeenCalled();
      expect(state.journal.serverId).toBe('srv-old');
      expect(state.journal.stagedReceipt?.size).toBe(newBytes.length);
      expect(deps.startService).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-enrolls onto a new server when enrollment blob targets a different serverUrl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-new-server-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const bytes = Buffer.from('BINARY_BYTES');
      await writeFile(sourcePath, bytes, { mode: 0o700 });

      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, stagedPath, bytes);
      let currentJournal = initialJournal;

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-tok',
        serverUrl: 'https://old-relay.example.com',
        nodeRole: 'controlled',
      };
      const newCred: ControlledNodeCredential = {
        serverId: 'srv-other',
        nodeId: '1122334455',
        token: 'node-secret-tok',
        serverUrl: 'https://new-relay.example.com',
        nodeRole: 'controlled',
      };
      const enrollmentBlob = {
        serverUrl: 'https://new-relay.example.com',
        enrollToken: 'enroll-new-server',
      };
      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, bytes, {
        now: 1_700_000_001_000,
        enrollmentBlob,
        journalPath,
        loadCredential: vi.fn(async () => state.credential),
        probeExistingCredential: vi.fn(async () => 'valid' as const),
        redeemEnrollmentV2: vi.fn(async () => newCred),
        loadInstallJournal: vi.fn(async () => currentJournal),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          currentJournal = await writeInstallPhase(p, phase, opts);
          state.journal = currentJournal;
          return currentJournal;
        }),
      });
      state.credential = existingCred;
      state.journal = initialJournal;

      const result = await bootstrapControlledNodeWithDisposition(deps);
      expect(result.disposition).toBe('handoff_complete');
      expect(result.credential).toEqual(newCred);
      expect(deps.redeemEnrollmentV2).toHaveBeenCalledTimes(1);
      expect(state.journal.serverId).toBe('srv-other');
      expect(deps.startService).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves existing credential, identity, and journal intact when re-enrollment redeem fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-redeem-fail-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const bytes = Buffer.from('BINARY_BYTES');
      await writeFile(sourcePath, bytes, { mode: 0o700 });

      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, stagedPath, bytes);
      let currentJournal = initialJournal;

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-revoked-tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const oldIdentity: PendingInstallIdentity = {
        installId: 'inst-old',
        nodeToken: 'old-revoked-tok',
        nodeTokenHash: 'b'.repeat(64),
        sourceExePath: join(dir, 'old-installer'),
      };
      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, bytes, {
        now: 1_700_000_001_000,
        enrollmentBlob: { serverUrl: 'https://relay.example.com', enrollToken: 'expired-tok' },
        journalPath,
        loadCredential: vi.fn(async () => state.credential),
        loadInstallIdentity: vi.fn(async () => state.identity),
        probeExistingCredential: vi.fn(async () => 'revoked' as const),
        redeemEnrollmentV2: vi.fn(async () => {
          throw new Error('enrollment_redeem_failed:410');
        }),
        loadInstallJournal: vi.fn(async () => currentJournal),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          currentJournal = await writeInstallPhase(p, phase, opts);
          state.journal = currentJournal;
          return currentJournal;
        }),
      });
      state.credential = existingCred;
      state.identity = oldIdentity;
      state.journal = initialJournal;

      await expect(bootstrapControlledNodeWithDisposition(deps)).rejects.toThrow(/enrollment_redeem_failed:410/);
      expect(deps.persistInstallIdentity).not.toHaveBeenCalled();
      expect(deps.persistCredential).not.toHaveBeenCalled();
      expect(state.credential).toEqual(existingCred);
      expect(state.identity).toEqual(oldIdentity);
      expect(state.journal.serverId).toBe('srv-old');
      expect(state.journal.installId).toBe('inst-old');
      expect(deps.startService).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never probes server or re-enrolls during stable runtime startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-stable-'));
    try {
      const sourcePath = join(dir, 'staged', 'imcodes-node');
      const bytes = Buffer.from('BINARY_BYTES');
      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, sourcePath, bytes);
      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const { deps } = createBootstrapFixture(dir, sourcePath, sourcePath, bytes, {
        journalPath,
        isStableRuntime: vi.fn(async () => true),
        loadCredential: vi.fn(async () => existingCred),
        loadInstallJournal: vi.fn(async () => initialJournal),
        probeExistingCredential: vi.fn(async () => 'revoked' as const),
      });

      const result = await bootstrapControlledNodeWithDisposition(deps);
      expect(result.disposition).toBe('run_runtime');
      expect(result.credential).toEqual(existingCred);
      expect(deps.probeExistingCredential).not.toHaveBeenCalled();
      expect(deps.redeemEnrollmentV2).not.toHaveBeenCalled();
      expect(deps.startService).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves formal staged executable and stable runtime health when cross-server redeem fails with different installer bytes (P0-1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-preserve-bin-'));
    try {
      const oldSourcePath = join(dir, 'old-installer');
      const newSourcePath = join(dir, 'new-installer');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const oldBytes = Buffer.from('#!/bin/sh\necho OLD_HEALTHY_BINARY_BYTES\n');
      const newBytes = Buffer.from('#!/bin/sh\necho DIFFERENT_NEW_BINARY_BYTES_LONGER\n');
      await writeFile(oldSourcePath, oldBytes, { mode: 0o700 });
      await writeFile(newSourcePath, newBytes, { mode: 0o700 });
      const opened = await openVerifiedEnrollmentSource(oldSourcePath);
      const oldStagedReceipt = await opened.stageTrailerFreeExecutable(stagedPath, oldBytes.length);
      await opened.close();

      const oldSha = createHash('sha256').update(oldBytes).digest('hex');
      const journalPath = join(dir, 'install.json');
      let j = await writeInstallPhase(journalPath, 'elevated', { now: 1_700_000_000_000 });
      j = await writeInstallPhase(journalPath, 'credential_prepared', {
        now: 1_700_000_000_001,
        previous: j,
        installId: 'inst-old',
        nodeTokenHash: 'b'.repeat(64),
        sourceExePath: oldSourcePath,
        sourceArtifact: { sha256: oldSha, size: oldBytes.length },
      });
      j = await writeInstallPhase(journalPath, 'files_staged', {
        now: 1_700_000_000_002,
        previous: j,
        stagedExePath: stagedPath,
        stagedReceipt: oldStagedReceipt,
      });
      j = await writeInstallPhase(journalPath, 'enrolled', {
        now: 1_700_000_000_003,
        previous: j,
        serverId: 'srv-old',
        cleanupStatus: 'skipped',
      });
      j = await writeInstallPhase(journalPath, 'service_registered', {
        now: 1_700_000_000_004,
        previous: j,
        serviceName: 'imcodes-node',
        serviceReceipt: { name: 'imcodes-node', platform: 'linux', action: stagedPath },
      });
      j = await writeInstallPhase(journalPath, 'service_start_requested', {
        now: 1_700_000_000_005,
        previous: j,
        serviceStartRequestedAt: 1_700_000_000_005,
      });
      j = await writeInstallPhase(journalPath, 'service_healthy', {
        now: 1_700_000_000_006,
        previous: j,
        healthyAt: 1_700_000_000_006,
      });

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-healthy-tok',
        serverUrl: 'https://old-relay.example.com',
        nodeRole: 'controlled',
      };
      const pendingPath = join(dir, 'pending-reenrollment.json');
      const { deps, state } = createBootstrapFixture(dir, newSourcePath, stagedPath, newBytes, {
        now: 1_700_000_001_000,
        enrollmentBlob: { serverUrl: 'https://new-relay.example.com', enrollToken: 'expired-tok' },
        journalPath,
        loadCredential: vi.fn(async () => state.credential),
        loadPendingReenrollment: () => loadPendingReenrollment(pendingPath),
        persistPendingReenrollment: (rec) => persistPendingReenrollment(rec, pendingPath),
        removePendingReenrollment: () => removePendingReenrollment(pendingPath),
        redeemEnrollmentV2: vi.fn(async () => {
          throw new Error('enrollment_redeem_failed:410');
        }),
        loadInstallJournal: vi.fn(async () => j),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          j = await writeInstallPhase(p, phase, opts);
          state.journal = j;
          return j;
        }),
      });
      state.credential = existingCred;
      state.journal = j;

      await expect(bootstrapControlledNodeWithDisposition(deps)).rejects.toThrow(/enrollment_redeem_failed:410/);
      // Formal executable and receipt remain untouched and stable!
      expect(await readFile(stagedPath)).toEqual(oldBytes);
      await expect(isCurrentExecutableStable(j, stagedPath)).resolves.toBe(true);

      // Subsequent real stable runtime startup stays on run_runtime and does NOT restart itself.
      const stableStartService = vi.fn(async () => {});
      const stableRes = await bootstrapControlledNodeWithDisposition({
        ...deps,
        enrollmentBlob: undefined,
        sourceExecutablePath: stagedPath,
        isStableRuntime: (cur) => isCurrentExecutableStable(cur, stagedPath),
        startService: stableStartService,
      });
      expect(stableRes.disposition).toBe('run_runtime');
      expect(stableRes.credential).toEqual(existingCred);
      expect(stableStartService).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses durable pending re-enrollment identity on retry after lost HTTP response and completes journal commit after credential-only crash (P0-2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-pending-retry-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node-v2');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const oldBytes = Buffer.from('OLD_BYTES');
      const newBytes = Buffer.from('NEW_BYTES_V2');
      await writeFile(sourcePath, newBytes, { mode: 0o700 });

      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, stagedPath, oldBytes);
      let currentJournal = initialJournal;
      const pendingPath = join(dir, 'pending-reenrollment.json');

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-revoked-tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const oldIdentity: PendingInstallIdentity = {
        installId: 'inst-old',
        nodeToken: 'old-revoked-tok',
        nodeTokenHash: 'b'.repeat(64),
        sourceExePath: join(dir, 'old-installer'),
      };
      let genCount = 0;
      const redeemedIdentities: Array<{ installId: string; nodeTokenHash: string }> = [];
      let simulateLostHttp = true;
      let simulateJournalWriteCrash = true;
      let expectedCred!: ControlledNodeCredential;

      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, newBytes, {
        now: 1_700_000_001_000,
        enrollmentBlob: { serverUrl: 'https://relay.example.com', enrollToken: 'single-use-tok' },
        journalPath,
        loadCredential: vi.fn(async () => state.credential),
        loadInstallIdentity: vi.fn(async () => state.identity),
        loadPendingReenrollment: () => loadPendingReenrollment(pendingPath),
        persistPendingReenrollment: (rec) => persistPendingReenrollment(rec, pendingPath),
        removePendingReenrollment: () => removePendingReenrollment(pendingPath),
        probeExistingCredential: vi.fn(async (cred) => (cred.serverId === 'srv-old' ? 'revoked' : 'valid')),
        generateInstallIdentity: vi.fn(() => {
          genCount += 1;
          return {
            installId: `inst-gen-${genCount}`,
            nodeToken: `tok-gen-${genCount}`,
            nodeTokenHash: createHash('sha256').update(`tok-gen-${genCount}`, 'utf8').digest('hex'),
            sourceExePath: sourcePath,
          };
        }),
        redeemEnrollmentV2: vi.fn(async (blob, id) => {
          redeemedIdentities.push({ installId: id.installId, nodeTokenHash: id.nodeTokenHash });
          expectedCred = {
            serverId: 'srv-idempotent-1',
            nodeId: '1234567890',
            token: id.nodeToken,
            serverUrl: blob.serverUrl,
            nodeRole: 'controlled',
          };
          if (simulateLostHttp) {
            simulateLostHttp = false;
            throw new Error('network_timeout_after_server_commit');
          }
          return expectedCred;
        }),
        loadInstallJournal: vi.fn(async () => currentJournal),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          if (simulateJournalWriteCrash) {
            simulateJournalWriteCrash = false;
            throw new Error('simulated_disk_fail_after_credential_persist');
          }
          currentJournal = await writeInstallPhase(p, phase, opts);
          state.journal = currentJournal;
          return currentJournal;
        }),
      });
      state.credential = existingCred;
      state.identity = oldIdentity;
      state.journal = initialJournal;

      // Attempt 1: server commits, HTTP response lost -> pending-reenrollment.json stays on disk, credential/journal untouched.
      await expect(bootstrapControlledNodeWithDisposition(deps)).rejects.toThrow(/network_timeout_after_server_commit/);
      const savedPending = await loadPendingReenrollment(pendingPath);
      expect(savedPending?.identity.installId).toBe('inst-gen-1');
      expect(savedPending?.redeemedCredential).toBeUndefined();
      expect(state.credential).toEqual(existingCred);

      // Attempt 2: retries with EXACT SAME installId/nodeTokenHash, receives credential, persists credential, then crashes before journal write!
      await expect(bootstrapControlledNodeWithDisposition(deps)).rejects.toThrow(/simulated_disk_fail_after_credential_persist/);
      expect(genCount).toBe(1);
      expect(redeemedIdentities).toEqual([
        { installId: 'inst-gen-1', nodeTokenHash: savedPending!.identity.nodeTokenHash },
        { installId: 'inst-gen-1', nodeTokenHash: savedPending!.identity.nodeTokenHash },
      ]);
      // Credential is now newCred (probing 'valid'!), yet journal STILL has 'srv-old' and pending still has redeemedCredential.
      expect(state.credential).toEqual(expectedCred);
      expect(currentJournal.serverId).toBe('srv-old');
      const committedPending = await loadPendingReenrollment(pendingPath);
      expect(committedPending?.redeemedCredential).toEqual(expectedCred);

      // Attempt 3: finishes committing journal rotation WITHOUT re-redeeming or calling probe, removes pending file, restarts service.
      const res3 = await bootstrapControlledNodeWithDisposition(deps);
      expect(res3.disposition).toBe('handoff_complete');
      expect(res3.credential).toEqual(expectedCred);
      expect(redeemedIdentities).toHaveLength(2);
      expect(currentJournal.serverId).toBe('srv-idempotent-1');
      expect(currentJournal.installId).toBe('inst-gen-1');
      expect(currentJournal.nodeTokenHash).toBe(savedPending!.identity.nodeTokenHash);
      expect(await loadPendingReenrollment(pendingPath)).toBeNull();
      expect(deps.startService).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent bootstrap invocations and isolates old relay endpoints on retarget (P0-2 + P0-3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-concurrent-endpoints-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const bytes = Buffer.from('BINARY_BYTES');
      await writeFile(sourcePath, bytes, { mode: 0o700 });

      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, stagedPath, bytes);
      let currentJournal = initialJournal;
      const endpointsPath = controlledNodeEndpointsPath(journalPath);
      await writeEndpointState(endpointsPath, {
        ...emptyEndpointState(),
        serverId: 'srv-old',
        primaryOrigin: 'https://old-relay.example.com',
        pinned: ['https://old-pin.example.com'],
        advertised: ['https://old-alt.example.com'],
        lastGood: 'https://old-alt.example.com',
        dropped: { 'https://old-drop.example.com': 9_999_999_999_999 },
      });

      const oldRuntimeSelector = await createRuntimeEndpointSelector(endpointsPath, {
        serverId: 'srv-old',
        serverUrl: 'https://old-relay.example.com',
      });
      expect(oldRuntimeSelector.current()).toBe('https://old-alt.example.com');

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-tok',
        serverUrl: 'https://old-relay.example.com',
        nodeRole: 'controlled',
      };
      const newCred: ControlledNodeCredential = {
        serverId: 'srv-new',
        nodeId: '2233445566',
        token: 'node-secret-tok',
        serverUrl: 'https://new-relay.example.com',
        nodeRole: 'controlled',
      };

      const callOrder: string[] = [];
      let releaseRedeem!: () => void;
      const redeemGate = new Promise<void>((r) => { releaseRedeem = r; });
      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, bytes, {
        now: 1_700_000_001_000,
        enrollmentBlob: { serverUrl: 'https://new-relay.example.com', enrollToken: 'retarget-tok' },
        journalPath,
        loadCredential: vi.fn(async () => state.credential),
        probeExistingCredential: vi.fn(async (cred) => (cred.serverId === 'srv-new' ? 'valid' : 'revoked')),
        redeemEnrollmentV2: vi.fn(async () => {
          callOrder.push('redeem');
          await redeemGate;
          return newCred;
        }),
        resetEndpointState: vi.fn(async (next, prev) => {
          callOrder.push('resetEndpoints');
          await resetEndpointStateForCredential(endpointsPath, prev, next);
        }),
        persistCredential: vi.fn(async (cred) => {
          callOrder.push('persistCredential');
          state.credential = cred;
        }),
        loadInstallJournal: vi.fn(async () => currentJournal),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          currentJournal = await writeInstallPhase(p, phase, opts);
          state.journal = currentJournal;
          return currentJournal;
        }),
      });
      state.credential = existingCred;
      state.journal = initialJournal;

      const p1 = bootstrapControlledNodeWithDisposition(deps);
      const p2 = bootstrapControlledNodeWithDisposition(deps);
      await new Promise((r) => setTimeout(r, 15));
      releaseRedeem();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.credential).toEqual(newCred);
      expect(r2.credential).toEqual(newCred);
      expect(deps.redeemEnrollmentV2).toHaveBeenCalledTimes(1);
      expect(callOrder.indexOf('resetEndpoints')).toBeLessThan(callOrder.indexOf('persistCredential'));

      // Late write by still-in-memory old runtime cannot re-activate old lastGood/advertised/dropped.
      oldRuntimeSelector.setAdvertised(['https://old-alt.example.com']);
      oldRuntimeSelector.recordSuccess();
      await new Promise((r) => setTimeout(r, 20));
      expect(await readEndpointState(endpointsPath)).toEqual({
        ...emptyEndpointState(),
        serverId: 'srv-new',
        primaryOrigin: 'https://new-relay.example.com',
      });

      const newRuntimeSelector = await createRuntimeEndpointSelector(endpointsPath, newCred);
      expect(newRuntimeSelector.current()).toBe('https://new-relay.example.com');
      expect(newRuntimeSelector.candidates()).toEqual(['https://new-relay.example.com']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('completes pending commit without startService when formal service restarts after binary overwrite BEFORE persistCredential (P0-1 crash point 1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-formal-crash-cred-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node-v2');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const oldBytes = Buffer.from('OLD_FORMAL_BINARY');
      const newBytes = Buffer.from('NEW_FORMAL_BINARY_V2');
      await writeFile(sourcePath, newBytes, { mode: 0o700 });

      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, stagedPath, oldBytes);
      let currentJournal = initialJournal;
      const pendingPath = join(dir, 'pending-reenrollment.json');
      const credPath = join(dir, 'cred.json');

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-revoked-tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const newCred: ControlledNodeCredential = {
        serverId: 'srv-new-1',
        nodeId: '3344556677',
        token: 'new-tok-1',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const generatedIdentity: PendingInstallIdentity = {
        installId: 'inst-new-1',
        nodeToken: 'new-tok-1',
        nodeTokenHash: createHash('sha256').update('new-tok-1', 'utf8').digest('hex'),
        sourceExePath: sourcePath,
      };
      let failPersistCred = true;

      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, newBytes, {
        now: 1_700_000_001_000,
        enrollmentBlob: { serverUrl: 'https://relay.example.com', enrollToken: 'tok-crash-1' },
        journalPath,
        credentialPath: credPath,
        loadCredential: vi.fn(async () => state.credential),
        persistCredential: vi.fn(async (cred) => {
          if (failPersistCred) {
            failPersistCred = false;
            throw new Error('simulated_crash_after_binary_overwrite_before_cred');
          }
          state.credential = cred;
        }),
        loadInstallIdentity: vi.fn(async () => state.identity),
        loadPendingReenrollment: () => loadPendingReenrollment(pendingPath),
        persistPendingReenrollment: (rec) => persistPendingReenrollment(rec, pendingPath),
        removePendingReenrollment: () => removePendingReenrollment(pendingPath),
        probeExistingCredential: vi.fn(async () => 'revoked' as const),
        generateInstallIdentity: vi.fn(() => ({ ...generatedIdentity })),
        redeemEnrollmentV2: vi.fn(async () => newCred),
        loadInstallJournal: vi.fn(async () => currentJournal),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          currentJournal = await writeInstallPhase(p, phase, opts);
          state.journal = currentJournal;
          return currentJournal;
        }),
      });
      state.credential = existingCred;
      state.journal = initialJournal;

      // Attempt 1 overwrites stagedPath with newBytes, then crashes BEFORE persistCredential.
      await expect(bootstrapControlledNodeWithDisposition(deps)).rejects.toThrow(/simulated_crash_after_binary_overwrite_before_cred/);
      expect(await readFile(stagedPath)).toEqual(newBytes);
      expect(state.credential).toEqual(existingCred);
      await expect(isCurrentExecutableStable(currentJournal, stagedPath)).resolves.toBe(false);
      const savedPending = await loadPendingReenrollment(pendingPath);
      expect(savedPending?.redeemedCredential).toEqual(newCred);
      expect(savedPending?.stagedReceipt?.sha256).toBe(createHash('sha256').update(newBytes).digest('hex'));

      // Systemd starts formal stagedPath with NO enrollment blob -> recovers cleanly without startService or re-redeem!
      const serviceStartMock = vi.fn(async () => {});
      const serviceRes = await bootstrapControlledNodeWithDisposition({
        ...deps,
        enrollmentBlob: undefined,
        sourceExecutablePath: stagedPath,
        isStableRuntime: (cur) => isCurrentExecutableStable(cur, stagedPath),
        inspectStagedReceipt: (p) => inspectExecutableReceipt(p, stagedPath),
        startService: serviceStartMock,
      });
      expect(serviceRes.disposition).toBe('run_runtime');
      expect(serviceRes.credential).toEqual(newCred);
      expect(serviceStartMock).not.toHaveBeenCalled();
      expect(deps.redeemEnrollmentV2).toHaveBeenCalledTimes(1);
      expect(currentJournal.serverId).toBe('srv-new-1');
      expect(currentJournal.stagedReceipt?.sha256).toBe(createHash('sha256').update(newBytes).digest('hex'));
      expect(await loadPendingReenrollment(pendingPath)).toBeNull();
      await expect(isCurrentExecutableStable(currentJournal, stagedPath)).resolves.toBe(true);

      // Next restart stays on healthy stable runtime directly.
      const nextRes = await bootstrapControlledNodeWithDisposition({
        ...deps,
        enrollmentBlob: undefined,
        sourceExecutablePath: stagedPath,
        isStableRuntime: (cur) => isCurrentExecutableStable(cur, stagedPath),
        startService: serviceStartMock,
      });
      expect(nextRes.disposition).toBe('run_runtime');
      expect(nextRes.credential).toEqual(newCred);
      expect(serviceStartMock).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates journal.stagedReceipt and omits startService when formal service restarts after persistCredential BEFORE journal commit (P0-1 crash point 2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-formal-crash-journal-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node-v2');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const oldBytes = Buffer.from('OLD_FORMAL_BINARY_2');
      const newBytes = Buffer.from('NEW_FORMAL_BINARY_2');
      await writeFile(sourcePath, newBytes, { mode: 0o700 });

      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, stagedPath, oldBytes);
      let currentJournal = initialJournal;
      const pendingPath = join(dir, 'pending-reenrollment.json');
      const credPath = join(dir, 'cred.json');

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-revoked-tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const newCred: ControlledNodeCredential = {
        serverId: 'srv-new-2',
        nodeId: '4455667788',
        token: 'new-tok-2',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const generatedIdentity: PendingInstallIdentity = {
        installId: 'inst-new-2',
        nodeToken: 'new-tok-2',
        nodeTokenHash: createHash('sha256').update('new-tok-2', 'utf8').digest('hex'),
        sourceExePath: sourcePath,
      };
      let failJournalWrite = true;

      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, newBytes, {
        now: 1_700_000_001_000,
        enrollmentBlob: { serverUrl: 'https://relay.example.com', enrollToken: 'tok-crash-2' },
        journalPath,
        credentialPath: credPath,
        loadCredential: vi.fn(async () => state.credential),
        loadInstallIdentity: vi.fn(async () => state.identity),
        loadPendingReenrollment: () => loadPendingReenrollment(pendingPath),
        persistPendingReenrollment: (rec) => persistPendingReenrollment(rec, pendingPath),
        removePendingReenrollment: () => removePendingReenrollment(pendingPath),
        probeExistingCredential: vi.fn(async () => 'revoked' as const),
        generateInstallIdentity: vi.fn(() => ({ ...generatedIdentity })),
        redeemEnrollmentV2: vi.fn(async () => newCred),
        loadInstallJournal: vi.fn(async () => currentJournal),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          if (failJournalWrite) {
            failJournalWrite = false;
            throw new Error('simulated_crash_after_persistCred_before_journal');
          }
          currentJournal = await writeInstallPhase(p, phase, opts);
          state.journal = currentJournal;
          return currentJournal;
        }),
      });
      state.credential = existingCred;
      state.journal = initialJournal;

      // Attempt 1 writes newBytes and newCred, then crashes right before journal rotation.
      await expect(bootstrapControlledNodeWithDisposition(deps)).rejects.toThrow(/simulated_crash_after_persistCred_before_journal/);
      expect(state.credential).toEqual(newCred);
      expect(currentJournal.serverId).toBe('srv-old');
      await expect(isCurrentExecutableStable(currentJournal, stagedPath)).resolves.toBe(false);

      // Service restarts at formal stagedPath with NO enrollment blob.
      const serviceStartMock = vi.fn(async () => {});
      const serviceRes = await bootstrapControlledNodeWithDisposition({
        ...deps,
        enrollmentBlob: undefined,
        sourceExecutablePath: stagedPath,
        isStableRuntime: (cur) => isCurrentExecutableStable(cur, stagedPath),
        inspectStagedReceipt: (p) => inspectExecutableReceipt(p, stagedPath),
        startService: serviceStartMock,
      });
      expect(serviceRes.disposition).toBe('run_runtime');
      expect(serviceRes.credential).toEqual(newCred);
      expect(serviceStartMock).not.toHaveBeenCalled();
      expect(currentJournal.serverId).toBe('srv-new-2');
      expect(currentJournal.stagedReceipt?.sha256).toBe(createHash('sha256').update(newBytes).digest('hex'));
      expect(await loadPendingReenrollment(pendingPath)).toBeNull();
      await expect(isCurrentExecutableStable(currentJournal, stagedPath)).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('commits already-redeemed pending credential when UI re-click issues a brand-new ticket without double-redeeming (P0-1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-ui-new-ticket-'));
    try {
      const sourcePath = join(dir, 'downloaded-imcodes-node');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const oldBytes = Buffer.from('OLD_BYTES');
      const newBytes = Buffer.from('NEW_BYTES');
      await writeFile(sourcePath, newBytes, { mode: 0o700 });

      const { journalPath, journal: initialJournal } = await seedHealthyInstallation(dir, sourcePath, stagedPath, oldBytes);
      let currentJournal = initialJournal;
      const pendingPath = join(dir, 'pending-reenrollment.json');

      const existingCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-revoked-tok',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const newCred: ControlledNodeCredential = {
        serverId: 'srv-new-ui-1',
        nodeId: '5566778899',
        token: 'new-tok-ui-1',
        serverUrl: 'https://relay.example.com',
        nodeRole: 'controlled',
      };
      const generatedIdentity: PendingInstallIdentity = {
        installId: 'inst-ui-1',
        nodeToken: 'new-tok-ui-1',
        nodeTokenHash: createHash('sha256').update('new-tok-ui-1', 'utf8').digest('hex'),
        sourceExePath: sourcePath,
      };
      let failPersistCred = true;

      const { deps, state } = createBootstrapFixture(dir, sourcePath, stagedPath, newBytes, {
        now: 1_700_000_001_000,
        enrollmentBlob: { serverUrl: 'https://relay.example.com', enrollToken: 'ticket-1-from-ui' },
        journalPath,
        credentialPath: join(dir, 'cred.json'),
        loadCredential: vi.fn(async () => state.credential),
        persistCredential: vi.fn(async (cred) => {
          if (failPersistCred) {
            failPersistCred = false;
            throw new Error('simulated_crash_before_cred_overwrite');
          }
          state.credential = cred;
        }),
        loadInstallIdentity: vi.fn(async () => state.identity),
        loadPendingReenrollment: () => loadPendingReenrollment(pendingPath),
        persistPendingReenrollment: (rec) => persistPendingReenrollment(rec, pendingPath),
        removePendingReenrollment: () => removePendingReenrollment(pendingPath),
        probeExistingCredential: vi.fn(async () => 'revoked' as const),
        generateInstallIdentity: vi.fn(() => ({ ...generatedIdentity })),
        redeemEnrollmentV2: vi.fn(async () => newCred),
        loadInstallJournal: vi.fn(async () => currentJournal),
        writeInstallPhase: vi.fn(async (p, phase, opts) => {
          currentJournal = await writeInstallPhase(p, phase, opts);
          state.journal = currentJournal;
          return currentJournal;
        }),
      });
      state.credential = existingCred;
      state.journal = initialJournal;

      // Attempt 1 redeems Ticket 1 -> stores pending.redeemedCredential -> fails before credential.json overwrite.
      await expect(bootstrapControlledNodeWithDisposition(deps)).rejects.toThrow(/simulated_crash_before_cred_overwrite/);
      expect(state.credential).toEqual(existingCred);

      // Attempt 2: user re-clicks UI install and gets a BRAND-NEW enrollToken (Ticket 2) on the same relay.
      const res2 = await bootstrapControlledNodeWithDisposition({
        ...deps,
        enrollmentBlob: { serverUrl: 'https://relay.example.com', enrollToken: 'ticket-2-brand-new' },
      });
      expect(res2.disposition).toBe('handoff_complete');
      expect(res2.credential).toEqual(newCred);
      // Must NEVER mint a second node for Ticket 2!
      expect(deps.redeemEnrollmentV2).toHaveBeenCalledTimes(1);
      expect(deps.startService).toHaveBeenCalledTimes(1);
      expect(currentJournal.serverId).toBe('srv-new-ui-1');
      expect(await loadPendingReenrollment(pendingPath)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes two concurrent OS processes with SQLite cross-process lock and releases lock before startService (P0-2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-stdin-two-procs-'));
    let redeemCount = 0;
    let currentValidToken = '';
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/enroll/v2/redeem') {
        redeemCount += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { nodeTokenHash: string };
        await new Promise((r) => setTimeout(r, 80));
        currentValidToken = body.nodeTokenHash;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          serverId: 'srv-cross-proc-1',
          nodeId: '7788990011',
          nodeRole: 'controlled',
        }));
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/api/server/') && req.url.endsWith('/heartbeat')) {
        const auth = String(req.headers.authorization ?? '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
        const valid = currentValidToken !== '' && tokenHash === currentValidToken;
        res.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(valid ? { ok: true } : { error: 'unauthorized' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
      const serverUrl = `http://127.0.0.1:${addr.port}`;

      const sourcePath = join(dir, 'downloaded-imcodes-node');
      const stagedPath = join(dir, 'staged', 'imcodes-node');
      const bytes = Buffer.from('#!/bin/sh\necho cross-proc-binary\n');
      await writeFile(sourcePath, bytes, { mode: 0o700 });

      const { journalPath } = await seedHealthyInstallation(dir, sourcePath, stagedPath, bytes);
      const credPath = join(dir, 'cred.json');
      const identityPath = join(dir, 'install-identity.json');
      const pendingPath = join(dir, 'pending-reenrollment.json');
      const oldCred: ControlledNodeCredential = {
        serverId: 'srv-old',
        token: 'old-revoked-tok',
        serverUrl,
        nodeRole: 'controlled',
      };
      await writeFile(credPath, JSON.stringify(oldCred), { mode: 0o600 });

      const workerScript = join(dir, 'worker.ts');
      const bootstrapMod = JSON.stringify(resolve('src/node/bootstrap.ts'));
      const enrollmentMod = JSON.stringify(resolve('src/node/enrollment.ts'));
      const journalMod = JSON.stringify(resolve('src/node/install-journal.ts'));
      const endpointsMod = JSON.stringify(resolve('src/node/server-endpoints.ts'));
      await writeFile(workerScript, `
        import {
          bootstrapControlledNodeWithDisposition,
          withBootstrapProcessLock,
        } from ${bootstrapMod};
        import {
          defaultInstallIdentityPath,
          generateInstallIdentity,
          hashEnrollmentToken,
          inspectExecutableReceipt,
          loadCredential,
          loadInstallIdentity,
          loadPendingReenrollment,
          openVerifiedEnrollmentSource,
          persistCredential,
          persistInstallIdentity,
          persistPendingReenrollment,
          probeControlledNodeCredentialStatus,
          redeemEnrollmentV2,
          removePendingReenrollment,
        } from ${enrollmentMod};
        import { loadInstallJournal, writeInstallPhase } from ${journalMod};
        import { controlledNodeEndpointsPath, resetEndpointStateForCredential } from ${endpointsMod};

        const credPath = process.env.TEST_CRED_PATH!;
        const identityPath = process.env.TEST_IDENTITY_PATH!;
        const pendingPath = process.env.TEST_PENDING_PATH!;
        const journalPath = process.env.TEST_JOURNAL_PATH!;
        const sourcePath = process.env.TEST_SOURCE_PATH!;
        const stagedPath = process.env.TEST_STAGED_PATH!;
        const serverUrl = process.env.TEST_SERVER_URL!;
        const enrollToken = process.env.TEST_ENROLL_TOKEN!;

        async function main() {
          const res = await bootstrapControlledNodeWithDisposition({
            enrollmentBlob: { serverUrl, enrollToken },
            loadCredential: () => loadCredential(credPath, { skipPermissionCheck: true }),
            openVerifiedEnrollmentSource: (p = sourcePath) => openVerifiedEnrollmentSource(p),
            loadInstallIdentity: () => loadInstallIdentity(identityPath, { skipPermissionCheck: true }),
            persistInstallIdentity: (id) => persistInstallIdentity(id, identityPath),
            generateInstallIdentity: () => ({ ...generateInstallIdentity(), sourceExePath: sourcePath }),
            redeemEnrollmentV2: (blob, id) => redeemEnrollmentV2(blob, id),
            persistCredential: (cred) => persistCredential(cred, credPath),
            probeExistingCredential: (cred) => probeControlledNodeCredentialStatus(cred),
            loadPendingReenrollment: () => loadPendingReenrollment(pendingPath, { skipPermissionCheck: true }),
            persistPendingReenrollment: (rec) => persistPendingReenrollment(rec, pendingPath),
            removePendingReenrollment: () => removePendingReenrollment(pendingPath),
            withProcessLock: (fn, lockCredPath = credPath) => withBootstrapProcessLock(lockCredPath, fn),
            inspectStagedReceipt: (p) => inspectExecutableReceipt(p, sourcePath),
            resetEndpointState: (next, prev) => resetEndpointStateForCredential(controlledNodeEndpointsPath(journalPath), prev, next, { allowLoopbackHttp: true }),
            installDefinition: async () => ({ name: 'imcodes-node', platform: process.platform, action: stagedPath }),
            inspectDefinition: async (r) => r,
            inspectServiceState: async () => ({
              installed: true, action: stagedPath, effectiveAction: stagedPath, loadedActionMatches: true,
              loaded: true, bootEnabled: true, principal: 'root', restartPolicy: process.platform === 'darwin' ? 'keepalive' : 'on-failure',
              observedDefinitionSha256: null, definitionMatches: true, runState: 'running', errors: [], raw: 'ok',
            }),
            startService: async () => {
              // Lock MUST already be released before startService runs!
              await withBootstrapProcessLock(credPath, async () => {}, { lockTimeoutMs: 500 });
            },
            verifyStagedExecutable: async () => {},
            isStableRuntime: async () => false,
            assertElevated: () => {},
            ensureReleasePublisherTrust: async () => {},
            inspectSourceArtifact: async (p) => {
              const receipt = await inspectExecutableReceipt(p);
              return { sha256: receipt.sha256, size: receipt.size };
            },
            prepareCredentialDir: async () => {},
            loadInstallJournal: (p) => loadInstallJournal(p),
            writeInstallPhase,
            journalPath,
            credentialPath: credPath,
            stagedExecutablePath: stagedPath,
            sourceExecutablePath: sourcePath,
            now: Date.now(),
            warn: () => {},
          });
          process.stdout.write(JSON.stringify({ serverId: res.credential?.serverId, tokenHash: hashEnrollmentToken(res.credential?.token ?? '') }));
        }
        main().catch((err) => {
          console.error(err);
          process.exit(1);
        });
      `);

      const runChild = (enrollToken: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild) => {
        const child = spawn(process.execPath, ['--import', 'tsx', workerScript], {
          env: {
            ...process.env,
            IMCODES_NODE_ALLOW_HTTP_ENROLL: '1',
            TEST_CRED_PATH: credPath,
            TEST_IDENTITY_PATH: identityPath,
            TEST_PENDING_PATH: pendingPath,
            TEST_JOURNAL_PATH: journalPath,
            TEST_SOURCE_PATH: sourcePath,
            TEST_STAGED_PATH: stagedPath,
            TEST_SERVER_URL: serverUrl,
            TEST_ENROLL_TOKEN: enrollToken,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += String(c); });
        child.stderr.on('data', (c) => { stderr += String(c); });
        child.on('exit', (code) => resolveChild({ code, stdout, stderr }));
      });

      const [r1, r2] = await Promise.all([runChild('proc-tok-1'), runChild('proc-tok-2')]);
      expect(r1.code, r1.stderr).toBe(0);
      expect(r2.code, r2.stderr).toBe(0);
      expect(redeemCount).toBe(1);
      const out1 = JSON.parse(r1.stdout) as { serverId: string; tokenHash: string };
      const out2 = JSON.parse(r2.stdout) as { serverId: string; tokenHash: string };
      expect(out1.serverId).toBe('srv-cross-proc-1');
      expect(out2.serverId).toBe('srv-cross-proc-1');
      expect(out1.tokenHash).toBe(out2.tokenHash);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('probeControlledNodeCredentialStatus', () => {
  const baseCred = {
    serverId: 'srv-probe-1',
    token: 'tok-secret-1',
    serverUrl: 'https://relay.example.com',
  };

  it('returns revoked on 401 and posts read-only probeOnly bearer request to /api/server/:id/heartbeat', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    const status = await probeControlledNodeCredentialStatus(baseCred, fetchMock as unknown as typeof fetch);
    expect(status).toBe('revoked');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example.com/api/server/srv-probe-1/heartbeat',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({ probeOnly: true }),
        headers: expect.objectContaining({ authorization: 'Bearer tok-secret-1' }),
      }),
    );
  });

  it('returns valid on 200 ok', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(probeControlledNodeCredentialStatus(baseCred, fetchMock as unknown as typeof fetch)).resolves.toBe('valid');
  });

  it.each([
    ['500', async () => new Response('err', { status: 500 })],
    ['403', async () => new Response(JSON.stringify({ error: 'account_disabled' }), { status: 403 })],
    ['404', async () => new Response('not found', { status: 404 })],
    ['network error', async () => { throw new Error('ECONNREFUSED'); }],
    ['redirect', async () => ({ ok: false, status: 302, redirected: true, url: 'https://evil.example/' } as Response)],
    ['origin mismatch', async () => ({ ok: false, status: 401, redirected: false, url: 'https://evil.example/api/server/srv-probe-1/heartbeat' } as Response)],
  ])('returns unknown on %s so transient or untrusted responses never wipe credentials', async (_label, impl) => {
    const fetchMock = vi.fn(impl);
    await expect(probeControlledNodeCredentialStatus(baseCred, fetchMock as unknown as typeof fetch)).resolves.toBe('unknown');
  });
});
