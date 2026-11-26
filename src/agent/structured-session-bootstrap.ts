import { randomUUID } from 'node:crypto';
import type { AgentType } from './detect.js';
import { findRolloutPathByUuid, ensureSessionFile as ensureCodexSessionFile } from '../daemon/codex-watcher.js';
import logger from '../util/logger.js';

export interface StructuredSessionBootstrapInput {
  sessionName: string;
  agentType: AgentType;
  projectDir: string;
  isNewSession: boolean;
  ccSessionId?: string | null;
  codexSessionId?: string | null;
}

export interface StructuredSessionBootstrapResult {
  ccSessionId?: string;
  codexSessionId?: string;
}

/**
 * Normalize provider-specific structured session identity/bootstrap behavior
 * so main sessions and sub-sessions use the same deterministic launch path.
 */
export async function resolveStructuredSessionBootstrap({
  sessionName,
  agentType,
  projectDir,
  isNewSession,
  ccSessionId,
  codexSessionId,
}: StructuredSessionBootstrapInput): Promise<StructuredSessionBootstrapResult> {
  let resolvedCcSessionId = ccSessionId ?? undefined;
  let resolvedCodexSessionId = codexSessionId ?? undefined;

  if (agentType === 'claude-code' && !resolvedCcSessionId && isNewSession) {
    resolvedCcSessionId = randomUUID();
  }

  if (agentType === 'codex') {
    const hadExistingCodexSessionId = !!resolvedCodexSessionId;
    if (!resolvedCodexSessionId && isNewSession) {
      resolvedCodexSessionId = randomUUID();
    }
    if (resolvedCodexSessionId) {
      const rolloutPath = hadExistingCodexSessionId
        ? await findRolloutPathByUuid(resolvedCodexSessionId)
        : null;
      if (!rolloutPath) {
        await ensureCodexSessionFile(resolvedCodexSessionId, projectDir, sessionName).catch((e) => {
          logger.warn({ err: e, projectDir, codexSessionId: resolvedCodexSessionId }, 'Failed to ensure Codex session file');
        });
      }
    }
  }

  return {
    ...(resolvedCcSessionId ? { ccSessionId: resolvedCcSessionId } : {}),
    ...(resolvedCodexSessionId ? { codexSessionId: resolvedCodexSessionId } : {}),
  };
}
