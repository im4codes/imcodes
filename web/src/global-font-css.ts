export const GLOBAL_FONT_DELTA_VAR = '--imcodes-global-font-delta';
export const CHAT_FONT_SIZE_VAR = '--imcodes-chat-font-size';
export const MIN_SCALED_FONT_PX = 8;

const CSS_TOKEN_OR_FONT_SIZE_RE = /(\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(font-size\s*:\s*)([^;{}]+)/gi;
const CSS_COMMENT_OR_LENGTH_RE = /(\/\*[\s\S]*?\*\/)|(?<![a-zA-Z0-9_.-])((?:\d+(?:\.\d+)?|\.\d+)(?:px|rem))\b/gi;
const CLAMP_VW_MID_RE = /(,\s*)(\d+(?:\.\d+)?v[wh])(\s*,)/gi;

export function scaledCssFontLength(amount: number, unit: 'px' | 'rem' = 'px'): string {
  const safe = Number.isFinite(amount) ? amount : (unit === 'rem' ? 0.875 : 14);
  return `max(${MIN_SCALED_FONT_PX}px, calc(${safe}${unit} + var(${GLOBAL_FONT_DELTA_VAR}, 0px)))`;
}

export function scaledCssFontPx(px: number): string {
  return scaledCssFontLength(px, 'px');
}

export function scaleFontSizeCssValue(rawValue: string): string {
  if (rawValue.includes(GLOBAL_FONT_DELTA_VAR) || rawValue.includes(CHAT_FONT_SIZE_VAR)) return rawValue;

  let next = rawValue.replace(CSS_COMMENT_OR_LENGTH_RE, (full, comment: string | undefined, lengthToken: string | undefined) => {
    if (comment) return comment;
    if (lengthToken !== undefined) {
      return `max(${MIN_SCALED_FONT_PX}px, calc(${lengthToken} + var(${GLOBAL_FONT_DELTA_VAR}, 0px)))`;
    }
    return full;
  });

  if (/clamp\s*\(/i.test(rawValue)) {
    next = next.replace(CLAMP_VW_MID_RE, (_full, lead: string, vwArg: string, trail: string) => {
      return `${lead}calc(${vwArg} + var(${GLOBAL_FONT_DELTA_VAR}, 0px))${trail}`;
    });
  }

  return next;
}

/**
 * Rewrites static `px` and `rem` lengths inside CSS `font-size` declarations so
 * every UI rule scales by `--imcodes-global-font-delta` (`1px` per `+1` step)
 * without altering `em`/`inherit` semantics or viewport geometry (`100dvh`/`--vvh`).
 */
export function transformCssFontSizes(css: string): string {
  if (!css.includes('font-size')) return css;
  return css.replace(
    CSS_TOKEN_OR_FONT_SIZE_RE,
    (full, commentOrString: string | undefined, propPrefix: string | undefined, value: string | undefined) => {
      if (commentOrString) return commentOrString;
      if (propPrefix && value !== undefined) {
        return `${propPrefix}${scaleFontSizeCssValue(value)}`;
      }
      return full;
    },
  );
}
