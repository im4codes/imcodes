import { describe, it, expect } from 'vitest';
import { stripAnsi, classifyLine, RawStreamParser, processRawPtyData } from '../../src/daemon/terminal-parser.js';

describe('stripAnsi', () => {
  it('removes CSI escape sequences', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
    expect(stripAnsi('\x1b[1;33mwarning\x1b[0m')).toBe('warning');
    expect(stripAnsi('\x1b[2J')).toBe('');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi('\x1b]0;window title\x07text')).toBe('text');
    expect(stripAnsi('\x1b]2;some title\x07')).toBe('');
  });

  it('removes other ESC sequences', () => {
    expect(stripAnsi('\x1b>')).toBe('');
    expect(stripAnsi('\x1b=X')).toBe('');
    expect(stripAnsi('\x1b>after')).toBe('fter');
  });

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('')).toBe('');
  });

  it('handles mixed ANSI and plain text', () => {
    const input = '\x1b[31mError:\x1b[0m something went wrong';
    expect(stripAnsi(input)).toBe('Error: something went wrong');
  });
});

describe('classifyLine', () => {
  it('returns HIDE for empty string', () => {
    expect(classifyLine('')).toBe('HIDE');
  });

  it('returns HIDE for whitespace-only string', () => {
    expect(classifyLine('   ')).toBe('HIDE');
    expect(classifyLine('\t\t')).toBe('HIDE');
  });

  it('returns HIDE for "How is Claude doing this session?"', () => {
    expect(classifyLine('How is Claude doing this session?')).toBe('HIDE');
    expect(classifyLine('  How is Claude doing this session?  ')).toBe('HIDE');
  });

  it('returns HIDE for "How is Claude doing this session" (no question mark)', () => {
    expect(classifyLine('How is Claude doing this session')).toBe('HIDE');
  });

  it('returns HIDE for pure braille chars', () => {
    expect(classifyLine('\u2812\u2816\u2800\u2812')).toBe('HIDE');
    expect(classifyLine('\u28FF\u2800')).toBe('HIDE');
  });

  it('returns HIDE for braille spinner with whitespace', () => {
    expect(classifyLine('  \u2812\u2816  ')).toBe('HIDE');
  });

  it('returns MUTED for >80% box-drawing characters', () => {
    const boxLine = '\u2500\u2501\u2502\u2503\u2504\u2505\u2506\u2507\u2508\u2509';
    expect(classifyLine(boxLine)).toBe('MUTED');
  });

  it('returns MUTED for a typical table border line', () => {
    const border = '\u2500'.repeat(20);
    expect(classifyLine(border)).toBe('MUTED');
  });

  it('returns KEEP for normal ASCII text', () => {
    expect(classifyLine('hello world')).toBe('KEEP');
    expect(classifyLine('Error: failed to connect')).toBe('KEEP');
    expect(classifyLine('const x = 42;')).toBe('KEEP');
  });

  it('returns KEEP for CJK text', () => {
    expect(classifyLine('你好世界')).toBe('KEEP');
    expect(classifyLine('日本語テスト')).toBe('KEEP');
  });

  it('returns KEEP for emoji text', () => {
    expect(classifyLine('✅ Build passed')).toBe('KEEP');
    expect(classifyLine('🚀 Deploying...')).toBe('KEEP');
  });

  it('returns KEEP for mixed box-drawing below 80% threshold', () => {
    const mixed = 'hello\u2500world';
    expect(classifyLine(mixed)).toBe('KEEP');
  });
});

// ── Task 8.4: RawStreamParser tests ─────────────────────────────────────────

describe('RawStreamParser', () => {
  it('emits line on CRLF', () => {
    const p = new RawStreamParser();
    const lines = p.feed(Buffer.from('hello\r\nworld\r\n'));
    expect(lines).toEqual(['hello', 'world']);
  });

  it('emits line on pure LF (Task 8.4 — pure LF scenario)', () => {
    const p = new RawStreamParser();
    const lines = p.feed(Buffer.from('hello\nworld\n'));
    expect(lines).toEqual(['hello', 'world']);
  });

  it('discards line on pure CR (overwrite)', () => {
    const p = new RawStreamParser();
    // "old\r" followed by "new\n" — CR discards "old", then "new" is completed by LF
    const lines = p.feed(Buffer.from('old\rnew\n'));
    expect(lines).toEqual(['new']);
    expect(lines).not.toContain('old');
  });

  it('handles CRLF vs CR correctly', () => {
    const p = new RawStreamParser();
    // \r\n = CRLF (emit line), \r<x> = pure CR (overwrite)
    const lines = p.feed(Buffer.from('keep\r\noverwrite\rreplacement\n'));
    expect(lines).toContain('keep');
    expect(lines).toContain('replacement');
    expect(lines).not.toContain('overwrite');
  });

  it('buffers incomplete ANSI sequence across chunks (Task 8.4)', () => {
    const p = new RawStreamParser();
    // Split \x1b[32m across two chunks
    p.feed(Buffer.from('before\x1b'));
    const lines = p.feed(Buffer.from('[32mafter\n'));
    // ANSI should be stripped from the line content
    expect(lines).toEqual(['beforeafter']);
  });

  it('buffers UTF-8 multibyte split across chunks (Task 8.4)', () => {
    const p = new RawStreamParser();
    // '中' = 0xE4 0xB8 0xAD
    const charBytes = Buffer.from('中', 'utf8'); // 3 bytes
    // Split: first chunk has first 2 bytes, second chunk has last byte + newline
    const chunk1 = Buffer.concat([Buffer.from('before'), charBytes.subarray(0, 2)]);
    const chunk2 = Buffer.concat([charBytes.subarray(2), Buffer.from('\n')]);
    p.feed(chunk1);
    const lines = p.feed(chunk2);
    expect(lines).toEqual(['before中']);
  });

  it('accumulates text without newline in pending()', () => {
    const p = new RawStreamParser();
    p.feed(Buffer.from('no newline yet'));
    expect(p.pending()).toBe('no newline yet');
    const lines = p.feed(Buffer.from('\n'));
    expect(lines).toEqual(['no newline yet']);
  });

  it('reset() clears all state', () => {
    const p = new RawStreamParser();
    p.feed(Buffer.from('partial'));
    p.reset();
    expect(p.pending()).toBe('');
    const lines = p.feed(Buffer.from('fresh\n'));
    expect(lines).toEqual(['fresh']);
  });
});

describe('processRawPtyData', () => {
  it('is callable without error', () => {
    expect(() => {
      processRawPtyData('test_session_raw', Buffer.from('hello\nworld\n'));
    }).not.toThrow();
  });
});
