/**
 * Daemon-injected system prompts. These ride alongside user-authored
 * `description` / `systemPrompt` but must NOT be subject to the
 * `USER_SESSION_TEXT_MAX_CHARS` cap that bounds user-authored text.
 *
 * Background — see p2p audit run 37bfbb85-430. Commit 4e8c6506 added a
 * 300-char cap on user-authored prompts to keep an oversized paste from
 * inflating every turn. At the time, `session-manager` merged the
 * IM.codes identity block and the Generated Image Reporting protocol
 * into the same string before passing it through the cap, so
 * daemon-injected functional guidance was silently truncated on every
 * transport session.
 *
 * Current injection points:
 *
 *   • `buildTransportImcodesIdentityPrompt` — appended to
 *     `sessionSystemText` by `compileAgentContextArtifact`, peer-level
 *     with `MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE`. Applies to ALL
 *     transport providers because every session has an exact name +
 *     label, and `imcodes send` is daemon-wide.
 *
 *   • `buildGeneratedImageReportingPrompt` — appended to Codex SDK's
 *     `baseInstructions` tail by `appendImcodesBaseInstructions`.
 *     Codex-only because Codex is currently the only transport agent
 *     with native image-generation tools (everyone else is a pure code
 *     agent). Living in `baseInstructions` means it is sent ONCE per
 *     `thread/start` / `thread/resume`, gets picked up by Codex's
 *     prefix cache, and costs zero tokens for non-Codex providers.
 *
 * Lives in `shared/` because both builders are pure string composition
 * with no Node-only dependencies — the server (defense-in-depth) and
 * the web layer (effective-prompt preview UX) may both want to import
 * the canonical builders.
 */
import { IMCODES_SESSION_ENV } from './imcodes-send.js';

/**
 * Render the IM.codes session identity block. Includes the exact
 * session name and the display label so the model knows to prefer
 * `$IMCODES_SESSION` (or the exact name) over the human-friendly label
 * when invoking `imcodes send` — labels can collide across sessions.
 */
export function buildTransportImcodesIdentityPrompt(
  sessionName: string,
  label: string | null | undefined,
): string {
  const displayLabel = label?.trim() || sessionName;
  return [
    'IM.codes session identity:',
    `- Exact session name: ${sessionName}`,
    `- Display label: ${displayLabel}`,
    `- When invoking \`imcodes send\`, prefer $${IMCODES_SESSION_ENV}. If a SDK/tool environment lacks it, prefix the command with ${IMCODES_SESSION_ENV}=${sessionName}. Do not use display labels as sender identity unless the exact session name is unavailable, because labels can be duplicated.`,
  ].join('\n');
}

/**
 * Render the Generated Image Reporting protocol. Tells the model to
 * always report the file path of any generated image so the user can
 * find / open / link to it.
 *
 * Compressed from 709 chars (8 lines) → 201 chars (1 line). All five
 * original semantic points are preserved:
 *   1. report file path of every image you create/edit/save
 *   2. repo-relative inside workspace, else absolute
 *   3. multiple images each get a path (implicit in "every")
 *   4. if no path is returned, say so explicitly
 *   5. if used in app/site/docs, note where it was added
 * The original's two redundant lines ("do not only say image was
 * generated" and the closing "never finish without …") restated rule 1
 * and were dropped — the positive imperative already covers them.
 *
 * This block is daemon-injected on every transport turn and lives in
 * `sessionSystemText`. Keeping it short saves ~500 chars per turn for
 * every transport session — see p2p audit 37bfbb85-430 N-A (cap fix)
 * and the token-diet sibling work.
 */
export function buildGeneratedImageReportingPrompt(): string {
  return 'Generated images: report the file path of every image you create/edit/save (repo-relative inside workspace, else absolute). If no path returned, say so. If used in app/site/docs, also note where added.';
}
