import type { CronAction, CronSendAction } from '../../shared/cron-types.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { attachMemoryMcpSourceProvenance, type MemoryMcpSourceProvenance } from '../../shared/memory-mcp-provenance.js';
import { EXECUTION_CLONE_ERROR_CODES } from '../../shared/execution-clone.js';

export type CronActionValidationResult =
  | { ok: true; action: CronSendAction }
  | { ok: false; reason: MCPErrorReason; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validateMcpCronAction(action: unknown, provenance: MemoryMcpSourceProvenance = {}): CronActionValidationResult {
  if (!isRecord(action)) {
    return { ok: false, reason: MCP_ERROR_REASONS.VALIDATION_FAILED, message: 'Cron action must be an object' };
  }

  if (action.type !== 'send') {
    return { ok: false, reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN, message: 'MCP cron jobs may only use structured send actions' };
  }

  // Cron-scheduled sends can NEVER create execution clones — a `clone` key on a
  // scheduled action is rejected outright (cron_clone_forbidden). The clone
  // create path requires a live, authorized creator session; a scheduled job has
  // no such anchor, so allowing it would orphan clones with no destroy authority.
  if ('clone' in action && action.clone !== undefined) {
    return {
      ok: false,
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
      message: `Cron send actions may not create execution clones (${EXECUTION_CLONE_ERROR_CODES.CRON_CLONE_FORBIDDEN})`,
    };
  }

  const target = typeof action.target === 'string' ? action.target.trim() : '';
  const message = typeof action.message === 'string' ? action.message.trim() : '';
  if (!target || !message) {
    return { ok: false, reason: MCP_ERROR_REASONS.VALIDATION_FAILED, message: 'Cron send action requires target and message' };
  }

  const idempotencyKey = typeof action.idempotencyKey === 'string' && action.idempotencyKey.trim()
    ? action.idempotencyKey.trim()
    : undefined;

  return {
    ok: true,
    action: attachMemoryMcpSourceProvenance({
      type: 'send' as const,
      target,
      message,
      ...(typeof action.reply === 'boolean' ? { reply: action.reply } : {}),
      ...(typeof action.broadcast === 'boolean' ? { broadcast: action.broadcast } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }, provenance),
  };
}

export function assertMcpCronAction(action: unknown): CronSendAction {
  const result = validateMcpCronAction(action);
  if (result.ok) return result.action;
  const err = new Error(result.message);
  (err as Error & { reason?: MCPErrorReason }).reason = result.reason;
  throw err;
}

export function isStructuredCronSendAction(action: CronAction): action is CronSendAction {
  return action.type === 'send';
}
