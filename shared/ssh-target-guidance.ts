import { ALIAS_MCP_TOOLS } from './alias-types.js';

/** Provider-neutral prose only. A leaf module so pair/system contracts can
 * share the routing rule without importing one another or Node APIs. */
export const SSH_TARGET_ROUTING_GUIDANCE = [
  'SSH TARGET ROUTING: when the user supplies an SSH command or literal SSH host/port/IdentityFile, use SSH directly to that exact authorized target with the existing SSH client, credentials and host-key trust.',
  `Only a user-supplied SSH alias needs ${ALIAS_MCP_TOOLS.RESOLVE}, once; a literal target does not need alias resolution or a second authorization. An unknown alias must not block an already supplied literal SSH target.`,
  'For that SSH target, do not first enumerate verification machines or cycle through OCU/computer-use, local execution as a substitute for remote commands, shell_session1 or exec_remote; do not wait or poll for control-plane recovery.',
  'OCU may be chosen only when you clearly know that the specific target and required OCU function are available; a listed tool or generic online status is not proof. Evidence can be an explicit user statement, prior success for that same target/function, or a trustworthy specific capability/reachability confirmation; SSH failure alone is not evidence of OCU availability. Do not guess availability or probe a sequence of channels. This known-available exception keeps the original tool schema, authority and resource claims.',
  'Local shell use to run the SSH client and isolated local development/unit/SDK tests remains allowed; local tests are not remote-device evidence. A separate explicit user request for GUI or another channel still governs that work.',
  'Run a bounded SSH preflight; record the exact command/target/error and stop repeated retries of the same failure. Continue work independent of that target. If SSH genuinely lacks required connection or trust material, ask once with precise options; do not scan unrelated channels merely to report alternatives tried.',
  'Do not substitute targets/accounts/credentials, disable host-key verification, guess a nodeId, or bypass resource claims, credential checks, tool authority or precise confirmation for destructive/production operations. With no supplied SSH target, keep the existing controlled-node and no-target discovery rules.',
].join(' ');
