export const GLOBAL_FONT_DELTA_VAR = '--imcodes-global-font-delta';
export const CHAT_FONT_SIZE_VAR = '--imcodes-chat-font-size';
export const MIN_SCALED_FONT_PX = 8;

const CSS_TOKEN_OR_FONT_SIZE_RE = /(\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(font-size\s*:\s*)([^;{}]+)/gi;
const CSS_COMMENT_OR_PX_RE = /(\/\*[\s\S]*?\*\/)|(\d+(?:\.\d+)?)px\b/gi;
const CLAMP_VW_MID_RE = /(,\s*)(\d+(?:\.\d+)?v[wh])(\s*,)/gi;

export function scaledCssFontPx(px: number): string {
  const safe = Number.isFinite(px) ? px : 14;
  return `max(${MIN_SCALED_FONT_PX}px, calc(${safe}px + var(${GLOBAL_FONT_DELTA_VAR}, 0px)))`;
}

export function scaleFontSizeCssValue(rawValue: string): string {
  if (rawValue.includes(GLOBAL_FONT_DELTA_VAR)) return rawValue;

  let next = rawValue.replace(CSS_COMMENT_OR_PX_RE, (full, comment: string | undefined, pxNum: string | undefined) => {
    if (comment) return comment;
    if (pxNum !== undefined) {
      return `max(${MIN_SCALED_FONT_PX}px, calc(${pxNum}px + var(${GLOBAL_FONT_DELTA_VAR}, 0px)))`;
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
 * Rewrites static `px` lengths inside CSS `font-size` declarations so every UI
 * rule scales by `--imcodes-global-font-delta` (`1px` per `+1` step) without
 * altering `em`/`rem`/`inherit` or breaking viewport geometry (`100dvh`/`--vvh`).
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
