import type { TransportContextBootstrap, TransportContextNamespaceStage } from './runtime-context-bootstrap.js';
import { getTransportContextBudgetMs } from './transport-context-budget.js';
import { withTimeoutOutcome } from '../util/timeout-outcome.js';
import { incrementCounter } from '../util/metrics.js';
import logger from '../util/logger.js';

/**
 * What a launch takes from the context bootstrap. Memory/context enrichment must never gate a
 * session launch (a saturated context store used to hold launches for minutes), so this is the
 * full bootstrap when it arrives within the transport context budget, otherwise whatever the
 * namespace stage produced before the budget ran out — the rest keeps running in the background
 * (`deferred`) and is handed to the runtime, which applies it late.
 */
export interface LaunchContextBootstrap {
  bootstrap: Partial<TransportContextBootstrap>;
  deferred?: Promise<TransportContextBootstrap>;
}

export async function resolveLaunchContextBootstrap(
  sessionName: string,
  resolve: (onNamespaceResolved: (stage: TransportContextNamespaceStage) => void) => Promise<TransportContextBootstrap>,
): Promise<LaunchContextBootstrap> {
  let stage: TransportContextNamespaceStage | undefined;
  const full = Promise.resolve().then(() => resolve((resolved) => { stage = resolved; }));
  const timeoutMs = getTransportContextBudgetMs();
  const partial = (reason: string): Partial<TransportContextBootstrap> => ({
    ...(stage ?? {}),
    diagnostics: [...(stage?.diagnostics ?? []), reason],
  });
  try {
    const outcome = await withTimeoutOutcome(full, timeoutMs);
    if (!outcome.timedOut) return { bootstrap: outcome.value };
    incrementCounter('transport.context.bootstrap_timeout', { phase: 'launch' });
    logger.warn({
      sessionName,
      timeoutMs,
      namespaceResolved: stage !== undefined,
    }, 'transport context bootstrap exceeded the launch budget; launching without waiting for it');
    return { bootstrap: partial('context-bootstrap:launch-timeout'), deferred: full };
  } catch (err) {
    incrementCounter('transport.context.bootstrap_failed', { phase: 'launch' });
    logger.warn({ err, sessionName }, 'transport context bootstrap failed at launch; launching without it');
    return { bootstrap: partial('context-bootstrap:launch-failed') };
  }
}

