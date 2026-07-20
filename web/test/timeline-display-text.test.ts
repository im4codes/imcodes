import { describe, expect, it } from 'vitest';
import { parseTimelineDisplayText } from '../src/timeline-display-text.js';

describe('parseTimelineDisplayText', () => {
  it('renders escaped LF and CRLF markers as line breaks', () => {
    expect(parseTimelineDisplayText(String.raw`one\ntwo\r\nthree`))
      .toBe('one\ntwo\nthree');
  });

  it('leaves existing line breaks and unrelated escapes unchanged', () => {
    expect(parseTimelineDisplayText('one\ntwo\\tthree C:\\temp'))
      .toBe('one\ntwo\\tthree C:\\temp');
  });

  it('does not parse doubled backslashes', () => {
    expect(parseTimelineDisplayText(String.raw`show \\n literally`))
      .toBe(String.raw`show \\n literally`);
  });

  it('preserves escaped newline markers inside inline and fenced code', () => {
    const text = 'outside\\n`inline\\ncode`\\n```ts\nconst value = "a\\nb";\n```';
    expect(parseTimelineDisplayText(text))
      .toBe('outside\n`inline\\ncode`\n```ts\nconst value = "a\\nb";\n```');
  });
});
