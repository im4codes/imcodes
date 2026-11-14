import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  CLOUD_DOCS_MAX_UPLOAD_BYTES,
  CLOUD_DOCS_ONLYOFFICE_SCRIPT_PATH,
  CLOUD_DOC_DOCBUILDER_DEFAULT_TIMEOUT_MS,
  CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS,
  CLOUD_DOC_DOCBUILDER_POLL_INTERVAL_MS,
  CLOUD_DOC_DOCBUILDER_SCRIPT_TTL_MS,
  CLOUD_DOC_CONVERT_DEFAULT_TIMEOUT_MS,
  CLOUD_DOC_CONVERT_MAX_TIMEOUT_MS,
  CLOUD_DOC_ERROR_CODES,
  getCloudDocExt,
  getCloudDocMeta,
} from '../../../shared/cloud-docs.js';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { resolveOnlyOfficeJwtSecret, resolveTrustedOnlyOfficeDownloadUrl } from '../routes/onlyoffice.js';
import { signJwt, verifyJwt } from '../security/crypto.js';
import { PayloadTooLargeError, readResponseBytesBounded } from '../util/bounded-stream.js';

const EPHEMERAL_SCRIPT_MAX_ENTRIES = 1024;

interface EphemeralScriptEntry {
  script: string;
  expiresAt: number;
}

const ephemeralScripts = new Map<string, EphemeralScriptEntry>();

export interface DocBuilderScriptStore {
  put(script: string, ttlMs: number): Promise<string> | string;
  consume(scriptId: string, options?: { peekOnly?: boolean }): Promise<string | null> | string | null;
  remove(scriptId: string): Promise<void> | void;
}

export class OnlyOfficeServiceError extends Error {
  readonly code: string;
  readonly statusCode: 400 | 413 | 422 | 502 | 503 | 504;
  readonly onlyofficeErrorCode?: number;

  constructor(
    code: string,
    message: string,
    statusCode: 400 | 413 | 422 | 502 | 503 | 504 = 502,
    onlyofficeErrorCode?: number,
  ) {
    super(message);
    this.name = 'OnlyOfficeServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.onlyofficeErrorCode = onlyofficeErrorCode;
  }
}

export interface DocBuilderScriptTokenClaims {
  type: 'onlyoffice-docbuilder-script';
  scriptId: string;
  iat?: number;
  exp?: number;
}

function pruneExpiredScripts(now = Date.now()): void {
  for (const [id, entry] of ephemeralScripts.entries()) {
    if (entry.expiresAt <= now) {
      ephemeralScripts.delete(id);
    }
  }
  while (ephemeralScripts.size >= EPHEMERAL_SCRIPT_MAX_ENTRIES) {
    const oldestKey = ephemeralScripts.keys().next().value;
    if (!oldestKey) break;
    ephemeralScripts.delete(oldestKey);
  }
}

export function storeEphemeralDocBuilderScript(
  script: string,
  ttlMs = CLOUD_DOC_DOCBUILDER_SCRIPT_TTL_MS,
): string {
  const now = Date.now();
  pruneExpiredScripts(now);
  const scriptId = `dbs_${randomUUID().replace(/-/g, '')}`;
  ephemeralScripts.set(scriptId, {
    script,
    expiresAt: now + ttlMs,
  });
  return scriptId;
}

export function consumeEphemeralDocBuilderScript(
  scriptId: string,
  options: { peekOnly?: boolean } = {},
): string | null {
  const entry = ephemeralScripts.get(scriptId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    ephemeralScripts.delete(scriptId);
    return null;
  }
  if (!options.peekOnly) {
    ephemeralScripts.delete(scriptId);
  }
  return entry.script;
}

export function deleteEphemeralDocBuilderScript(scriptId: string): void {
  ephemeralScripts.delete(scriptId);
}

export function clearEphemeralDocBuilderScriptsForTests(): void {
  ephemeralScripts.clear();
}

export const memoryDocBuilderScriptStore: DocBuilderScriptStore = {
  put: (script, ttlMs) => storeEphemeralDocBuilderScript(script, ttlMs),
  consume: (scriptId, options) => consumeEphemeralDocBuilderScript(scriptId, options),
  remove: (scriptId) => deleteEphemeralDocBuilderScript(scriptId),
};

export function createDbDocBuilderScriptStore(db: Database): DocBuilderScriptStore {
  return {
    async put(script: string, ttlMs: number): Promise<string> {
      const now = Date.now();
      const scriptId = `dbs_${randomUUID().replace(/-/g, '')}`;
      await db.execute('DELETE FROM onlyoffice_docbuilder_scripts WHERE expires_at <= $1', [now]);
      await db.execute(
        `INSERT INTO onlyoffice_docbuilder_scripts (id, script, expires_at, created_at)
         VALUES ($1, $2, $3, $4)`,
        [scriptId, script, now + ttlMs, now],
      );
      return scriptId;
    },
    async consume(scriptId: string, options: { peekOnly?: boolean } = {}): Promise<string | null> {
      const now = Date.now();
      if (options.peekOnly) {
        const row = await db.queryOne<{ script: string }>(
          'SELECT script FROM onlyoffice_docbuilder_scripts WHERE id = $1 AND expires_at > $2',
          [scriptId, now],
        );
        return row?.script ?? null;
      }
      const row = await db.queryOne<{ script: string }>(
        'DELETE FROM onlyoffice_docbuilder_scripts WHERE id = $1 AND expires_at > $2 RETURNING script',
        [scriptId, now],
      );
      return row?.script ?? null;
    },
    async remove(scriptId: string): Promise<void> {
      await db.execute('DELETE FROM onlyoffice_docbuilder_scripts WHERE id = $1', [scriptId]).catch(() => {});
    },
  };
}

export function signDocBuilderScriptToken(
  scriptId: string,
  signingKey: string,
  ttlSeconds = Math.ceil(CLOUD_DOC_DOCBUILDER_SCRIPT_TTL_MS / 1000),
): string {
  return signJwt(
    {
      type: 'onlyoffice-docbuilder-script',
      scriptId,
    },
    signingKey,
    ttlSeconds,
  );
}

export function verifyDocBuilderScriptToken(
  token: string,
  signingKey: string,
): DocBuilderScriptTokenClaims | null {
  const payload = verifyJwt(token, signingKey);
  if (!payload || payload.type !== 'onlyoffice-docbuilder-script') return null;
  if (typeof payload.scriptId !== 'string' || !payload.scriptId.trim()) return null;
  return {
    type: 'onlyoffice-docbuilder-script',
    scriptId: payload.scriptId,
    iat: typeof payload.iat === 'number' ? payload.iat : undefined,
    exp: typeof payload.exp === 'number' ? payload.exp : undefined,
  };
}

export function resolveOnlyOfficeInternalBaseUrl(
  env: Pick<Env, 'ONLYOFFICE_INTERNAL_URL'>,
): string {
  return (env.ONLYOFFICE_INTERNAL_URL || 'http://onlyoffice:80').replace(/\/+$/, '');
}

export function getMimeTypeForFilename(filenameOrExt: string): string {
  const meta = getCloudDocMeta(filenameOrExt);
  if (meta) return meta.mimeType;
  const lower = filenameOrExt.trim().toLowerCase();
  const ext = lower.startsWith('.') ? lower : path.posix.extname(lower);
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function signOnlyOfficeServiceJwt(
  payload: Record<string, unknown>,
  ooSecret: string,
): { headerToken: string; bodyToken: string } {
  return {
    headerToken: signJwt({ payload }, ooSecret, 300),
    bodyToken: signJwt(payload, ooSecret, 300),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeDocBuilderError(code: number): string {
  switch (code) {
    case -1:
      return 'ONLYOFFICE DocBuilder unknown error (-1)';
    case -2:
      return 'ONLYOFFICE DocBuilder generation timeout (-2)';
    case -3:
      return 'ONLYOFFICE DocBuilder document generation error (-3)';
    case -4:
      return 'ONLYOFFICE DocBuilder failed to download script or input file (-4)';
    case -6:
      return 'ONLYOFFICE DocBuilder failed to access result database (-6)';
    case -8:
      return 'ONLYOFFICE DocBuilder invalid JWT token (-8)';
    default:
      return `ONLYOFFICE DocBuilder failed with error code ${code}`;
  }
}

function describeConverterError(code: number): string {
  switch (code) {
    case -1:
      return 'ONLYOFFICE Converter unknown error (-1)';
    case -2:
      return 'ONLYOFFICE Converter timeout (-2)';
    case -3:
      return 'ONLYOFFICE Converter conversion error (-3)';
    case -4:
      return 'ONLYOFFICE Converter failed to download source document (-4)';
    case -5:
      return 'ONLYOFFICE Converter incorrect password (-5)';
    case -6:
      return 'ONLYOFFICE Converter failed to access result database (-6)';
    case -7:
      return 'ONLYOFFICE Converter input error (-7)';
    case -8:
      return 'ONLYOFFICE Converter invalid JWT token (-8)';
    case -9:
      return 'ONLYOFFICE Converter unsupported output format (-9)';
    case -10:
      return 'ONLYOFFICE Converter size limit exceeded (-10)';
    default:
      return `ONLYOFFICE Converter failed with error code ${code}`;
  }
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  errorCode: string,
  timeoutErrorCode: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), Math.max(100, timeoutMs));
  try {
    const res = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OnlyOfficeServiceError(
        errorCode,
        `ONLYOFFICE service returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        res.status === 504 ? 504 : 502,
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof OnlyOfficeServiceError) throw err;
    if (controller.signal.aborted && controller.signal.reason === 'timeout') {
      throw new OnlyOfficeServiceError(timeoutErrorCode, 'ONLYOFFICE request timed out', 504);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new OnlyOfficeServiceError(errorCode, `ONLYOFFICE request failed: ${msg}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function downloadOnlyOfficeArtifact(
  rawUrl: string,
  env: Pick<Env, 'SERVER_URL' | 'ONLYOFFICE_PUBLIC_URL' | 'ONLYOFFICE_INTERNAL_URL'>,
  timeoutMs: number,
  failureCode: string,
): Promise<Buffer> {
  const trusted = resolveTrustedOnlyOfficeDownloadUrl(rawUrl, env);
  if (!trusted) {
    throw new OnlyOfficeServiceError(
      CLOUD_DOC_ERROR_CODES.UNTRUSTED_DOWNLOAD_URL,
      'ONLYOFFICE returned an untrusted download URL',
      502,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), Math.max(100, timeoutMs));
  try {
    let res: Response;
    try {
      res = await fetch(trusted.internalFetchUrl, {
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (fetchErr) {
      if (
        !controller.signal.aborted &&
        trusted.fallbackPublicUrl &&
        trusted.fallbackPublicUrl !== trusted.internalFetchUrl
      ) {
        res = await fetch(trusted.fallbackPublicUrl, {
          redirect: 'error',
          signal: controller.signal,
        });
      } else {
        throw fetchErr;
      }
    }

    if (!res.ok) {
      throw new OnlyOfficeServiceError(
        failureCode,
        `Failed to download ONLYOFFICE output (HTTP ${res.status})`,
        502,
      );
    }

    return await readResponseBytesBounded(res, CLOUD_DOCS_MAX_UPLOAD_BYTES, controller);
  } catch (err) {
    if (err instanceof OnlyOfficeServiceError) throw err;
    if (err instanceof PayloadTooLargeError) {
      throw new OnlyOfficeServiceError(
        CLOUD_DOC_ERROR_CODES.FILE_TOO_LARGE,
        'ONLYOFFICE output exceeds maximum allowed size',
        413,
      );
    }
    if (controller.signal.aborted && controller.signal.reason === 'timeout') {
      throw new OnlyOfficeServiceError(failureCode, 'Timed out downloading ONLYOFFICE output', 504);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new OnlyOfficeServiceError(failureCode, `Failed to download ONLYOFFICE output: ${msg}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

export interface ExecuteDocBuilderOptions {
  env: Pick<
    Env,
    | 'ONLYOFFICE_ENABLED'
    | 'ONLYOFFICE_INTERNAL_URL'
    | 'ONLYOFFICE_PUBLIC_URL'
    | 'ONLYOFFICE_JWT_SECRET'
    | 'SERVER_URL'
    | 'JWT_SIGNING_KEY'
  >;
  script: string;
  argument?: Record<string, unknown>;
  outputName?: string;
  requiredExt?: string;
  timeoutMs?: number;
  db?: Database;
  scriptStore?: DocBuilderScriptStore;
}

export interface ExecuteDocBuilderResult {
  bytes: Buffer;
  outputName: string;
  mimeType: string;
  onlyofficeUrls?: Record<string, string>;
}

interface DocBuilderHttpResponse {
  error?: number;
  key?: string;
  end?: boolean;
  urls?: Record<string, string>;
}

function normalizeExtConstraint(ext?: string): string | undefined {
  const trimmed = ext?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('.') ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
}

export function selectDocBuilderOutputCandidate<T extends { name: string }>(
  candidates: readonly T[],
  options: { outputName?: string; requiredExt?: string },
  sourceLabel = 'ONLYOFFICE DocBuilder',
): T {
  if (candidates.length === 0) {
    throw new OnlyOfficeServiceError(
      CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED,
      `${sourceLabel} produced no output files`,
      502,
    );
  }

  const reqExt = normalizeExtConstraint(options.requiredExt);
  if (options.outputName) {
    const target = options.outputName.trim();
    const targetBase = path.posix.basename(target);
    const match = candidates.find(
      (entry) => entry.name === target || path.posix.basename(entry.name) === targetBase,
    );
    if (!match) {
      throw new OnlyOfficeServiceError(
        CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
        `Requested output "${targetBase}" was not produced by ${sourceLabel}`,
        422,
      );
    }
    if (reqExt && getCloudDocExt(path.posix.basename(match.name)) !== reqExt) {
      throw new OnlyOfficeServiceError(
        CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
        `Output "${path.posix.basename(match.name)}" does not match required extension "${reqExt}"`,
        422,
      );
    }
    return match;
  }

  if (reqExt) {
    const byExt = candidates.find(
      (entry) => getCloudDocExt(path.posix.basename(entry.name)) === reqExt,
    );
    if (!byExt) {
      throw new OnlyOfficeServiceError(
        CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
        `${sourceLabel} produced no output matching required extension "${reqExt}"`,
        422,
      );
    }
    return byExt;
  }

  return candidates[0]!;
}

export interface PrepareOnlyOfficeDocBuilderScriptOptions {
  inputUrl?: string;
}

const INPUT_URL_PLACEHOLDER = '{{INPUT_URL}}';
const INPUT_URL_ARG_RE =
  /^(?:Argument\s*\.\s*(?:inputUrl|_imcodesInputUrl)|Argument\s*\[\s*(?:'inputUrl'|"inputUrl")\s*\])$/;
const REGEX_EXPR_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'default',
  'delete',
  'export',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);
const REGEX_STMT_PREFIX_KEYWORDS = new Set(['else', 'do']);
const CONTROL_HEADER_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

interface JsLexState {
  canStartRegex: boolean;
  afterDot: boolean;
  pendingControlParen: boolean;
  nextBraceIsObject: boolean;
  parenStack: Array<'control' | 'expr'>;
  braceStack: Array<'block' | 'object'>;
}

interface JsLexToken {
  text: string;
  nextIndex: number;
  punct: boolean;
}

function createLexState(insideExpression = false): JsLexState {
  return {
    canStartRegex: true,
    afterDot: false,
    pendingControlParen: false,
    nextBraceIsObject: insideExpression,
    parenStack: [],
    braceStack: [],
  };
}

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_$]/.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9]/.test(ch);
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function escapeJsStringBody(value: string, quote: '"' | "'" | '`'): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\u2028':
        out += '\\u2028';
        break;
      case '\u2029':
        out += '\\u2029';
        break;
      case quote:
        out += `\\${quote}`;
        break;
      case '$':
        out += quote === '`' ? '\\$' : '$';
        break;
      default: {
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
      }
    }
  }
  return out;
}

function scanLineComment(src: string, start: number): { text: string; nextIndex: number } {
  let i = start + 2;
  while (i < src.length && src[i] !== '\n' && src[i] !== '\r') {
    i += 1;
  }
  return { text: src.slice(start, i), nextIndex: i };
}

function scanBlockComment(src: string, start: number): { text: string; nextIndex: number } {
  const closeIdx = src.indexOf('*/', start + 2);
  const nextIndex = closeIdx === -1 ? src.length : closeIdx + 2;
  return { text: src.slice(start, nextIndex), nextIndex };
}

function scanRegexLiteral(src: string, start: number): { text: string; nextIndex: number } | null {
  if (src[start] !== '/' || src[start + 1] === '/' || src[start + 1] === '*') {
    return null;
  }
  let i = start + 1;
  let inCharClass = false;

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') {
      return null;
    }
    if (ch === '\\') {
      if (i + 1 >= src.length) {
        return null;
      }
      const escaped = src[i + 1]!;
      if (escaped === '\n' || escaped === '\r' || escaped === '\u2028' || escaped === '\u2029') {
        return null;
      }
      i += 2;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') {
        inCharClass = false;
      }
      i += 1;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      i += 1;
      continue;
    }
    if (ch === '/') {
      i += 1;
      while (i < src.length && isIdentifierChar(src[i])) {
        i += 1;
      }
      return { text: src.slice(start, i), nextIndex: i };
    }
    i += 1;
  }

  return null;
}

function scanNumberLiteral(src: string, start: number): { text: string; nextIndex: number } {
  let i = start;
  if (src[i] === '0' && /[xXbBoO]/.test(src[i + 1] ?? '')) {
    i += 2;
    while (i < src.length && /[0-9A-Za-z_]/.test(src[i]!)) {
      i += 1;
    }
    if (src[i] === 'n') {
      i += 1;
    }
    return { text: src.slice(start, i), nextIndex: i };
  }

  if (src[i] === '.') {
    i += 1;
    while (i < src.length && /[0-9_]/.test(src[i]!)) {
      i += 1;
    }
  } else {
    while (i < src.length && /[0-9_]/.test(src[i]!)) {
      i += 1;
    }
    if (src[i] === '.' && isDigit(src[i + 1])) {
      i += 1;
      while (i < src.length && /[0-9_]/.test(src[i]!)) {
        i += 1;
      }
    }
  }

  if ((src[i] === 'e' || src[i] === 'E') && (isDigit(src[i + 1]) || ((src[i + 1] === '+' || src[i + 1] === '-') && isDigit(src[i + 2])))) {
    i += src[i + 1] === '+' || src[i + 1] === '-' ? 2 : 1;
    while (i < src.length && /[0-9_]/.test(src[i]!)) {
      i += 1;
    }
  }
  if (src[i] === 'n') {
    i += 1;
  }

  return { text: src.slice(start, i), nextIndex: i };
}

function scanQuotedLiteral(
  src: string,
  start: number,
  inputUrl: string | undefined,
): { text: string; nextIndex: number } {
  const quote = src[start] as '"' | "'";
  const replacement = inputUrl !== undefined ? escapeJsStringBody(inputUrl, quote) : null;
  let i = start + 1;
  let out = quote;

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      out += ch;
      if (i + 1 < src.length) {
        out += src[i + 1]!;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === quote) {
      out += quote;
      return { text: out, nextIndex: i + 1 };
    }
    if (replacement !== null && src.startsWith(INPUT_URL_PLACEHOLDER, i)) {
      out += replacement;
      i += INPUT_URL_PLACEHOLDER.length;
      continue;
    }
    out += ch;
    i += 1;
  }

  return { text: out, nextIndex: i };
}

function stepJsLexicalToken(
  src: string,
  start: number,
  state: JsLexState,
  inputUrl: string | undefined,
): JsLexToken {
  const ch = src[start]!;

  if (isWhitespace(ch)) {
    let i = start + 1;
    while (i < src.length && isWhitespace(src[i])) {
      i += 1;
    }
    return { text: src.slice(start, i), nextIndex: i, punct: false };
  }

  if (ch === '/' && src[start + 1] === '/') {
    const comment = scanLineComment(src, start);
    return { ...comment, punct: false };
  }
  if (ch === '/' && src[start + 1] === '*') {
    const comment = scanBlockComment(src, start);
    return { ...comment, punct: false };
  }

  if (ch === '"' || ch === "'") {
    state.canStartRegex = false;
    state.afterDot = false;
    state.pendingControlParen = false;
    state.nextBraceIsObject = false;
    return { ...scanQuotedLiteral(src, start, inputUrl), punct: false };
  }
  if (ch === '`') {
    state.canStartRegex = false;
    state.afterDot = false;
    state.pendingControlParen = false;
    state.nextBraceIsObject = false;
    return { ...scanTemplateLiteral(src, start, inputUrl), punct: false };
  }

  if (ch === '/' && state.canStartRegex) {
    const regex = scanRegexLiteral(src, start);
    if (regex) {
      state.canStartRegex = false;
      state.afterDot = false;
      state.pendingControlParen = false;
      state.nextBraceIsObject = false;
      return { ...regex, punct: false };
    }
  }

  if (ch === '?' && src[start + 1] === '.' && !isDigit(src[start + 2])) {
    state.canStartRegex = false;
    state.afterDot = true;
    state.pendingControlParen = false;
    state.nextBraceIsObject = false;
    return { text: '?.', nextIndex: start + 2, punct: false };
  }

  if (isDigit(ch) || (ch === '.' && isDigit(src[start + 1]))) {
    state.canStartRegex = false;
    state.afterDot = false;
    state.pendingControlParen = false;
    state.nextBraceIsObject = false;
    return { ...scanNumberLiteral(src, start), punct: false };
  }

  if (isIdentifierStart(ch)) {
    let i = start + 1;
    while (i < src.length && isIdentifierChar(src[i])) {
      i += 1;
    }
    const word = src.slice(start, i);
    const wasAfterDot = state.afterDot;
    const wasPendingControl = state.pendingControlParen;
    state.afterDot = false;
    state.pendingControlParen = false;

    if (!wasAfterDot && CONTROL_HEADER_KEYWORDS.has(word)) {
      state.pendingControlParen = true;
      state.canStartRegex = false;
      state.nextBraceIsObject = false;
    } else if (!wasAfterDot && word === 'await' && wasPendingControl) {
      state.pendingControlParen = true;
      state.canStartRegex = true;
      state.nextBraceIsObject = true;
    } else if (!wasAfterDot && REGEX_STMT_PREFIX_KEYWORDS.has(word)) {
      state.canStartRegex = true;
      state.nextBraceIsObject = false;
    } else if (!wasAfterDot && REGEX_EXPR_PREFIX_KEYWORDS.has(word)) {
      state.canStartRegex = true;
      state.nextBraceIsObject = true;
    } else {
      state.canStartRegex = false;
      state.nextBraceIsObject = false;
    }
    return { text: word, nextIndex: i, punct: false };
  }

  if (ch === '=' && src[start + 1] === '>') {
    state.canStartRegex = true;
    state.afterDot = false;
    state.pendingControlParen = false;
    state.nextBraceIsObject = false;
    return { text: '=>', nextIndex: start + 2, punct: false };
  }

  if ((ch === '+' && src[start + 1] === '+') || (ch === '-' && src[start + 1] === '-')) {
    state.canStartRegex = false;
    state.afterDot = false;
    state.pendingControlParen = false;
    state.nextBraceIsObject = false;
    return { text: src.slice(start, start + 2), nextIndex: start + 2, punct: false };
  }

  if (ch === '.') {
    state.canStartRegex = false;
    state.afterDot = true;
    state.pendingControlParen = false;
    state.nextBraceIsObject = false;
    return { text: '.', nextIndex: start + 1, punct: false };
  }

  if (ch === '(') {
    state.parenStack.push(state.pendingControlParen ? 'control' : 'expr');
    state.pendingControlParen = false;
    state.afterDot = false;
    state.canStartRegex = true;
    state.nextBraceIsObject = true;
    return { text: '(', nextIndex: start + 1, punct: true };
  }

  if (ch === ')') {
    const kind = state.parenStack.pop() ?? 'expr';
    state.pendingControlParen = false;
    state.afterDot = false;
    state.canStartRegex = kind === 'control';
    state.nextBraceIsObject = false;
    return { text: ')', nextIndex: start + 1, punct: true };
  }

  if (ch === '{') {
    state.braceStack.push(state.nextBraceIsObject ? 'object' : 'block');
    state.pendingControlParen = false;
    state.afterDot = false;
    state.canStartRegex = true;
    state.nextBraceIsObject = false;
    return { text: '{', nextIndex: start + 1, punct: true };
  }

  if (ch === '}') {
    const kind = state.braceStack.pop() ?? 'block';
    state.pendingControlParen = false;
    state.afterDot = false;
    state.canStartRegex = kind !== 'object';
    state.nextBraceIsObject = false;
    return { text: '}', nextIndex: start + 1, punct: true };
  }

  if (ch === ']') {
    state.canStartRegex = false;
    state.afterDot = false;
    state.pendingControlParen = false;
    state.nextBraceIsObject = false;
    return { text: ']', nextIndex: start + 1, punct: false };
  }

  state.canStartRegex = true;
  state.afterDot = false;
  state.pendingControlParen = false;
  state.nextBraceIsObject = ch !== ';';
  return { text: ch, nextIndex: start + 1, punct: false };
}

function scanTemplateExpression(
  src: string,
  start: number,
  inputUrl: string | undefined,
): { text: string; nextIndex: number } {
  const state = createLexState(true);
  let i = start;
  let depth = 1;
  let out = '';

  while (i < src.length) {
    const token = stepJsLexicalToken(src, i, state, inputUrl);
    out += token.text;
    i = token.nextIndex;
    if (token.punct) {
      if (token.text === '{') {
        depth += 1;
      } else if (token.text === '}') {
        depth -= 1;
        if (depth === 0) {
          return { text: out, nextIndex: i };
        }
      }
    }
  }

  return { text: out, nextIndex: i };
}

function scanTemplateLiteral(
  src: string,
  start: number,
  inputUrl: string | undefined,
): { text: string; nextIndex: number } {
  const replacement = inputUrl !== undefined ? escapeJsStringBody(inputUrl, '`') : null;
  let i = start + 1;
  let out = '`';

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      out += ch;
      if (i + 1 < src.length) {
        out += src[i + 1]!;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === '`') {
      out += '`';
      return { text: out, nextIndex: i + 1 };
    }
    if (src.startsWith('${', i)) {
      out += '${';
      const expr = scanTemplateExpression(src, i + 2, inputUrl);
      out += expr.text;
      i = expr.nextIndex;
      continue;
    }
    if (replacement !== null && src.startsWith(INPUT_URL_PLACEHOLDER, i)) {
      out += replacement;
      i += INPUT_URL_PLACEHOLDER.length;
      continue;
    }
    out += ch;
    i += 1;
  }

  return { text: out, nextIndex: i };
}

function findMatchingParen(src: string, openParenIdx: number): number {
  const state = createLexState(true);
  let depth = 1;
  let i = openParenIdx + 1;

  while (i < src.length) {
    const token = stepJsLexicalToken(src, i, state, undefined);
    if (token.punct) {
      if (token.text === '(') {
        depth += 1;
      } else if (token.text === ')') {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    i = token.nextIndex;
  }

  return -1;
}

function replaceInputUrlInLiterals(src: string, inputUrl: string | undefined): string {
  if (inputUrl === undefined || !src.includes(INPUT_URL_PLACEHOLDER)) {
    return src;
  }
  const state = createLexState(true);
  let i = 0;
  let out = '';
  while (i < src.length) {
    const token = stepJsLexicalToken(src, i, state, inputUrl);
    out += token.text;
    i = token.nextIndex;
  }
  return out;
}

/**
 * Prepare a DocBuilder JS script for ONLYOFFICE's outer C++ `.docbuilder` line parser:
 * 1. Substitute `{{INPUT_URL}}` inside string/template literals without touching comments or regexes.
 * 2. Rewrite `builder.OpenFile(Argument.inputUrl|_imcodesInputUrl|Argument['inputUrl']|Argument["inputUrl"])`
 *    into a string literal `builder.OpenFile("<url>")`.
 * 3. Ensure every `builder.(CreateFile|OpenFile|SaveFile|CloseFile)(...)` call stands on its own line.
 */
export function prepareOnlyOfficeDocBuilderScript(
  script: string,
  options: PrepareOnlyOfficeDocBuilderScriptOptions = {},
): string {
  const inputUrl = options.inputUrl;
  const builderCallRe = /builder\s*\.\s*(CreateFile|OpenFile|SaveFile|CloseFile)\s*\(/y;
  const state = createLexState(false);
  let i = 0;
  let out = '';

  while (i < script.length) {
    const ch = script[i]!;
    if (
      ch === 'b' &&
      !state.afterDot &&
      (i === 0 || (!isIdentifierChar(script[i - 1]) && script[i - 1] !== '.'))
    ) {
      builderCallRe.lastIndex = i;
      const match = builderCallRe.exec(script);
      if (match) {
        const method = match[1]!;
        const openParenIdx = builderCallRe.lastIndex - 1;
        const closeParenIdx = findMatchingParen(script, openParenIdx);
        if (closeParenIdx !== -1) {
          let stmtEnd = closeParenIdx + 1;
          let semiScan = stmtEnd;
          while (semiScan < script.length && (script[semiScan] === ' ' || script[semiScan] === '\t')) {
            semiScan += 1;
          }
          const hasSemicolon = script[semiScan] === ';';
          if (hasSemicolon) {
            stmtEnd = semiScan + 1;
          }

          const rawArgs = script.slice(openParenIdx + 1, closeParenIdx);
          let callText: string;
          if (
            method === 'OpenFile' &&
            inputUrl !== undefined &&
            INPUT_URL_ARG_RE.test(rawArgs.trim())
          ) {
            callText = `builder.OpenFile(${JSON.stringify(inputUrl)})${hasSemicolon ? ';' : ''}`;
          } else {
            const processedArgs = replaceInputUrlInLiterals(rawArgs, inputUrl);
            callText = `${script.slice(i, openParenIdx + 1)}${processedArgs}${script.slice(closeParenIdx, stmtEnd)}`;
          }

          const lastNl = out.lastIndexOf('\n');
          const linePrefix = out.slice(lastNl + 1);
          if (/[^\t \r]/.test(linePrefix)) {
            out = `${out.replace(/[ \t]+$/, '')}\n`;
          }
          out += callText;

          state.canStartRegex = hasSemicolon;
          state.afterDot = false;
          state.pendingControlParen = false;
          state.nextBraceIsObject = false;

          let afterIdx = stmtEnd;
          while (afterIdx < script.length && (script[afterIdx] === ' ' || script[afterIdx] === '\t')) {
            afterIdx += 1;
          }
          if (afterIdx < script.length && script[afterIdx] !== '\r' && script[afterIdx] !== '\n') {
            out += '\n';
            i = afterIdx;
          } else {
            i = stmtEnd;
          }
          continue;
        }
      }
    }

    const token = stepJsLexicalToken(script, i, state, inputUrl);
    out += token.text;
    i = token.nextIndex;
  }

  return out;
}

export async function executeOnlyOfficeDocBuilder(
  options: ExecuteDocBuilderOptions,
): Promise<ExecuteDocBuilderResult> {
  const timeoutMs = Math.min(
    Math.max(50, options.timeoutMs ?? CLOUD_DOC_DOCBUILDER_DEFAULT_TIMEOUT_MS),
    CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS,
  );

  if (options.env.ONLYOFFICE_ENABLED !== 'true') {
    throw new OnlyOfficeServiceError(
      CLOUD_DOC_ERROR_CODES.ONLYOFFICE_DISABLED,
      'ONLYOFFICE integration is disabled',
      503,
    );
  }

  const internalUrl = resolveOnlyOfficeInternalBaseUrl(options.env);
  const serverBaseUrl = (options.env.SERVER_URL || 'http://localhost:19138').replace(/\/+$/, '');
  const ooSecret = resolveOnlyOfficeJwtSecret(options.env);
  const scriptStore =
    options.scriptStore ??
    (options.db ? createDbDocBuilderScriptStore(options.db) : memoryDocBuilderScriptStore);

  const scriptTtlMs = Math.max(CLOUD_DOC_DOCBUILDER_SCRIPT_TTL_MS, timeoutMs + 60_000);
  const inputUrl =
    typeof options.argument?.inputUrl === 'string'
      ? options.argument.inputUrl
      : typeof options.argument?._imcodesInputUrl === 'string'
        ? options.argument._imcodesInputUrl
        : undefined;
  const preparedScript = prepareOnlyOfficeDocBuilderScript(options.script, { inputUrl });
  const scriptId = await scriptStore.put(preparedScript, scriptTtlMs);
  const scriptToken = signDocBuilderScriptToken(
    scriptId,
    options.env.JWT_SIGNING_KEY,
    Math.ceil(scriptTtlMs / 1000),
  );
  const scriptUrl = `${serverBaseUrl}${CLOUD_DOCS_ONLYOFFICE_SCRIPT_PATH}/${scriptToken}`;

  const deadline = Date.now() + timeoutMs;

  try {
    const initialPayload: Record<string, unknown> = {
      async: true,
      url: scriptUrl,
    };
    if (options.argument !== undefined) {
      initialPayload.argument = options.argument;
    }

    const { headerToken, bodyToken } = signOnlyOfficeServiceJwt(initialPayload, ooSecret);
    let responseData = await fetchJsonWithTimeout<DocBuilderHttpResponse>(
      `${internalUrl}/docbuilder`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${headerToken}`,
        },
        body: JSON.stringify({ ...initialPayload, token: bodyToken }),
      },
      deadline - Date.now(),
      CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED,
      CLOUD_DOC_ERROR_CODES.DOCBUILDER_TIMEOUT,
    );

    if (typeof responseData.error === 'number' && responseData.error !== 0) {
      throw new OnlyOfficeServiceError(
        responseData.error === -2
          ? CLOUD_DOC_ERROR_CODES.DOCBUILDER_TIMEOUT
          : CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED,
        describeDocBuilderError(responseData.error),
        responseData.error === -2 ? 504 : 502,
        responseData.error,
      );
    }

    while (!responseData.end) {
      const hasUrls =
        responseData.urls &&
        typeof responseData.urls === 'object' &&
        Object.keys(responseData.urls).length > 0;
      if (hasUrls && responseData.end === undefined) {
        break;
      }
      if (typeof responseData.key !== 'string' || !responseData.key.trim()) {
        throw new OnlyOfficeServiceError(
          CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED,
          'ONLYOFFICE DocBuilder returned incomplete response without job key',
          502,
        );
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new OnlyOfficeServiceError(
          CLOUD_DOC_ERROR_CODES.DOCBUILDER_TIMEOUT,
          'ONLYOFFICE DocBuilder timed out waiting for completion',
          504,
        );
      }

      await sleep(Math.min(CLOUD_DOC_DOCBUILDER_POLL_INTERVAL_MS, remaining));

      const pollPayload: Record<string, unknown> = {
        async: true,
        key: responseData.key,
      };
      const pollJwt = signOnlyOfficeServiceJwt(pollPayload, ooSecret);
      responseData = await fetchJsonWithTimeout<DocBuilderHttpResponse>(
        `${internalUrl}/docbuilder`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${pollJwt.headerToken}`,
          },
          body: JSON.stringify({ ...pollPayload, token: pollJwt.bodyToken }),
        },
        deadline - Date.now(),
        CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED,
        CLOUD_DOC_ERROR_CODES.DOCBUILDER_TIMEOUT,
      );

      if (typeof responseData.error === 'number' && responseData.error !== 0) {
        throw new OnlyOfficeServiceError(
          responseData.error === -2
            ? CLOUD_DOC_ERROR_CODES.DOCBUILDER_TIMEOUT
            : CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED,
          describeDocBuilderError(responseData.error),
          responseData.error === -2 ? 504 : 502,
          responseData.error,
        );
      }
    }

    if (!responseData.urls || typeof responseData.urls !== 'object') {
      throw new OnlyOfficeServiceError(
        CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED,
        'ONLYOFFICE DocBuilder produced no output URLs',
        502,
      );
    }

    const candidates = Object.entries(responseData.urls)
      .filter(([name, url]) => typeof name === 'string' && name.length > 0 && typeof url === 'string' && url.length > 0)
      .map(([name, url]) => ({ name, url }));

    const selected = selectDocBuilderOutputCandidate(
      candidates,
      { outputName: options.outputName, requiredExt: options.requiredExt },
      'ONLYOFFICE DocBuilder',
    );

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new OnlyOfficeServiceError(
        CLOUD_DOC_ERROR_CODES.DOCBUILDER_TIMEOUT,
        'ONLYOFFICE DocBuilder timed out before downloading result',
        504,
      );
    }

    const bytes = await downloadOnlyOfficeArtifact(
      selected.url,
      options.env,
      remaining,
      CLOUD_DOC_ERROR_CODES.DOCBUILDER_FAILED,
    );

    return {
      bytes,
      outputName: path.posix.basename(selected.name),
      mimeType: getMimeTypeForFilename(selected.name),
      onlyofficeUrls: responseData.urls,
    };
  } finally {
    await scriptStore.remove(scriptId);
  }
}

export interface ConvertViaOnlyOfficeOptions {
  env: Pick<
    Env,
    | 'ONLYOFFICE_ENABLED'
    | 'ONLYOFFICE_INTERNAL_URL'
    | 'ONLYOFFICE_PUBLIC_URL'
    | 'ONLYOFFICE_JWT_SECRET'
    | 'SERVER_URL'
    | 'JWT_SIGNING_KEY'
  >;
  fileUrl: string;
  filetype: string;
  outputtype: string;
  title: string;
  key: string;
  timeoutMs?: number;
}

export interface ConvertViaOnlyOfficeResult {
  bytes: Buffer;
  fileType: string;
  mimeType: string;
}

interface ConverterHttpResponse {
  endConvert?: boolean;
  fileType?: string;
  fileUrl?: string;
  percent?: number;
  error?: number;
}

export async function convertViaOnlyOfficeConverter(
  options: ConvertViaOnlyOfficeOptions,
): Promise<ConvertViaOnlyOfficeResult> {
  if (options.env.ONLYOFFICE_ENABLED !== 'true') {
    throw new OnlyOfficeServiceError(
      CLOUD_DOC_ERROR_CODES.ONLYOFFICE_DISABLED,
      'ONLYOFFICE integration is disabled',
      503,
    );
  }

  const timeoutMs = Math.min(
    Math.max(50, options.timeoutMs ?? CLOUD_DOC_CONVERT_DEFAULT_TIMEOUT_MS),
    CLOUD_DOC_CONVERT_MAX_TIMEOUT_MS,
  );
  const internalUrl = resolveOnlyOfficeInternalBaseUrl(options.env);
  const ooSecret = resolveOnlyOfficeJwtSecret(options.env);
  const deadline = Date.now() + timeoutMs;

  const requestPayload: Record<string, unknown> = {
    async: true,
    filetype: options.filetype,
    key: options.key,
    outputtype: options.outputtype,
    title: options.title,
    url: options.fileUrl,
  };

  let responseData: ConverterHttpResponse | null = null;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new OnlyOfficeServiceError(
        CLOUD_DOC_ERROR_CODES.CONVERTER_TIMEOUT,
        'ONLYOFFICE Converter timed out',
        504,
      );
    }

    const { headerToken, bodyToken } = signOnlyOfficeServiceJwt(requestPayload, ooSecret);
    responseData = await fetchJsonWithTimeout<ConverterHttpResponse>(
      `${internalUrl}/ConvertService.ashx`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${headerToken}`,
        },
        body: JSON.stringify({ ...requestPayload, token: bodyToken }),
      },
      remaining,
      CLOUD_DOC_ERROR_CODES.CONVERTER_FAILED,
      CLOUD_DOC_ERROR_CODES.CONVERTER_TIMEOUT,
    );

    if (typeof responseData.error === 'number' && responseData.error !== 0) {
      throw new OnlyOfficeServiceError(
        responseData.error === -2
          ? CLOUD_DOC_ERROR_CODES.CONVERTER_TIMEOUT
          : CLOUD_DOC_ERROR_CODES.CONVERTER_FAILED,
        describeConverterError(responseData.error),
        responseData.error === -2 ? 504 : 502,
        responseData.error,
      );
    }

    if (responseData.endConvert === true) {
      break;
    }
    if (responseData.endConvert === undefined && typeof responseData.fileUrl === 'string' && responseData.fileUrl) {
      break;
    }

    const pollWaitRemaining = deadline - Date.now();
    if (pollWaitRemaining <= 0) {
      throw new OnlyOfficeServiceError(
        CLOUD_DOC_ERROR_CODES.CONVERTER_TIMEOUT,
        'ONLYOFFICE Converter timed out waiting for completion',
        504,
      );
    }
    await sleep(Math.min(CLOUD_DOC_DOCBUILDER_POLL_INTERVAL_MS, pollWaitRemaining));
  }

  if (!responseData.fileUrl || typeof responseData.fileUrl !== 'string') {
    throw new OnlyOfficeServiceError(
      CLOUD_DOC_ERROR_CODES.CONVERTER_FAILED,
      'ONLYOFFICE Converter returned no output fileUrl',
      502,
    );
  }

  const expectedType = options.outputtype.replace(/^\./, '').toLowerCase();
  const resolvedType = (responseData.fileType || expectedType).replace(/^\./, '').toLowerCase();
  if (resolvedType !== expectedType) {
    throw new OnlyOfficeServiceError(
      CLOUD_DOC_ERROR_CODES.DOCBUILDER_OUTPUT_MISMATCH,
      `ONLYOFFICE Converter produced "${resolvedType}" instead of requested "${expectedType}"`,
      422,
    );
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new OnlyOfficeServiceError(
      CLOUD_DOC_ERROR_CODES.CONVERTER_TIMEOUT,
      'ONLYOFFICE Converter timed out before downloading result',
      504,
    );
  }

  const bytes = await downloadOnlyOfficeArtifact(
    responseData.fileUrl,
    options.env,
    remaining,
    CLOUD_DOC_ERROR_CODES.CONVERTER_FAILED,
  );

  return {
    bytes,
    fileType: resolvedType,
    mimeType: getMimeTypeForFilename(`.${resolvedType}`),
  };
}
