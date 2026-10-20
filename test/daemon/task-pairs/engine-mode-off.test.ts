/**
 * A project that has not explicitly opted into the pairs engine must run
 * neither task-pair engine (2026-09-25, tsk_cd_pairs_optin: a mode=off
 * project running its own external dispatch/audit workflow had its legacy
 * tasks imported as pairs, was sent 95 nudges, and got a daemon heartbeat and
 * escalation fighting its own AGENTS.md-driven flow).
 *
 * Owner decision (2026-09-26, same task): pairs is no longer a zero-config
 * default. It activates only on an explicit `pairEngine` choice, or a Brain
 * snapshot that explicitly sets mode `supervised`/`supervised_audit`. No
 * saved supervision config at all, and no Brain session at all, are both
 * inert -- same as an explicit mode=off snapshot.
 *
 * Deliberately does NOT force `IMCODES_SUPERVISION_ENGINE=pairs` the way the
 * sibling task-pair test files do: that env override always wins regardless
 * of mode, so it would hide exactly the bug this file exists to catch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import {
  isPairsEngineProject,
  isPairsEngineSession,
  isTaskPairEngineActive,
  resolveTaskPairEngine,
  resolveTaskPairEngineState,
} from '../../../src/daemon/task-pairs/engine.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { importLegacyTasks } from '../../../src/daemon/task-pairs/legacy-import.js';
import { SUPERVISION_MODE, normalizeSessionSupervisionSnapshot } from '../../../shared/supervision-config.js';
import type { SupervisionTaskSnapshot } from '../../../src/daemon/supervision-state-store.js';

const PROJECT = 'modeoffproj';
const BRAIN = 'deck_modeoffproj_brain';
const EXEC = 'deck_sub_modeoffexec';
const AUD = 'deck_sub_modeoffaud';

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}

function brainWithMode(mode: string, extra: Record<string, unknown> = {}): SessionRecord {
  return session(BRAIN, 'brain', {
    transportConfig: { supervision: normalizeSessionSupervisionSnapshot({ mode, ...extra }) },
  } as Partial<SessionRecord>);
}

describe('task-pair engine: mode off with no explicit engine is inert', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    delete process.env.IMCODES_SUPERVISION_ENGINE;
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  });

  afterEach(() => {
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  // ---- resolveTaskPairEngineState: the root cause ------------------------

  it('mode off with nothing explicitly configured resolves to the inert off state', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.OFF));
    expect(resolveTaskPairEngineState(PROJECT)).toBe('off');
    expect(isPairsEngineProject(PROJECT)).toBe(false);
    expect(isPairsEngineSession(EXEC)).toBe(false);
    expect(isTaskPairEngineActive(PROJECT)).toBe(false);
    // The deprecated boolean-shaped API must never silently fall back to
    // legacy automation for a project the owner left uncovered by either
    // engine -- callers not yet updated to the tri-state result still see
    // "not pairs", never a false claim of "must be legacy".
    expect(resolveTaskPairEngine(PROJECT)).toBe('legacy');
  });

  it('mode supervised_audit with nothing explicitly configured still defaults to pairs (no regression for the default project)', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    expect(resolveTaskPairEngineState(PROJECT)).toBe('pairs');
    expect(isPairsEngineProject(PROJECT)).toBe(true);
    expect(isTaskPairEngineActive(PROJECT)).toBe(true);
  });

  it('mode supervised with nothing explicitly configured also defaults to pairs', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED));
    expect(resolveTaskPairEngineState(PROJECT)).toBe('pairs');
  });

  it('a Brain session with no supervision snapshot at all is inert (no saved config -> off, owner decision)', () => {
    upsertSession(session(BRAIN, 'brain'));
    expect(isPairsEngineProject(PROJECT)).toBe(false);
    expect(isTaskPairEngineActive(PROJECT)).toBe(false);
    expect(resolveTaskPairEngineState(PROJECT)).toBe('off');
  });

  it('a project with no Brain session at all is also inert', () => {
    // No upsertSession(BRAIN) at all -- e.g. a fresh or not-yet-discovered project.
    expect(resolveTaskPairEngineState(PROJECT)).toBe('off');
    expect(isPairsEngineProject(PROJECT)).toBe(false);
    expect(isTaskPairEngineActive(PROJECT)).toBe(false);
  });

  it('an explicit pairEngine on the Brain session wins over mode off', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.OFF, { pairEngine: 'pairs' }));
    expect(resolveTaskPairEngineState(PROJECT)).toBe('pairs');
    expect(isPairsEngineProject(PROJECT)).toBe(true);
  });

  it('an explicit legacy pairEngine on the Brain session is retired and remains inert', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.OFF, { pairEngine: 'legacy' }));
    expect(resolveTaskPairEngineState(PROJECT)).toBe('off');
    expect(isTaskPairEngineActive(PROJECT)).toBe(false);
  });

  it('a stale legacy environment override also resolves to inert/off', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED));
    process.env.IMCODES_SUPERVISION_ENGINE = 'legacy';
    expect(resolveTaskPairEngineState(PROJECT)).toBe('off');
    expect(isTaskPairEngineActive(PROJECT)).toBe(false);
  });

  it('a stored per-project engine setting wins over mode off', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.OFF));
    getTaskPairStore().setProjectEngine(PROJECT, 'pairs');
    expect(resolveTaskPairEngineState(PROJECT)).toBe('pairs');
  });

  it('a stored legacy engine is preserved for migration but resolves inert/off', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED));
    getTaskPairStore().setProjectEngine(PROJECT, 'legacy');
    expect(resolveTaskPairEngineState(PROJECT)).toBe('off');
    expect(getTaskPairStore().getProjectSettings(PROJECT).engine).toBe('legacy');
  });

  it('the env override wins over mode off regardless of everything else', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.OFF));
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    expect(resolveTaskPairEngineState(PROJECT)).toBe('pairs');
  });

  it('no project context is inert too (nothing to consult means nothing enabled)', () => {
    expect(resolveTaskPairEngineState(undefined)).toBe('off');
  });

  // ---- legacy import: no import for a mode-off unconfigured project ------

  it('never imports a mode-off unconfigured project\'s legacy tasks as pairs', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.OFF));
    const task: SupervisionTaskSnapshot = {
      taskId: 'tsk_external', projectName: PROJECT, status: 'implementing', objective: 'owned by the project\'s own flow',
      assignments: [{ role: 'implementer', status: 'implementing', identity: { sessionName: EXEC } }],
    } as unknown as SupervisionTaskSnapshot;
    const registry = { list: () => [task] };
    expect(importLegacyTasks(registry, 5_000)).toBe(0);
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_external')).toBeUndefined();
  });

  it('imports the same task once the project switches to supervised_audit', () => {
    upsertSession(brainWithMode(SUPERVISION_MODE.OFF));
    const task: SupervisionTaskSnapshot = {
      taskId: 'tsk_external2', projectName: PROJECT, status: 'implementing', objective: 'owned by the project\'s own flow',
      assignments: [{ role: 'implementer', status: 'implementing', identity: { sessionName: EXEC } }],
    } as unknown as SupervisionTaskSnapshot;
    const registry = { list: () => [task] };
    expect(importLegacyTasks(registry, 5_000)).toBe(0);
    upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
    expect(importLegacyTasks(registry, 6_000)).toBe(1);
    expect(getTaskPairStore().getPair(PROJECT, 'tsk_external2')).toBeDefined();
  });

  // ---- scheduler: an already-open pair goes quiet, not deleted -----------

  describe('an already-open pair on a project switched to mode off', () => {
    let now = 1_000_000;
    let sent: Array<{ target: string; text: string; id: string }>;
    let automation: TaskPairAutomation;
    let turn = 0;
    function marker(writer: string, line: string) {
      turn += 1;
      return taskPairService.ingestText(PROJECT, writer, line, `modeoff-turn-${turn}`, now);
    }
    function sentTo(target: string, reasonPart?: string) {
      return sent.filter((entry) => entry.target === target && (!reasonPart || entry.id.includes(`:${reasonPart}`)));
    }
    async function tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        now += 6 * 60_000;
        await automation.tick();
      }
    }

    beforeEach(() => {
      upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
      upsertSession(session(EXEC, 'w1'));
      upsertSession(session(AUD, 'w2'));
      sent = [];
      setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
      automation = new TaskPairAutomation({
        now: () => now,
        isBusy: () => false,
        isLimited: () => false,
        pickCandidate: () => undefined,
        provision: async () => undefined,
        poolOf: () => 'primary',
        importLegacy: () => undefined,
      });
      taskPairService.setScheduler(automation);
      marker(BRAIN, `<!-- IMCODES_TASK DISPATCH offpair executor=${EXEC} auditor=${AUD} -->`);
    });

    afterEach(() => {
      taskPairService.setScheduler(undefined);
      setTaskPairDeliveryDepsForTests(undefined);
    });

    it('stops nudging while mode is off, keeps the stored pair, and resumes nudging once mode is switched back', async () => {
      // Confirm the pair is actually live and nudged while supervised_audit,
      // or "stops nudging in mode off" would be a vacuous pass.
      sent = [];
      await tick(2);
      expect(sentTo(EXEC, 'nudge-executor').length).toBeGreaterThan(0);
      expect(getTaskPairStore().getPair(PROJECT, 'offpair')).toBeDefined();

      upsertSession(brainWithMode(SUPERVISION_MODE.OFF));
      sent = [];
      await tick(3);
      expect(sent).toHaveLength(0);
      // Not deleted -- still there, unchanged, ready to resume.
      const quiet = getTaskPairStore().getPair(PROJECT, 'offpair');
      expect(quiet).toBeDefined();
      expect(quiet?.state.status).not.toBe('cancelled');
      expect(quiet?.state.status).not.toBe('done');

      upsertSession(brainWithMode(SUPERVISION_MODE.SUPERVISED_AUDIT));
      sent = [];
      await tick(2);
      expect(sent.length).toBeGreaterThan(0);
    });
  });
});
