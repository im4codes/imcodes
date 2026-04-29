// Re-export of the canonical shared redaction module so existing daemon
// import paths keep working. The implementation lives at
// `shared/redact-secrets.ts` so the server can import the same patterns
// without duplicating regexes (CLAUDE.md MANDATORY rule: never copy code
// across daemon/server/web).
export {
  BASE_REDACTION_PATTERNS,
  REDACT_USER_PATTERN_INPUT_CAP,
  compileExtraRedactPatterns,
  redactSensitiveText,
} from '../../shared/redact-secrets.js';
export type { RedactionPattern, CompileExtraRedactPatternsErrorHandler } from '../../shared/redact-secrets.js';
