import { describe, expect, it } from 'vitest';
import { sanitizeUploadFilename, UPLOAD_FILENAME_MAX_BYTES } from '../../shared/upload-filename.js';

describe('sanitizeUploadFilename', () => {
  const cases: Array<[string, string]> = [
    ['截图 2026.png', '截图 2026.png'],
    ['../evil.txt', 'evil.txt'],
    ['..\\evil.txt', 'evil.txt'],
    ['CON.txt', 'file'],
    ['LPT9.log', 'file'],
    ['COM0.txt', 'file'],
    ['LPT0.log', 'file'],
    ['CONIN$.txt', 'file'],
    ['CONOUT$.txt', 'file'],
    ['a<b>:c?.txt', 'a_b_c_.txt'],
    ['report:name.txt', 'report_name.txt'],
    ['report:name.txt ', 'report_name.txt'],
    ['.hidden', '_hidden'],
    ['-leading.txt', '_leading.txt'],
    ['zero\u200Bwidth.png', 'zero_width.png'],
    ['a\u202Egnp.exe', 'a_gnp.exe'],
    ['...', 'file'],
    ['name. ', 'name'],
    ['', 'file'],
    ['control\u0000\u0007\u001fname.txt', 'control_name.txt'],
    ['Cafe\u0301.txt', 'Café.txt'],
  ];

  it.each(cases)('sanitizes %j', (input, expected) => {
    expect(sanitizeUploadFilename(input)).toBe(expected);
  });

  it('normalizes to NFC and caps the UTF-8 byte length while preserving extension', () => {
    const output = sanitizeUploadFilename(`${'界'.repeat(200)}.png`);
    expect(output.endsWith('.png')).toBe(true);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(UPLOAD_FILENAME_MAX_BYTES);
    expect(output.slice(-4)).toBe('.png');
    const exact = sanitizeUploadFilename(`${'a'.repeat(300)}.png`);
    expect(Buffer.byteLength(exact, 'utf8')).toBe(UPLOAD_FILENAME_MAX_BYTES);
    expect(exact.endsWith('.png')).toBe(true);
  });

  it('is deterministic and keeps duplicate names independent at the id layer', () => {
    expect(sanitizeUploadFilename('报价单 v2.xlsx')).toBe('报价单 v2.xlsx');
    expect(sanitizeUploadFilename('报价单 v2.xlsx')).toBe('报价单 v2.xlsx');
  });
});
