import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import {
  CLOUD_DOCS_MAX_UPLOAD_BYTES,
  CLOUD_DOC_CONTENT_MAX_CHARS,
  CLOUD_DOC_CONVERT_MAX_TIMEOUT_MS,
  CLOUD_DOC_CONVERT_TARGET_TYPES,
  CLOUD_DOC_CREATE_TYPES,
  CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS,
  CLOUD_DOC_DOCBUILDER_OUTPUT_TYPES,
  CLOUD_DOC_EDIT_MODES,
  getCloudDocExt,
  getCloudDocMeta,
  isConvertTargetType,
  isDocBuilderOutputType,
  type CloudDocContentPayload,
  type CloudDocConvertTargetType,
  type CloudDocCreateType,
  type CloudDocDocBuilderOutputType,
  type CloudDocEditMode,
  type CloudDocItem,
  type CloudDocShareTargetKind,
} from '../../shared/cloud-docs.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import {
  cloudDocConvertClient,
  cloudDocCreateClient,
  cloudDocDeleteClient,
  cloudDocDocBuilderCreateClient,
  cloudDocDocBuilderEditClient,
  cloudDocDownloadFileClient,
  cloudDocEditClient,
  cloudDocListClient,
  cloudDocReadClient,
  cloudDocReplaceFileClient,
  cloudDocShareClient,
  cloudDocUploadFileClient,
  sanitizeCloudDocTransferFilename,
  type CloudDocsClientResult,
  type CloudDocsHttpCredentials,
} from '../daemon/cloud-docs-mcp-client.js';
import {
  resolveCloudDocsCredentials,
  type CloudDocsCliExecutionResult,
} from '../daemon/cloud-docs-mcp-deps.js';
import type { DaemonCredential } from '../daemon/machine-mcp-deps.js';
import { getCloudDocsGuideText } from './cloud-docs-guide.js';

export type CloudDocsCliResult = CloudDocsCliExecutionResult;

export interface RunCloudDocsCliOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  loadCredential?: (homeDir?: string) => Promise<DaemonCredential | null>;
  loadSharedMachineAuthority?: () => Promise<string | null>;
  cwd?: string;
}

interface CommonCliFlags {
  serverUrl?: string;
  serverId?: string;
  token?: string;
  home?: string;
  json?: boolean;
}

/**
 * Split a single command string into argv tokens cleanly across POSIX & Windows.
 * - Unquoted backslashes are always preserved verbatim (e.g. C:\Users\Alice\doc.docx).
 * - Single-quoted strings are literal.
 * - Inside double-quoted strings, Windows CommandLineToArgvW backslash+quote rules
 *   apply so both "C:\Users\Alice\doc.docx" and "{\"a\":\"b\"}" round-trip cleanly.
 */
export function splitCliArgs(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i]!;

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '\\') {
        let backslashCount = 1;
        while (commandLine[i + backslashCount] === '\\') {
          backslashCount += 1;
        }
        if (commandLine[i + backslashCount] === '"') {
          current += '\\'.repeat(Math.floor(backslashCount / 2));
          if (backslashCount % 2 === 1) {
            current += '"';
            i += backslashCount;
          } else {
            i += backslashCount - 1;
          }
          continue;
        }
        current += ch;
        continue;
      }
      if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    hasToken = true;
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    current += ch;
  }

  if (quote !== null) {
    throw new Error('Unclosed quote in command string');
  }
  if (hasToken) {
    args.push(current);
  }
  return args;
}

function addAuthAndFormatOptions(cmd: Command, includeAuth = true): Command {
  cmd.option('--json', 'Emit structured JSON output');
  if (includeAuth) {
    cmd
      .option('--server-url <url>', 'Override IM.codes server URL (or IMCODES_SERVER_URL)')
      .option('--server-id <id>', 'Override bound server ID (or IMCODES_SERVER_ID)')
      .option('--token <token>', 'Override daemon server token (or IMCODES_TOKEN)')
      .option('--home <dir>', 'Override IM.codes daemon home directory (or IMCODES_HOME)');
  }
  return cmd;
}

function extractCommonFlags(cmd: Command): CommonCliFlags {
  const chain: CommonCliFlags[] = [];
  let cursor: Command | null = cmd;
  while (cursor) {
    chain.push(cursor.opts<CommonCliFlags>());
    cursor = cursor.parent;
  }
  const merged: CommonCliFlags = {};
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const entry = chain[i]!;
    if (entry.serverUrl) merged.serverUrl = entry.serverUrl;
    if (entry.serverId) merged.serverId = entry.serverId;
    if (entry.token) merged.token = entry.token;
    if (entry.home) merged.home = entry.home;
    if (entry.json) merged.json = true;
  }
  return merged;
}

function parsePositiveInt(raw: unknown, label: string, max?: number): { ok: true; value: number } | { ok: false; message: string } {
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 1 || (max !== undefined && num > max)) {
    const bound = max !== undefined ? `in [1, ${max}]` : '>= 1';
    return { ok: false, message: `${label} must be an integer ${bound}` };
  }
  return { ok: true, value: num };
}

async function readTextOption(
  inlineValue: string | undefined,
  filePath: string | undefined,
  label: string,
  cwd: string,
): Promise<{ ok: true; value?: string } | { ok: false; message: string }> {
  if (inlineValue !== undefined && filePath !== undefined) {
    return { ok: false, message: `Pass either --${label} or --${label}-file, not both` };
  }
  if (inlineValue !== undefined) {
    return { ok: true, value: inlineValue };
  }
  if (filePath !== undefined) {
    try {
      const resolved = resolve(cwd, filePath);
      return { ok: true, value: await readFile(resolved, 'utf8') };
    } catch (err) {
      return {
        ok: false,
        message: `Failed to read --${label}-file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { ok: true, value: undefined };
}

async function readArgumentObjectOption(
  inlineJson: string | undefined,
  filePath: string | undefined,
  cwd: string,
): Promise<{ ok: true; value?: Record<string, unknown> } | { ok: false; message: string }> {
  const textRes = await readTextOption(inlineJson, filePath, 'argument', cwd);
  if (!textRes.ok) return textRes;
  if (textRes.value === undefined) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(textRes.value);
  } catch (err) {
    return {
      ok: false,
      message: `Invalid JSON for --argument: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: '--argument must decode to a JSON object' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

async function resolveOutFilePath(
  outOpt: string | undefined,
  fallbackFileName: string,
  cwd: string,
): Promise<string> {
  const safeName = sanitizeCloudDocTransferFilename(fallbackFileName);
  if (!outOpt || !outOpt.trim()) {
    return resolve(cwd, safeName);
  }
  const raw = outOpt.trim();
  const resolved = resolve(cwd, raw);
  const endsWithSeparator = raw.endsWith('/') || raw.endsWith('\\');
  let isDir = endsWithSeparator;
  if (!isDir && existsSync(resolved)) {
    try {
      isDir = (await stat(resolved)).isDirectory();
    } catch {
      isDir = false;
    }
  }
  if (isDir) {
    const joined = join(resolved, safeName);
    const rel = relative(resolved, joined);
    if (rel.startsWith('..')) {
      throw new Error(`Refusing unsafe output filename "${safeName}"`);
    }
    return joined;
  }
  return resolved;
}

async function writeBinaryOutFile(
  outOpt: string | undefined,
  fallbackFileName: string,
  bytes: Uint8Array | Buffer,
  cwd: string,
): Promise<string> {
  const destPath = await resolveOutFilePath(outOpt, fallbackFileName, cwd);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, bytes);
  return destPath;
}

function formatReadableDocContent(payload: CloudDocContentPayload): string {
  const lines: string[] = [];
  lines.push(`${payload.doc.name} (${payload.doc.id}) v${payload.doc.docVersion} [${payload.role}]`);
  if (payload.truncated) {
    lines.push('(content truncated)');
  }
  if (typeof payload.content === 'string' && payload.content.length > 0) {
    lines.push('');
    lines.push(payload.content);
  }
  if (Array.isArray(payload.sheets) && payload.sheets.length > 0) {
    for (const sheet of payload.sheets) {
      lines.push('');
      lines.push(`[Sheet: ${sheet.name}]`);
      for (const row of sheet.rows) {
        lines.push(row.join('\t'));
      }
    }
  }
  if (Array.isArray(payload.slides) && payload.slides.length > 0) {
    for (const slide of payload.slides) {
      lines.push('');
      lines.push(`[Slide ${slide.index}${slide.title ? `: ${slide.title}` : ''}]`);
      if (slide.texts.length > 0) {
        lines.push(slide.texts.join('\n'));
      }
    }
  }
  return lines.join('\n');
}

function formatDocSummary(doc: CloudDocItem, prefix = 'OK'): string {
  return `${prefix}: ${doc.name} (id=${doc.id}, ext=${doc.ext}, version=${doc.docVersion}, bytes=${doc.sizeBytes})`;
}

export async function runCloudDocsCli(
  argv: string[],
  options: RunCloudDocsCliOptions = {},
): Promise<CloudDocsCliResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  let stdout = '';
  let stderr = '';
  let data: unknown;
  let exitCode = 0;
  let errorReason: MCPErrorReason | undefined;

  const fail = (
    reason: MCPErrorReason,
    message: string,
    opts?: { json?: boolean; code?: string; exit?: number },
  ): void => {
    const cleanMsg = sanitizeMcpErrorMessage(message);
    errorReason = reason;
    exitCode = opts?.exit ?? 1;
    if (opts?.json) {
      stderr += `${JSON.stringify({
        ok: false,
        reason,
        ...(opts.code ? { code: opts.code } : {}),
        message: cleanMsg,
      })}\n`;
    } else {
      stderr += `Error (${reason}): ${cleanMsg}\n`;
    }
  };

  const succeed = (payload: unknown, text: string, json?: boolean): void => {
    data = payload;
    exitCode = 0;
    if (json) {
      stdout += `${JSON.stringify(payload, null, 2)}\n`;
    } else {
      stdout += text.endsWith('\n') ? text : `${text}\n`;
    }
  };

  const finishClientResult = <T extends object>(
    res: CloudDocsClientResult<T>,
    json: boolean | undefined,
    onOk: (okRes: { status: 'ok' } & T) => void | Promise<void>,
  ): Promise<void> | void => {
    if (res.status !== 'ok') {
      fail(res.reason, res.message, { json, code: res.code });
      return;
    }
    return onOk(res);
  };

  const acquireCreds = async (cmd: Command): Promise<{ creds: CloudDocsHttpCredentials; flags: CommonCliFlags } | null> => {
    const flags = extractCommonFlags(cmd);
    const resolved = await resolveCloudDocsCredentials({
      serverUrl: flags.serverUrl,
      serverId: flags.serverId,
      token: flags.token,
      home: flags.home,
      env,
      loadCredential: options.loadCredential,
      loadSharedMachineAuthority: options.loadSharedMachineAuthority,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
    if (resolved.status !== 'ok') {
      fail(resolved.reason, resolved.message, { json: flags.json });
      return null;
    }
    return { creds: resolved.credentials, flags };
  };

  const configureCmd = (cmd: Command): Command => {
    cmd.exitOverride();
    cmd.configureOutput({
      writeOut: (str) => {
        stdout += str;
      },
      writeErr: (str) => {
        stderr += str;
      },
    });
    return cmd;
  };

  const program = configureCmd(
    new Command('imcodes cloud-docs').description('Unified CLI for IM.codes Cloud Docs & ONLYOFFICE Document Builder / Converter'),
  );
  addAuthAndFormatOptions(program, true);

  // 1. list
  const listCmd = addAuthAndFormatOptions(
    configureCmd(program.command('list').description('List own and shared Cloud Docs, folders, and recent documents')),
  );
  listCmd
    .option('--folder <folderId>', 'Filter owned documents by parent folderId')
    .option('--search <query>', 'Case-insensitive filename or folder search filter')
    .option('--recent', 'Also include recent documents')
    .action(async (opts: { folder?: string; search?: string; recent?: boolean }, cmd: Command) => {
      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocListClient(ctx.creds, {
        ...(opts.folder ? { folderId: opts.folder } : {}),
        ...(opts.search ? { search: opts.search } : {}),
        ...(opts.recent ? { includeRecent: true } : {}),
      });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        const lines: string[] = [
          `Folders (${ok.folders.length}): ${ok.folders.map((f) => `${f.name} [${f.id}]`).join(', ') || 'none'}`,
          `Docs (${ok.docs.length}):`,
          ...ok.docs.map((d) => `  - ${d.name} (id=${d.id}, ext=${d.ext}, v=${d.docVersion}, bytes=${d.sizeBytes})`),
        ];
        if (ok.sharedFolders.length > 0) {
          lines.push(`Shared Folders (${ok.sharedFolders.length}):`);
          lines.push(...ok.sharedFolders.map((f) => `  - ${f.name} (id=${f.id}, role=${f.role})`));
        }
        if (ok.sharedDocs.length > 0) {
          lines.push(`Shared Docs (${ok.sharedDocs.length}):`);
          lines.push(...ok.sharedDocs.map((d) => `  - ${d.name} (id=${d.id}, role=${d.role}, v=${d.docVersion})`));
        }
        if (ok.recentDocuments) {
          lines.push(`Recent Documents (${ok.recentDocuments.length}):`);
          lines.push(...ok.recentDocuments.map((r) => `  - ${r.title} (id=${r.cloudDocId ?? r.id})`));
        }
        succeed(ok, lines.join('\n'), ctx.flags.json);
      });
    });

  // 2. read
  const readCmd = addAuthAndFormatOptions(
    configureCmd(program.command('read <docId>').description('Read extracted text, spreadsheet sheets, or presentation slides')),
  );
  readCmd
    .option('--max-chars <n>', `Maximum extracted characters (1..${CLOUD_DOC_CONTENT_MAX_CHARS})`)
    .option('--out <path>', 'Write extracted readable text to a local file')
    .action(async (docId: string, opts: { maxChars?: string; out?: string }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      let maxChars: number | undefined;
      if (opts.maxChars !== undefined) {
        const parsed = parsePositiveInt(opts.maxChars, '--max-chars', CLOUD_DOC_CONTENT_MAX_CHARS);
        if (!parsed.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, parsed.message, { json: flags.json });
        maxChars = parsed.value;
      }
      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocReadClient(ctx.creds, {
        docId,
        ...(maxChars !== undefined ? { maxChars } : {}),
      });
      await finishClientResult(res, ctx.flags.json, async (ok) => {
        const formatted = formatReadableDocContent(ok);
        let savedTo: string | undefined;
        if (opts.out) {
          const textBody = typeof ok.content === 'string' && ok.content.length > 0 ? ok.content : formatted;
          const fallback = `${ok.doc.name}.txt`;
          savedTo = await writeBinaryOutFile(opts.out, fallback, Buffer.from(textBody, 'utf8'), cwd);
        }
        const payload = savedTo ? { ...ok, savedTo } : ok;
        succeed(payload, savedTo ? `${formatted}\n\nSaved to: ${savedTo}` : formatted, ctx.flags.json);
      });
    });

  // 3. create
  const createCmd = addAuthAndFormatOptions(
    configureCmd(program.command('create').description('Create a Cloud Doc (docx/xlsx/pptx/md/txt) with optional content or DocBuilder script')),
  );
  createCmd
    .option('--type <type>', `Document format (${CLOUD_DOC_CREATE_TYPES.join(', ')})`)
    .option('--name <name>', 'Document filename')
    .option('--folder-id <folderId>', 'Parent folderId (defaults to root)')
    .option('--content <text>', 'Initial text/table/slide content')
    .option('--content-file <path>', 'Read initial content from a local UTF-8 file')
    .option('--script <js>', 'Optional ONLYOFFICE DocBuilder JS script')
    .option('--script-file <path>', 'Read ONLYOFFICE DocBuilder JS script from file')
    .option('--argument <json>', 'Optional JSON object passed as Argument to DocBuilder')
    .option('--argument-file <path>', 'Read JSON Argument object from file')
    .option('--timeout <ms>', `DocBuilder execution timeout in ms (1..${CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS})`)
    .action(async (opts: {
      type?: string;
      name?: string;
      folderId?: string;
      content?: string;
      contentFile?: string;
      script?: string;
      scriptFile?: string;
      argument?: string;
      argumentFile?: string;
      timeout?: string;
    }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      const contentRes = await readTextOption(opts.content, opts.contentFile, 'content', cwd);
      if (!contentRes.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, contentRes.message, { json: flags.json });
      if (contentRes.value !== undefined && contentRes.value.length > CLOUD_DOC_CONTENT_MAX_CHARS) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, `content exceeds max ${CLOUD_DOC_CONTENT_MAX_CHARS} characters`, { json: flags.json });
      }
      const scriptRes = await readTextOption(opts.script, opts.scriptFile, 'script', cwd);
      if (!scriptRes.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, scriptRes.message, { json: flags.json });
      const argRes = await readArgumentObjectOption(opts.argument, opts.argumentFile, cwd);
      if (!argRes.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, argRes.message, { json: flags.json });

      let timeoutMs: number | undefined;
      if (opts.timeout !== undefined) {
        const parsed = parsePositiveInt(opts.timeout, '--timeout', CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS);
        if (!parsed.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, parsed.message, { json: flags.json });
        timeoutMs = parsed.value;
      }

      let rawType = opts.type?.trim().replace(/^\./, '').toLowerCase();
      if (!rawType && opts.name) {
        const inferred = getCloudDocExt(opts.name)?.replace(/^\./, '');
        if (inferred) rawType = inferred;
      }
      if (!rawType || !(CLOUD_DOC_CREATE_TYPES as readonly string[]).includes(rawType)) {
        return fail(
          MCP_ERROR_REASONS.VALIDATION_FAILED,
          `--type must be one of ${CLOUD_DOC_CREATE_TYPES.join(', ')} (or provide --name with a matching extension)`,
          { json: flags.json },
        );
      }

      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocCreateClient(ctx.creds, {
        kind: 'doc',
        type: rawType as CloudDocCreateType,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.folderId !== undefined ? { folderId: opts.folderId } : {}),
        ...(contentRes.value !== undefined ? { content: contentRes.value } : {}),
        ...(scriptRes.value !== undefined ? { engine: 'docbuilder' as const, docbuilderScript: scriptRes.value } : {}),
        ...(argRes.value !== undefined ? { argument: argRes.value } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        const text = ok.doc ? formatDocSummary(ok.doc, 'Created') : 'Created';
        succeed(ok, text, ctx.flags.json);
      });
    });

  // 4. mkdir
  const mkdirCmd = addAuthAndFormatOptions(
    configureCmd(program.command('mkdir <name>').description('Create a Cloud Docs folder')),
  );
  mkdirCmd
    .option('--parent <folderId>', 'Parent folderId')
    .option('--folder-id <folderId>', 'Alias for --parent')
    .action(async (name: string, opts: { parent?: string; folderId?: string }, cmd: Command) => {
      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const parentId = opts.parent ?? opts.folderId;
      const res = await cloudDocCreateClient(ctx.creds, {
        kind: 'folder',
        name,
        ...(parentId !== undefined ? { folderId: parentId } : {}),
      });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        const folder = ok.folder;
        const text = folder ? `Created folder: ${folder.name} (id=${folder.id})` : 'Created folder';
        succeed(ok, text, ctx.flags.json);
      });
    });

  // 5. edit
  const editCmd = addAuthAndFormatOptions(
    configureCmd(program.command('edit <docId>').description('Edit document content/DocBuilder script, rename, or move')),
  );
  editCmd
    .option('--content <text>', 'Updated text/table/slide content')
    .option('--content-file <path>', 'Read updated content from local UTF-8 file')
    .option('--mode <mode>', `Edit mode: ${CLOUD_DOC_EDIT_MODES.join(' | ')}`)
    .option('--expected-version <n>', 'Optimistic CAS version check')
    .option('--name <name>', 'Rename document')
    .option('--folder-id <folderId>', 'Move document to destination folderId (use "null" for own root)')
    .option('--root', 'Move document to owner root folder (folderId=null)')
    .option('--script <js>', 'ONLYOFFICE DocBuilder JS script for engine=docbuilder edit')
    .option('--script-file <path>', 'Read ONLYOFFICE DocBuilder JS script from file')
    .option('--argument <json>', 'Optional JSON object passed as Argument to DocBuilder')
    .option('--argument-file <path>', 'Read JSON Argument object from file')
    .option('--timeout <ms>', `DocBuilder timeout in ms (1..${CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS})`)
    .action(async (docId: string, opts: {
      content?: string;
      contentFile?: string;
      mode?: string;
      expectedVersion?: string;
      name?: string;
      folderId?: string;
      root?: boolean;
      script?: string;
      scriptFile?: string;
      argument?: string;
      argumentFile?: string;
      timeout?: string;
    }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      const contentRes = await readTextOption(opts.content, opts.contentFile, 'content', cwd);
      if (!contentRes.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, contentRes.message, { json: flags.json });
      if (contentRes.value !== undefined && contentRes.value.length > CLOUD_DOC_CONTENT_MAX_CHARS) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, `content exceeds max ${CLOUD_DOC_CONTENT_MAX_CHARS} characters`, { json: flags.json });
      }
      const scriptRes = await readTextOption(opts.script, opts.scriptFile, 'script', cwd);
      if (!scriptRes.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, scriptRes.message, { json: flags.json });
      const argRes = await readArgumentObjectOption(opts.argument, opts.argumentFile, cwd);
      if (!argRes.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, argRes.message, { json: flags.json });

      if (opts.mode !== undefined && !(CLOUD_DOC_EDIT_MODES as readonly string[]).includes(opts.mode)) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, `--mode must be one of ${CLOUD_DOC_EDIT_MODES.join(', ')}`, { json: flags.json });
      }
      let expectedVersion: number | undefined;
      if (opts.expectedVersion !== undefined) {
        const parsed = parsePositiveInt(opts.expectedVersion, '--expected-version');
        if (!parsed.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, parsed.message, { json: flags.json });
        expectedVersion = parsed.value;
      }
      let timeoutMs: number | undefined;
      if (opts.timeout !== undefined) {
        const parsed = parsePositiveInt(opts.timeout, '--timeout', CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS);
        if (!parsed.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, parsed.message, { json: flags.json });
        timeoutMs = parsed.value;
      }

      if (opts.root && opts.folderId !== undefined) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, 'Pass either --root or --folder-id, not both', { json: flags.json });
      }
      const folderId = opts.root
        ? null
        : opts.folderId === 'null'
          ? null
          : opts.folderId;

      if (contentRes.value === undefined && scriptRes.value === undefined && opts.name === undefined && folderId === undefined) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, 'edit requires --content/--content-file, --script/--script-file, --name, or --folder-id/--root', { json: flags.json });
      }

      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocEditClient(ctx.creds, {
        docId,
        ...(contentRes.value !== undefined ? { content: contentRes.value } : {}),
        ...(opts.mode !== undefined ? { mode: opts.mode as CloudDocEditMode } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
        ...(scriptRes.value !== undefined ? { engine: 'docbuilder' as const, docbuilderScript: scriptRes.value } : {}),
        ...(argRes.value !== undefined ? { argument: argRes.value } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        succeed(ok, formatDocSummary(ok.doc, 'Updated'), ctx.flags.json);
      });
    });

  // 6. builder
  const builderCmd = addAuthAndFormatOptions(
    configureCmd(program.command('builder [docId]').description('Run an ONLYOFFICE Document Builder JS script (create new doc or edit/export existing doc)')),
  );
  builderCmd
    .option('--type <ext>', `Target document format for new doc (${CLOUD_DOC_DOCBUILDER_OUTPUT_TYPES.join(', ')})`)
    .option('--name <name>', 'Remote document filename')
    .option('--folder-id <folderId>', 'Destination folderId')
    .option('--root', 'Move existing doc to owner root folder (folderId=null)')
    .option('--script <js>', 'ONLYOFFICE DocBuilder JS script')
    .option('--script-file <path>', 'Read ONLYOFFICE DocBuilder JS script from local file')
    .option('--argument <json>', 'JSON object passed as Argument in DocBuilder')
    .option('--argument-file <path>', 'Read JSON Argument object from local file')
    .option('--output-type <ext>', 'Requested output format when editing/exporting existing doc')
    .option('--output-name <name>', 'Expected filename produced by builder.SaveFile(...)')
    .option('--save', 'Persist output back to the existing Cloud Doc (default true when docId supplied)', true)
    .option('--no-save', 'Do not overwrite Cloud Doc; return/write exported bytes instead')
    .option('--expected-version <n>', 'Optimistic CAS version check when saving existing doc')
    .option('--out <path>', 'Write exported bytes (when --no-save) to a local file')
    .option('--timeout <ms>', `Execution timeout in ms (1..${CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS})`)
    .action(async (docId: string | undefined, opts: {
      type?: string;
      name?: string;
      folderId?: string;
      root?: boolean;
      script?: string;
      scriptFile?: string;
      argument?: string;
      argumentFile?: string;
      outputType?: string;
      outputName?: string;
      save?: boolean;
      expectedVersion?: string;
      out?: string;
      timeout?: string;
    }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      const scriptRes = await readTextOption(opts.script, opts.scriptFile, 'script', cwd);
      if (!scriptRes.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, scriptRes.message, { json: flags.json });
      if (!scriptRes.value || !scriptRes.value.trim()) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, 'builder requires --script or --script-file', { json: flags.json });
      }
      const argRes = await readArgumentObjectOption(opts.argument, opts.argumentFile, cwd);
      if (!argRes.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, argRes.message, { json: flags.json });

      let timeoutMs: number | undefined;
      if (opts.timeout !== undefined) {
        const parsed = parsePositiveInt(opts.timeout, '--timeout', CLOUD_DOC_DOCBUILDER_MAX_TIMEOUT_MS);
        if (!parsed.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, parsed.message, { json: flags.json });
        timeoutMs = parsed.value;
      }

      if (!docId) {
        let createType: CloudDocDocBuilderOutputType | undefined;
        if (opts.type !== undefined) {
          const normalized = opts.type.trim().replace(/^\./, '').toLowerCase();
          if (!isDocBuilderOutputType(normalized)) {
            return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, `--type must be one of ${CLOUD_DOC_DOCBUILDER_OUTPUT_TYPES.join(', ')}`, { json: flags.json });
          }
          createType = normalized;
        }
        const ctx = await acquireCreds(cmd);
        if (!ctx) return;
        const res = await cloudDocDocBuilderCreateClient(ctx.creds, {
          script: scriptRes.value,
          ...(createType ? { type: createType } : {}),
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.folderId !== undefined ? { folderId: opts.folderId } : {}),
          ...(argRes.value !== undefined ? { argument: argRes.value } : {}),
          ...(opts.outputName !== undefined ? { outputName: opts.outputName } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        await finishClientResult(res, ctx.flags.json, (ok) => {
          succeed(ok, formatDocSummary(ok.doc, 'Created via DocBuilder'), ctx.flags.json);
        });
        return;
      }

      let outputType: CloudDocDocBuilderOutputType | undefined;
      if (opts.outputType !== undefined) {
        const normalized = opts.outputType.trim().replace(/^\./, '').toLowerCase();
        if (!isDocBuilderOutputType(normalized)) {
          return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, `--output-type must be one of ${CLOUD_DOC_DOCBUILDER_OUTPUT_TYPES.join(', ')}`, { json: flags.json });
        }
        outputType = normalized;
      }
      let expectedVersion: number | undefined;
      if (opts.expectedVersion !== undefined) {
        const parsed = parsePositiveInt(opts.expectedVersion, '--expected-version');
        if (!parsed.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, parsed.message, { json: flags.json });
        expectedVersion = parsed.value;
      }
      if (opts.root && opts.folderId !== undefined) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, 'Pass either --root or --folder-id, not both', { json: flags.json });
      }
      const folderId = opts.root ? null : opts.folderId === 'null' ? null : opts.folderId;

      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocDocBuilderEditClient(ctx.creds, {
        docId,
        script: scriptRes.value,
        ...(argRes.value !== undefined ? { argument: argRes.value } : {}),
        ...(outputType ? { outputType } : {}),
        ...(opts.outputName !== undefined ? { outputName: opts.outputName } : {}),
        save: opts.save !== false,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      await finishClientResult(res, ctx.flags.json, async (ok) => {
        if ('bytesBase64' in ok && typeof ok.bytesBase64 === 'string') {
          let savedTo: string | undefined;
          if (opts.out) {
            const bytes = Buffer.from(ok.bytesBase64, 'base64');
            savedTo = await writeBinaryOutFile(opts.out, ok.outputName, bytes, cwd);
          }
          const payload = savedTo
            ? {
                doc: ok.doc,
                outputName: ok.outputName,
                mimeType: ok.mimeType,
                bytesWritten: ok.bytesWritten,
                savedTo,
                ...(ok.onlyofficeUrls ? { onlyofficeUrls: ok.onlyofficeUrls } : {}),
              }
            : ok;
          const summary = savedTo
            ? `Exported via DocBuilder: ${ok.outputName} (${ok.bytesWritten} bytes) -> ${savedTo}`
            : `Exported via DocBuilder: ${ok.outputName} (${ok.bytesWritten} bytes; pass --out <path> to write locally)`;
          succeed(payload, summary, ctx.flags.json);
          return;
        }
        succeed(ok, formatDocSummary(ok.doc, 'Updated via DocBuilder'), ctx.flags.json);
      });
    });

  // 7. convert
  const convertCmd = addAuthAndFormatOptions(
    configureCmd(program.command('convert <docId>').description('Convert a Cloud Doc using ONLYOFFICE Converter')),
  );
  convertCmd
    .requiredOption('--to <targetType>', `Target format (${CLOUD_DOC_CONVERT_TARGET_TYPES.join(', ')})`)
    .option('--out <path>', 'Write converted binary output to local path')
    .option('--save-as-new', 'Save converted document as a new Cloud Doc on the server')
    .option('--name <name>', 'Output filename')
    .option('--folder-id <folderId>', 'Destination folderId when --save-as-new is set')
    .option('--timeout <ms>', `Conversion timeout in ms (1..${CLOUD_DOC_CONVERT_MAX_TIMEOUT_MS})`)
    .action(async (docId: string, opts: {
      to: string;
      out?: string;
      saveAsNew?: boolean;
      name?: string;
      folderId?: string;
      timeout?: string;
    }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      const targetType = opts.to.trim().replace(/^\./, '').toLowerCase();
      if (!isConvertTargetType(targetType)) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, `--to must be one of ${CLOUD_DOC_CONVERT_TARGET_TYPES.join(', ')}`, { json: flags.json });
      }
      let timeoutMs: number | undefined;
      if (opts.timeout !== undefined) {
        const parsed = parsePositiveInt(opts.timeout, '--timeout', CLOUD_DOC_CONVERT_MAX_TIMEOUT_MS);
        if (!parsed.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, parsed.message, { json: flags.json });
        timeoutMs = parsed.value;
      }

      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocConvertClient(ctx.creds, {
        docId,
        targetType: targetType as CloudDocConvertTargetType,
        ...(opts.saveAsNew ? { saveAsNew: true } : {}),
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.folderId !== undefined ? { folderId: opts.folderId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      await finishClientResult(res, ctx.flags.json, async (ok) => {
        if ('bytesBase64' in ok && typeof ok.bytesBase64 === 'string') {
          let savedTo: string | undefined;
          if (opts.out) {
            const bytes = Buffer.from(ok.bytesBase64, 'base64');
            savedTo = await writeBinaryOutFile(opts.out, ok.fileName, bytes, cwd);
          }
          const payload = savedTo
            ? { fileName: ok.fileName, mimeType: ok.mimeType, bytesWritten: ok.bytesWritten, savedTo }
            : ok;
          const summary = savedTo
            ? `Converted to ${ok.fileName} (${ok.bytesWritten} bytes) -> ${savedTo}`
            : `Converted to ${ok.fileName} (${ok.bytesWritten} bytes; pass --out <path> to write locally)`;
          succeed(payload, summary, ctx.flags.json);
          return;
        }
        if ('doc' in ok && ok.doc) {
          succeed(ok, formatDocSummary(ok.doc, 'Converted & saved as new Cloud Doc'), ctx.flags.json);
        }
      });
    });

  // 8. upload
  const uploadCmd = addAuthAndFormatOptions(
    configureCmd(program.command('upload [localFile]').description('Upload a local file as a new Cloud Doc or replace an existing Cloud Doc in-place')),
  );
  uploadCmd
    .option('--file <path>', 'Local file path to upload')
    .option('--name <name>', 'Override Cloud Doc filename')
    .option('--folder-id <folderId>', 'Destination folderId')
    .option('--root', 'When used with --replace, move doc to owner root folder (folderId=null)')
    .option('--replace <docId>', 'Replace an existing Cloud Doc binary in-place (PUT /api/cloud-docs/:id/file)')
    .option('--expected-version <n>', 'Optimistic CAS version check when using --replace')
    .action(async (localFileArg: string | undefined, opts: {
      file?: string;
      name?: string;
      folderId?: string;
      root?: boolean;
      replace?: string;
      expectedVersion?: string;
    }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      if (localFileArg && opts.file && localFileArg !== opts.file) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, 'Pass local file as positional arg or --file, not conflicting values', { json: flags.json });
      }
      const rawPath = (opts.file ?? localFileArg ?? '').trim();
      if (!rawPath) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, 'upload requires <localFile> or --file <path>', { json: flags.json });
      }
      if (opts.root && opts.folderId !== undefined) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, 'Pass either --root or --folder-id, not both', { json: flags.json });
      }
      let expectedVersion: number | undefined;
      if (opts.expectedVersion !== undefined) {
        const parsed = parsePositiveInt(opts.expectedVersion, '--expected-version');
        if (!parsed.ok) return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, parsed.message, { json: flags.json });
        expectedVersion = parsed.value;
      }

      const resolvedPath = resolve(cwd, rawPath);
      let fileBytes: Buffer;
      try {
        fileBytes = await readFile(resolvedPath);
      } catch (err) {
        return fail(
          MCP_ERROR_REASONS.VALIDATION_FAILED,
          `Failed to read local file "${rawPath}": ${err instanceof Error ? err.message : String(err)}`,
          { json: flags.json },
        );
      }
      if (fileBytes.length > CLOUD_DOCS_MAX_UPLOAD_BYTES) {
        return fail(
          MCP_ERROR_REASONS.VALIDATION_FAILED,
          `File exceeds maximum Cloud Docs upload size (${CLOUD_DOCS_MAX_UPLOAD_BYTES} bytes)`,
          { json: flags.json },
        );
      }

      const inferredName = sanitizeCloudDocTransferFilename(opts.name ?? rawPath);
      const mimeType = getCloudDocMeta(opts.name ?? inferredName)?.mimeType;
      const folderId = opts.root ? null : opts.folderId === 'null' ? null : opts.folderId;

      const ctx = await acquireCreds(cmd);
      if (!ctx) return;

      if (opts.replace) {
        const res = await cloudDocReplaceFileClient(ctx.creds, {
          docId: opts.replace,
          fileBytes,
          fileName: inferredName,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(folderId !== undefined ? { folderId } : {}),
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          ...(mimeType ? { mimeType } : {}),
        });
        await finishClientResult(res, ctx.flags.json, (ok) => {
          succeed(ok, formatDocSummary(ok.doc, 'Replaced file'), ctx.flags.json);
        });
        return;
      }

      const res = await cloudDocUploadFileClient(ctx.creds, {
        fileBytes,
        fileName: inferredName,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
        ...(mimeType ? { mimeType } : {}),
      });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        succeed(ok, formatDocSummary(ok.doc, 'Uploaded'), ctx.flags.json);
      });
    });

  // 9. download
  const downloadCmd = addAuthAndFormatOptions(
    configureCmd(program.command('download <docId>').description('Download raw Cloud Doc binary bytes to a local file')),
  );
  downloadCmd
    .option('--out <path>', 'Output file path or directory (defaults to ./<docName>)')
    .action(async (docId: string, opts: { out?: string }, cmd: Command) => {
      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocDownloadFileClient(ctx.creds, { docId });
      await finishClientResult(res, ctx.flags.json, async (ok) => {
        const fallback = ok.fileName ?? `${sanitizeCloudDocTransferFilename(docId)}.bin`;
        const savedTo = await writeBinaryOutFile(opts.out, fallback, ok.bytes, cwd);
        const payload = {
          docId,
          fileName: fallback,
          ...(ok.contentType ? { contentType: ok.contentType } : {}),
          bytesWritten: ok.bytesRead,
          savedTo,
        };
        succeed(payload, `Downloaded ${fallback} (${ok.bytesRead} bytes) -> ${savedTo}`, ctx.flags.json);
      });
    });

  // 10. delete
  const deleteCmd = addAuthAndFormatOptions(
    configureCmd(program.command('delete <id>').description('Delete an owned Cloud Doc or folder tree')),
  );
  deleteCmd
    .option('--kind <kind>', 'Target kind: doc (default) or folder', 'doc')
    .action(async (id: string, opts: { kind: string }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      if (opts.kind !== 'doc' && opts.kind !== 'folder') {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, '--kind must be doc or folder', { json: flags.json });
      }
      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocDeleteClient(ctx.creds, {
        targetKind: opts.kind as CloudDocShareTargetKind,
        id,
      });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        succeed(ok, `Deleted ${opts.kind}: ${id}`, ctx.flags.json);
      });
    });

  // 11. share
  const shareCmd = configureCmd(program.command('share').description('Manage Cloud Doc and folder sharing permissions'));
  addAuthAndFormatOptions(shareCmd, true);

  addAuthAndFormatOptions(
    configureCmd(shareCmd.command('list <targetId>').description('List active shares for a document or folder')),
  )
    .option('--kind <kind>', 'Target kind: doc (default) or folder', 'doc')
    .action(async (targetId: string, opts: { kind: string }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      if (opts.kind !== 'doc' && opts.kind !== 'folder') {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, '--kind must be doc or folder', { json: flags.json });
      }
      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocShareClient(ctx.creds, {
        action: 'list',
        targetKind: opts.kind as CloudDocShareTargetKind,
        targetId,
      });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        const shares = ok.shares ?? [];
        const lines = shares.length > 0
          ? shares.map((s) => `  - ${s.id}: ${s.shareMode} target=${s.targetUserUsername ?? s.targetUserName ?? s.targetTeamId ?? s.targetUserId} role=${s.role} allowDownload=${s.allowDownload}`)
          : ['No active shares.'];
        succeed(ok, lines.join('\n'), ctx.flags.json);
      });
    });

  addAuthAndFormatOptions(
    configureCmd(shareCmd.command('teams').description('List teams available for Cloud Docs sharing')),
  )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocShareClient(ctx.creds, { action: 'list_teams' });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        const teams = ok.teams ?? [];
        const lines = teams.length > 0
          ? teams.map((t) => `  - ${t.name} (id=${t.id})`)
          : ['No shareable teams available.'];
        succeed(ok, lines.join('\n'), ctx.flags.json);
      });
    });

  addAuthAndFormatOptions(
    configureCmd(shareCmd.command('grant <targetId>').description('Grant viewer or editor access to a user or team')),
  )
    .option('--kind <kind>', 'Target kind: doc (default) or folder', 'doc')
    .option('--user <username>', 'Share with username / identifier')
    .option('--user-id <userId>', 'Share with userId')
    .option('--team-id <teamId>', 'Share with teamId')
    .requiredOption('--role <role>', 'Granted role: viewer or editor')
    .option('--allow-download', 'Allow downloads/conversions for shared recipients')
    .option('--no-download', 'Disallow downloads/conversions for shared recipients')
    .action(async (targetId: string, opts: {
      kind: string;
      user?: string;
      userId?: string;
      teamId?: string;
      role: string;
      download: boolean;
      allowDownload?: boolean;
    }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      if (opts.kind !== 'doc' && opts.kind !== 'folder') {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, '--kind must be doc or folder', { json: flags.json });
      }
      if (opts.role !== 'viewer' && opts.role !== 'editor') {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, '--role must be viewer or editor', { json: flags.json });
      }
      const hasUser = Boolean(opts.user || opts.userId);
      const hasTeam = Boolean(opts.teamId);
      if (hasUser === hasTeam) {
        return fail(MCP_ERROR_REASONS.VALIDATION_FAILED, 'Provide either --team-id OR (--user / --user-id)', { json: flags.json });
      }
      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocShareClient(ctx.creds, {
        action: 'grant',
        targetKind: opts.kind as CloudDocShareTargetKind,
        targetId,
        shareMode: hasTeam ? 'team' : 'user',
        ...(opts.teamId ? { targetTeamId: opts.teamId } : {}),
        ...(opts.userId ? { targetUserId: opts.userId } : {}),
        ...(opts.user ? { targetUsername: opts.user } : {}),
        role: opts.role,
        ...(opts.download === false ? { allowDownload: false } : opts.allowDownload ? { allowDownload: true } : {}),
      });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        const share = ok.share;
        succeed(ok, share ? `Granted share ${share.id} (${share.role})` : 'Granted share', ctx.flags.json);
      });
    });

  addAuthAndFormatOptions(
    configureCmd(shareCmd.command('revoke <shareId>').description('Revoke an existing share by shareId')),
  )
    .action(async (shareId: string, _opts: Record<string, unknown>, cmd: Command) => {
      const ctx = await acquireCreds(cmd);
      if (!ctx) return;
      const res = await cloudDocShareClient(ctx.creds, { action: 'revoke', shareId });
      await finishClientResult(res, ctx.flags.json, (ok) => {
        succeed(ok, `Revoked share: ${shareId}`, ctx.flags.json);
      });
    });

  // 12. docs
  const docsCmd = addAuthAndFormatOptions(
    configureCmd(program.command('docs [topic]').description('Read embedded progressive-disclosure Cloud Docs & ONLYOFFICE handbook')),
    false,
  );
  docsCmd
    .option('--topic <topic>', 'Topic: index|quickstart|docx|xlsx|pptx|edit|convert|share|troubleshooting|all')
    .action((topicArg: string | undefined, opts: { topic?: string }, cmd: Command) => {
      const flags = extractCommonFlags(cmd);
      const requested = opts.topic ?? topicArg ?? 'index';
      const guide = getCloudDocsGuideText(requested);
      if (!guide.ok) {
        fail(MCP_ERROR_REASONS.VALIDATION_FAILED, guide.message, { json: flags.json });
        return;
      }
      succeed({ topic: guide.topic, text: guide.text }, guide.text, flags.json);
    });

  const effectiveArgv = argv.length > 0 ? argv : ['--help'];
  try {
    await program.parseAsync(effectiveArgv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help' || err.code === 'commander.version') {
        exitCode = 0;
      } else {
        exitCode = err.exitCode > 0 ? err.exitCode : 2;
        errorReason = MCP_ERROR_REASONS.VALIDATION_FAILED;
      }
    } else {
      fail(
        MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    exitCode,
    stdout,
    stderr,
    ...(data !== undefined ? { data } : {}),
    ...(errorReason ? { errorReason } : {}),
  };
}

export function registerCloudDocsCommand(parent: Command): void {
  parent
    .command('cloud-docs [args...]')
    .description('Unified Cloud Docs & ONLYOFFICE Document Builder CLI (`imcodes cloud-docs docs` for guide)')
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (args: string[], _opts: Record<string, unknown>, cmd: Command) => {
      const rawArgs = (cmd.parent as { rawArgs?: string[] } | undefined)?.rawArgs;
      let forwarded = args;
      if (Array.isArray(rawArgs)) {
        const idx = rawArgs.indexOf('cloud-docs');
        if (idx >= 0) {
          forwarded = rawArgs.slice(idx + 1);
        }
      }
      const result = await runCloudDocsCli(forwarded);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.exitCode !== 0) {
        const err = new Error(result.stderr.trim() || `cloud-docs exited with code ${result.exitCode}`) as Error & { exitCode?: number };
        err.exitCode = result.exitCode;
        throw err;
      }
    });
}
