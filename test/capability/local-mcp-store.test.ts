import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
} from '../../shared/capability-management.js';
import { createDefaultCapabilityService } from '../../src/capability/capability-service-adapter.js';

const OWNER_ID = 'local-mcp-owner';
const SERVER_ID = 'local-mcp-server';
const CAPABILITY_ID = 'local-mcp-capability';
const VERSION_ID = 'local-mcp-version';

function localStorePath(homeDir: string): string {
  const ownerHash = createHash('sha256').update(OWNER_ID).digest('hex');
  return join(homeDir, '.imcodes', 'capability-local-mcp', `${ownerHash}.json`);
}

function localCapability(scopeId = SERVER_ID): Record<string, unknown> {
  return {
    id: CAPABILITY_ID,
    revision: 7,
    kind: CAPABILITY_KIND.MCP,
    name: 'local-tools',
    state: CAPABILITY_STATE.ACTIVE,
    scope: CAPABILITY_SCOPE.LOCAL,
    versionId: VERSION_ID,
    version: 1,
    artifactDigest: 'a'.repeat(64),
    sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
    readiness: CAPABILITY_READINESS.READY,
    findings: [],
    bindings: [{
      id: 'local-mcp-binding',
      capabilityId: CAPABILITY_ID,
      versionId: VERSION_ID,
      scope: CAPABILITY_SCOPE.LOCAL,
      scopeId,
      providers: [],
      machines: [],
      active: true,
    }],
    updatedAt: 1,
  };
}

function localStore(recordOverride: Record<string, unknown> = {}): Record<string, unknown> {
  const capability = localCapability();
  return {
    schemaVersion: 1,
    ownerId: OWNER_ID,
    records: [{
      capabilityId: CAPABILITY_ID,
      capability,
      versions: [{
        capability: structuredClone(capability),
        definition: {
          name: 'local-tools',
          transport: 'streamable_http',
          url: 'https://mcp.example.test/tools',
        },
      }],
      ...recordOverride,
    }],
  };
}

describe('machine-local MCP store codec', () => {
  let homeDir: string | undefined;

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    homeDir = undefined;
  });

  async function writeStore(value: unknown): Promise<void> {
    if (!homeDir) throw new Error('missing test home');
    const path = localStorePath(homeDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value), 'utf8');
  }

  function loadItems(): ReturnType<ReturnType<typeof createDefaultCapabilityService>['list']>['items'] {
    if (!homeDir) throw new Error('missing test home');
    return createDefaultCapabilityService({
      ownerId: OWNER_ID,
      conversationIdentity: 'conversation',
      serverId: SERVER_ID,
      homeDir,
    }).list({}).items;
  }

  it('never trusts persisted ready or active runtime claims', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-local-mcp-codec-'));
    await writeStore(localStore());

    expect(loadItems()).toEqual([
      expect.objectContaining({
        id: CAPABILITY_ID,
        state: CAPABILITY_STATE.RUNTIME_PENDING,
        readiness: CAPABILITY_READINESS.RUNTIME_PENDING,
      }),
    ]);
  });

  it('rejects a LOCAL record bound to another daemon', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-local-mcp-codec-'));
    const crossServerCapability = localCapability('different-server');
    await writeStore(localStore({
      capability: crossServerCapability,
      versions: [{
        capability: structuredClone(crossServerCapability),
        definition: {
          name: 'local-tools', transport: 'streamable_http', url: 'https://mcp.example.test/tools',
        },
      }],
    }));

    expect(loadItems()).toEqual([]);
  });

  it('rejects unknown keys at every persisted codec boundary and a mismatched owner', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-local-mcp-codec-'));
    await writeStore(localStore({ injectedRuntimeAuthority: true }));
    expect(loadItems()).toEqual([]);

    const capabilityWithUnknownKey = { ...localCapability(), injectedRuntimeAuthority: true };
    await writeStore(localStore({
      capability: capabilityWithUnknownKey,
      versions: [{
        capability: structuredClone(capabilityWithUnknownKey),
        definition: {
          name: 'local-tools', transport: 'streamable_http', url: 'https://mcp.example.test/tools',
        },
      }],
    }));
    expect(loadItems()).toEqual([]);

    await writeStore(localStore({
      versions: [{
        capability: localCapability(),
        definition: {
          name: 'local-tools', transport: 'streamable_http', url: 'https://mcp.example.test/tools',
          injectedRuntimeAuthority: true,
        },
      }],
    }));
    expect(loadItems()).toEqual([]);

    await writeStore({ ...localStore(), injectedRuntimeAuthority: true });
    expect(loadItems()).toEqual([]);

    await writeStore({ ...localStore(), ownerId: 'different-owner' });
    expect(loadItems()).toEqual([]);
  });

  it('rejects an oversized file before JSON decoding', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-local-mcp-codec-'));
    const path = localStorePath(homeDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(CAPABILITY_LIMITS.PACKAGE_BYTES + 1, 0x20));

    expect(loadItems()).toEqual([]);
  });

  it('rejects write-side item, version, binding, and encoded-byte overflow without replacing prior state', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-local-mcp-write-cap-'));
    await writeStore(localStore());
    const createInternal = () => createDefaultCapabilityService({
      ownerId: OWNER_ID, conversationIdentity: 'conversation', serverId: SERVER_ID, homeDir,
    }) as unknown as {
      mcpCapabilities: Map<string, any>;
      mcpVersionHistory: Map<string, Map<string, any>>;
      persistLocalMcpStore(): void;
    };

    const itemOverflow = createInternal();
    for (let index = 0; index < CAPABILITY_LIMITS.SYNC_ITEMS; index += 1) {
      const id = `overflow-item-${index}`;
      const versionId = `overflow-version-${index}`;
      const capability = { ...localCapability(), id, versionId, bindings: [{
        id: `binding-${index}`, capabilityId: id, versionId, scope: CAPABILITY_SCOPE.LOCAL,
        scopeId: SERVER_ID, providers: [], machines: [], active: true,
      }] };
      itemOverflow.mcpCapabilities.set(id, capability);
      itemOverflow.mcpVersionHistory.set(id, new Map([[versionId, { capability, definition: {
        name: `mcp-${index}`, transport: 'streamable_http', url: 'https://mcp.example.test/tools',
      } }]]));
    }
    expect(() => itemOverflow.persistLocalMcpStore()).toThrow('capacity exceeded');

    const versionOverflow = createInternal();
    const current = versionOverflow.mcpCapabilities.get(CAPABILITY_ID)!;
    const versions = new Map<string, any>();
    for (let index = 0; index <= CAPABILITY_LIMITS.SYNC_VERSIONS; index += 1) {
      const versionId = `too-many-version-${index}`;
      const capability = { ...current, versionId, bindings: [{
        ...current.bindings[0], versionId,
      }] };
      versions.set(versionId, { capability, definition: {
        name: 'local-tools', transport: 'streamable_http', url: 'https://mcp.example.test/tools',
      } });
    }
    versionOverflow.mcpVersionHistory.set(CAPABILITY_ID, versions);
    expect(() => versionOverflow.persistLocalMcpStore()).toThrow('capacity exceeded');

    const bindingOverflow = createInternal();
    const bindingCapability = bindingOverflow.mcpCapabilities.get(CAPABILITY_ID)!;
    bindingCapability.bindings = Array.from({ length: CAPABILITY_LIMITS.SYNC_BINDINGS + 1 }, (_, index) => ({
      ...bindingCapability.bindings[0], id: `too-many-binding-${index}`,
    }));
    expect(() => bindingOverflow.persistLocalMcpStore()).toThrow('capacity exceeded');

    const byteOverflow = createInternal();
    byteOverflow.mcpCapabilities.get(CAPABILITY_ID)!.sourceLabel = 'x'.repeat(CAPABILITY_LIMITS.PACKAGE_BYTES + 1);
    expect(() => byteOverflow.persistLocalMcpStore()).toThrow('byte capacity exceeded');

    // Every rejected write occurs before the temporary-file/rename boundary.
    expect(loadItems()).toEqual([expect.objectContaining({ id: CAPABILITY_ID })]);
  });
});
