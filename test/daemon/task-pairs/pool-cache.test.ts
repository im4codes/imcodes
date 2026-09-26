import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { upsertSession } from '../../../src/store/session-store.js';
import { configuredPools } from '../../../src/daemon/supervision-auto-provision.js';
import {
  __resetSupervisorDefaultsCacheForTests,
  __setCachedSupervisorDefaultsForTests,
} from '../../../src/daemon/supervisor-defaults-cache.js';
import { normalizeSessionSupervisionSnapshot } from '../../../shared/supervision-config.js';
import {
  DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS,
  buildSupervisionExecutionCapabilityId,
} from '../../../shared/supervision-execution-pool.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';

function brainWithPool(pool: Record<string, unknown>): SessionRecord {
  return {
    name: 'deck_pool_brain', projectName: 'pool-project', role: 'brain',
    agentType: 'codex-sdk', runtimeType: 'transport', projectDir: '/tmp/pool-project', state: 'idle',
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    transportConfig: {
      supervision: normalizeSessionSupervisionSnapshot({ mode: 'supervised_audit', executionPools: pool }),
    },
  } as SessionRecord;
}

function configuredPool(model: string) {
  // Explicit executor-only role: under role-based routing any pool entry can
  // serve either role by default ('both'), so these tests -- which need a
  // pool that genuinely cannot satisfy the auditor role -- must say so.
  const config = { agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model, role: 'executor' as const };
  return {
    state: 'configured' as const,
    primaryDevelopmentPool: {
      configs: [{ ...config, capabilityId: buildSupervisionExecutionCapabilityId(config) }],
      controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.primary,
    },
    economyTaskPool: { configs: [], controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.economy },
  };
}

describe('task-pair pool authority', () => {
  afterEach(() => __resetSupervisorDefaultsCacheForTests());

  it('uses the persisted account pool when the Brain sessions.json mirror is stale', () => {
    const oldMirror = configuredPool('gpt-5.6-sol');
    const accountPool = configuredPool('gpt-6-luna');
    __setCachedSupervisorDefaultsForTests({ backend: 'codex-sdk', model: 'gpt-6-luna', executionPools: accountPool });
    const pools = configuredPools(brainWithPool(oldMirror));
    expect(pools?.primaryDevelopmentPool.configs.map((config) => config.model)).toEqual(['gpt-6-luna']);
  });
});

/**
 * Causal coverage for the 215/jdzj symptom (P0, r1 audit): a session mirror
 * that looks "configured" but was never actually synced from the account
 * cache must say so in the Brain notice, not just silently degrade to
 * needs_auditor with no diagnostic.
 */
describe('task-pair pool authority: unsynced-cache visibility', () => {
  const PROJECT = 'poolsyncproj';
  const BRAIN = 'deck_poolsyncproj_brain';
  let now = 1_000_000;
  let sent: Array<{ target: string; text: string }>;
  let automation: TaskPairAutomation;

  function brainSession(pool: Record<string, unknown>): SessionRecord {
    return {
      name: BRAIN, projectName: PROJECT, role: 'brain', agentType: 'codex-sdk', runtimeType: 'transport',
      projectDir: `/tmp/${PROJECT}`, state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
      transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode: 'off', executionPools: pool }) },
    } as SessionRecord;
  }

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text) => { sent.push({ target, text }); } });
    // A mirror pool that satisfies neither role -- provider is codex-sdk, and
    // the default allowlist wants claude-code-sdk for the auditor -- so the
    // pick genuinely misses regardless of the cache.
    upsertSession(brainSession(configuredPool('gpt-5.6-sol')));
    automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined });
    taskPairService.setScheduler(automation);
  });

  afterEach(() => {
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    __resetSupervisorDefaultsCacheForTests();
    if (process.env.IMCODES_SUPERVISION_ENGINE === 'pairs') delete process.env.IMCODES_SUPERVISION_ENGINE;
  });

  it('names the never-synced account cache in the needs_auditor Brain notice', async () => {
    taskPairService.ingestText(PROJECT, BRAIN, '<!-- IMCODES_TASK DISPATCH T80 -->', 'pool-sync-turn-1', now);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const notice = sent.find((entry) => entry.target === BRAIN);
    expect(notice?.text).toContain("account pool not synced from server (last successful fetch: never); using this session's local copy");
  });

  it('omits the never-synced wording once the account cache has genuinely synced', async () => {
    __setCachedSupervisorDefaultsForTests({ backend: 'codex-sdk', model: 'gpt-5.6-sol', executionPools: configuredPool('gpt-5.6-sol') });

    taskPairService.ingestText(PROJECT, BRAIN, '<!-- IMCODES_TASK DISPATCH T81 -->', 'pool-sync-turn-2', now);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const notice = sent.find((entry) => entry.target === BRAIN);
    expect(notice?.text).toBeTruthy();
    expect(notice?.text).not.toContain('account pool not synced');
  });

  it('reports "no account-level pool configured" rather than "not synced" once a fetch confirmed the account has none', async () => {
    // A real fetch succeeded and came back with no pool at all -- a genuine
    // answer, not a degraded/never-fetched cache. `haiku` is on the excluded-
    // development-model list, so the legacy backend/model migration that
    // would otherwise synthesize a single-config pool does not fire, and the
    // cache stays genuinely 'legacy_unconfigured'.
    __setCachedSupervisorDefaultsForTests({ backend: 'claude-code-sdk', model: 'haiku' });

    taskPairService.ingestText(PROJECT, BRAIN, '<!-- IMCODES_TASK DISPATCH T82 -->', 'pool-sync-turn-3', now);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const notice = sent.find((entry) => entry.target === BRAIN);
    expect(notice?.text).toContain("no account-level pool configured; using this session's local copy");
    expect(notice?.text).not.toContain('not synced from server');
  });

  it('appends the sync gap to a requested-model miss, since a stale cache can be exactly why the model is missing', async () => {
    taskPairService.ingestText(
      PROJECT, BRAIN,
      '<!-- IMCODES_TASK DISPATCH T83 auditormodel=nonexistent-fictional-model -->',
      'pool-sync-turn-4', now,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const notice = sent.find((entry) => entry.target === BRAIN && entry.text.includes('no session/config for requested model'));
    expect(notice?.text).toContain('no session/config for requested model nonexistent-fictional-model');
    expect(notice?.text).toContain("account pool not synced from server (last successful fetch: never); using this session's local copy");
  });
});
