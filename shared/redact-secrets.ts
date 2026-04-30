// Canonical deterministic-redaction module shared by daemon (`src/`) and
// server (`server/`). The daemon writes already-redacted summaries before
// replication; the server re-redacts defensively before persisting embeddings
// so a misbehaving daemon (or a custom-pattern miss) never lets secrets enter
// pgvector. Patterns and the "[REDACTED:type]" tag scheme are part of the
// foundations spec contract — any change here must move with the OpenSpec
// artifacts under `memory-system-1.1-foundations`.
//
// Notes for callers:
// - `redactSensitiveText` is regex-based and synchronous. Per CLAUDE.md, no
//   new shared module duplicates patterns; both daemon and server import
//   from this file.
// - User-supplied patterns from `.imc/memory.yaml` are compiled via
//   `compileExtraRedactPatterns`. Invalid patterns are reported through the
//   optional `onError` callback so the loader can warn-once and increment a
//   counter; we do NOT silently swallow.
// - To bound worst-case CPU when a user supplies a catastrophic-backtracking
//   regex, `redactSensitiveText` truncates input to
//   `REDACT_USER_PATTERN_INPUT_CAP` (1 MiB) BEFORE applying user patterns.
//   Base patterns always run on the full input. This is a best-effort cap;
//   full ReDoS protection requires re2 and is out of scope for foundations.

export interface RedactionPattern {
  type: string;
  re: RegExp;
}

export const BASE_REDACTION_PATTERNS: RedactionPattern[] = [
  { type: 'gcp_pem', re: /---BEGIN\s+PRIVATE\s+KEY---[\s\S]+?---END\s+PRIVATE\s+KEY---/g },
  { type: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+\/=:-]{20,}/gi },
  { type: 'anthropic_key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: 'github_token', re: /\bgh[psuro]_[A-Za-z0-9]{20,}\b/g },
  { type: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'google_key', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { type: 'password', re: /\bpassword\s*[:=]\s*['"]?[^\s'"]+['"]?/gi },
  { type: 'slack', re: /\bxox[abps]-[0-9A-Za-z-]{10,}\b/g },
  { type: 'stripe', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/g },
  { type: 'openai_session', re: /\bsess-[0-9A-Za-z]{20,}\b/g },
  { type: 'hex40', re: /\b[0-9a-f]{40}\b/g },
  { type: 'base64', re: /(?<![A-Za-z0-9+/])(?:[A-Za-z0-9+/]{64,}={0,2})(?![A-Za-z0-9+/])/g },
];

/** Best-effort cap for ReDoS exposure when the user has supplied custom regexes. */
export const REDACT_USER_PATTERN_INPUT_CAP = 1_000_000;

export type CompileExtraRedactPatternsErrorHandler = (pattern: string, error: Error) => void;

/**
 * Compile user-supplied regex strings from `.imc/memory.yaml` into RegExp
 * objects. Invalid patterns are skipped; if `onError` is provided it is
 * invoked with the offending pattern and the constructor error so the
 * caller (`memory-config.ts`) can emit a structured warn-once + counter.
 */
export function compileExtraRedactPatterns(
  patterns: string[] | undefined,
  onError?: CompileExtraRedactPatternsErrorHandler,
): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns ?? []) {
    try {
      compiled.push(new RegExp(pattern, 'g'));
    } catch (error) {
      if (onError) {
        onError(pattern, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  return compiled;
}

/**
 * Apply all baseline redactions and any user-supplied extras to `text`.
 * Empty / falsy inputs are returned unchanged.
 *
 * For ReDoS containment, when `extraPatterns.length > 0` and `text.length`
 * exceeds `REDACT_USER_PATTERN_INPUT_CAP`, the user patterns are applied to
 * the first cap chars only; the remainder is returned with user patterns
 * NOT applied (base patterns still applied to the whole string). This is
 * the same compromise used by the daemon's hot path; in practice secrets
 * are short, so the cap is reached only on logs/dumps where partial coverage
 * is preferable to a 30-second event-loop stall.
 */
export function redactSensitiveText(text: string, extraPatterns: RegExp[] = []): string {
  if (!text) return text;
  let output = text;
  for (const pattern of BASE_REDACTION_PATTERNS) {
    output = output.replace(pattern.re, `[REDACTED:${pattern.type}]`);
  }
  if (extraPatterns.length === 0) return output;
  if (output.length <= REDACT_USER_PATTERN_INPUT_CAP) {
    for (const extra of extraPatterns) {
      output = output.replace(extra, '[REDACTED:custom]');
    }
    return output;
  }
  // Split: apply user patterns to the leading window only, leave the
  // trailing remainder untouched by user patterns.
  let head = output.slice(0, REDACT_USER_PATTERN_INPUT_CAP);
  const tail = output.slice(REDACT_USER_PATTERN_INPUT_CAP);
  for (const extra of extraPatterns) {
    head = head.replace(extra, '[REDACTED:custom]');
  }
  return head + tail;
}
