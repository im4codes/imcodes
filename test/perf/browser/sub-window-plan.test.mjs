import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planSubWindows, seedVisibility, seededSubIds } from './sub-window-plan.mjs';

const COMPOSE = readFileSync(new URL('./docker-compose.yml', import.meta.url), 'utf8');

test('the default 20-session run seeds and waits for nine visible windows', () => {
  const plan = planSubWindows({ sessions: 20, subWindowsEnv: '19', seedMinimized: true });
  assert.equal(plan.total, 19);
  assert.equal(plan.target, 9);
  assert.equal(plan.visible.length, 9);
  assert.equal(plan.hiddenSeeded.length, 10);
});

// tsk_cd_web_route_settled_stall: IMC_PERF_SESSIONS=1 with compose's default
// IMC_PERF_SUB_WINDOWS=19 used to wait 90 s for nine windows that were never
// seeded, and the daemon still served 20 sessions.
test('SESSIONS=1 works: no sub-windows are seeded, none are waited for', () => {
  const plan = planSubWindows({ sessions: 1, subWindowsEnv: '19', seedMinimized: true });
  assert.deepEqual({ total: plan.total, target: plan.target, visible: plan.visible, hidden: plan.hiddenSeeded }, { total: 0, target: 0, visible: [], hidden: [] });
  assert.deepEqual(seededSubIds(1), []);
});

test('an explicit request can ask for fewer windows, never for more than are seeded', () => {
  assert.equal(planSubWindows({ sessions: 20, subWindowsEnv: '12', seedMinimized: true }).total, 12);
  assert.equal(planSubWindows({ sessions: 5, subWindowsEnv: '19', seedMinimized: true }).total, 4);
  assert.equal(planSubWindows({ sessions: 20, subWindowsEnv: undefined, seedMinimized: false }).target, 19);
  assert.equal(planSubWindows({ sessions: 20, subWindowsEnv: '', seedMinimized: false }).total, 19);
});

test('the target never exceeds the visible windows the seed installs (any session count, any request)', () => {
  for (const seedMinimized of [true, false]) {
    for (let sessions = 0; sessions <= 40; sessions += 1) {
      for (const subWindowsEnv of [undefined, '', '0', '3', '9', '10', '11', '19', '40', 'nope']) {
        const plan = planSubWindows({ sessions, subWindowsEnv, seedMinimized });
        assert.ok(plan.target <= plan.visible.length, `sessions=${sessions} env=${subWindowsEnv} min=${seedMinimized}`);
        assert.ok(plan.total <= Math.max(0, sessions - 1));
      }
    }
  }
});

test('seed visibility keeps the last ten minimized and never invents ids', () => {
  const { visible, hidden } = seedVisibility(30, true);
  assert.equal(hidden.length, 10);
  assert.equal(visible.length, 19);
  assert.deepEqual([...visible, ...hidden], seededSubIds(30));
  assert.deepEqual(seedVisibility(6, true), { visible: [], hidden: seededSubIds(6) });
});

test('a config that would wait for unseeded windows fails fast with a specific message', () => {
  // Not reachable through planSubWindows' own clamping; assert the guard text
  // stays specific if someone loosens the clamp.
  const source = readFileSync(new URL('./sub-window-plan.mjs', import.meta.url), 'utf8');
  assert.match(source, /waits for \$\{target\} sub-windows but only \$\{visible\.length\} are seeded/);
});

test('compose hands IMC_PERF_SESSIONS to BOTH the fake daemon and the harness', () => {
  const block = (name) => {
    const start = COMPOSE.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
    assert.ok(start >= 0, `service ${name} present`);
    const rest = COMPOSE.slice(start + 1);
    const next = rest.search(/^  [a-z][\w-]*:\s*$/m);
    return next >= 0 ? rest.slice(0, next) : rest;
  };
  assert.match(block('daemon'), /IMC_PERF_SESSIONS: \$\{IMC_PERF_SESSIONS:-20\}/);
  assert.match(block('harness'), /IMC_PERF_SESSIONS: \$\{IMC_PERF_SESSIONS:-20\}/);
});
