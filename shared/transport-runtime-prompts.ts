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
import { SSH_TARGET_ROUTING_GUIDANCE } from './ssh-target-guidance.js';
import { MEMORY_MCP_TOOL_NAMES } from './memory-mcp-contracts.js';
import { VERIFICATION_MACHINE_MCP_TOOLS } from './verification-machine.js';
import { FILE_OUTPUT_CONTRACT_ID, buildFileOutputContract } from './file-output-contract.js';

/**
 * Shared device-target authority rules. A target explicitly supplied in the
 * current user request is already in scope for that request's safe work; it is
 * not useful to make the user authorize the same target a second time.
 */
export const REAL_DEVICE_AUTHORIZATION_GUIDANCE = [
  'A device, SSH target/command, canonical nodeId, alias, or endpoint explicitly supplied by the user in the current request is authorized for that request\'s non-destructive inspection or testing; do not ask for a second authorization or require verification_machine_list first.',
  SSH_TARGET_ROUTING_GUIDANCE,
  'Non-destructive work includes reading logs, checking status, running tests or builds, and temporary isolated validation.',
  `Use the exact target with its tool's own schema, authority, resource-claim, reachability, and credential checks; for a controlled_node use ${MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE} with its nodeId.`,
  `When the user has not specified a target, call ${VERIFICATION_MACHINE_MCP_TOOLS.LIST} and, when availability matters, ${VERIFICATION_MACHINE_MCP_TOOLS.VERIFY} before selecting a machine.`,
  'Deleting, overwriting, migrating ownership, restarting or stopping production, cleaning resources outside this task, or writing default-user data is destructive or irreversible and requires confirmation of the precise scope before execution.',
  'Never bypass tool authority or resource claims, expose credentials, or fabricate device evidence; report commands, targets, and outcomes exactly.',
].join(' ');

/**
 * Prefer evidence from an authorized real machine over a purely textual audit.
 * This is provider-neutral and session-stable, so it belongs in the shared
 * system prompt rather than in one SDK adapter or a supervision-only preamble.
 */
export const REAL_DEVICE_TESTING_SYSTEM_GUIDANCE = [
  'REAL-DEVICE TESTING PRIORITY: when suitable real-device testing is available, perform it before audit because it can expose actual code defects quickly.',
  REAL_DEVICE_AUTHORIZATION_GUIDANCE,
].join(' ');

/**
 * Render the IM.codes session identity block. Includes the exact
 * session name and the display label so the model knows to prefer
 * `$IMCODES_SESSION` (or the exact name) over the human-friendly label
 * when invoking `imcodes send` — labels can collide across sessions.
 *
 * When `role` is `'brain'`, the block also tells the model it IS the
 * project's main session — the one leading the whole session group
 * (coordinating sub-sessions/workers) — so it knows its own standing
 * without having to infer it from the session name suffix.
 */
export function buildTransportImcodesIdentityPrompt(
  sessionName: string,
  label: string | null | undefined,
  role?: string | null,
): string {
  const displayLabel = label?.trim() || sessionName;
  return [
    'IM.codes session identity:',
    `- Exact session name: ${sessionName}`,
    `- Display label: ${displayLabel}`,
    ...(role === 'brain'
      ? ['- Your role: Brain — the main session leading this project\'s whole session group. Sub-sessions and workers report to you.']
      : []),
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
