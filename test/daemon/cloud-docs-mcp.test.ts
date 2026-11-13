import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { createDaemonCloudDocsToolDeps } from '../../src/daemon/cloud-docs-mcp-deps.js';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';

describe('MCP cloud_docs CLI-passthrough tool', () => {
  let server: http.Server;
  let workDir: string;
  let baseUrl: string;
  let lastRequest: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string } | null;
  let mockStatus = 200;
  let mockJson: unknown = { folders: [], docs: [], sharedFolders: [], sharedDocs: [] };
  let mockBody: Buffer | null = null;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'imcodes-cdoc-mcp-'));
    lastRequest = null;
    mockStatus = 200;
    mockJson = { folders: [], docs: [], sharedFolders: [], sharedDocs: [] };
    mockBody = null;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        if (mockBody !== null) {
          res.writeHead(mockStatus, { 'Content-Type': 'application/octet-stream' });
          res.end(mockBody);
          return;
        }
        res.writeHead(mockStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockJson));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind mock HTTP server');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(workDir, { recursive: true, force: true });
  });

  async function openClient(opts: {
    catalogMode?: 'dynamic' | 'static_full';
    nodeRole?: typeof NODE_ROLE.FULL | typeof NODE_ROLE.CONTROLLED;
    sharedMachineAuthority?: string | null;
    unbound?: boolean;
  } = {}) {
    const cloudDocsDeps = createDaemonCloudDocsToolDeps({
      loadCredential: async () => (
        opts.unbound ? null : { serverUrl: baseUrl, serverId: 'srv-mcp', token: 'tok-mcp' }
      ),
      loadSharedMachineAuthority: async () => opts.sharedMachineAuthority ?? null,
    });
    const mcpServer = createMemoryMcpServerFromEnv({
      env: {
        ...(opts.catalogMode === 'static_full' ? { IMCODES_MCP_TOOL_CATALOG_MODE: 'static_full' } : {}),
      },
      toolDeps: {
        nodeRole: opts.nodeRole ?? NODE_ROLE.FULL,
        cloudDocsDeps,
      },
    });
    const client = new Client({ name: 'cloud-docs-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
    return { client, close: () => client.close() };
  }

  it('publishes only cloud_docs after group:cloud-docs discovery, omits legacy 6 tools, and gates CONTROLLED nodes', async () => {
    const fullDynamic = await openClient({ catalogMode: 'dynamic' });
    try {
      const initialNames = (await fullDynamic.client.listTools()).tools.map((t) => t.name);
      expect(initialNames).not.toContain(MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS);
      for (const legacy of ['cloud_doc_list', 'cloud_doc_read', 'cloud_doc_create', 'cloud_doc_edit', 'cloud_doc_delete', 'cloud_doc_share']) {
        expect(initialNames).not.toContain(legacy);
      }

      await fullDynamic.client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'group:cloud-docs' },
      });
      const publishedNames = (await fullDynamic.client.listTools()).tools.map((t) => t.name);
      expect(publishedNames).toContain(MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS);
    } finally {
      await fullDynamic.close();
    }

    const controlled = await openClient({ catalogMode: 'static_full', nodeRole: NODE_ROLE.CONTROLLED });
    try {
      const controlledNames = (await controlled.client.listTools()).tools.map((t) => t.name);
      expect(controlledNames).not.toContain(MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS);
    } finally {
      await controlled.close();
    }
  });

  it('routes args, command strings, omitted help, shared authority, and non-zero failures through runCloudDocsCli', async () => {
    const conn = await openClient({ catalogMode: 'static_full', sharedMachineAuthority: 'delegated-sma-1' });
    try {
      // 1. Omitted args/command defaults to --help (exit 0)
      const helpRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: {},
      });
      expect(helpRes.isError).not.toBe(true);
      expect(helpRes.structuredContent).toMatchObject({ status: 'ok', exitCode: 0 });
      expect(String((helpRes.structuredContent as { stdout?: string }).stdout)).toContain('Unified CLI for IM.codes Cloud Docs');

      // 2. Embedded docs progressive disclosure
      const docsRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { args: ['docs', '--topic', 'pptx'] },
      });
      expect(docsRes.isError).not.toBe(true);
      expect(String((docsRes.structuredContent as { stdout?: string }).stdout)).toContain('builder.CreateFile("pptx")');

      // 3. String command form executes list --search with delegated machine authority header
      const cmdRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { command: 'list --search "My Report" --json' },
      });
      expect(cmdRes.isError).not.toBe(true);
      expect(lastRequest?.url).toBe('/api/cloud-docs?search=My+Report');
      expect(lastRequest?.headers[SHARED_MACHINE_AUTHORITY_HEADER.toLowerCase()]).toBe('delegated-sma-1');

      // 4. Rejects passing both args and command
      const bothRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { args: ['list'], command: 'list' },
      });
      expect(bothRes.isError).toBe(true);
      expect(bothRes.structuredContent).toMatchObject({
        status: 'error',
        reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      });

      // 5. Rejects unclosed quote cleanly
      const quoteRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { command: 'list --search "unclosed' },
      });
      expect(quoteRes.isError).toBe(true);
      expect(quoteRes.structuredContent).toMatchObject({
        status: 'error',
        reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      });

      // 6. Propagates non-zero HTTP failure (409 CAS -> revision_conflict)
      mockStatus = 409;
      mockJson = { error: 'version_conflict', currentVersion: 4 };
      const conflictRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { args: ['edit', 'doc-1', '--content', 'next', '--expected-version', '3'] },
      });
      expect(conflictRes.isError).toBe(true);
      expect(conflictRes.structuredContent).toMatchObject({
        status: 'error',
        reason: MCP_ERROR_REASONS.REVISION_CONFLICT,
      });

      // 7. Brief CLI parity through MCP args & command forms (read --convert-to, create --file, edit --file/--no-save --out, --version, share)
      const pdfBytes = Buffer.from('%PDF-mcp', 'utf8');
      mockStatus = 200;
      mockBody = null;
      mockJson = {
        fileName: 'mcp-read.pdf',
        mimeType: 'application/pdf',
        bytesWritten: pdfBytes.length,
        bytesBase64: pdfBytes.toString('base64'),
      };
      const mcpPdfOut = join(workDir, 'mcp-read.pdf');
      const readConvRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { args: ['read', 'doc-1', '--convert-to', 'pdf', '--out', mcpPdfOut] },
      });
      expect(readConvRes.isError).not.toBe(true);
      expect(lastRequest?.method).toBe('POST');
      expect(lastRequest?.url).toBe('/api/cloud-docs/doc-1/convert');
      expect(JSON.parse(lastRequest!.body)).toEqual({ targetType: 'pdf' });
      expect(readFileSync(mcpPdfOut).equals(pdfBytes)).toBe(true);

      const srcDocx = join(workDir, 'mcp-src.docx');
      writeFileSync(srcDocx, Buffer.from('PK-mcp-src', 'utf8'));
      mockBody = null;
      mockJson = { doc: { id: 'doc-new', docVersion: 1 }, created: true };
      const createFileRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { command: `create --type docx --folder fld-m --file "${srcDocx}"` },
      });
      expect(createFileRes.isError).not.toBe(true);
      expect(lastRequest?.method).toBe('POST');
      expect(lastRequest?.url).toBe('/api/cloud-docs/files');

      mockJson = { ok: true, doc: { id: 'doc-1', docVersion: 5 }, role: 'owner', bytesWritten: 10 };
      const editFileRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { args: ['edit', 'doc-1', '--file', srcDocx, '--version', '4'] },
      });
      expect(editFileRes.isError).not.toBe(true);
      expect(lastRequest?.method).toBe('PUT');
      expect(lastRequest?.url).toBe('/api/cloud-docs/doc-1/file');
      expect(lastRequest?.body).toContain('name="expectedVersion"\r\n\r\n4');

      const previewDocx = Buffer.from('PK-mcp-preview', 'utf8');
      mockJson = {
        doc: { id: 'doc-1', name: 'Brief.docx', ext: '.docx', docVersion: 5 },
        bytesBase64: previewDocx.toString('base64'),
        outputName: 'mcp-preview.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytesWritten: previewDocx.length,
      };
      const mcpPreviewOut = join(workDir, 'mcp-preview.docx');
      const editNoSaveRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { args: ['edit', 'doc-1', '--script', 'Api.GetDocument();', '--no-save', '--out', mcpPreviewOut] },
      });
      expect(editNoSaveRes.isError).not.toBe(true);
      expect(lastRequest?.url).toBe('/api/cloud-docs/doc-1/docbuilder');
      expect(JSON.parse(lastRequest!.body)).toMatchObject({ script: 'Api.GetDocument();', save: false });
      expect(readFileSync(mcpPreviewOut).equals(previewDocx)).toBe(true);

      mockBody = null;
      mockJson = { teams: [] };
      const teamsRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { command: 'share list-teams' },
      });
      expect(teamsRes.isError).not.toBe(true);
      expect(lastRequest?.url).toBe('/api/cloud-docs/teams');

      mockJson = { share: { id: 'sh-2' } };
      const grantRes = await conn.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { command: 'share grant --id doc-1 --mode user --username bob --role viewer --no-allow-download' },
      });
      expect(grantRes.isError).not.toBe(true);
      expect(lastRequest?.url).toBe('/api/cloud-docs/shares');
      expect(JSON.parse(lastRequest!.body)).toEqual({
        targetKind: 'doc',
        targetId: 'doc-1',
        shareMode: 'user',
        role: 'viewer',
        targetUsername: 'bob',
        allowDownload: false,
      });
    } finally {
      await conn.close();
    }

    // 7. Unbound daemon returns feature_disabled cleanly
    const unbound = await openClient({ catalogMode: 'static_full', unbound: true });
    try {
      const res = await unbound.client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
        arguments: { args: ['list'] },
      });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({
        status: 'error',
        reason: MCP_ERROR_REASONS.FEATURE_DISABLED,
      });
    } finally {
      await unbound.close();
    }
  });
});
