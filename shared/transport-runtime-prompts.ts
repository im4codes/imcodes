/**
 * Daemon-injected system prompts that ride alongside user-authored
 * `description` / `systemPrompt` but must NOT be subject to the
 * `USER_SESSION_TEXT_MAX_CHARS` cap that bounds user-authored text.
 *
 * Background — see p2p audit run 37bfbb85-430. Commit 4e8c6506 added a
 * 300-char cap on user-authored prompts to keep an oversized paste from
 * inflating every turn. At the time, `session-manager` merged the
 * IM.codes identity block (~350 chars) and the Generated Image
 * Reporting protocol (~650 chars) into the same string before passing
 * it through the cap, so daemon-injected functional guidance was
 * silently truncated on every transport session. This file owns those
 * two builders so the assembly layer can inject them peer-level with
 * `MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE` (also static) into
 * `sessionSystemText`, completely outside the user-authored cap path.
 *
 * Lives in `shared/` because it is pure string composition with no
 * Node-only dependencies — the server (PR4 defense-in-depth) and the
 * web layer (effective-prompt preview UX) may both want to import the
 * same canonical builders.
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
 */
export function buildGeneratedImageReportingPrompt(): string {
  return [
    'Generated Image Reporting:',
    'When you generate, edit, save, or otherwise create any image file, you MUST report the local file path of every generated image in your final response.',
    '- If multiple images are created, list each path.',
    '- Use repository-relative paths when the image is inside the workspace; otherwise use absolute paths.',
    '- Do not only say that the image was generated.',
    '- If image generation succeeds but no file path is available, explicitly say that no path was returned.',
    '- If the image is intended for use in the app/site/docs, also mention where it was added or how it should be referenced.',
    'Never finish an image-generation task without telling the user where the generated image file is located.',
  ].join('\n');
}
