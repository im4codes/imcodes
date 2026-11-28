/** Quote `value` as one POSIX shell word (single quotes; an embedded `'` becomes `'\''`). */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Quote one literal CLI argument for the target platform shell so special characters cannot expand or split. */
export function quoteShellArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const escaped = value
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\+)$/, '$1$1')
      .replace(/%/g, '%%');
    return `"${escaped}"`;
  }
  return shellQuote(value);
}
