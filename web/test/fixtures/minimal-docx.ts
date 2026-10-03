import JSZip from 'jszip';

/**
 * tsk_5rf: a real, minimal, valid .docx used to prove Word previews actually
 * render. Shared by the OfficePreview unit smoke and the FileBrowser
 * production-branch smoke so both drive identical, genuine bytes.
 */
export const MINIMAL_DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const MINIMAL_DOCX_TEXT = 'imcodes regression smoke paragraph';

export async function buildMinimalDocx(text: string = MINIMAL_DOCX_TEXT): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word')!.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`);
  return zip.generateAsync({ type: 'arraybuffer' });
}
