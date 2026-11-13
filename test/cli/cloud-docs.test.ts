import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLOUD_DOC_ERROR_CODES,
} from '../../shared/cloud-docs.js';
import {
  HOOK_AUTHORITY_RECORD_VERSION,
  HOOK_IDENTITY_HOOK_PATH,
} from '../../shared/hook-authority.js';
import {
  HOOK_SESSION_CREDENTIAL_ENV,
  HOOK_SESSION_CREDENTIAL_HEADER,
} from '../../shared/hook-session-credential.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { IMCODES_SESSION_ENV } from '../../shared/imcodes-send.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { IMCODES_DAEMON_SESSION_NAME_ENV, IMCODES_MCP_TOOL_CATALOG_MODE_ENV } from '../../shared/memory-mcp-env.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { SESSION_RESOURCE_OWNER_ENV } from '../../shared/session-resource-lifecycle.js';
import {
  SHARED_MACHINE_AUTHORITY_HEADER,
  SHARED_MACHINE_AUTHORITY_HOOK_PATH,
  SHARED_MACHINE_AUTHORITY_STALE_RUNTIME_ERROR,
} from '../../shared/shared-machine-authority.js';
import { runCloudDocsCli, splitCliArgs } from '../../src/cli/cloud-docs.js';
import { createProgram } from '../../src/cli.js';
import { sanitizeCloudDocTransferFilename } from '../../src/daemon/cloud-docs-mcp-client.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import { publishHookAuthority } from '../../src/daemon/hook-port.js';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';

interface RecordedHttpRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  bodyText: string;
  bodyBytes: Buffer;
}

describe('splitCliArgs & filename sanitization', () => {
  it('preserves Windows backslashes, spaces in quotes, UNC paths, and escaped JSON quotes', () => {
    expect(splitCliArgs('upload --file C:\\Users\\Alice\\plan.docx')).toEqual([
      'upload',
      '--file',
      'C:\\Users\\Alice\\plan.docx',
    ]);
    expect(splitCliArgs('upload --file "C:\\Users\\Alice\\My Docs\\plan 2026.docx" --name "Q4 Plan.docx"')).toEqual([
      'upload',
      '--file',
      'C:\\Users\\Alice\\My Docs\\plan 2026.docx',
      '--name',
      'Q4 Plan.docx',
    ]);
    expect(splitCliArgs('builder --type docx --argument "{\\"title\\":\\"Report\\",\\"count\\":3}"')).toEqual([
      'builder',
      '--type',
      'docx',
      '--argument',
      '{"title":"Report","count":3}',
    ]);
    expect(splitCliArgs("read 'doc 123' --out 'C:\\Temp\\My Out\\out.txt'")).toEqual([
      'read',
      'doc 123',
      '--out',
      'C:\\Temp\\My Out\\out.txt',
    ]);
    expect(splitCliArgs('upload "\\\\server\\share\\file.xlsx"')).toEqual([
      'upload',
      '\\\\server\\share\\file.xlsx',
    ]);
    expect(() => splitCliArgs('read "unclosed')).toThrow(/Unclosed quote/i);
  });

  it('sanitizes Windows and POSIX traversal paths into safe single filenames', () => {
    expect(sanitizeCloudDocTransferFilename('C:\\Users\\Alice\\My Docs\\Report.docx')).toBe('Report.docx');
    expect(sanitizeCloudDocTransferFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeCloudDocTransferFilename('..\\..\\evil\\payload.xlsx')).toBe('payload.xlsx');
  });
});

describe('imcodes cloud-docs CLI', () => {
  let workDir: string;
  let homeDir: string;
  let server: http.Server;
  let baseUrl: string;
  let recorded: RecordedHttpRequest[];
  let responder: (req: RecordedHttpRequest) => {
    status?: number;
    headers?: Record<string, string>;
    json?: unknown;
    body?: Buffer | string;
  };

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'imcodes-cdoc-cli-'));
    homeDir = mkdtempSync(join(tmpdir(), 'imcodes-cdoc-home-'));
    recorded = [];
    responder = () => ({ status: 200, json: { folders: [], docs: [], sharedFolders: [], sharedDocs: [] } });

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyBytes = Buffer.concat(chunks);
        const rec: RecordedHttpRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          bodyBytes,
          bodyText: bodyBytes.toString('utf8'),
        };
        recorded.push(rec);
        const reply = responder(rec);
        const status = reply.status ?? 200;
        const headers: Record<string, string> = { ...(reply.headers ?? {}) };
        if (reply.body !== undefined) {
          res.writeHead(status, headers);
          res.end(reply.body);
          return;
        }
        headers['Content-Type'] ??= 'application/json';
        res.writeHead(status, headers);
        res.end(JSON.stringify(reply.json ?? {}));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind test HTTP server');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(workDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('ships offline progressive-disclosure docs without credentials', async () => {
    const idx = await runCloudDocsCli(['docs'], { env: {} });
    expect(idx.exitCode).toBe(0);
    expect(idx.stdout).toContain('imcodes cloud-docs list');
    expect(idx.stdout).toContain('imcodes cloud-docs read <docId>');
    expect(idx.stdout).toContain('docs --topic docx');

    for (const topic of ['quickstart', 'docx', 'xlsx', 'pptx', 'edit', 'convert', 'share', 'troubleshooting', 'all']) {
      const res = await runCloudDocsCli(['docs', '--topic', topic], { env: {} });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.length).toBeGreaterThan(100);
    }

    const docxJson = await runCloudDocsCli(['docs', 'docx', '--json'], { env: {} });
    expect(docxJson.exitCode).toBe(0);
    expect(JSON.parse(docxJson.stdout)).toMatchObject({ topic: 'docx' });
    expect(JSON.parse(docxJson.stdout).text).toContain('builder.CreateFile("docx")');

    const badTopic = await runCloudDocsCli(['docs', '--topic', 'nonexistent'], { env: {} });
    expect(badTopic.exitCode).toBe(1);
    expect(badTopic.stderr).toContain('Unknown docs topic');
  });

  it('resolves credentials in flags -> env -> home server.json order and fails explicitly when unbound', async () => {
    const unbound = await runCloudDocsCli(['list'], {
      env: {},
      loadCredential: async () => null,
    });
    expect(unbound.exitCode).toBe(1);
    expect(unbound.errorReason).toBe(MCP_ERROR_REASONS.FEATURE_DISABLED);
    expect(unbound.stderr).toContain('credentials missing');

    // Home server.json fallback
    writeFileSync(
      join(homeDir, 'server.json'),
      JSON.stringify({ workerUrl: baseUrl, serverId: 'srv-home', token: 'tok-home' }),
    );
    const viaHome = await runCloudDocsCli(['list', '--home', homeDir], { env: {} });
    expect(viaHome.exitCode).toBe(0);
    expect(recorded.at(-1)?.headers[SERVER_ID_HEADER.toLowerCase()]).toBe('srv-home');
    expect(recorded.at(-1)?.headers.authorization).toBe('Bearer tok-home');

    // Env overrides home server.json
    const viaEnv = await runCloudDocsCli(['list', '--home', homeDir], {
      env: {
        IMCODES_SERVER_URL: baseUrl,
        IMCODES_SERVER_ID: 'srv-env',
        IMCODES_TOKEN: 'tok-env',
      },
    });
    expect(viaEnv.exitCode).toBe(0);
    expect(recorded.at(-1)?.headers[SERVER_ID_HEADER.toLowerCase()]).toBe('srv-env');
    expect(recorded.at(-1)?.headers.authorization).toBe('Bearer tok-env');

    // Flags override env and home server.json
    const viaFlags = await runCloudDocsCli([
      'list',
      '--home', homeDir,
      '--server-url', baseUrl,
      '--server-id', 'srv-flag',
      '--token', 'tok-flag',
    ], {
      env: {
        IMCODES_SERVER_URL: 'http://127.0.0.1:9',
        IMCODES_SERVER_ID: 'srv-env',
        IMCODES_TOKEN: 'tok-env',
      },
      loadSharedMachineAuthority: async () => 'sma-token-1',
    });
    expect(viaFlags.exitCode).toBe(0);
    expect(recorded.at(-1)?.headers[SERVER_ID_HEADER.toLowerCase()]).toBe('srv-flag');
    expect(recorded.at(-1)?.headers.authorization).toBe('Bearer tok-flag');
    expect(recorded.at(-1)?.headers[SHARED_MACHINE_AUTHORITY_HEADER.toLowerCase()]).toBe('sma-token-1');
  });

  it('supports list, read, create, mkdir, edit, delete, and share subcommands cleanly', async () => {
    const authEnv = { IMCODES_SERVER_URL: baseUrl, IMCODES_SERVER_ID: 'srv-1', IMCODES_TOKEN: 'tok-1' };
    const sampleDoc = {
      id: 'doc-1',
      userId: 'u1',
      folderId: null,
      name: 'Brief.docx',
      ext: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 512,
      docVersion: 2,
      createdAt: 1,
      updatedAt: 2,
      lastOpenedAt: null,
    };

    // read --max-chars --out
    responder = () => ({
      json: {
        doc: sampleDoc,
        role: 'owner',
        allowDownload: true,
        ext: '.docx',
        format: 'docx',
        editable: true,
        content: 'Extracted paragraph text',
        truncated: false,
        totalChars: 24,
        byteLength: 24,
        maxChars: 5000,
      },
    });
    const readOut = join(workDir, 'nested', 'extracted.txt');
    const readRes = await runCloudDocsCli(['read', 'doc-1', '--max-chars', '5000', '--out', readOut], { env: authEnv, cwd: workDir });
    expect(readRes.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/content?maxChars=5000');
    expect(readFileSync(readOut, 'utf8')).toBe('Extracted paragraph text');

    // create (infers type from name, reads --content-file)
    const contentFile = join(workDir, 'init.txt');
    writeFileSync(contentFile, 'Initial notes');
    responder = () => ({ status: 201, json: { doc: sampleDoc } });
    const createRes = await runCloudDocsCli(['create', '--name', 'Brief.docx', '--content-file', contentFile, '--folder-id', 'fld-1'], {
      env: authEnv,
      cwd: workDir,
    });
    expect(createRes.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/blank');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({
      type: 'docx',
      name: 'Brief.docx',
      folderId: 'fld-1',
      content: 'Initial notes',
    });

    // mkdir
    responder = () => ({ status: 201, json: { folder: { id: 'fld-2', userId: 'u1', parentId: 'fld-1', name: 'Specs', createdAt: 1, updatedAt: 1 } } });
    const mkdirRes = await runCloudDocsCli(['mkdir', 'Specs', '--parent', 'fld-1'], { env: authEnv });
    expect(mkdirRes.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/folders');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({ name: 'Specs', parentId: 'fld-1' });

    // edit (--root + --mode append + --expected-version)
    responder = () => ({ status: 200, json: { ok: true, doc: { ...sampleDoc, docVersion: 3 }, role: 'owner', bytesWritten: 600 } });
    const editRes = await runCloudDocsCli([
      'edit', 'doc-1', '--content', 'More text', '--mode', 'append', '--expected-version', '2', '--root', '--name', 'Final.docx',
    ], { env: authEnv });
    expect(editRes.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/content');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({
      content: 'More text',
      mode: 'append',
      expectedVersion: 2,
      name: 'Final.docx',
      folderId: null,
    });

    // share grant (--no-download) & revoke & teams
    responder = () => ({ status: 201, json: { share: { id: 'shr-1', targetKind: 'doc', targetId: 'doc-1', shareMode: 'user', targetTeamId: null, targetTeamName: null, targetUserId: 'u2', targetUserName: 'Bob', targetUserUsername: 'bob', role: 'viewer', allowDownload: false, createdBy: 'u1', createdAt: 1, updatedAt: 1 } } });
    const grantRes = await runCloudDocsCli(['share', 'grant', 'doc-1', '--user', 'bob', '--role', 'viewer', '--no-download'], { env: authEnv });
    expect(grantRes.exitCode).toBe(0);
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({
      targetKind: 'doc',
      targetId: 'doc-1',
      shareMode: 'user',
      targetUsername: 'bob',
      role: 'viewer',
      allowDownload: false,
    });

    responder = () => ({ status: 200, json: { ok: true } });
    const delRes = await runCloudDocsCli(['delete', 'fld-2', '--kind', 'folder'], { env: authEnv });
    expect(delRes.exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('DELETE');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/folders/fld-2');
  });

  it('executes DocBuilder create, DocBuilder edit/export, Convert, Upload, Replace, and Download binary flows', async () => {
    const authEnv = { IMCODES_SERVER_URL: baseUrl, IMCODES_SERVER_ID: 'srv-1', IMCODES_TOKEN: 'tok-1' };
    const doc = {
      id: 'doc-db',
      userId: 'u1',
      folderId: null,
      name: 'Report.docx',
      ext: '.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 200,
      docVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: null,
    };

    const scriptFile = join(workDir, 'build.js');
    writeFileSync(scriptFile, 'builder.CreateFile("docx");builder.SaveFile("docx","Report.docx");builder.CloseFile();');
    const argFile = join(workDir, 'arg.json');
    writeFileSync(argFile, JSON.stringify({ title: 'Quarterly Report' }));

    // 1. DocBuilder Create
    responder = () => ({ status: 201, json: { doc, bytesWritten: 200 } });
    const buildCreate = await runCloudDocsCli([
      'builder', '--type', 'docx', '--name', 'Report.docx', '--script-file', scriptFile, '--argument-file', argFile, '--output-name', 'Report.docx', '--json',
    ], { env: authEnv, cwd: workDir });
    expect(buildCreate.exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('POST');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/docbuilder');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toMatchObject({
      type: 'docx',
      name: 'Report.docx',
      outputName: 'Report.docx',
      argument: { title: 'Quarterly Report' },
    });

    // 2. DocBuilder Export (--no-save --out)
    const exportedPdf = Buffer.from('%PDF-1.7 docbuilder export bytes');
    responder = () => ({
      status: 200,
      json: {
        doc,
        bytesBase64: exportedPdf.toString('base64'),
        outputName: 'Preview.pdf',
        mimeType: 'application/pdf',
        bytesWritten: exportedPdf.length,
      },
    });
    const exportPath = join(workDir, 'Preview.pdf');
    const buildExport = await runCloudDocsCli([
      'builder', 'doc-db', '--no-save', '--output-type', 'pdf', '--script', 'builder.OpenFile(Argument.inputUrl);', '--out', exportPath, '--json',
    ], { env: authEnv, cwd: workDir });
    expect(buildExport.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-db/docbuilder');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toMatchObject({ save: false, outputType: 'pdf' });
    expect(readFileSync(exportPath).equals(exportedPdf)).toBe(true);
    expect(JSON.parse(buildExport.stdout).savedTo).toBe(exportPath);

    // 3. Convert --to pdf --out <existing dir>
    const outDir = join(workDir, 'converted');
    mkdirSync(outDir, { recursive: true });
    const convertedBytes = Buffer.from('%PDF-converted-output');
    responder = () => ({
      status: 200,
      json: {
        fileName: 'Report.pdf',
        mimeType: 'application/pdf',
        bytesWritten: convertedBytes.length,
        bytesBase64: convertedBytes.toString('base64'),
      },
    });
    const convRes = await runCloudDocsCli(['convert', 'doc-db', '--to', 'pdf', '--out', outDir], { env: authEnv, cwd: workDir });
    expect(convRes.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-db/convert');
    expect(readFileSync(join(outDir, 'Report.pdf')).equals(convertedBytes)).toBe(true);

    // 4. Upload new binary (POST /files) & Replace binary (PUT /:id/file)
    const localDocx = join(workDir, 'Local Upload.docx');
    const binaryPayload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0xff]);
    writeFileSync(localDocx, binaryPayload);

    responder = () => ({ status: 201, json: { doc } });
    const upRes = await runCloudDocsCli(['upload', '--file', localDocx, '--folder-id', 'fld-1'], { env: authEnv, cwd: workDir });
    expect(upRes.exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('POST');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/files');
    expect(recorded.at(-1)?.headers['content-type']).toContain('multipart/form-data');
    expect(recorded.at(-1)?.bodyBytes.includes(binaryPayload)).toBe(true);

    responder = () => ({ status: 200, json: { ok: true, doc: { ...doc, docVersion: 2 }, role: 'owner', bytesWritten: binaryPayload.length } });
    const repRes = await runCloudDocsCli(['upload', localDocx, '--replace', 'doc-db', '--expected-version', '1'], { env: authEnv, cwd: workDir });
    expect(repRes.exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('PUT');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-db/file');
    expect(recorded.at(-1)?.bodyText).toContain('name="expectedVersion"');
    expect(recorded.at(-1)?.bodyBytes.includes(binaryPayload)).toBe(true);

    // 5. Download binary while sanitizing traversal Content-Disposition filename
    const rawDownload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99, 0x88]);
    responder = () => ({
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="../../escape/SafeName.docx"',
      },
      body: rawDownload,
    });
    const dlDir = join(workDir, 'downloads');
    mkdirSync(dlDir, { recursive: true });
    const dlRes = await runCloudDocsCli(['download', 'doc-db', '--out', `${dlDir}/`, '--json'], { env: authEnv, cwd: workDir });
    expect(dlRes.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-db/download?download=1');
    expect(existsSync(join(dlDir, 'SafeName.docx'))).toBe(true);
    expect(readFileSync(join(dlDir, 'SafeName.docx')).equals(rawDownload)).toBe(true);
  });

  it('propagates HTTP error codes (401/403/409/422/503) cleanly as non-zero exit codes', async () => {
    const authEnv = { IMCODES_SERVER_URL: baseUrl, IMCODES_SERVER_ID: 'srv-1', IMCODES_TOKEN: 'tok-1' };

    const cases: Array<[number, string, string]> = [
      [401, 'invalid_token', MCP_ERROR_REASONS.IDENTITY_REJECTED],
      [403, 'download_forbidden', MCP_ERROR_REASONS.SCOPE_FORBIDDEN],
      [409, 'version_conflict', MCP_ERROR_REASONS.REVISION_CONFLICT],
      [422, CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH, MCP_ERROR_REASONS.VALIDATION_FAILED],
      [503, CLOUD_DOC_ERROR_CODES.ONLYOFFICE_DISABLED, MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE],
    ];
    for (const [status, errCode, expectedReason] of cases) {
      responder = () => ({ status, json: { error: errCode } });
      const res = await runCloudDocsCli(['builder', '--type', 'docx', '--script', 'builder.CreateFile("docx");'], { env: authEnv });
      expect(res.exitCode).toBe(1);
      expect(res.errorReason).toBe(expectedReason);
      expect(res.stderr).toContain(errCode);
    }

    // Commander subcommand wiring in src/cli.ts works identically
    let capturedOut = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      capturedOut += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    try {
      await createProgram().parseAsync(['node', 'imcodes', 'cloud-docs', 'docs', '--topic', 'xlsx']);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(capturedOut).toContain('builder.CreateFile("xlsx")');
  });

  it('supports full brief CLI flag/subcommand parity and forwards --version past Commander', async () => {
    const authEnv = { IMCODES_SERVER_URL: baseUrl, IMCODES_SERVER_ID: 'srv-1', IMCODES_TOKEN: 'tok-1' };

    // 1. read --convert-to + --out writes converted bytes and rejects combining with --max-chars
    const convertedBytes = Buffer.from('%PDF-1.7 converted', 'utf8');
    responder = () => ({
      status: 200,
      json: {
        fileName: 'converted.pdf',
        mimeType: 'application/pdf',
        bytesWritten: convertedBytes.length,
        bytesBase64: convertedBytes.toString('base64'),
      },
    });
    const convertedOut = join(workDir, 'converted.pdf');
    const readConverted = await runCloudDocsCli(['read', 'doc-1', '--convert-to', 'pdf', '--out', convertedOut], { env: authEnv });
    expect(readConverted.exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('POST');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/convert');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({ targetType: 'pdf' });
    expect(readFileSync(convertedOut).equals(convertedBytes)).toBe(true);

    const conflictingRead = await runCloudDocsCli(['read', 'doc-1', '--convert-to', 'pdf', '--max-chars', '100'], { env: authEnv });
    expect(conflictingRead.exitCode).toBe(1);
    expect(conflictingRead.errorReason).toBe(MCP_ERROR_REASONS.VALIDATION_FAILED);

    // 2. create --type docx --file uploads local file via multipart /files and rejects invalid combos
    const createSource = join(workDir, 'draft.docx');
    writeFileSync(createSource, Buffer.from('PK-docx-draft', 'utf8'));
    responder = () => ({ status: 201, json: { doc: { id: 'doc-up', name: 'draft.docx', ext: '.docx', docVersion: 1 }, created: true } });
    const createFromFile = await runCloudDocsCli(['create', '--type', 'docx', '--folder', 'fld-9', '--file', createSource], { env: authEnv });
    expect(createFromFile.exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('POST');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/files');
    expect(recorded.at(-1)?.bodyText).toContain('name="folderId"\r\n\r\nfld-9');

    const badCreateMix = await runCloudDocsCli(['create', '--type', 'docx', '--file', createSource, '--content', 'hello'], { env: authEnv });
    expect(badCreateMix.exitCode).toBe(1);
    expect(badCreateMix.errorReason).toBe(MCP_ERROR_REASONS.VALIDATION_FAILED);

    // 3. create docbuilder with brief flags (--folder, --arg-json, --timeout-ms)
    responder = () => ({ status: 201, json: { doc: { id: 'doc-b1', ext: '.xlsx', docVersion: 1 } } });
    const createBuilder = await runCloudDocsCli([
      'create', '--type', 'xlsx', '--name', 'KPI', '--folder', 'fld-2',
      '--script', 'var a = Argument;', '--arg-json', '{"sheet":"KPI"}', '--timeout-ms', '15000',
    ], { env: authEnv });
    expect(createBuilder.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/blank');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toMatchObject({
      name: 'KPI',
      type: 'xlsx',
      folderId: 'fld-2',
      engine: 'docbuilder',
      docbuilderScript: 'var a = Argument;',
      argument: { sheet: 'KPI' },
      timeoutMs: 15000,
    });

    // 4. list --folder + mkdir --folder
    responder = () => ({ status: 200, json: { folders: [], docs: [], sharedFolders: [], sharedDocs: [] } });
    expect((await runCloudDocsCli(['list', '--folder', 'fld-list'], { env: authEnv })).exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs?folderId=fld-list');

    responder = () => ({ status: 200, json: { folder: { id: 'fld-new', name: 'Sub', parentId: 'fld-list' } } });
    expect((await runCloudDocsCli(['mkdir', 'Sub', '--folder', 'fld-list'], { env: authEnv })).exitCode).toBe(0);
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({ name: 'Sub', parentId: 'fld-list' });

    // 5. edit --file --version replaces raw document bytes via PUT /api/cloud-docs/:id/file
    const replaceSource = join(workDir, 'edited.docx');
    writeFileSync(replaceSource, Buffer.from('PK-docx-edited', 'utf8'));
    responder = () => ({ status: 200, json: { ok: true, doc: { id: 'doc-1', name: 'edited.docx', ext: '.docx', docVersion: 3 }, role: 'owner', bytesWritten: 14 } });
    const editFile = await runCloudDocsCli(['edit', 'doc-1', '--file', replaceSource, '--version', '2'], { env: authEnv });
    expect(editFile.exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('PUT');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/file');
    expect(recorded.at(-1)?.bodyText).toContain('name="expectedVersion"\r\n\r\n2');

    // 6. edit --script --no-save --out writes transient docbuilder binary output
    const previewBytes = Buffer.from('PK-preview-docx', 'utf8');
    responder = () => ({
      status: 200,
      json: {
        doc: { id: 'doc-1', name: 'Brief.docx', ext: '.docx', docVersion: 2 },
        bytesBase64: previewBytes.toString('base64'),
        outputName: 'preview.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytesWritten: previewBytes.length,
      },
    });
    const previewOut = join(workDir, 'preview.docx');
    const editPreview = await runCloudDocsCli([
      'edit', 'doc-1', '--script', 'Api.GetDocument();', '--arg-json', '{"x":1}',
      '--version', '2', '--timeout-ms', '15000', '--no-save', '--out', previewOut,
    ], { env: authEnv });
    expect(editPreview.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/docbuilder');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({
      script: 'Api.GetDocument();',
      argument: { x: 1 },
      expectedVersion: 2,
      timeoutMs: 15000,
      save: false,
    });
    expect(readFileSync(previewOut).equals(previewBytes)).toBe(true);

    // Rejects --out without --no-save on edit
    const badEditOut = await runCloudDocsCli(['edit', 'doc-1', '--script', 'Api.GetDocument();', '--out', previewOut], { env: authEnv });
    expect(badEditOut.exitCode).toBe(1);
    expect(badEditOut.errorReason).toBe(MCP_ERROR_REASONS.VALIDATION_FAILED);

    // 7. builder [docId] honors --type as outputType alongside --folder, --version, --arg-json, --timeout-ms
    responder = () => ({ status: 200, json: { ok: true, doc: { id: 'doc-1', docVersion: 5 } } });
    const builderDoc = await runCloudDocsCli([
      'builder', 'doc-1', '--type', 'pdf', '--folder', 'fld-out', '--version', '4',
      '--script', 'Api.Save();', '--arg-json', '{"ok":true}', '--timeout-ms', '9000',
    ], { env: authEnv });
    expect(builderDoc.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/docbuilder');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({
      outputType: 'pdf',
      folderId: 'fld-out',
      expectedVersion: 4,
      script: 'Api.Save();',
      argument: { ok: true },
      timeoutMs: 9000,
      save: true,
    });

    // 8. convert --folder --timeout-ms + upload --doc-id --version
    responder = () => ({
      status: 200,
      json: {
        fileName: 'conv2.pdf',
        mimeType: 'application/pdf',
        bytesWritten: convertedBytes.length,
        bytesBase64: convertedBytes.toString('base64'),
      },
    });
    const convertOut = join(workDir, 'conv2.pdf');
    expect((await runCloudDocsCli(['convert', 'doc-1', '--to', 'pdf', '--folder', 'fld-c', '--timeout-ms', '9000', '--out', convertOut], { env: authEnv })).exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('POST');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/convert');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({ targetType: 'pdf', folderId: 'fld-c', timeoutMs: 9000 });
    expect(readFileSync(convertOut).equals(convertedBytes)).toBe(true);

    responder = () => ({ status: 200, json: { ok: true, doc: { id: 'doc-1', docVersion: 8 }, role: 'owner', bytesWritten: 14 } });
    expect((await runCloudDocsCli(['upload', replaceSource, '--doc-id', 'doc-1', '--version', '7'], { env: authEnv })).exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('PUT');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/file');
    expect(recorded.at(-1)?.bodyText).toContain('name="expectedVersion"\r\n\r\n7');

    // 9. share brief parity: list-teams, list --id, grant --id --mode --username --no-allow-download, revoke --share-id
    responder = () => ({ status: 200, json: { teams: [{ id: 'team-1', name: 'Core' }] } });
    expect((await runCloudDocsCli(['share', 'list-teams'], { env: authEnv })).exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/teams');

    responder = () => ({ status: 200, json: { shares: [] } });
    expect((await runCloudDocsCli(['share', 'list', '--id', 'doc-1'], { env: authEnv })).exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/shares/doc/doc-1');

    responder = () => ({ status: 200, json: { share: { id: 'sh-1' } } });
    expect((await runCloudDocsCli([
      'share', 'grant', '--id', 'doc-1', '--mode', 'user', '--username', 'alice', '--role', 'editor', '--no-allow-download',
    ], { env: authEnv })).exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/shares');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({
      targetKind: 'doc',
      targetId: 'doc-1',
      shareMode: 'user',
      role: 'editor',
      targetUsername: 'alice',
      allowDownload: false,
    });

    responder = () => ({ status: 200, json: { ok: true } });
    expect((await runCloudDocsCli(['share', 'revoke', '--share-id', 'sh-1'], { env: authEnv })).exitCode).toBe(0);
    expect(recorded.at(-1)?.method).toBe('DELETE');
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/shares/sh-1');

    // 10. Outer src/cli.ts Commander MUST pass --version to cloud-docs instead of printing package version
    const savedSessionEnv: Record<string, string | undefined> = {};
    const sessionKeys = [
      IMCODES_SESSION_ENV,
      IMCODES_DAEMON_SESSION_NAME_ENV,
      SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID,
      SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH,
      HOOK_SESSION_CREDENTIAL_ENV,
    ];
    for (const key of sessionKeys) {
      savedSessionEnv[key] = process.env[key];
      delete process.env[key];
    }
    let capturedOut = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      capturedOut += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    responder = () => ({ status: 200, json: { ok: true, doc: { id: 'doc-1', name: 'Brief.docx', ext: '.docx', docVersion: 4 } } });
    const prevExitCode = process.exitCode;
    try {
      await createProgram().parseAsync([
        'node', 'imcodes', 'cloud-docs', 'edit', 'doc-1', '--content', 'v2', '--version', '3',
        '--server-url', baseUrl, '--server-id', 'srv-1', '--token', 'tok-1',
      ]);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.stdout.write = origWrite;
      process.exitCode = prevExitCode;
      for (const key of sessionKeys) {
        if (savedSessionEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedSessionEnv[key];
      }
    }
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/content');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({ content: 'v2', expectedVersion: 3 });
    expect(capturedOut).toContain('version=4');
  });

  it('enforces shared-machine authority parity across direct CLI and MCP and fails closed on incomplete/broken/spoofed session context', async () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'imcodes-cdoc-sma-home-'));
    const altHome = mkdtempSync(join(tmpdir(), 'imcodes-cdoc-sma-alt-'));
    writeFileSync(
      join(stateHome, 'server.json'),
      JSON.stringify({ workerUrl: baseUrl, serverId: 'srv-state', token: 'tok-state' }),
    );
    writeFileSync(
      join(altHome, 'server.json'),
      JSON.stringify({ workerUrl: baseUrl, serverId: 'srv-alt', token: 'tok-alt' }),
    );

    const writeSessions = (records: Array<{ name: string; state: string; sessionInstanceId: string; runtimeEpoch: string }>) => {
      const sessions: Record<string, unknown> = {};
      for (const r of records) {
        sessions[r.name] = {
          name: r.name,
          projectName: 'proj',
          role: 'w1',
          agentType: 'claude-code',
          projectDir: workDir,
          state: r.state,
          sessionInstanceId: r.sessionInstanceId,
          runtimeEpoch: r.runtimeEpoch,
          createdAt: 1,
          updatedAt: 2,
          restarts: 0,
        };
      }
      writeFileSync(join(stateHome, 'sessions.json'), JSON.stringify({ sessions }));
    };

    writeSessions([{
      name: 'deck_sub_shared_1',
      state: 'running',
      sessionInstanceId: 'inst-shared-1',
      runtimeEpoch: 'epoch-1',
    }]);

    let hookCalls = 0;
    let hookResponder: (body: Record<string, unknown>, headers: http.IncomingHttpHeaders) => {
      status: number;
      json: unknown;
    } = (body, headers) => {
      expect(headers[HOOK_SESSION_CREDENTIAL_HEADER.toLowerCase()]).toBe('cred-secret-1');
      if (body.runtimeEpoch === 'epoch-old') {
        return {
          status: 409,
          json: { ok: false, error: SHARED_MACHINE_AUTHORITY_STALE_RUNTIME_ERROR },
        };
      }
      return {
        status: 200,
        json: { ok: true, required: true, authority: `sma-signed-${String(body.runtimeEpoch)}` },
      };
    };

    const identity = currentDaemonProcessIdentity();
    let hookPort = 0;
    const hookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === HOOK_IDENTITY_HOOK_PATH) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            version: HOOK_AUTHORITY_RECORD_VERSION,
            port: hookPort,
            pid: identity.pid,
            startToken: identity.startToken,
          }));
          return;
        }
        if (req.url === SHARED_MACHINE_AUTHORITY_HOOK_PATH) {
          hookCalls += 1;
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
          const reply = hookResponder(body, req.headers);
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(reply.json));
          return;
        }
        res.writeHead(404).end();
      });
    });

    await new Promise<void>((resolveListen) => hookServer.listen(0, '127.0.0.1', () => resolveListen()));
    const hookAddr = hookServer.address();
    if (!hookAddr || typeof hookAddr === 'string') throw new Error('Failed to bind mock hook server');
    hookPort = hookAddr.port;
    const published = await publishHookAuthority(hookPort, { home: stateHome });
    expect(published.published).toBe(true);

    const baseSharedEnv: NodeJS.ProcessEnv = {
      IMCODES_HOME: stateHome,
      [IMCODES_SESSION_ENV]: 'deck_sub_shared_1',
      [IMCODES_DAEMON_SESSION_NAME_ENV]: 'deck_sub_shared_1',
      [SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]: 'inst-shared-1',
      [SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]: 'epoch-1',
      [HOOK_SESSION_CREDENTIAL_ENV]: 'cred-secret-1',
      [IMCODES_MCP_TOOL_CATALOG_MODE_ENV]: 'static_full',
    };

    try {
      // 1. Direct CLI and real createMemoryMcpServerFromEnv send IDENTICAL X-IMCodes-Shared-Machine-Authority
      const directRes = await runCloudDocsCli(['list'], { env: baseSharedEnv });
      expect(directRes.exitCode).toBe(0);
      const directHeader = recorded.at(-1)?.headers[SHARED_MACHINE_AUTHORITY_HEADER.toLowerCase()];
      expect(directHeader).toBe('sma-signed-epoch-1');

      const mcpServer = createMemoryMcpServerFromEnv({ env: baseSharedEnv });
      const client = new Client({ name: 'sma-parity-client', version: '1.0.0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(ct), mcpServer.connect(st)]);
      try {
        const mcpRes = await client.callTool({
          name: MEMORY_MCP_TOOL_NAMES.CLOUD_DOCS,
          arguments: { args: ['list'] },
        });
        expect(mcpRes.isError).not.toBe(true);
        expect(recorded.at(-1)?.headers[SHARED_MACHINE_AUTHORITY_HEADER.toLowerCase()]).toBe(directHeader);
      } finally {
        await client.close();
        await mcpServer.close();
      }

      // 2. Owner context (no session markers) succeeds without X-IMCodes-Shared-Machine-Authority
      const ownerRes = await runCloudDocsCli(['list'], { env: { IMCODES_HOME: stateHome } });
      expect(ownerRes.exitCode).toBe(0);
      expect(recorded.at(-1)?.headers[SHARED_MACHINE_AUTHORITY_HEADER.toLowerCase()]).toBeUndefined();

      // 3. Stale runtime epoch (409) recovers via active sessions.json lookup when instanceId matches
      writeSessions([{
        name: 'deck_sub_shared_1',
        state: 'running',
        sessionInstanceId: 'inst-shared-1',
        runtimeEpoch: 'epoch-2',
      }]);
      const refreshedRes = await runCloudDocsCli(['list'], {
        env: { ...baseSharedEnv, [SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]: 'epoch-old' },
      });
      expect(refreshedRes.exitCode).toBe(0);
      expect(recorded.at(-1)?.headers[SHARED_MACHINE_AUTHORITY_HEADER.toLowerCase()]).toBe('sma-signed-epoch-2');

      // 4. Fail-closed checks: ALL must exit non-zero and make ZERO Cloud Docs HTTP requests
      const countBeforeFailClosed = recorded.length;

      // 4a. Incomplete session marker (IMCODES_SESSION alone without instance/epoch)
      const incomplete = await runCloudDocsCli(['list'], {
        env: { IMCODES_HOME: stateHome, [IMCODES_SESSION_ENV]: 'deck_sub_shared_1' },
      });
      expect(incomplete.exitCode).toBe(1);

      // 4b. Explicit --home / flags / env overrides inside broken session CANNOT bypass verification
      const bypassAttempts = [
        ['list', '--home', altHome],
        ['list', '--server-url', baseUrl, '--server-id', 'srv-flag', '--token', 'tok-flag'],
      ];
      for (const argv of bypassAttempts) {
        const res = await runCloudDocsCli(argv, {
          env: {
            IMCODES_HOME: stateHome,
            IMCODES_SERVER_URL: baseUrl,
            IMCODES_SERVER_ID: 'srv-env',
            IMCODES_TOKEN: 'tok-env',
            [IMCODES_SESSION_ENV]: 'deck_sub_shared_1',
          },
        });
        expect(res.exitCode).toBe(1);
      }

      // 4c. Forged actor/authority flags are rejected
      const forgedActor = await runCloudDocsCli(['list', '--actor', 'owner'], { env: baseSharedEnv });
      expect(forgedActor.exitCode).toBe(1);
      const forgedSma = await runCloudDocsCli(['list', '--shared-authority', 'forged'], { env: baseSharedEnv });
      expect(forgedSma.exitCode).toBe(1);

      // 4d. 409 refresh with mismatched sessionInstanceId fails closed
      writeSessions([{
        name: 'deck_sub_shared_1',
        state: 'running',
        sessionInstanceId: 'different-inst',
        runtimeEpoch: 'epoch-2',
      }]);
      const mismatchedInst = await runCloudDocsCli(['list'], {
        env: { ...baseSharedEnv, [SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]: 'epoch-old' },
      });
      expect(mismatchedInst.exitCode).toBe(1);

      // 4e. 409 refresh with stopped session fails closed
      writeSessions([{
        name: 'deck_sub_shared_1',
        state: 'stopped',
        sessionInstanceId: 'inst-shared-1',
        runtimeEpoch: 'epoch-2',
      }]);
      const stoppedSession = await runCloudDocsCli(['list'], {
        env: { ...baseSharedEnv, [SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]: 'epoch-old' },
      });
      expect(stoppedSession.exitCode).toBe(1);

      // 4f. Invalid hook response fails closed
      hookResponder = () => ({ status: 200, json: { ok: true, required: true, authority: null } });
      const badHookReply = await runCloudDocsCli(['list'], { env: baseSharedEnv });
      expect(badHookReply.exitCode).toBe(1);

      // 4g. Unavailable hook (altHome with no hook-port) fails closed inside session context
      const unavailableHook = await runCloudDocsCli(['list'], {
        env: { ...baseSharedEnv, IMCODES_HOME: altHome },
      });
      expect(unavailableHook.exitCode).toBe(1);

      expect(recorded.length).toBe(countBeforeFailClosed);

      // 5. Offline docs and --help work inside a broken session with ZERO hook/HTTP calls
      const hookCallsBeforeOffline = hookCalls;
      const offlineDocs = await runCloudDocsCli(['docs', '--topic', 'share'], {
        env: { IMCODES_HOME: altHome, [IMCODES_SESSION_ENV]: 'deck_sub_shared_1' },
      });
      expect(offlineDocs.exitCode).toBe(0);
      expect(offlineDocs.stdout).toContain('share grant --id');
      const offlineHelp = await runCloudDocsCli(['--help'], {
        env: { IMCODES_HOME: altHome, [IMCODES_SESSION_ENV]: 'deck_sub_shared_1' },
      });
      expect(offlineHelp.exitCode).toBe(0);
      expect(hookCalls).toBe(hookCallsBeforeOffline);
      expect(recorded.length).toBe(countBeforeFailClosed);
    } finally {
      await new Promise<void>((resolveClose) => hookServer.close(() => resolveClose()));
      rmSync(stateHome, { recursive: true, force: true });
      rmSync(altHome, { recursive: true, force: true });
    }
  });

  it('rejects contradictory save/export/version combinations pre-flight with zero HTTP requests', async () => {
    const authEnv = { IMCODES_SERVER_URL: baseUrl, IMCODES_SERVER_ID: 'srv-1', IMCODES_TOKEN: 'tok-1' };
    const localSrc = join(workDir, 'src.docx');
    const localOut = join(workDir, 'export.docx');
    writeFileSync(localSrc, Buffer.from('PK-src', 'utf8'));

    const invalidCases: string[][] = [
      ['builder', '--type', 'docx', '--script', 'builder.CreateFile("docx");', '--no-save'],
      ['builder', '--type', 'docx', '--script', 'builder.CreateFile("docx");', '--no-save', '--out', localOut],
      ['builder', '--type', 'docx', '--script', 'builder.CreateFile("docx");', '--out', localOut],
      ['builder', '--type', 'docx', '--script', 'builder.CreateFile("docx");', '--version', '2'],
      ['builder', 'doc-1', '--script', 'Api.Save();', '--out', localOut],
      ['builder', 'doc-1', '--script', 'Api.Save();', '--save', '--out', localOut],
      ['convert', 'doc-1', '--to', 'pdf', '--save-as-new', '--out', localOut],
      ['upload', localSrc, '--version', '2'],
      ['edit', 'doc-1', '--file', localSrc, '--timeout-ms', '5000'],
    ];

    for (const argv of invalidCases) {
      const res = await runCloudDocsCli(argv, { env: authEnv });
      expect(res.exitCode, `Expected failure for ${argv.join(' ')}`).toBe(1);
      expect(res.errorReason).toBe(MCP_ERROR_REASONS.VALIDATION_FAILED);
      expect(existsSync(localOut)).toBe(false);
    }
    expect(recorded).toHaveLength(0);

    // Positive controls: normal create save and existing-doc --no-save --out still succeed accurately
    responder = () => ({ status: 201, json: { doc: { id: 'doc-new', name: 'Saved.docx', ext: '.docx', docVersion: 1 }, bytesWritten: 120 } });
    const createOk = await runCloudDocsCli(['builder', '--type', 'docx', '--name', 'Saved.docx', '--script', 'builder.CreateFile("docx");'], { env: authEnv });
    expect(createOk.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/docbuilder');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toEqual({ type: 'docx', name: 'Saved.docx', script: 'builder.CreateFile("docx");' });

    const exportBytes = Buffer.from('PK-exported', 'utf8');
    responder = () => ({
      status: 200,
      json: {
        doc: { id: 'doc-1', name: 'Saved.docx', ext: '.docx', docVersion: 1 },
        bytesBase64: exportBytes.toString('base64'),
        outputName: 'export.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytesWritten: exportBytes.length,
      },
    });
    const exportOk = await runCloudDocsCli(['builder', 'doc-1', '--no-save', '--out', localOut, '--script', 'Api.GetDocument();'], { env: authEnv });
    expect(exportOk.exitCode).toBe(0);
    expect(recorded.at(-1)?.url).toBe('/api/cloud-docs/doc-1/docbuilder');
    expect(JSON.parse(recorded.at(-1)!.bodyText)).toMatchObject({ save: false });
    expect(readFileSync(localOut).equals(exportBytes)).toBe(true);

    const editGuide = await runCloudDocsCli(['docs', '--topic', 'edit'], { env: {} });
    expect(editGuide.exitCode).toBe(0);
    expect(editGuide.stdout).toContain('--no-save and --out require an existing <docId>');
  });
});
