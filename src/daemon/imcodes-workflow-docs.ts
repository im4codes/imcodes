/**
 * Shared IM.codes workflow docs reused across agent bootstrap context and
 * supervision prompts so command guidance stays consistent.
 */
import { IMCODES_SESSION_ENV, IMCODES_SESSION_LABEL_ENV } from '../../shared/imcodes-send.js';

export const AGENT_SEND_DOCS = `
## Inter-Agent Communication

You can send messages to other agent sessions managed by the same daemon.

To send a message to another agent session:
  imcodes send "<label-or-session-name>" "<message>"
  imcodes send "<label-or-session-name>" "<message>" --files file1.ts,file2.ts

To broadcast to all sibling sessions:
  imcodes send --all "<message>"

To target by agent type:
  imcodes send --type codex "<message>"

Use \`imcodes send --list\` to see available sibling sessions.

Notes:
- Messages are delivered via the daemon's hook server. If the target is busy, the message is queued.
- The \`--files\` flag attaches file references; format depends on the target agent type.
- Your session identity is auto-detected from $${IMCODES_SESSION_ENV}. SDK/transport sessions also expose
  $${IMCODES_SESSION_LABEL_ENV} for display only; prefer $${IMCODES_SESSION_ENV} in generated commands because labels
  can be duplicated.
- If the user wants the agent to coordinate with another session, ask another worker to help, or hand work/results to a sibling session, this is usually actionable through \`imcodes send\` and should not by itself force human intervention.
`.trim();

export const OPENSPEC_WORKFLOW_DOCS = `
## OpenSpec Workflow

OpenSpec changes live under \`openspec/changes/<name>/\` and typically include \`proposal.md\`, \`design.md\`, \`specs/\`, and \`tasks.md\`.

Useful OpenSpec commands:
  openspec new change "<name>"
  openspec status --change "<name>" --json
  openspec instructions apply --change "<name>" --json

Operational expectations:
- When a task references an OpenSpec change, treat the change directory as the source of truth for scope and completion.
- If the user wants to use OpenSpec, implement an OpenSpec change, audit an OpenSpec change, or turn a discussion/description into OpenSpec artifacts, treat that as work the agent can usually continue autonomously.
- "Implement" means advance the code and tests while keeping the referenced OpenSpec artifacts aligned.
- "Audit implementation" means compare implementation against the OpenSpec artifacts, fix gaps directly, and update artifacts too when needed.
- "Propose" means write actual change artifacts under \`openspec/changes/\`, not just a draft note.
- "Achieve" means push the change to done by finishing remaining implementation/spec work and archive it once the completion criteria are satisfied.
`.trim();

export const P2P_WORKFLOW_DOCS = `
## P2P Discussions

P2P is IM.codes' built-in multi-agent discussion, review, audit, and planning workflow.

Common P2P chat tokens:
  @@all(discuss) <message>
  @@all(review) <message>
  @@all(audit>plan) <message>
  @@<label-or-session>(audit) <message>

Operational expectations:
- Built-in modes include \`audit\`, \`review\`, \`plan\`, \`brainstorm\`, and \`discuss\`.
- Combo pipelines like \`audit>plan\`, \`review>plan\`, and \`brainstorm>discuss>plan\` are valid.
- If the user wants a multi-agent discussion, review, audit, or planning pass, the agent can usually invoke P2P directly instead of stopping for human clarification.
- Use P2P when the user wants multi-agent discussion, review, brainstorming, or planning support, not as a replacement for direct implementation when no discussion is needed.
`.trim();

export const SUPERVISION_IMCODES_BACKGROUND_DOCS = [
  'IM.codes capability background:',
  'Use this background mainly to interpret the user\'s requested workflow and custom instructions.',
  'If the user wants OpenSpec, P2P discussion/review/planning, or inter-agent coordination via imcodes send, that is usually work the agent can continue doing autonomously.',
  'Do not treat the mere need to use one of these IM.codes workflows as a reason to ask_human or to mark the task complete early.',
  OPENSPEC_WORKFLOW_DOCS,
  P2P_WORKFLOW_DOCS,
  AGENT_SEND_DOCS,
].join('\n\n');
