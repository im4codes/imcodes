import { MCP_FEATURE_FLAGS_BY_NAME } from './memory-mcp-feature-flags.js';

export const IMCODES_SESSION_ENV = 'IMCODES_SESSION';
export const IMCODES_SESSION_LABEL_ENV = 'IMCODES_SESSION_LABEL';
export const IMCODES_EXTERNAL_CLI_SENDER = '__imcodes_external_cli__';
export const IMCODES_SEND_MCP_DISPATCH_FEATURE_FLAG = MCP_FEATURE_FLAGS_BY_NAME.sendDispatch;

/**
 * Decode newline escapes in positional `imcodes send` message arguments.
 *
 * Shells preserve `\n` inside ordinary quoted arguments, while our generated
 * delegation commands intentionally use that compact form for multi-line
 * briefs. Decode only newline escapes here (not `\t`, `\u`, and friends) so
 * unrelated backslash content stays unchanged. A doubled backslash escapes
 * the decoder; callers can also use the CLI's `--literal` option.
 */
export function decodeImcodesSendNewlineEscapes(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\' || index + 1 >= value.length) {
      decoded += char;
      continue;
    }

    const next = value[index + 1];
    if (next === '\\') {
      decoded += '\\';
      index += 1;
      continue;
    }
    if (next === 'n') {
      decoded += '\n';
      index += 1;
      continue;
    }
    if (next === 'r') {
      if (value[index + 2] === '\\' && value[index + 3] === 'n') index += 2;
      decoded += '\n';
      index += 1;
      continue;
    }

    decoded += `\\${next}`;
    index += 1;
  }
  return decoded;
}
