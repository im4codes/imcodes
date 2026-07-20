/**
 * Interpret escaped newline markers for timeline display only.
 *
 * The persisted event payload remains untouched. Backtick-delimited inline or
 * fenced code is also left verbatim, and a doubled backslash escapes parsing.
 */
export function parseTimelineDisplayText(value: string): string {
  let rendered = '';
  let codeDelimiterLength = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === '`') {
      let runLength = 1;
      while (value[index + runLength] === '`') runLength += 1;
      rendered += '`'.repeat(runLength);
      if (codeDelimiterLength === 0) codeDelimiterLength = runLength;
      else if (runLength === codeDelimiterLength) codeDelimiterLength = 0;
      index += runLength - 1;
      continue;
    }

    if (char !== '\\' || codeDelimiterLength > 0 || index + 1 >= value.length) {
      rendered += char;
      continue;
    }

    const next = value[index + 1];
    if (next === '\\') {
      rendered += '\\\\';
      index += 1;
      continue;
    }
    if (next === 'n') {
      rendered += '\n';
      index += 1;
      continue;
    }
    if (next === 'r' && value[index + 2] === '\\' && value[index + 3] === 'n') {
      rendered += '\n';
      index += 3;
      continue;
    }

    rendered += char;
  }

  return rendered;
}
