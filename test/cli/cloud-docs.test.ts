import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLOUD_DOC_ERROR_CODES,
} from '../../shared/cloud-docs.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { runCloudDocsCli, splitCliArgs } from '../../src/cli/cloud-docs.js';
import { createProgram } from '../../src/cli.js';
import { sanitizeCloudDocTransferFilename } from '../../src/daemon/cloud-docs-mcp-client.js';

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
});
