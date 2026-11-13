import { describe, expect, it } from 'vitest';
import {
  applyCloudDocContentEdit,
  buildCloudDocBytesFromContent,
  CloudDocContentError,
  extractCloudDocContent,
  extractZipEntries,
} from '../src/services/cloud-doc-content.js';
import { buildZipArchive } from '../src/routes/onlyoffice.js';
import {
  CLOUD_DOC_CONTENT_MAX_CHARS,
  CLOUD_DOC_ERROR_CODES,
  CLOUD_DOC_OOXML_MAX_PARAGRAPHS,
  CLOUD_DOC_OOXML_MAX_ROW_COLS,
} from '../../shared/cloud-docs.js';

describe('cloud-doc-content OOXML & text service', () => {
  it('round-trips DOCX paragraphs with XML entities and control-char sanitization', () => {
    const input = 'Title & Summary <v1>\nSecond "quoted" \'line\' > baseline';
    const bytes = buildCloudDocBytesFromContent('.docx', input);
    expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');

    const extracted = extractCloudDocContent('.docx', bytes);
    expect(extracted.format).toBe('docx');
    expect(extracted.editable).toBe(true);
    expect(extracted.truncated).toBe(false);
    expect(extracted.content).toBe(input);
  });

  it('extracts DOCX tables, tabs, and line breaks', () => {
    const bytes = buildZipArchive([
      {
        name: 'word/document.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          '<w:p><w:r><w:t>Intro</w:t><w:tab/><w:t>LineA</w:t><w:br/><w:t>LineB</w:t></w:r></w:p>' +
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Col1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Col2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
          '<w:sectPr/></w:body></w:document>',
      },
    ]);
    const extracted = extractCloudDocContent('.docx', bytes);
    expect(extracted.content).toBe('Intro\tLineA\nLineB\nCol1\tCol2');
  });

  it('round-trips XLSX single-sheet TSV/CSV preserving numeric vs leading-zero strings and multi-sheet workbooks', () => {
    const single = 'Item\tQty\tCode\nWidget\t42\t007';
    const singleBytes = buildCloudDocBytesFromContent('.xlsx', single);
    const singleRead = extractCloudDocContent('.xlsx', singleBytes);
    expect(singleRead.format).toBe('xlsx');
    expect(singleRead.sheets).toEqual([
      { name: 'Sheet1', rows: [['Item', 'Qty', 'Code'], ['Widget', '42', '007']] },
    ]);
    expect(singleRead.content).toBe(single);

    const multi = '## Sheet: Summary\nMetric\tValue\nTotal\t99\n\n## Sheet: Details\n"A,1",10';
    const multiBytes = buildCloudDocBytesFromContent('.xlsx', multi);
    const multiRead = extractCloudDocContent('.xlsx', multiBytes);
    expect(multiRead.sheets).toEqual([
      { name: 'Summary', rows: [['Metric', 'Value'], ['Total', '99']] },
      { name: 'Details', rows: [['A,1', '10']] },
    ]);
  });

  it('extracts XLSX sharedStrings and sparse cell columns', () => {
    const bytes = buildZipArchive([
      {
        name: 'xl/workbook.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Revenue" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      {
        name: 'xl/sharedStrings.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Quarter &amp; Year</t></si><si><t>Q1</t></si></sst>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row></sheetData></worksheet>',
      },
    ]);
    const extracted = extractCloudDocContent('.xlsx', bytes);
    expect(extracted.sheets).toEqual([
      { name: 'Revenue', rows: [['Quarter & Year', '', 'Q1']] },
    ]);
  });

  it('round-trips PPTX multi-slide decks and supports append mode', () => {
    const initial = '--- Slide 1 ---\nRoadmap 2026\nKey Goal & Focus\n\n--- Slide 2 ---\nMilestones\nLaunch';
    const bytes = buildCloudDocBytesFromContent('.pptx', initial);
    const read1 = extractCloudDocContent('.pptx', bytes);
    expect(read1.format).toBe('pptx');
    expect(read1.slides).toEqual([
      { index: 1, title: 'Roadmap 2026', texts: ['Roadmap 2026', 'Key Goal & Focus'] },
      { index: 2, title: 'Milestones', texts: ['Milestones', 'Launch'] },
    ]);

    const updatedBytes = applyCloudDocContentEdit({
      ext: '.pptx',
      existingBytes: bytes,
      mode: 'append',
      content: '--- Slide 3 ---\nQ&A',
    });
    const read2 = extractCloudDocContent('.pptx', updatedBytes);
    expect(read2.slides).toHaveLength(3);
    expect(read2.slides?.[2]).toEqual({ index: 3, title: 'Q&A', texts: ['Q&A'] });
  });

  it('supports plain text extensions, bounded maxChars truncation, and rejects oversized or unsupported formats', () => {
    const mdBytes = buildCloudDocBytesFromContent('.md', '# Heading\nBody line');
    const edited = applyCloudDocContentEdit({
      ext: '.md',
      existingBytes: mdBytes,
      mode: 'append',
      content: 'Appended line',
    });
    const truncated = extractCloudDocContent('.md', edited, 10);
    expect(truncated.format).toBe('text');
    expect(truncated.content).toBe('# Heading\n');
    expect(truncated.truncated).toBe(true);
    expect(truncated.totalChars).toBe('# Heading\nBody line\nAppended line'.length);

    expect(() => extractCloudDocContent('.pdf', Buffer.from('%PDF-1.4'))).toThrowError(CloudDocContentError);
    expect(() => buildCloudDocBytesFromContent('.txt', 'a'.repeat(CLOUD_DOC_CONTENT_MAX_CHARS + 1))).toThrowError(
      CloudDocContentError,
    );
  });

  it('rejects malformed archives, CRC mismatches, encrypted entries, entry-count caps, and zip bombs', () => {
    // 1. Corrupt non-ZIP bytes (both too-small and >= 22B without EOCD)
    expect(() => extractCloudDocContent('.docx', Buffer.from('not-a-zip'))).toThrowError(
      new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Archive is too small or corrupt'),
    );
    expect(() => extractCloudDocContent('.docx', Buffer.alloc(64, 0x41))).toThrowError(
      new CloudDocContentError(CLOUD_DOC_ERROR_CODES.INVALID_ARCHIVE, 'Missing ZIP central directory footer'),
    );

    // 2. Missing required OOXML part
    const emptyZip = buildZipArchive([{ name: 'other.xml', content: '<x/>' }]);
    expect(() => extractCloudDocContent('.docx', emptyZip)).toThrowError(/Missing word\/document\.xml/);
    expect(() => extractCloudDocContent('.xlsx', emptyZip)).toThrowError(/Missing worksheet XML/);
    expect(() => extractCloudDocContent('.pptx', emptyZip)).toThrowError(/Missing slide XML/);

    // 3. Corrupted CRC32 inside central directory
    const validDocx = buildCloudDocBytesFromContent('.docx', 'Hello');
    const corruptCrc = Buffer.from(validDocx);
    const cdIdx = corruptCrc.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corruptCrc.writeUInt32LE(0xdeadbeef, cdIdx + 16);
    expect(() => extractZipEntries(corruptCrc)).toThrowError(/CRC mismatch/);

    // 4. Encrypted entry flag rejection
    const encryptedZip = Buffer.from(validDocx);
    encryptedZip.writeUInt16LE(0x0001, cdIdx + 8);
    expect(() => extractZipEntries(encryptedZip)).toThrowError(/Encrypted ZIP entries/);

    // 5. Max entries cap
    expect(() => extractZipEntries(validDocx, { maxEntries: 2 })).toThrowError(/exceeds max entry limit/);

    // 6. Zip bomb: highly compressible zero buffer exceeding entry/total budget
    const hugeZeros = Buffer.alloc(64 * 1024, 0);
    const zipBomb = buildZipArchive([{ name: 'word/document.xml', content: hugeZeros }]);
    expect(zipBomb.length).toBeLessThan(4096);
    expect(() => extractZipEntries(zipBomb, { maxEntryBytes: 16 * 1024, maxTotalBytes: 16 * 1024 })).toThrowError(
      /exceeds size (limit|budget)/,
    );
  });

  it('rejects absurd XLSX sparse column references and bounds sheets/slides under maxChars truncation and builder caps', () => {
    for (const badRef of ['ZZZZZZZZ1', 'XFD1']) {
      const badXlsx = buildZipArchive([
        {
          name: 'xl/worksheets/sheet1.xml',
          content:
            '<?xml version="1.0" encoding="UTF-8"?>' +
            `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="${badRef}" t="n"><v>1</v></c></row></sheetData></worksheet>`,
        },
      ]);
      expect(() => extractCloudDocContent('.xlsx', badXlsx)).toThrowError(
        expect.objectContaining({ code: CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE, statusCode: 413 }),
      );
    }

    const hugeCellXlsx = buildCloudDocBytesFromContent(
      '.xlsx',
      `## Sheet: First\n${'X'.repeat(1000)}\tExtra\n\n## Sheet: Second\nSkipped`,
    );
    const truncXlsx = extractCloudDocContent('.xlsx', hugeCellXlsx, 16);
    expect(truncXlsx.truncated).toBe(true);
    expect(truncXlsx.content.length).toBeLessThanOrEqual(16);
    expect(truncXlsx.sheets).toHaveLength(1);
    expect(truncXlsx.sheets?.[0].rows[0][0].length).toBeLessThanOrEqual(16);

    const hugeSlidePptx = buildCloudDocBytesFromContent(
      '.pptx',
      `--- Slide 1 ---\n${'Y'.repeat(1000)}\nSecond line\n\n--- Slide 2 ---\nLater`,
    );
    const truncPptx = extractCloudDocContent('.pptx', hugeSlidePptx, 16);
    expect(truncPptx.truncated).toBe(true);
    expect(truncPptx.content.length).toBeLessThanOrEqual(16);
    expect(truncPptx.slides).toHaveLength(1);
    expect(truncPptx.slides?.[0].texts[0].length).toBeLessThanOrEqual(16);

    const tooWideRow = Array.from({ length: CLOUD_DOC_OOXML_MAX_ROW_COLS + 1 }, (_v, i) => String(i)).join('\t');
    expect(() => buildCloudDocBytesFromContent('.xlsx', tooWideRow)).toThrowError(
      expect.objectContaining({ code: CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE, statusCode: 413 }),
    );
    const tooManyParas = Array.from({ length: CLOUD_DOC_OOXML_MAX_PARAGRAPHS + 1 }, () => 'p').join('\n');
    expect(() => buildCloudDocBytesFromContent('.docx', tooManyParas)).toThrowError(
      expect.objectContaining({ code: CLOUD_DOC_ERROR_CODES.CONTENT_TOO_LARGE, statusCode: 413 }),
    );
  });

  it('performs non-destructive surgical append on DOCX, XLSX, and PPTX and fails closed on unsupported structures', () => {
    // 1. XLSX preserves formulas, style attributes, and calcChain while appending new rows cleanly
    const richXlsx = buildZipArchive([
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      },
      {
        name: '_rels/.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'xl/workbook.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      { name: 'xl/calcChain.xml', content: '<?xml version="1.0" encoding="UTF-8"?><calcChain><c r="B1"/></calcChain>' },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
          '<row r="1"><c r="A1" s="1" t="n"><v>10</v></c><c r="B1"><f>A1*2</f><v>20</v></c></row>' +
          '</sheetData></worksheet>',
      },
    ]);
    const appendedXlsx = applyCloudDocContentEdit({ ext: '.xlsx', existingBytes: richXlsx, mode: 'append', content: '30\t40' });
    const xlsxEntries = extractZipEntries(appendedXlsx);
    expect(xlsxEntries.get('xl/calcChain.xml')?.toString('utf8')).toContain('<calcChain><c r="B1"/></calcChain>');
    const updatedSheetXml = xlsxEntries.get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
    expect(updatedSheetXml).toContain('<c r="A1" s="1" t="n"><v>10</v></c>');
    expect(updatedSheetXml).toContain('<f>A1*2</f>');
    expect(extractCloudDocContent('.xlsx', appendedXlsx).sheets?.[0].rows).toEqual([['10', '20'], ['30', '40']]);

    // Refuse XLSX structured <tableParts> safely
    const tableXlsx = buildZipArchive([
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>',
      },
    ]);
    expect(() =>
      applyCloudDocContentEdit({ ext: '.xlsx', existingBytes: tableXlsx, mode: 'append', content: '2' }),
    ).toThrowError(expect.objectContaining({ code: CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT, statusCode: 400 }));

    // 2. DOCX preserves tables and embedded media when appending
    const richDocx = buildZipArchive([
      {
        name: 'word/document.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>CellA</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
          '<w:sectPr/></w:body></w:document>',
      },
      { name: 'word/media/logo.png', content: Buffer.from([137, 80, 78, 71]) },
    ]);
    const appendedDocx = applyCloudDocContentEdit({ ext: '.docx', existingBytes: richDocx, mode: 'append', content: 'After table' });
    const docxEntries = extractZipEntries(appendedDocx);
    expect(docxEntries.get('word/media/logo.png')).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(docxEntries.get('word/document.xml')?.toString('utf8')).toContain('<w:tbl>');
    expect(extractCloudDocContent('.docx', appendedDocx).content).toBe('CellA\nAfter table');

    // 3. PPTX preserves embedded media & notesSlides and refuses <p:sectionLst> safely
    const richPptx = buildZipArchive([
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
          '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
          '</Types>',
      },
      {
        name: 'ppt/presentation.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
      },
      {
        name: 'ppt/_rels/presentation.xml.rels',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
      },
      {
        name: 'ppt/slides/slide1.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>KeepMedia</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
      },
      { name: 'ppt/media/img.png', content: Buffer.from([1, 2, 3, 4]) },
      { name: 'ppt/notesSlides/notesSlide1.xml', content: '<notes>Presenter note</notes>' },
    ]);
    const appendedPptx = applyCloudDocContentEdit({ ext: '.pptx', existingBytes: richPptx, mode: 'append', content: 'Slide Two' });
    const pptxEntries = extractZipEntries(appendedPptx);
    expect(pptxEntries.get('ppt/media/img.png')).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(pptxEntries.get('ppt/notesSlides/notesSlide1.xml')?.toString('utf8')).toBe('<notes>Presenter note</notes>');
    expect(extractCloudDocContent('.pptx', appendedPptx).slides).toHaveLength(2);

    const sectionedPptx = buildZipArchive([
      {
        name: '[Content_Types].xml',
        content: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
      },
      {
        name: 'ppt/presentation.xml',
        content: '<?xml version="1.0" encoding="UTF-8"?><p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sectionLst/></p:presentation>',
      },
      {
        name: 'ppt/_rels/presentation.xml.rels',
        content: '<?xml version="1.0" encoding="UTF-8"?><Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
      },
      { name: 'ppt/slides/slide1.xml', content: '<p:sld/>' },
    ]);
    expect(() =>
      applyCloudDocContentEdit({ ext: '.pptx', existingBytes: sectionedPptx, mode: 'append', content: 'Next' }),
    ).toThrowError(expect.objectContaining({ code: CLOUD_DOC_ERROR_CODES.UNSUPPORTED_CONTENT_EDIT, statusCode: 400 }));
  });
});
