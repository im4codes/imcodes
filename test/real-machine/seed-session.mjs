#!/usr/bin/env node
// Seed one session record into a SCOPED kit daemon's session store, before its first start.
// The daemon keeps its session store under HOME/.imcodes (NOT under IMCODES_HOME), and the kit
// scopes HOME to <state>/agent-home, so the store is <state>/agent-home/.imcodes. The daemon
// imports sessions.json there once on first start (then owns sessions.sqlite), so seeding is only
// meaningful before `launcher.sh install`. Use it to prove a restore path: a transport session
// WITHOUT --binary-path makes the daemon resolve a bare CLI on PATH (the kit tripwire fires); with
// --binary-path <absolute fixture> it runs the fixture. The daemon warm-restores a session ~100 s
// after start, so a tripwire row is only decided after that: wait, then run checker.sh.
//
//   IMCODES_TEST_KIT_ROOT=<root> node seed-session.mjs --state <root>/<owner> --name deck_kit_brain \
//        --project kit --agent codex-sdk --project-dir <root>/<owner>/projects/kit \
//        [--binary-path /abs/fixture] [--role brain] [--model M]
//
// Refuses any state dir that is not below IMCODES_TEST_KIT_ROOT.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith('--') ? [...acc, [cur.slice(2), all[i + 1]]] : acc), []));
const need = (k) => { if (!args[k]) { console.error(`seed-session: --${k} is required`); process.exit(2); } return args[k]; };
const kitRoot = process.env.IMCODES_TEST_KIT_ROOT ? resolve(process.env.IMCODES_TEST_KIT_ROOT) : '';
const state = resolve(need('state'));
if (!kitRoot || !state.startsWith(`${kitRoot}/`)) {
  console.error(`seed-session: refusing ${state}: it must be an owner state dir below IMCODES_TEST_KIT_ROOT (${kitRoot || 'unset'})`);
  process.exit(2);
}
const home = join(state, 'agent-home', '.imcodes');
const name = need('name'); const project = need('project'); const agent = need('agent'); const projectDir = need('project-dir');
if (args['binary-path'] && !args['binary-path'].startsWith('/')) { console.error('seed-session: --binary-path must be absolute'); process.exit(2); }
mkdirSync(home, { recursive: true }); mkdirSync(projectDir, { recursive: true });
const file = join(home, 'sessions.json');
const store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 2, identityPrompts: {}, sessions: {} };
const now = Date.now();
store.sessions[name] = {
  name, projectName: project, role: args.role ?? 'brain', agentType: agent, runtimeType: agent === 'shell' ? 'process' : 'transport',
  projectDir, state: 'idle', restarts: 0, restartTimestamps: [], createdAt: now - 60_000, updatedAt: now,
  sessionInstanceId: randomUUID(), runtimeEpoch: randomUUID(), userCreated: true,
  ...(agent === 'shell' ? { shellBin: '/bin/bash' } : {
    // A transport session is only restored after a restart when it carries a provider route + resume id.
    providerId: agent, providerSessionId: `route-${randomUUID()}`, providerResumeId: randomUUID(),
    requestedModel: args.model ?? 'gpt-5.2', activeModel: args.model ?? 'gpt-5.2',
  }),
  ...(args['binary-path'] ? { transportConfig: { binaryPath: args['binary-path'] } } : {}),
};
writeFileSync(file, JSON.stringify(store, null, 2));
console.log(`seeded ${name} (${agent}${args['binary-path'] ? `, binaryPath=${args['binary-path']}` : ', NO binaryPath'}) into ${file}`);
