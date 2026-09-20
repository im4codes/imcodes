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
 *   • `buildFilePathReportingPrompt` — appended to `sessionSystemText`
 *     by `compileAgentContextArtifact`. Applies to ALL transport
 *     providers because IM.codes file preview/download needs the canonical
 *     file-output contract.
 *
 * Lives in `shared/` because both builders are pure string composition
 * with no Node-only dependencies — the server (defense-in-depth) and
 * the web layer (effective-prompt preview UX) may both want to import
 * the canonical builders.
 */
import { IMCODES_SESSION_ENV } from './imcodes-send.js';
import { ALIAS_MCP_TOOLS } from './alias-types.js';
import { MEMORY_MCP_TOOL_NAMES } from './memory-mcp-contracts.js';
import { VERIFICATION_MACHINE_MCP_TOOLS } from './verification-machine.js';
import { FILE_OUTPUT_CONTRACT_ID, buildFileOutputContract } from './file-output-contract.js';

/**
 * Prefer evidence from an authorized real machine over a purely textual audit.
 * This is provider-neutral and session-stable, so it belongs in the shared
 * system prompt rather than in one SDK adapter or a supervision-only preamble.
 */
export const REAL_DEVICE_TESTING_SYSTEM_GUIDANCE = [
  'REAL-DEVICE TESTING PRIORITY: when suitable authorized real-device testing is available, perform it before audit because it can expose actual code defects quickly.',
  // How to FIND what is authorized. The guidance used to say "use controlled
  // nodes when applicable" and "otherwise ask the user" -- with no way to learn
  // which machines this user and project had already authorized. So a model
  // that was supposed to verify on the machines configured for it asked the
  // user instead, and the authorization the user had set up went unused.
  `Before asking for a machine, call ${VERIFICATION_MACHINE_MCP_TOOLS.LIST} to see the verification machines already authorized for this user and project; use ${VERIFICATION_MACHINE_MCP_TOOLS.VERIFY} on one whose availability matters.`,
  // Both kinds, not only controlled nodes: the list also carries SSH machines,
  // which the old wording did not mention at all.
  `For a controlled_node entry, run commands with ${MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE} against its nodeId; for an ssh entry, resolve its alias with ${ALIAS_MCP_TOOLS.RESOLVE} and connect with that value.`,
  'Only if no authorized machine fits the operating system or device the change needs, ask the user for that specific authorization.',
].join(' ');

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
 * The generic path/link shape is referenced from file_output_v1 instead of
 * being restated here; this block adds only image-specific completeness.
 *
 * This block is daemon-injected into Codex baseInstructions, once per
 * thread/start|resume.
 */
export function buildGeneratedImageReportingPrompt(): string {
  return `Generated images: apply ${FILE_OUTPUT_CONTRACT_ID} to every image you create/edit/save. If no path returned, say so. If used in app/site/docs, also note where added.`;
}

/**
 * Render the File Path Reporting protocol. This is provider-neutral:
 * any agent can create artifacts or ask IM.codes/the user to open,
 * preview, download, or send a file. The frontend resolves those
 * actions most reliably from absolute paths, so keep this short and
 * daemon-injected outside user-authored prompt caps.
 */
export function buildFilePathReportingPrompt(): string {
  return buildFileOutputContract();
}
