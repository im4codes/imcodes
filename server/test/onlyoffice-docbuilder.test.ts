import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOUD_DOCS_MAX_UPLOAD_BYTES,
  CLOUD_DOC_ERROR_CODES,
} from '../../shared/cloud-docs.js';
import { verifyJwt } from '../src/security/crypto.js';
import {
  OnlyOfficeServiceError,
  clearEphemeralDocBuilderScriptsForTests,
  consumeEphemeralDocBuilderScript,
  convertViaOnlyOfficeConverter,
  executeOnlyOfficeDocBuilder,
  selectDocBuilderOutputCandidate,
  signDocBuilderScriptToken,
  storeEphemeralDocBuilderScript,
  verifyDocBuilderScriptToken,
} from '../src/services/onlyoffice-docbuilder.js';

const JWT_KEY = 'docbuilder-service-test-signing-key-32chars!';
const OO_SECRET = 'docbuilder-onlyoffice-jwt-secret-32chars!';

interface MockHttpServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startMockServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void | Promise<void>,
): Promise<MockHttpServer> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      Promise.resolve(handler(req, body, res)).catch((err) => {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : 'mock_error');
      });
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind mock server');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('onlyoffice-docbuilder service', () => {
  const servers: MockHttpServer[] = [];

  afterEach(async () => {
    clearEphemeralDocBuilderScriptsForTests();
    while (servers.length > 0) {
      const s = servers.pop()!;
      await s.close();
    }
  });

  it('stores, signs, verifies, and consumes ephemeral scripts once within TTL', async () => {
    const scriptId = storeEphemeralDocBuilderScript('builder.CreateFile("docx");', 5000);
    const token = signDocBuilderScriptToken(scriptId, JWT_KEY, 60);
    const claims = verifyDocBuilderScriptToken(token, JWT_KEY);
    expect(claims?.scriptId).toBe(scriptId);
    expect(verifyDocBuilderScriptToken(`${token}tampered`, JWT_KEY)).toBeNull();

    // Peek does not consume
    expect(consumeEphemeralDocBuilderScript(scriptId, { peekOnly: true })).toBe('builder.CreateFile("docx");');
    // Consume returns once then null
    expect(consumeEphemeralDocBuilderScript(scriptId)).toBe('builder.CreateFile("docx");');
    expect(consumeEphemeralDocBuilderScript(scriptId)).toBeNull();

    // Expired script returns null
    const expiredId = storeEphemeralDocBuilderScript('expired();', 10);
    await new Promise((r) => setTimeout(r, 25));
    expect(consumeEphemeralDocBuilderScript(expiredId)).toBeNull();
  });

  it('fails explicitly with onlyoffice_disabled when disabled and no CLI bin configured', async () => {
    await expect(
      executeOnlyOfficeDocBuilder({
        env: {
          ONLYOFFICE_ENABLED: 'false',
          ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice:80',
          ONLYOFFICE_JWT_SECRET: OO_SECRET,
          SERVER_URL: 'http://localhost:19138',
          JWT_SIGNING_KEY: JWT_KEY,
        },
        script: 'builder.CreateFile("docx");',
      }),
    ).rejects.toMatchObject({
      code: CLOUD_DOC_ERROR_CODES.ONLYOFFICE_DISABLED,
      statusCode: 503,
    });

    await expect(
      convertViaOnlyOfficeConverter({
        env: {
          ONLYOFFICE_ENABLED: 'false',
          ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice:80',
          ONLYOFFICE_JWT_SECRET: OO_SECRET,
          SERVER_URL: 'http://localhost:19138',
          JWT_SIGNING_KEY: JWT_KEY,
        },
        fileUrl: 'http://localhost:19138/api/cloud-docs/onlyoffice/file/tok',
        filetype: 'docx',
        outputtype: 'pdf',
        title: 'doc.docx',
        key: 'k1',
      }),
    ).rejects.toMatchObject({
      code: CLOUD_DOC_ERROR_CODES.ONLYOFFICE_DISABLED,
      statusCode: 503,
    });
  });

  it('executes /docbuilder with JWT in both header and body, async polling, Argument passthrough, and origin normalization', async () => {
    const requests: Array<{ path: string; authHeader?: string; body: Record<string, unknown> }> = [];
    let pollCount = 0;
    const expectedBytes = Buffer.from('PK\x03\x04generated-docx-bytes');

    const mockOo = await startMockServer((req, rawBody, res) => {
      if (req.method === 'POST' && req.url === '/docbuilder') {
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        requests.push({ path: req.url, authHeader: req.headers.authorization, body });

        // Verify JWT in both Authorization header ({ payload }) and body.token (flat)
        const bearer = req.headers.authorization?.replace(/^Bearer\s+/, '') ?? '';
        const decodedHeader = verifyJwt(bearer, OO_SECRET);
        const decodedBody = verifyJwt(String(body.token ?? ''), OO_SECRET);
        expect(decodedHeader?.payload).toBeTruthy();
        expect(decodedBody).toBeTruthy();
        expect((decodedHeader!.payload as Record<string, unknown>).async).toBe(true);
        expect(decodedBody!.async).toBe(true);

        if (!body.key) {
          expect(String(body.url)).toContain('/api/cloud-docs/onlyoffice/script/');
          expect(body.argument).toEqual({ title: 'Quarterly Report', count: 42 });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ key: 'job-123', end: false }));
          return;
        }

        pollCount += 1;
        if (pollCount === 1) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ key: 'job-123', end: false }));
          return;
        }

        // Return URL under ONLYOFFICE_PUBLIC_URL to verify origin normalization back to internalUrl!
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 0,
            key: 'job-123',
            end: true,
            urls: {
              'report.docx': 'https://public.example.com/onlyoffice/cache/files/job-123/report.docx',
            },
          }),
        );
        return;
      }

      if (req.method === 'GET' && req.url === '/cache/files/job-123/report.docx') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(expectedBytes);
        return;
      }

      res.statusCode = 404;
      res.end('not_found');
    });
    servers.push(mockOo);

    const result = await executeOnlyOfficeDocBuilder({
      env: {
        ONLYOFFICE_ENABLED: 'true',
        ONLYOFFICE_INTERNAL_URL: mockOo.baseUrl,
        ONLYOFFICE_PUBLIC_URL: 'https://public.example.com/onlyoffice',
        ONLYOFFICE_JWT_SECRET: OO_SECRET,
        SERVER_URL: 'http://127.0.0.1:19138',
        JWT_SIGNING_KEY: JWT_KEY,
      },
      script: 'builder.CreateFile("docx");',
      argument: { title: 'Quarterly Report', count: 42 },
      requiredExt: '.docx',
      timeoutMs: 5000,
    });

    expect(requests).toHaveLength(3);
    expect(result.outputName).toBe('report.docx');
    expect(result.bytes.equals(expectedBytes)).toBe(true);
    expect(result.mimeType).toContain('wordprocessingml.document');
  });

  it('rejects untrusted download URLs and maps ONLYOFFICE error codes cleanly', async () => {
    const mockOo = await startMockServer((req, _rawBody, res) => {
      if (req.url === '/docbuilder') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            end: true,
            urls: {
              'evil.docx': 'https://evil.attacker.invalid/secret.docx',
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(mockOo);

    await expect(
      executeOnlyOfficeDocBuilder({
        env: {
          ONLYOFFICE_ENABLED: 'true',
          ONLYOFFICE_INTERNAL_URL: mockOo.baseUrl,
          ONLYOFFICE_PUBLIC_URL: 'https://public.example.com/onlyoffice',
          ONLYOFFICE_JWT_SECRET: OO_SECRET,
          SERVER_URL: 'http://127.0.0.1:19138',
          JWT_SIGNING_KEY: JWT_KEY,
        },
        script: 'builder.CreateFile("docx");',
      }),
    ).rejects.toMatchObject({
      code: CLOUD_DOC_ERROR_CODES.UNTRUSTED_DOWNLOAD_URL,
      statusCode: 502,
    });

    const mockErrOo = await startMockServer((_req, _rawBody, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: -3 }));
    });
    servers.push(mockErrOo);

    await expect(
      executeOnlyOfficeDocBuilder({
        env: {
          ONLYOFFICE_ENABLED: 'true',
          ONLYOFFICE_INTERNAL_URL: mockErrOo.baseUrl,
          ONLYOFFICE_JWT_SECRET: OO_SECRET,
          SERVER_URL: 'http://127.0.0.1:19138',
          JWT_SIGNING_KEY: JWT_KEY,
        },
        script: 'broken();',
      }),
    ).rejects.toMatchObject({
      code: CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED,
      onlyofficeErrorCode: -3,
      statusCode: 502,
    });
  });

  it('enforces DocBuilder timeout when async polling never finishes', async () => {
    const mockSlowOo = await startMockServer((_req, _rawBody, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ key: 'slow-job', end: false }));
    });
    servers.push(mockSlowOo);

    await expect(
      executeOnlyOfficeDocBuilder({
        env: {
          ONLYOFFICE_ENABLED: 'true',
          ONLYOFFICE_INTERNAL_URL: mockSlowOo.baseUrl,
          ONLYOFFICE_JWT_SECRET: OO_SECRET,
          SERVER_URL: 'http://127.0.0.1:19138',
          JWT_SIGNING_KEY: JWT_KEY,
        },
        script: 'builder.CreateFile("docx");',
        timeoutMs: 150,
      }),
    ).rejects.toMatchObject({
      code: CLOUD_DOC_ERROR_CODES.DOCBUILDER_TIMEOUT,
      statusCode: 504,
    });
  });

  it('rejects mismatched fileType from /ConvertService.ashx before downloading bytes', async () => {
    const mockOo = await startMockServer((req, _rawBody, res) => {
      if (req.url === '/ConvertService.ashx') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            endConvert: true,
            percent: 100,
            fileType: 'docx',
            fileUrl: `${mockOo.baseUrl}/cache/conv/wrong.docx`,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(mockOo);

    await expect(
      convertViaOnlyOfficeConverter({
        env: {
          ONLYOFFICE_ENABLED: 'true',
          ONLYOFFICE_INTERNAL_URL: mockOo.baseUrl,
          ONLYOFFICE_JWT_SECRET: OO_SECRET,
          SERVER_URL: 'http://127.0.0.1:19138',
          JWT_SIGNING_KEY: JWT_KEY,
        },
        fileUrl: 'http://127.0.0.1:19138/api/cloud-docs/onlyoffice/file/tok',
        filetype: 'docx',
        outputtype: 'pdf',
        title: 'Mismatch.docx',
        key: 'conv-mismatch',
      }),
    ).rejects.toMatchObject({
      code: CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
      statusCode: 422,
    });
  });

  it('enforces strict outputName and requiredExt selection across HTTP multi-output and mismatch errors', async () => {
    const docxBytes = Buffer.from('PK\x03\x04docx');
    const pdfBytes = Buffer.from('%PDF-1.7\n');

    expect(
      selectDocBuilderOutputCandidate(
        [{ name: 'first.docx' }, { name: 'second.pdf' }],
        { requiredExt: '.pdf' },
      ).name,
    ).toBe('second.pdf');
    expect(
      selectDocBuilderOutputCandidate(
        [{ name: 'first.docx' }, { name: 'second.pdf' }],
        {},
      ).name,
    ).toBe('first.docx');
    expect(() =>
      selectDocBuilderOutputCandidate([{ name: 'first.docx' }], { requiredExt: '.pdf' }),
    ).toThrowError(OnlyOfficeServiceError);
    expect(() =>
      selectDocBuilderOutputCandidate([{ name: 'first.docx' }], { outputName: 'missing.docx' }),
    ).toThrowError(OnlyOfficeServiceError);
    expect(() =>
      selectDocBuilderOutputCandidate(
        [{ name: 'custom.docx' }],
        { outputName: 'custom.docx', requiredExt: '.pdf' },
      ),
    ).toThrowError(OnlyOfficeServiceError);

    const mockOo = await startMockServer((req, _rawBody, res) => {
      if (req.url === '/docbuilder') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 0,
            end: true,
            urls: {
              'generated.docx': `${mockOo.baseUrl}/cache/generated.docx`,
              'summary.pdf': `${mockOo.baseUrl}/cache/summary.pdf`,
            },
          }),
        );
        return;
      }
      if (req.url === '/cache/generated.docx') {
        res.end(docxBytes);
        return;
      }
      if (req.url === '/cache/summary.pdf') {
        res.end(pdfBytes);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(mockOo);

    const env = {
      ONLYOFFICE_ENABLED: 'true',
      ONLYOFFICE_INTERNAL_URL: mockOo.baseUrl,
      ONLYOFFICE_JWT_SECRET: OO_SECRET,
      SERVER_URL: 'http://127.0.0.1:19138',
      JWT_SIGNING_KEY: JWT_KEY,
    };

    const pickedPdf = await executeOnlyOfficeDocBuilder({
      env,
      script: 'builder.CreateFile("docx");',
      requiredExt: '.pdf',
    });
    expect(pickedPdf.outputName).toBe('summary.pdf');
    expect(pickedPdf.bytes.equals(pdfBytes)).toBe(true);

    await expect(
      executeOnlyOfficeDocBuilder({
        env,
        script: 'builder.CreateFile("docx");',
        requiredExt: '.xlsx',
      }),
    ).rejects.toMatchObject({
      code: CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
      statusCode: 422,
    });

    await expect(
      executeOnlyOfficeDocBuilder({
        env,
        script: 'builder.CreateFile("docx");',
        outputName: 'nonexistent.docx',
      }),
    ).rejects.toMatchObject({
      code: CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
      statusCode: 422,
    });
  });

  it('converts documents via /ConvertService.ashx with JWT, polling, and origin normalization', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n%mock-converted-pdf\n');
    let calls = 0;

    const mockOo = await startMockServer((req, rawBody, res) => {
      if (req.method === 'POST' && req.url === '/ConvertService.ashx') {
        calls += 1;
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        const bearer = req.headers.authorization?.replace(/^Bearer\s+/, '') ?? '';
        const decodedHeader = verifyJwt(bearer, OO_SECRET);
        const decodedBody = verifyJwt(String(body.token ?? ''), OO_SECRET);
        expect((decodedHeader?.payload as Record<string, unknown>)?.outputtype).toBe('pdf');
        expect(decodedBody?.filetype).toBe('docx');
        expect(decodedBody?.outputtype).toBe('pdf');

        if (calls === 1) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ endConvert: false, percent: 45 }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            endConvert: true,
            percent: 100,
            fileType: 'pdf',
            fileUrl: 'https://public.example.com/onlyoffice/cache/conv/output.pdf',
          }),
        );
        return;
      }

      if (req.method === 'GET' && req.url === '/cache/conv/output.pdf') {
        res.statusCode = 200;
        res.end(pdfBytes);
        return;
      }

      res.statusCode = 404;
      res.end();
    });
    servers.push(mockOo);

    const converted = await convertViaOnlyOfficeConverter({
      env: {
        ONLYOFFICE_ENABLED: 'true',
        ONLYOFFICE_INTERNAL_URL: mockOo.baseUrl,
        ONLYOFFICE_PUBLIC_URL: 'https://public.example.com/onlyoffice',
        ONLYOFFICE_JWT_SECRET: OO_SECRET,
        SERVER_URL: 'http://127.0.0.1:19138',
        JWT_SIGNING_KEY: JWT_KEY,
      },
      fileUrl: 'http://127.0.0.1:19138/api/cloud-docs/onlyoffice/file/tok',
      filetype: 'docx',
      outputtype: 'pdf',
      title: 'Plan.docx',
      key: 'conv-key-1',
    });

    expect(calls).toBe(2);
    expect(converted.fileType).toBe('pdf');
    expect(converted.mimeType).toBe('application/pdf');
    expect(converted.bytes.equals(pdfBytes)).toBe(true);
  });

  it('rejects oversized converted output exceeding CLOUD_DOCS_MAX_UPLOAD_BYTES', async () => {
    const mockOo = await startMockServer((req, _rawBody, res) => {
      if (req.url === '/ConvertService.ashx') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            endConvert: true,
            fileType: 'pdf',
            fileUrl: `${mockOo.baseUrl}/cache/huge.pdf`,
          }),
        );
        return;
      }
      if (req.url === '/cache/huge.pdf') {
        res.statusCode = 200;
        res.setHeader('Content-Length', String(CLOUD_DOCS_MAX_UPLOAD_BYTES + 1));
        res.end(Buffer.alloc(1024));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(mockOo);

    await expect(
      convertViaOnlyOfficeConverter({
        env: {
          ONLYOFFICE_ENABLED: 'true',
          ONLYOFFICE_INTERNAL_URL: mockOo.baseUrl,
          ONLYOFFICE_JWT_SECRET: OO_SECRET,
          SERVER_URL: 'http://127.0.0.1:19138',
          JWT_SIGNING_KEY: JWT_KEY,
        },
        fileUrl: 'http://127.0.0.1:19138/api/cloud-docs/onlyoffice/file/tok',
        filetype: 'docx',
        outputtype: 'pdf',
        title: 'Big.docx',
        key: 'conv-big',
      }),
    ).rejects.toThrow(OnlyOfficeServiceError);
  });
});
