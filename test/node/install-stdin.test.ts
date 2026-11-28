import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type ControlledNodeBootstrapDeps,
} from '../../src/node/bootstrap.js';
import {
  openVerifiedEnrollmentSource,
  probeControlledNodeCredentialStatus,
  type ControlledNodeCredential,
  type PendingInstallIdentity,
  type VerifiedEnrollmentSource,
} from '../../src/node/enrollment.js';
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
      nodeTokenHash: 'b'.repeat(64),
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
      journal: InstallJournal;
    } = {
      credential: null,
      identity: null,
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
});

describe('probeControlledNodeCredentialStatus', () => {
  const baseCred = {
    serverId: 'srv-probe-1',
    token: 'tok-secret-1',
    serverUrl: 'https://relay.example.com',
  };

  it('returns revoked on 401 and posts bearer token to /api/server/:id/heartbeat', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    const status = await probeControlledNodeCredentialStatus(baseCred, fetchMock as unknown as typeof fetch);
    expect(status).toBe('revoked');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example.com/api/server/srv-probe-1/heartbeat',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
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
