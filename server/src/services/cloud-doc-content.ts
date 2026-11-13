import { inflateRawSync } from 'node:zlib';
import {
  CLOUD_DOC_CONTENT_MAX_CHARS,
  CLOUD_DOC_EDITABLE_EXTS,
  CLOUD_DOC_ERROR_CODES,
  CLOUD_DOC_OOXML_MAX_CELLS,
  CLOUD_DOC_OOXML_MAX_COL_INDEX,
  CLOUD_DOC_OOXML_MAX_PARAGRAPHS,
  CLOUD_DOC_OOXML_MAX_ROW_COLS,
  CLOUD_DOC_READABLE_TEXT_EXTS,
  CLOUD_DOC_ZIP_MAX_ENTRIES,
  CLOUD_DOC_ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES,
  CLOUD_DOC_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
  type CloudDocContentPayload,
  type CloudDocEditMode,
} from '../../../shared/cloud-docs.js';
import { buildBlankDocumentBytes, buildZipArchive, crc32 } from '../routes/onlyoffice.js';

const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// eslint-disable-next-line no-control-regex
const DISALLOWED_XML_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export class CloudDocContentError extends Error {
  readonly code: string;
  readonly statusCode: 400 | 413;

  constructor(code: string, message: string, statusCode: 400 | 413 = 400) {
    super(message);
    this.name = 'CloudDocContentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isEditableCloudDocExt(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return (CLOUD_DOC_EDITABLE_EXTS as readonly string[]).includes(normalized);
}

function isPlainTextExt(ext: string): boolean {
  return (CLOUD_DOC_READABLE_TEXT_EXTS as readonly string[]).includes(ext);
}

export function escapeXmlText(input: string): string {
  return input
    .replace(DISALLOWED_XML_CONTROL_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXmlText(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(rawAttrs)) !== null) {
    attrs[match[1]] = unescapeXmlText(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/** Extract ZIP entries with strict archive, entry-count, per-entry, and total decompressed bounds. */
export function extractZipEntries(
  buf: Buffer,
  limits: {
    maxEntries?: number;
    maxEntryBytes?: number;
    maxTotalBytes?: number;
  } = {},
): Map<string, Buffer> {
  const maxEntries = limits.maxEntries ?? CLOUD_DOC_ZIP_MAX_ENTRIES;
  const maxEntryBytes = limits.maxEntryBytes ?? CLOUD_DOC_ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? CLOUD_DOC_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES;

  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Archive is too small or corrupt');
  }

  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Missing ZIP central directory footer');
  }

  const diskNumber = buf.readUInt16LE(eocdOffset + 4);
  const cdDisk = buf.readUInt16LE(eocdOffset + 6);
  const diskEntries = buf.readUInt16LE(eocdOffset + 8);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || cdDisk !== 0 || diskEntries !== totalEntries || totalEntries === 0xffff) {
    throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Unsupported multi-disk or ZIP64 archive');
  }
  if (totalEntries > maxEntries) {
    throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE, `Archive exceeds max entry limit (${maxEntries})`, 413);
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Corrupt ZIP central directory bounds');
  }

  const entries = new Map<string, Buffer>();
  let cursor = cdOffset;
  let totalDecompressed = 0;

  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (cursor + 46 > cdOffset + cdSize || buf.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER_SIG) {
      throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Invalid ZIP central directory entry');
    }

    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const expectedCrc = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const declaredUncompressed = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    if (cursor + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) {
      throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Truncated ZIP central directory header');
    }

    if ((flags & 0x0001) !== 0) {
      throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Encrypted ZIP entries are not supported');
    }

    const entryName = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (entryName.endsWith('/')) continue; // skip directory entries

    if (declaredUncompressed > maxEntryBytes) {
      throw new CloudDocContentError(
        CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
        `Archive entry ${entryName} exceeds size limit`,
        413,
      );
    }

    if (localHeaderOffset + 30 > cdOffset || buf.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_HEADER_SIG) {
      throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Invalid ZIP local file header');
    }

    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) {
      throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Truncated ZIP entry payload');
    }

    const compressedSlice = buf.subarray(dataStart, dataEnd);
    const remainingBudget = maxTotalBytes - totalDecompressed;
    const entryBudget = Math.min(maxEntryBytes, remainingBudget);

    let data: Buffer;
    if (method === 0) {
      if (compressedSlice.length > entryBudget) {
        throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE, 'Decompressed archive exceeds total budget', 413);
      }
      data = Buffer.from(compressedSlice);
    } else if (method === 8) {
      try {
        data = inflateRawSync(compressedSlice, { maxOutputLength: entryBudget + 1 });
      } catch (err) {
        const errCode = (err as { code?: string })?.code;
        if (errCode === 'ERR_BUFFER_TOO_LARGE') {
          throw new CloudDocContentError(
            CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
            'Decompressed archive exceeds size budget',
            413,
          );
        }
        throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Corrupt deflate stream in archive');
      }
      if (data.length > entryBudget) {
        throw new CloudDocContentError(
          CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
          'Decompressed archive exceeds size budget',
          413,
        );
      }
    } else {
      throw new CloudDocContentError(
        CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE,
        `Unsupported ZIP compression method ${method}`,
      );
    }

    if (crc32(data) !== expectedCrc) {
      throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, `CRC mismatch in archive entry ${entryName}`);
    }

    totalDecompressed += data.length;
    if (totalDecompressed > maxTotalBytes) {
      throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE, 'Archive exceeds total uncompressed budget', 413);
    }

    entries.set(entryName, data);
  }

  return entries;
}

function extractParagraphRuns(xml: string, textTagPattern: RegExp, breakTagPattern: RegExp, tabTagPattern: RegExp): string {
  // Walk tags in order to preserve runs, breaks, and tabs within a paragraph block.
  const tokenRe = /<[^>]+>|[^<]+/g;
  const parts: string[] = [];
  let inText = false;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml)) !== null) {
    const token = m[0];
    if (token.startsWith('<')) {
      if (textTagPattern.test(token)) {
        inText = !token.endsWith('/>');
      } else if (breakTagPattern.test(token)) {
        inText = false;
        parts.push('\n');
      } else if (tabTagPattern.test(token)) {
        inText = false;
        parts.push('\t');
      } else {
        inText = false;
      }
    } else if (inText) {
      parts.push(unescapeXmlText(token));
    }
  }
  return parts.join('');
}

function checkArchiveOutputBounds(files: ReadonlyArray<{ name: string; content: string | Buffer }>): void {
  if (files.length > CLOUD_DOC_ZIP_MAX_ENTRIES) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Generated OOXML archive exceeds max entry limit (${CLOUD_DOC_ZIP_MAX_ENTRIES})`,
      413,
    );
  }
  let totalBytes = 0;
  for (const file of files) {
    const entryBytes = Buffer.isBuffer(file.content) ? file.content.length : Buffer.byteLength(file.content, 'utf8');
    if (entryBytes > CLOUD_DOC_ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new CloudDocContentError(
        CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
        `Generated archive entry "${file.name}" exceeds size limit (${CLOUD_DOC_ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES} bytes)`,
        413,
      );
    }
    totalBytes += entryBytes;
    if (totalBytes > CLOUD_DOC_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new CloudDocContentError(
        CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
        `Generated archive exceeds total uncompressed size budget (${CLOUD_DOC_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes)`,
        413,
      );
    }
  }
}

function extractDocxText(
  entries: Map<string, Buffer>,
  maxChars: number = CLOUD_DOC_CONTENT_MAX_CHARS,
): { content: string; truncated: boolean; totalChars: number } {
  const docBuf = entries.get('word/document.xml');
  if (!docBuf) {
    throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Missing word/document.xml in DOCX');
  }
  const xml = docBuf.toString('utf8');
  const lines: string[] = [];
  let paragraphCount = 0;
  let remainingChars = maxChars;
  let rawCharsSeen = 0;
  let truncated = false;

  // Process top-level blocks in <w:body> preserving table rows (<w:tr>) vs standalone paragraphs (<w:p>).
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i.exec(xml);
  const body = bodyMatch ? bodyMatch[1] : xml;

  const pushLine = (line: string): boolean => {
    paragraphCount += 1;
    if (paragraphCount > CLOUD_DOC_OOXML_MAX_PARAGRAPHS) {
      throw new CloudDocContentError(
        CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
        `DOCX paragraph/row count exceeds limit (${CLOUD_DOC_OOXML_MAX_PARAGRAPHS})`,
        413,
      );
    }
    const sep = lines.length > 0 ? 1 : 0;
    rawCharsSeen += sep + line.length;
    if (remainingChars <= 0) {
      truncated = true;
      return false;
    }
    if (sep + line.length > remainingChars) {
      if (remainingChars > sep) {
        lines.push(line.slice(0, remainingChars - sep));
      }
      remainingChars = 0;
      truncated = true;
      return false;
    }
    lines.push(line);
    remainingChars -= sep + line.length;
    return true;
  };

  const blockRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\s*\/>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(body)) !== null) {
    const snippet = block[0];
    if (snippet.startsWith('<w:tbl')) {
      const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      let row: RegExpExecArray | null;
      while ((row = rowRe.exec(snippet)) !== null) {
        const cellTexts: string[] = [];
        const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        let cell: RegExpExecArray | null;
        while ((cell = cellRe.exec(row[1])) !== null) {
          const pTexts: string[] = [];
          const pRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\s*\/>/g;
          let p: RegExpExecArray | null;
          while ((p = pRe.exec(cell[1])) !== null) {
            pTexts.push(extractParagraphRuns(p[0], /^<w:t(?:\s|>)/, /^<w:(?:br|cr)(?:\s|\/>|>)/, /^<w:tab(?:\s|\/>|>)/));
          }
          cellTexts.push(pTexts.join(' ').trim());
        }
        if (!pushLine(cellTexts.join('\t'))) {
          const content = lines.join('\n').slice(0, maxChars);
          return { content, truncated: true, totalChars: Math.max(rawCharsSeen, content.length + 1) };
        }
      }
    } else {
      const line = extractParagraphRuns(snippet, /^<w:t(?:\s|>)/, /^<w:(?:br|cr)(?:\s|\/>|>)/, /^<w:tab(?:\s|\/>|>)/);
      if (!pushLine(line)) {
        const content = lines.join('\n').slice(0, maxChars);
        return { content, truncated: true, totalChars: Math.max(rawCharsSeen, content.length + 1) };
      }
    }
  }

  const content = lines.join('\n');
  return { content, truncated, totalChars: truncated ? Math.max(rawCharsSeen, content.length + 1) : content.length };
}

function colRefToIndex(ref: string): number | null {
  const letters = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!letters) return null;
  if (letters[1].length > 3) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Spreadsheet cell reference "${ref}" exceeds supported column bounds`,
      413,
    );
  }
  const rowNum = Number.parseInt(letters[2], 10);
  if (!Number.isFinite(rowNum) || rowNum <= 0) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE,
      `Malformed spreadsheet cell reference "${ref}"`,
      400,
    );
  }
  let idx = 0;
  for (const ch of letters[1].toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  const zeroBased = idx - 1;
  if (zeroBased > CLOUD_DOC_OOXML_MAX_COL_INDEX || zeroBased >= CLOUD_DOC_OOXML_MAX_ROW_COLS) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Spreadsheet column "${ref}" exceeds maximum row width (${CLOUD_DOC_OOXML_MAX_ROW_COLS})`,
      413,
    );
  }
  return zeroBased;
}

function indexToColRef(idx: number): string {
  let n = idx + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseRelationships(relsBuf: Buffer | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsBuf) return map;
  const xml = relsBuf.toString('utf8');
  const relRe = /<Relationship\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(m[1]);
    if (attrs.Id && attrs.Target) {
      map.set(attrs.Id, attrs.Target);
    }
  }
  return map;
}

function parseSharedStrings(buf: Buffer | undefined): string[] {
  if (!buf) return [];
  const xml = buf.toString('utf8');
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const tParts: string[] = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(m[1])) !== null) {
      tParts.push(unescapeXmlText(t[1]));
    }
    out.push(tParts.join(''));
  }
  return out;
}

function discoverXlsxSheets(entries: Map<string, Buffer>): Array<{ name: string; path: string }> {
  const wbBuf = entries.get('xl/workbook.xml');
  const wbRels = parseRelationships(entries.get('xl/_rels/workbook.xml.rels'));

  const sheetSpecs: Array<{ name: string; path: string }> = [];
  if (wbBuf) {
    const wbXml = wbBuf.toString('utf8');
    const sheetRe = /<sheet\b([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = sheetRe.exec(wbXml)) !== null) {
      const attrs = parseXmlAttributes(m[1]);
      const name = attrs.name || `Sheet${sheetSpecs.length + 1}`;
      const rid = attrs['r:id'] || attrs.id;
      const target = rid ? wbRels.get(rid) : undefined;
      if (target) {
        const normalizedTarget = target.replace(/^\/+/, '');
        const fullPath = normalizedTarget.startsWith('xl/') ? normalizedTarget : `xl/${normalizedTarget}`;
        if (entries.has(fullPath)) {
          sheetSpecs.push({ name, path: fullPath });
        }
      }
    }
  }

  if (sheetSpecs.length === 0) {
    const fallbackPaths = [...entries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
      .sort((a, b) => {
        const na = Number.parseInt(/(\d+)\.xml$/i.exec(a)?.[1] ?? '0', 10);
        const nb = Number.parseInt(/(\d+)\.xml$/i.exec(b)?.[1] ?? '0', 10);
        return na - nb;
      });
    if (fallbackPaths.length === 0) {
      throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Missing worksheet XML in XLSX');
    }
    fallbackPaths.forEach((p, idx) => sheetSpecs.push({ name: `Sheet${idx + 1}`, path: p }));
  }

  return sheetSpecs;
}

function extractXlsxContent(
  entries: Map<string, Buffer>,
  maxChars: number = CLOUD_DOC_CONTENT_MAX_CHARS,
): { content: string; sheets: Array<{ name: string; rows: string[][] }>; truncated: boolean; totalChars: number } {
  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml'));
  const sheetSpecs = discoverXlsxSheets(entries);
  const isSingleDefaultSheet = sheetSpecs.length === 1 && sheetSpecs[0].name === 'Sheet1';

  const sheets: Array<{ name: string; rows: string[][] }> = [];
  let totalCells = 0;
  let remainingChars = maxChars;
  let rawCharsSeen = 0;
  let truncated = false;

  for (let sIdx = 0; sIdx < sheetSpecs.length; sIdx += 1) {
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }
    const spec = sheetSpecs[sIdx];
    const headerLen = isSingleDefaultSheet
      ? 0
      : (sIdx > 0 ? 2 : 0) + `## Sheet: ${spec.name}`.length;
    if (sIdx > 0 && remainingChars <= 2) {
      truncated = true;
      break;
    }
    rawCharsSeen += headerLen;
    remainingChars = Math.max(0, remainingChars - headerLen);

    const sheetXml = entries.get(spec.path)!.toString('utf8');
    const rows: string[][] = [];
    const rowRe = /<row\b[^>]*\/>|<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rowRe.exec(sheetXml)) !== null) {
      const rowInnerXml = rMatch[1] ?? '';
      if (rows.length > 0 || !isSingleDefaultSheet) {
        if (remainingChars <= 0) {
          truncated = true;
          break;
        }
        // Account for the rendered newline separator between rows (including empty rows).
        if (rows.length > 0) {
          rawCharsSeen += 1;
          remainingChars -= 1;
        }
      }
      const rowValues: string[] = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cMatch: RegExpExecArray | null;
      while ((cMatch = cellRe.exec(rowInnerXml)) !== null) {
        const attrs = parseXmlAttributes(cMatch[1]);
        const body = cMatch[2] ?? '';
        const colIdx = attrs.r ? colRefToIndex(attrs.r) : rowValues.length;
        const targetCol = colIdx !== null && colIdx >= 0 ? colIdx : rowValues.length;
        if (targetCol >= CLOUD_DOC_OOXML_MAX_ROW_COLS) {
          throw new CloudDocContentError(
            CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
            `Spreadsheet row width exceeds maximum (${CLOUD_DOC_OOXML_MAX_ROW_COLS} columns)`,
            413,
          );
        }
        const addedCells = Math.max(0, targetCol - rowValues.length) + 1;
        totalCells += addedCells;
        if (totalCells > CLOUD_DOC_OOXML_MAX_CELLS) {
          throw new CloudDocContentError(
            CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
            `Spreadsheet cell count exceeds maximum (${CLOUD_DOC_OOXML_MAX_CELLS})`,
            413,
          );
        }

        const cellType = attrs.t ?? '';
        let value = '';
        if (cellType === 'inlineStr') {
          const tParts: string[] = [];
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let t: RegExpExecArray | null;
          while ((t = tRe.exec(body)) !== null) {
            tParts.push(unescapeXmlText(t[1]));
          }
          value = tParts.join('');
        } else {
          const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
          const rawV = vMatch ? unescapeXmlText(vMatch[1]) : '';
          if (cellType === 's') {
            const idx = Number.parseInt(rawV, 10);
            value = Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : '';
          } else if (cellType === 'b') {
            value = rawV === '1' ? 'TRUE' : 'FALSE';
          } else {
            value = rawV;
          }
        }

        const tabsNeeded = rowValues.length === 0 ? targetCol : Math.max(0, targetCol - rowValues.length + 1);
        rawCharsSeen += tabsNeeded + value.length;
        if (tabsNeeded > remainingChars) {
          remainingChars = 0;
          truncated = true;
          break;
        }
        remainingChars -= tabsNeeded;
        while (rowValues.length < targetCol) rowValues.push('');
        if (value.length > remainingChars) {
          rowValues[targetCol] = value.slice(0, remainingChars);
          remainingChars = 0;
          truncated = true;
          break;
        }
        rowValues[targetCol] = value;
        remainingChars -= value.length;
      }
      while (rowValues.length > 0 && rowValues[rowValues.length - 1] === '') {
        rowValues.pop();
      }
      if (rowValues.length > 0 || !truncated) {
        rows.push(rowValues);
      }
      if (truncated) break;
    }
    sheets.push({ name: spec.name, rows });
    if (remainingChars <= 0 && sIdx < sheetSpecs.length - 1) {
      truncated = true;
      break;
    }
  }

  const fullContent =
    sheets.length === 1 && sheets[0].name === 'Sheet1'
      ? sheets[0].rows.map((row) => row.join('\t')).join('\n')
      : sheets.map((sheet) => `## Sheet: ${sheet.name}\n${sheet.rows.map((row) => row.join('\t')).join('\n')}`).join('\n\n');

  if (fullContent.length > maxChars) {
    truncated = true;
  }
  const content = truncated ? fullContent.slice(0, maxChars) : fullContent;
  const totalChars = truncated ? Math.max(rawCharsSeen, fullContent.length, content.length + 1) : content.length;

  return { content, sheets, truncated, totalChars };
}

function extractPptxContent(
  entries: Map<string, Buffer>,
  maxChars: number = CLOUD_DOC_CONTENT_MAX_CHARS,
): {
  content: string;
  slides: Array<{ index: number; title?: string; texts: string[] }>;
  truncated: boolean;
  totalChars: number;
} {
  const presBuf = entries.get('ppt/presentation.xml');
  const presRels = parseRelationships(entries.get('ppt/_rels/presentation.xml.rels'));

  const slidePaths: string[] = [];
  if (presBuf) {
    const presXml = presBuf.toString('utf8');
    const sldIdRe = /<p:sldId\b([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = sldIdRe.exec(presXml)) !== null) {
      const attrs = parseXmlAttributes(m[1]);
      const rid = attrs['r:id'] || attrs.id;
      const target = rid ? presRels.get(rid) : undefined;
      if (target) {
        const normalizedTarget = target.replace(/^\/+/, '');
        const fullPath = normalizedTarget.startsWith('ppt/') ? normalizedTarget : `ppt/${normalizedTarget}`;
        if (entries.has(fullPath)) slidePaths.push(fullPath);
      }
    }
  }

  if (slidePaths.length === 0) {
    const fallback = [...entries.keys()]
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => {
        const na = Number.parseInt(/(\d+)\.xml$/i.exec(a)?.[1] ?? '0', 10);
        const nb = Number.parseInt(/(\d+)\.xml$/i.exec(b)?.[1] ?? '0', 10);
        return na - nb;
      });
    if (fallback.length === 0) {
      throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Missing slide XML in PPTX');
    }
    slidePaths.push(...fallback);
  }

  const slides: Array<{ index: number; title?: string; texts: string[] }> = [];
  let totalParagraphs = 0;
  let remainingChars = maxChars;
  let rawCharsSeen = 0;
  let truncated = false;

  for (let i = 0; i < slidePaths.length; i += 1) {
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }
    const slideHeaderCost = (i > 0 ? 2 : 0) + `--- Slide ${i + 1} ---`.length;
    if (i > 0 && remainingChars <= 2) {
      truncated = true;
      break;
    }
    rawCharsSeen += slideHeaderCost;
    remainingChars = Math.max(0, remainingChars - slideHeaderCost);

    const xml = entries.get(slidePaths[i])!.toString('utf8');
    const texts: string[] = [];
    const pRe = /<a:p\b[^>]*>[\s\S]*?<\/a:p>|<a:p\s*\/>/g;
    let p: RegExpExecArray | null;
    while ((p = pRe.exec(xml)) !== null) {
      totalParagraphs += 1;
      if (totalParagraphs > CLOUD_DOC_OOXML_MAX_PARAGRAPHS) {
        throw new CloudDocContentError(
          CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
          `Presentation paragraph count exceeds maximum (${CLOUD_DOC_OOXML_MAX_PARAGRAPHS})`,
          413,
        );
      }
      const text = extractParagraphRuns(p[0], /^<a:t(?:\s|>)/, /^<a:br(?:\s|\/>|>)/, /^<a:tab(?:\s|\/>|>)/).trimEnd();
      if (!text) continue;
      const lineSep = texts.length > 0 ? 1 : 0;
      rawCharsSeen += lineSep + text.length;
      if (remainingChars <= lineSep) {
        remainingChars = 0;
        truncated = true;
        break;
      }
      remainingChars -= lineSep;
      if (text.length > remainingChars) {
        texts.push(text.slice(0, remainingChars));
        remainingChars = 0;
        truncated = true;
        break;
      }
      texts.push(text);
      remainingChars -= text.length;
    }
    slides.push({
      index: i + 1,
      ...(texts[0] ? { title: texts[0] } : {}),
      texts,
    });
    if (remainingChars <= 0 && i < slidePaths.length - 1) {
      truncated = true;
      break;
    }
  }

  const fullContent = slides
    .map((slide) => `--- Slide ${slide.index} ---${slide.texts.length ? `\n${slide.texts.join('\n')}` : ''}`)
    .join('\n\n');

  if (fullContent.length > maxChars) {
    truncated = true;
  }
  const content = truncated ? fullContent.slice(0, maxChars) : fullContent;
  const totalChars = truncated ? Math.max(rawCharsSeen, fullContent.length, content.length + 1) : content.length;

  return { content, slides, truncated, totalChars };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function parseRowCells(line: string): string[] {
  if (!line) return [];
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(',') || line.startsWith('"')) return parseCsvLine(line);
  return [line];
}

function parseXlsxInputSheets(content: string): Array<{ name: string; rows: string[][] }> {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return [{ name: 'Sheet1', rows: [] }];
  }

  const lines = normalized.split('\n');
  const sheets: Array<{ name: string; rows: string[][] }> = [];
  let current: { name: string; rows: string[][] } | null = null;
  let totalCells = 0;
  const sheetHeaderRe = /^(?:##\s*)?Sheet:\s*(.+?)\s*$/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const headerMatch = sheetHeaderRe.exec(line);
    if (headerMatch) {
      const sheetName = headerMatch[1].replace(/[\\/?*[\]:]/g, '').trim().slice(0, 31) || `Sheet${sheets.length + 1}`;
      current = { name: sheetName, rows: [] };
      sheets.push(current);
      continue;
    }
    if (!current) {
      current = { name: 'Sheet1', rows: [] };
      sheets.push(current);
    }
    if (
      line === '' &&
      current.rows.length > 0 &&
      (i === lines.length - 1 || sheetHeaderRe.test(lines[i + 1] ?? ''))
    ) {
      // Ignore trailing newline at EOF or separator blank line immediately before the next sheet header.
      continue;
    }
    const rowCells = parseRowCells(line);
    if (rowCells.length > CLOUD_DOC_OOXML_MAX_ROW_COLS) {
      throw new CloudDocContentError(
        CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
        `Spreadsheet row width exceeds maximum (${CLOUD_DOC_OOXML_MAX_ROW_COLS} columns)`,
        413,
      );
    }
    totalCells += rowCells.length;
    if (totalCells > CLOUD_DOC_OOXML_MAX_CELLS) {
      throw new CloudDocContentError(
        CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
        `Spreadsheet cell count exceeds maximum (${CLOUD_DOC_OOXML_MAX_CELLS})`,
        413,
      );
    }
    current.rows.push(rowCells);
  }

  return sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }];
}

function buildDocxParagraphsXml(lines: ReadonlyArray<string>): string {
  return (lines.length > 0 ? lines : [''])
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(line)}</w:t></w:r></w:p>`)
    .join('');
}

function buildDocxBytes(content: string): Buffer {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > CLOUD_DOC_OOXML_MAX_PARAGRAPHS) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Document paragraph count exceeds maximum (${CLOUD_DOC_OOXML_MAX_PARAGRAPHS})`,
      413,
    );
  }
  const paragraphs = buildDocxParagraphsXml(lines);
  const files: Array<{ name: string; content: string | Buffer }> = [
    {
      name: '[Content_Types].xml',
      content:
        `${XML_DECLARATION}` +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        `${XML_DECLARATION}` +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      content:
        `${XML_DECLARATION}` +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${paragraphs}<w:sectPr/></w:body>` +
        '</w:document>',
    },
  ];
  checkArchiveOutputBounds(files);
  return buildZipArchive(files);
}

function buildXlsxRowsXml(rows: ReadonlyArray<ReadonlyArray<string>>, startRowNum: number = 1): string {
  return rows
    .map((cells, rIdx) => {
      const rowNum = startRowNum + rIdx;
      const cellsXml = cells
        .map((val, cIdx) => {
          const ref = `${indexToColRef(cIdx)}${rowNum}`;
          if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(val) && Number.isFinite(Number(val))) {
            return `<c r="${ref}" t="n"><v>${val}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(val)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNum}">${cellsXml}</row>`;
    })
    .join('');
}

function buildXlsxBytes(content: string): Buffer {
  const sheets = parseXlsxInputSheets(content);
  const files: Array<{ name: string; content: string | Buffer }> = [];

  const contentTypeOverrides = sheets
    .map(
      (_s, idx) =>
        `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');

  files.push({
    name: '[Content_Types].xml',
    content:
      `${XML_DECLARATION}` +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      contentTypeOverrides +
      '</Types>',
  });

  files.push({
    name: '_rels/.rels',
    content:
      `${XML_DECLARATION}` +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  });

  const workbookSheets = sheets
    .map((s, idx) => `<sheet name="${escapeXmlText(s.name)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`)
    .join('');
  files.push({
    name: 'xl/workbook.xml',
    content:
      `${XML_DECLARATION}` +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${workbookSheets}</sheets>` +
      '</workbook>',
  });

  const rels = sheets
    .map(
      (_s, idx) =>
        `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`,
    )
    .join('');
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    content:
      `${XML_DECLARATION}` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  });

  sheets.forEach((sheet, idx) => {
    const rowXml = buildXlsxRowsXml(sheet.rows, 1);
    files.push({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      content:
        `${XML_DECLARATION}` +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        (rowXml ? `<sheetData>${rowXml}</sheetData>` : '<sheetData/>') +
        '</worksheet>',
    });
  });

  checkArchiveOutputBounds(files);
  return buildZipArchive(files);
}

function parsePptxInputSlides(content: string): string[][] {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [[]];

  const lines = normalized.split('\n');
  const slides: string[][] = [];
  let current: string[] | null = null;
  let totalParagraphs = 0;

  for (const line of lines) {
    if (/^---\s*(?:Slide\s+\d+[^-]*)?---\s*$/i.test(line)) {
      current = [];
      slides.push(current);
      continue;
    }
    if (!current) {
      current = [];
      slides.push(current);
    }
    if (line.trim() !== '') {
      totalParagraphs += 1;
      if (totalParagraphs > CLOUD_DOC_OOXML_MAX_PARAGRAPHS) {
        throw new CloudDocContentError(
          CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
          `Presentation paragraph count exceeds maximum (${CLOUD_DOC_OOXML_MAX_PARAGRAPHS})`,
          413,
        );
      }
      current.push(line);
    }
  }

  return slides.length > 0 ? slides : [[]];
}

function buildPptxSlideXml(slideLines: ReadonlyArray<string>): string {
  const paragraphs = (slideLines.length > 0 ? slideLines : [''])
    .map((line) => `<a:p><a:r><a:t>${escapeXmlText(line)}</a:t></a:r></a:p>`)
    .join('');
  return (
    `${XML_DECLARATION}` +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/>' +
    '<p:sp>' +
    '<p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="5943600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs}</p:txBody>` +
    '</p:sp>' +
    '</p:spTree></p:cSld>' +
    '</p:sld>'
  );
}

function buildPptxBytes(content: string): Buffer {
  const slides = parsePptxInputSlides(content);
  const files: Array<{ name: string; content: string | Buffer }> = [];

  const slideOverrides = slides
    .map(
      (_s, idx) =>
        `<Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join('');

  files.push({
    name: '[Content_Types].xml',
    content:
      `${XML_DECLARATION}` +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      slideOverrides +
      '</Types>',
  });

  files.push({
    name: '_rels/.rels',
    content:
      `${XML_DECLARATION}` +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
  });

  const sldIds = slides
    .map((_s, idx) => `<p:sldId id="${256 + idx}" r:id="rId${idx + 1}"/>`)
    .join('');
  files.push({
    name: 'ppt/presentation.xml',
    content:
      `${XML_DECLARATION}` +
      '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
      '<p:sldSz cx="9144000" cy="6858000"/>' +
      '<p:notesSz cx="6858000" cy="9144000"/>' +
      '</p:presentation>',
  });

  const rels = slides
    .map(
      (_s, idx) =>
        `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${idx + 1}.xml"/>`,
    )
    .join('');
  files.push({
    name: 'ppt/_rels/presentation.xml.rels',
    content:
      `${XML_DECLARATION}` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  });

  slides.forEach((slideLines, idx) => {
    files.push({
      name: `ppt/slides/slide${idx + 1}.xml`,
      content: buildPptxSlideXml(slideLines),
    });
  });

  checkArchiveOutputBounds(files);
  return buildZipArchive(files);
}

function archiveFilesFromEntries(entries: Map<string, Buffer>): Array<{ name: string; content: Buffer }> {
  const files: Array<{ name: string; content: Buffer }> = [];
  for (const [name, content] of entries) {
    files.push({ name, content });
  }
  return files;
}

function appendDocxBytes(existingBytes: Buffer, appendContent: string): Buffer {
  const entries = extractZipEntries(existingBytes);
  const docBuf = entries.get('word/document.xml');
  if (!docBuf) {
    throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Missing word/document.xml in DOCX');
  }
  const xml = docBuf.toString('utf8');
  const lines = appendContent.replace(/\r\n/g, '\n').split('\n');
  const existingParagraphs = xml.match(/<w:p\b/g)?.length ?? 0;
  if (existingParagraphs + lines.length > CLOUD_DOC_OOXML_MAX_PARAGRAPHS) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Document paragraph count exceeds maximum (${CLOUD_DOC_OOXML_MAX_PARAGRAPHS})`,
      413,
    );
  }
  const newParagraphsXml = buildDocxParagraphsXml(lines);

  let updatedXml: string;
  const selfClosingBody = /<w:body\s*\/>/.exec(xml);
  if (selfClosingBody) {
    updatedXml = xml.replace(/<w:body\s*\/>/, `<w:body>${newParagraphsXml}</w:body>`);
  } else {
    const bodyOpenMatch = /<w:body\b[^>]*>/.exec(xml);
    const bodyCloseIdx = xml.lastIndexOf('</w:body>');
    if (!bodyOpenMatch || bodyCloseIdx === -1 || bodyCloseIdx < bodyOpenMatch.index + bodyOpenMatch[0].length) {
      throw new CloudDocContentError(
        CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT,
        'DOCX structure lacks a supported </w:body> anchor for non-destructive append',
        400,
      );
    }
    const bodyStart = bodyOpenMatch.index + bodyOpenMatch[0].length;
    const bodySlice = xml.slice(bodyStart, bodyCloseIdx);
    const lastSectIdx = bodySlice.lastIndexOf('<w:sectPr');
    const tailAfterSect = lastSectIdx !== -1 ? bodySlice.slice(lastSectIdx) : '';
    const insertAt =
      lastSectIdx !== -1 && !/<\/w:(?:p|tbl)>/i.test(tailAfterSect) ? bodyStart + lastSectIdx : bodyCloseIdx;
    updatedXml = `${xml.slice(0, insertAt)}${newParagraphsXml}${xml.slice(insertAt)}`;
  }

  entries.set('word/document.xml', Buffer.from(updatedXml, 'utf8'));
  const files = archiveFilesFromEntries(entries);
  checkArchiveOutputBounds(files);
  return buildZipArchive(files);
}

function appendXlsxBytes(existingBytes: Buffer, appendContent: string): Buffer {
  const entries = extractZipEntries(existingBytes);
  const sheetSpecs = discoverXlsxSheets(entries);

  const normalizedInput = appendContent.replace(/\r\n/g, '\n');
  const hasExplicitSheetHeaders = /(?:^|\n)(?:##\s*)?Sheet:\s*.+/i.test(normalizedInput);
  const parsedSheets = parseXlsxInputSheets(appendContent);

  const appendPlan = new Map<string, string[][]>();
  if (!hasExplicitSheetHeaders) {
    appendPlan.set(sheetSpecs[0].path, parsedSheets[0]?.rows ?? []);
  } else {
    for (const ps of parsedSheets) {
      const target = sheetSpecs.find((spec) => spec.name === ps.name);
      if (!target) {
        throw new CloudDocContentError(
          CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT,
          `Target worksheet "${ps.name}" does not exist for non-destructive append`,
          400,
        );
      }
      const existingPlan = appendPlan.get(target.path) ?? [];
      appendPlan.set(target.path, [...existingPlan, ...ps.rows]);
    }
  }

  let totalWorkbookCells = 0;
  for (const spec of sheetSpecs) {
    const sheetXml = entries.get(spec.path)?.toString('utf8') ?? '';
    totalWorkbookCells += sheetXml.match(/<c\b/g)?.length ?? 0;
  }
  let addedCells = 0;
  for (const rows of appendPlan.values()) {
    for (const row of rows) {
      if (row.length > CLOUD_DOC_OOXML_MAX_ROW_COLS) {
        throw new CloudDocContentError(
          CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
          `Spreadsheet row width exceeds maximum (${CLOUD_DOC_OOXML_MAX_ROW_COLS} columns)`,
          413,
        );
      }
      addedCells += row.length;
    }
  }
  if (totalWorkbookCells + addedCells > CLOUD_DOC_OOXML_MAX_CELLS) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Spreadsheet cell count exceeds maximum (${CLOUD_DOC_OOXML_MAX_CELLS})`,
      413,
    );
  }

  for (const [path, rowsToAppend] of appendPlan) {
    if (rowsToAppend.length === 0) continue;
    const sheetXml = entries.get(path)!.toString('utf8');
    if (/<tableParts\b/i.test(sheetXml)) {
      throw new CloudDocContentError(
        CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT,
        'Non-destructive XLSX append refuses worksheets with structured <tableParts> ranges',
        400,
      );
    }

    let maxRow = 0;
    let sequentialRows = 0;
    const rowTagRe = /<row\b([^>]*)>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowTagRe.exec(sheetXml)) !== null) {
      sequentialRows += 1;
      const attrs = parseXmlAttributes(rm[1]);
      const explicitRow = attrs.r ? Number.parseInt(attrs.r, 10) : 0;
      maxRow = Math.max(maxRow, Number.isFinite(explicitRow) && explicitRow > 0 ? explicitRow : sequentialRows);
    }

    const newRowsXml = buildXlsxRowsXml(rowsToAppend, maxRow + 1);
    let updatedSheetXml: string;
    const selfClosingSheetData = /<sheetData\s*\/>/.exec(sheetXml);
    if (selfClosingSheetData) {
      updatedSheetXml = sheetXml.replace(/<sheetData\s*\/>/, `<sheetData>${newRowsXml}</sheetData>`);
    } else {
      const sheetDataCloseIdx = sheetXml.lastIndexOf('</sheetData>');
      if (sheetDataCloseIdx === -1) {
        throw new CloudDocContentError(
          CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT,
          'Worksheet lacks a supported </sheetData> anchor for non-destructive append',
          400,
        );
      }
      updatedSheetXml = `${sheetXml.slice(0, sheetDataCloseIdx)}${newRowsXml}${sheetXml.slice(sheetDataCloseIdx)}`;
    }
    entries.set(path, Buffer.from(updatedSheetXml, 'utf8'));
  }

  const files = archiveFilesFromEntries(entries);
  checkArchiveOutputBounds(files);
  return buildZipArchive(files);
}

function appendPptxBytes(existingBytes: Buffer, appendContent: string): Buffer {
  const entries = extractZipEntries(existingBytes);
  const existingSlidePaths = [...entries.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k));
  if (existingSlidePaths.length === 0) {
    throw new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Missing slide XML in PPTX');
  }

  const presBuf = entries.get('ppt/presentation.xml');
  const relsBuf = entries.get('ppt/_rels/presentation.xml.rels');
  const contentTypesBuf = entries.get('[Content_Types].xml');
  if (!presBuf || !relsBuf || !contentTypesBuf) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT,
      'PPTX archive lacks required presentation metadata parts for non-destructive append',
      400,
    );
  }

  const presXml = presBuf.toString('utf8');
  if (/<p:sectionLst\b/i.test(presXml)) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT,
      'Non-destructive PPTX append refuses decks with <p:sectionLst> slide sections',
      400,
    );
  }

  const relsXml = relsBuf.toString('utf8');
  const contentTypesXml = contentTypesBuf.toString('utf8');
  const hasSelfClosingSldIdLst = /<p:sldIdLst\s*\/>/.test(presXml);
  const sldIdLstCloseIdx = presXml.lastIndexOf('</p:sldIdLst>');
  const relsCloseIdx = relsXml.lastIndexOf('</Relationships>');
  const typesCloseIdx = contentTypesXml.lastIndexOf('</Types>');
  if ((!hasSelfClosingSldIdLst && sldIdLstCloseIdx === -1) || relsCloseIdx === -1 || typesCloseIdx === -1) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT,
      'PPTX structure lacks required XML anchors for non-destructive append',
      400,
    );
  }

  let existingParagraphs = 0;
  for (const slidePath of existingSlidePaths) {
    const slideXml = entries.get(slidePath)?.toString('utf8') ?? '';
    existingParagraphs += slideXml.match(/<a:p\b/g)?.length ?? 0;
  }
  const slidesToAdd = parsePptxInputSlides(appendContent);
  const addedParagraphs = slidesToAdd.reduce((sum, slide) => sum + Math.max(1, slide.length), 0);
  if (existingParagraphs + addedParagraphs > CLOUD_DOC_OOXML_MAX_PARAGRAPHS) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Presentation paragraph count exceeds maximum (${CLOUD_DOC_OOXML_MAX_PARAGRAPHS})`,
      413,
    );
  }

  let maxSlideNum = 0;
  for (const slidePath of existingSlidePaths) {
    const num = Number.parseInt(/slide(\d+)\.xml$/i.exec(slidePath)?.[1] ?? '0', 10);
    if (Number.isFinite(num)) maxSlideNum = Math.max(maxSlideNum, num);
  }

  let maxSldId = 255;
  const sldIdNumRe = /<p:sldId\b([^>]*?)\/?>/g;
  let sm: RegExpExecArray | null;
  while ((sm = sldIdNumRe.exec(presXml)) !== null) {
    const idVal = Number.parseInt(parseXmlAttributes(sm[1]).id ?? '0', 10);
    if (Number.isFinite(idVal)) maxSldId = Math.max(maxSldId, idVal);
  }

  let maxRId = 0;
  const relIdRe = /\bId\s*=\s*(?:"rId(\d+)"|'rId(\d+)')/g;
  let rm: RegExpExecArray | null;
  while ((rm = relIdRe.exec(relsXml)) !== null) {
    const rVal = Number.parseInt(rm[1] ?? rm[2] ?? '0', 10);
    if (Number.isFinite(rVal)) maxRId = Math.max(maxRId, rVal);
  }

  // Inherit slideLayout relationship if present on existing slides.
  let templateSlideLayoutRels: string | null = null;
  const sortedSlides = [...existingSlidePaths].sort();
  for (const slidePath of sortedSlides) {
    const baseName = slidePath.slice('ppt/slides/'.length);
    const slideRelsBuf = entries.get(`ppt/slides/_rels/${baseName}.rels`);
    if (!slideRelsBuf) continue;
    const layoutMatch = /<Relationship\b[^>]*slideLayout[^>]*\/?>/i.exec(slideRelsBuf.toString('utf8'));
    if (layoutMatch) {
      templateSlideLayoutRels =
        `${XML_DECLARATION}` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${layoutMatch[0]}</Relationships>`;
      break;
    }
  }

  let newSldIdsXml = '';
  let newRelsXml = '';
  let newOverridesXml = '';
  for (const slideLines of slidesToAdd) {
    maxSlideNum += 1;
    maxSldId += 1;
    maxRId += 1;
    const rId = `rId${maxRId}`;
    const slideEntry = `ppt/slides/slide${maxSlideNum}.xml`;
    entries.set(slideEntry, Buffer.from(buildPptxSlideXml(slideLines), 'utf8'));
    if (templateSlideLayoutRels) {
      entries.set(`ppt/slides/_rels/slide${maxSlideNum}.xml.rels`, Buffer.from(templateSlideLayoutRels, 'utf8'));
    }
    newSldIdsXml += `<p:sldId id="${maxSldId}" r:id="${rId}"/>`;
    newRelsXml += `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${maxSlideNum}.xml"/>`;
    newOverridesXml += `<Override PartName="/${slideEntry}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  }

  const updatedPresXml = hasSelfClosingSldIdLst
    ? presXml.replace(/<p:sldIdLst\s*\/>/, `<p:sldIdLst>${newSldIdsXml}</p:sldIdLst>`)
    : `${presXml.slice(0, sldIdLstCloseIdx)}${newSldIdsXml}${presXml.slice(sldIdLstCloseIdx)}`;
  const updatedRelsXml = `${relsXml.slice(0, relsCloseIdx)}${newRelsXml}${relsXml.slice(relsCloseIdx)}`;
  const updatedTypesXml = `${contentTypesXml.slice(0, typesCloseIdx)}${newOverridesXml}${contentTypesXml.slice(typesCloseIdx)}`;

  entries.set('ppt/presentation.xml', Buffer.from(updatedPresXml, 'utf8'));
  entries.set('ppt/_rels/presentation.xml.rels', Buffer.from(updatedRelsXml, 'utf8'));
  entries.set('[Content_Types].xml', Buffer.from(updatedTypesXml, 'utf8'));

  const files = archiveFilesFromEntries(entries);
  checkArchiveOutputBounds(files);
  return buildZipArchive(files);
}

export function extractCloudDocContent(
  ext: string,
  bytes: Buffer,
  maxChars: number = CLOUD_DOC_CONTENT_MAX_CHARS,
): Omit<CloudDocContentPayload, 'doc' | 'role' | 'allowDownload'> {
  const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  const boundedMax = Math.max(1, Math.min(maxChars, CLOUD_DOC_CONTENT_MAX_CHARS));

  let format: CloudDocContentPayload['format'];
  let content: string;
  let truncated: boolean;
  let totalChars: number;
  let sheets: Array<{ name: string; rows: string[][] }> | undefined;
  let slides: Array<{ index: number; title?: string; texts: string[] }> | undefined;

  if (normalizedExt === '.docx') {
    format = 'docx';
    const extracted = extractDocxText(extractZipEntries(bytes), boundedMax);
    content = extracted.content;
    truncated = extracted.truncated;
    totalChars = extracted.totalChars;
  } else if (normalizedExt === '.xlsx') {
    format = 'xlsx';
    const extracted = extractXlsxContent(extractZipEntries(bytes), boundedMax);
    content = extracted.content;
    truncated = extracted.truncated;
    totalChars = extracted.totalChars;
    sheets = extracted.sheets;
  } else if (normalizedExt === '.pptx') {
    format = 'pptx';
    const extracted = extractPptxContent(extractZipEntries(bytes), boundedMax);
    content = extracted.content;
    truncated = extracted.truncated;
    totalChars = extracted.totalChars;
    slides = extracted.slides;
  } else if (isPlainTextExt(normalizedExt)) {
    format = 'text';
    const fullContent = bytes.toString('utf8');
    totalChars = fullContent.length;
    truncated = totalChars > boundedMax;
    content = truncated ? fullContent.slice(0, boundedMax) : fullContent;
  } else {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.UNSUPPORTED_FORMAT,
      `Text content extraction is not supported for ${normalizedExt} files`,
    );
  }

  return {
    ext: normalizedExt,
    format,
    editable: isEditableCloudDocExt(normalizedExt),
    content,
    truncated,
    totalChars,
    byteLength: bytes.length,
    maxChars: boundedMax,
    ...(sheets ? { sheets } : {}),
    ...(slides ? { slides } : {}),
  };
}

export function buildCloudDocBytesFromContent(ext: string, content?: string): Buffer {
  const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  if (content === undefined) {
    if (normalizedExt === '.txt') return Buffer.alloc(0);
    return buildBlankDocumentBytes(normalizedExt);
  }
  if (content.length > CLOUD_DOC_CONTENT_MAX_CHARS) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Document content exceeds maximum length of ${CLOUD_DOC_CONTENT_MAX_CHARS} characters`,
      413,
    );
  }

  if (normalizedExt === '.docx') return buildDocxBytes(content);
  if (normalizedExt === '.xlsx') return buildXlsxBytes(content);
  if (normalizedExt === '.pptx') return buildPptxBytes(content);
  if (isPlainTextExt(normalizedExt)) return Buffer.from(content, 'utf8');

  throw new CloudDocContentError(
    CLOUD_DOC_ERROR_CODES.UNSUPPORTED_FORMAT,
    `Document content generation is not supported for ${normalizedExt} files`,
  );
}

export function applyCloudDocContentEdit(params: {
  ext: string;
  existingBytes: Buffer;
  mode: CloudDocEditMode;
  content: string;
}): Buffer {
  const normalizedExt = params.ext.startsWith('.') ? params.ext.toLowerCase() : `.${params.ext.toLowerCase()}`;
  if (!isEditableCloudDocExt(normalizedExt)) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT,
      `Editing text content is not supported for ${normalizedExt} files`,
    );
  }
  if (params.content.length > CLOUD_DOC_CONTENT_MAX_CHARS) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Document content exceeds maximum length of ${CLOUD_DOC_CONTENT_MAX_CHARS} characters`,
      413,
    );
  }

  if (params.mode === 'replace') {
    return buildCloudDocBytesFromContent(normalizedExt, params.content);
  }

  if (normalizedExt === '.docx') {
    return appendDocxBytes(params.existingBytes, params.content);
  }
  if (normalizedExt === '.xlsx') {
    return appendXlsxBytes(params.existingBytes, params.content);
  }
  if (normalizedExt === '.pptx') {
    return appendPptxBytes(params.existingBytes, params.content);
  }

  // Plain-text append: keep existing bytes intact and enforce total char limit.
  const existingText = params.existingBytes.toString('utf8');
  if (existingText.length > CLOUD_DOC_CONTENT_MAX_CHARS) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      'Existing document exceeds readable edit limit',
      413,
    );
  }
  const nextText = existingText ? `${existingText}\n${params.content}` : params.content;
  if (nextText.length > CLOUD_DOC_CONTENT_MAX_CHARS) {
    throw new CloudDocContentError(
      CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE,
      `Document content exceeds maximum length of ${CLOUD_DOC_CONTENT_MAX_CHARS} characters`,
      413,
    );
  }
  return Buffer.from(nextText, 'utf8');
}
