/**
 * Which configuration an explicit `task.autoProvision` call creates. One rule, in this order, no judgement call:
 *
 *   1. the caller's own `task.requestedExecutionType` (handled by the caller of this function: it never reaches here);
 *   2. the first executor-eligible entry of the Brain's configured execution pool (the owner chose it; tier order breaks ties);
 *   3. the Brain's OWN provider family, secondary tier (the pair creator's default rule, `resolveCreationConfig`: Anthropic Sonnet, OpenAI Sol).
 *
 * The same input always yields the same configuration, whatever sessions happen to be idle, limited or busy right now.
 */
import type { SessionRecord } from '../store/session-store.js';
import { getSession } from '../store/session-store.js';
import type { SupervisionExecutionConfig, SupervisionExecutionPoolKind } from '../../shared/supervision-execution-pool.js';
import { TASK_PAIR_CREATED_SESSION_REASONS, type TaskPairCreatedSessionReason } from '../../shared/task-pair.js';
import { roleEligibleProvisionConfig } from './task-pairs/pool.js';
import { resolveCreationConfig } from './task-pairs/session-creation.js';

export type ForcedProvisionConfigSource = 'configured_pool' | 'default_same_family_secondary';

export type ForcedProvisionConfigResult =
  | { ok: true; config: SupervisionExecutionConfig; source: ForcedProvisionConfigSource; reason: TaskPairCreatedSessionReason }
  | { ok: false; error: string };

export function resolveForcedProvisionConfig(
  parent: SessionRecord,
  pool: SupervisionExecutionPoolKind,
  deps: { getSession?: (name: string) => SessionRecord | undefined } = {},
): ForcedProvisionConfigResult {
  const lookup = deps.getSession ?? getSession;
  const pooled = roleEligibleProvisionConfig(
    { brain: parent.name, role: 'executor', pool },
    { getSession: (name: string) => (name === parent.name ? parent : lookup(name)) },
  );
  if (pooled) return { ok: true, config: pooled, source: 'configured_pool', reason: TASK_PAIR_CREATED_SESSION_REASONS.EXPLICIT };

  const created = resolveCreationConfig(parent, undefined);
  if (!created.ok) return { ok: false, error: `${created.error}; pass task.requestedExecutionType naming the model to create` };
  return { ok: true, config: created.config, source: 'default_same_family_secondary', reason: TASK_PAIR_CREATED_SESSION_REASONS.DEFAULT };
}
