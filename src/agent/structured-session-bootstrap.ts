import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { AgentType } from './detect.js';
import { findRolloutPathByUuid, ensureSessionFile as ensureCodexSessionFile } from '../daemon/codex-watcher.js';
import { injectGeminiMemory } from '../daemon/memory-inject.js';
import { legacyInjectionDisabled } from '../context/shared-context-flags.js';
import { GeminiDriver } from './drivers/gemini.js';
import logger from '../util/logger.js';

export interface StructuredSessionBootstrapInput {
  agentType: AgentType;
  projectDir: string;
  isNewSession: boolean;
  ccSessionId?: string | null;
  codexSessionId?: string | null;
  geminiSessionId?: string | null;
}

export interface StructuredSessionBootstrapResult {
  ccSessionId?: string;
  codexSessionId?: string;
  geminiSessionId?: string;
}

/**
 * Normalize provider-specific structured session identity/bootstrap behavior
 * so main sessions and sub-sessions use the same deterministic launch path.
 */
export async function resolveStructuredSessionBootstrap({
  agentType,
  projectDir,
  isNewSession,
  ccSessionId,
  codexSessionId,
  geminiSessionId,
}: StructuredSessionBootstrapInput): Promise<StructuredSessionBootstrapResult> {
  let resolvedCcSessionId = ccSessionId ?? undefined;
  let resolvedCodexSessionId = codexSessionId ?? undefined;
  let resolvedGeminiSessionId = geminiSessionId ?? undefined;

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
        await ensureCodexSessionFile(resolvedCodexSessionId, projectDir).catch((e) => {
          logger.warn({ err: e, projectDir, codexSessionId: resolvedCodexSessionId }, 'Failed to ensure Codex session file');
        });
      }
    }
  }

  if (agentType === 'gemini' && !resolvedGeminiSessionId && isNewSession) {
    try {
      resolvedGeminiSessionId = await new GeminiDriver().resolveSessionId(projectDir);
      logger.info({ projectDir, geminiSessionId: resolvedGeminiSessionId }, 'Resolved Gemini session ID');
      if (resolvedGeminiSessionId && !legacyInjectionDisabled()) {
        injectGeminiMemory(resolvedGeminiSessionId, projectDir, basename(projectDir)).catch((e) =>
          logger.warn({ err: e, projectDir, geminiSessionId: resolvedGeminiSessionId }, 'Gemini memory injection failed (non-fatal)'),
        );
      }
    } catch (e) {
      logger.warn({ err: e, projectDir }, 'Failed to resolve Gemini session ID — launching without --resume');
    }
  }

  return {
    ...(resolvedCcSessionId ? { ccSessionId: resolvedCcSessionId } : {}),
    ...(resolvedCodexSessionId ? { codexSessionId: resolvedCodexSessionId } : {}),
    ...(resolvedGeminiSessionId ? { geminiSessionId: resolvedGeminiSessionId } : {}),
  };
}
