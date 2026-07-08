// Pure agent-aware alias expansion (A′): the daemon substitutes markers into the
// agent-bound copy using the out-of-band resolvedAliases the sender computed.
// Dependency-free; unit-testable without the live transport pipeline.
// See openspec/changes/alias-quick-insert (design D9/D10, tasks 8.1/8.2/8.4).

import { SESSION_AGENT_TYPES, type SessionAgentType } from './agent-types.js';
import {
  ALIAS_LEGEND_DIRECTIVE,
  ALIAS_REASONS,
  ALIAS_VALUE_MAX,
  buildAliasLegendLine,
  isValidMarkerName,
  nfc,
  parseAliasMarkers,
  type AliasReason,
  type SendAliasResolution,
} from './alias-types.js';

export type AliasExpansionMode = 'inline' | 'legend';

/**
 * Explicit mode for every current agent type. Typed as `Record<SessionAgentType, ...>`
 * so a new union member fails to compile until it is classified here (test-guarded too).
 * Raw executors (`shell`/`script`) consume text literally → inline; NL/LLM agents → legend.
 */
export const ALIAS_EXPANSION_MODE_BY_AGENT: Record<SessionAgentType, AliasExpansionMode> = {
  'claude-code-sdk': 'legend',
  'claude-code': 'legend',
  'codex-sdk': 'legend',
  'qoder-sdk': 'legend',
  'codex': 'legend',
  'copilot-sdk': 'legend',
  'cursor-headless': 'legend',
  'opencode': 'legend',
  'gemini-sdk': 'legend',
  'gemini': 'legend',
  'qwen': 'legend',
  'openclaw': 'legend',
  'kimi-sdk': 'legend',
  'shell': 'inline',
  'script': 'inline',
};

/** Classify an agent type. Unknown/future types default to `inline` (the safe form: value in place). */
export function aliasExpansionModeFor(agentType: string): AliasExpansionMode {
  const known = (ALIAS_EXPANSION_MODE_BY_AGENT as Record<string, AliasExpansionMode | undefined>)[agentType];
  return known ?? 'inline';
}

/** True when every current `SessionAgentType` has an explicit classification (guards against silent default). */
export function everyAgentTypeClassified(): boolean {
  return SESSION_AGENT_TYPES.every(
    (t) => (ALIAS_EXPANSION_MODE_BY_AGENT as Record<string, AliasExpansionMode | undefined>)[t] !== undefined,
  );
}

export interface AliasExpansionResult {
  /** false only for raw executors when a marker could not be resolved (fail-closed). */
  deliver: boolean;
  /** The agent-bound text (meaningful only when `deliver` is true). */
  text: string;
  /** Distinct unresolved marker names, for non-blocking diagnostics (value never included). */
  unresolved: string[];
  /** Set to `alias_unresolved_failclosed` when `deliver` is false. */
  reason?: AliasReason;
}

/**
 * Enforcement point for a client-supplied resolved alias value (A′).
 *
 * `validateAliasValue` only runs on the SERVER save path; the daemon receives the
 * `resolvedAliases` map out-of-band from the sender's client and never re-validates
 * it before injection. A malicious/buggy client could therefore ship control/ANSI
 * bytes (ESC `\x1b[...`, CR `\r`), NUL, or oversized text — which, injected raw,
 * becomes shell control injection (inline shell/script agents) or legend prompt
 * injection (NL/LLM agents). This sanitizer is the last gate before ANY injection:
 *   - NFC-normalize (consistent code-point counting + matching);
 *   - strip Unicode control chars (`\p{Cc}`, i.e. C0+C1) EXCEPT `\n` and `\t`
 *     (OQ5: inline shell values may legitimately be multi-line / tabbed). This
 *     removal covers NUL (U+0000), ESC (U+001B), and CR (U+000D);
 *   - cap to ALIAS_VALUE_MAX code points (same ceiling as server-side validation),
 *     slicing on a code-point boundary so a surrogate pair is never split.
 */
export function sanitizeResolvedAliasValue(value: string): string {
  const normalized = nfc(value)
    // `[^\P{Cc}\n\t]` matches a char that IS `\p{Cc}` but is NOT `\n` and NOT
    // `\t` — i.e. "control chars except newline/tab". Drops NUL, ESC, CR, etc.
    // The `u` flag is required for the `\p{Cc}` / `\P{Cc}` property escapes.
    .replace(/[^\P{Cc}\n\t]/gu, '');
  const codePoints = Array.from(normalized);
  return codePoints.length > ALIAS_VALUE_MAX
    ? codePoints.slice(0, ALIAS_VALUE_MAX).join('')
    : normalized;
}

/** Single-pass inline substitution: replace each valid, resolved marker; leave others literal. */
function substituteInline(text: string, resolved: SendAliasResolution): string {
  return text.replace(/;;\(([^()]*)\)/g, (whole, rawName: string) => {
    if (!isValidMarkerName(rawName)) return whole;
    const name = nfc(rawName);
    // Sanitize the injected value at the substitution point (enforcement).
    return Object.prototype.hasOwnProperty.call(resolved, name)
      ? sanitizeResolvedAliasValue(resolved[name])
      : whole;
  });
}

/**
 * Expand alias markers into the agent-bound copy.
 * - inline: substitute values in place; if ANY referenced marker is unresolved, fail closed
 *   (do not deliver) so a literal `;;(name)` never reaches a shell.
 * - legend: keep body markers; prepend a directive + one `;;(name): value` line per distinct
 *   resolved marker (first-occurrence order); unresolved markers stay literal and are reported.
 *
 * Every resolved value is passed through `sanitizeResolvedAliasValue` before use in
 * EITHER the inline substitution OR the legend lines — this is the daemon's only
 * validation point for the client-supplied map.
 */
export function expandForAgent(
  text: string,
  resolved: SendAliasResolution,
  mode: AliasExpansionMode,
): AliasExpansionResult {
  const names = parseAliasMarkers(text);
  const has = (n: string) => Object.prototype.hasOwnProperty.call(resolved, n);
  const unresolved = names.filter((n) => !has(n));

  if (mode === 'inline') {
    if (unresolved.length > 0) {
      return { deliver: false, text: '', unresolved, reason: ALIAS_REASONS.UNRESOLVED_FAILCLOSED };
    }
    return { deliver: true, text: substituteInline(text, resolved), unresolved: [] };
  }

  const resolvedNames = names.filter(has);
  if (resolvedNames.length === 0) {
    return { deliver: true, text, unresolved };
  }
  // Sanitize each value before it becomes a legend line (enforcement).
  const legend = resolvedNames
    .map((n) => buildAliasLegendLine(n, sanitizeResolvedAliasValue(resolved[n])))
    .join('\n');
  return { deliver: true, text: `${ALIAS_LEGEND_DIRECTIVE}\n${legend}\n\n${text}`, unresolved };
}
