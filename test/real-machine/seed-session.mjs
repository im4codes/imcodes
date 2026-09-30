#!/usr/bin/env node
// Seed one session record into a SCOPED kit daemon home, before the daemon's first start.
// The daemon imports sessions.json once on first start (then owns sessions.sqlite), so seeding
// is only meaningful before `launcher.sh install`. Use it to prove a restart-restore path: a
// transport session WITHOUT --binary-path makes the daemon resolve a bare CLI on PATH (the kit
// tripwire fires); with --binary-path <absolute fixture> it runs the fixture.
//
//   node seed-session.mjs --home <state>/imcodes-home --name deck_kit_brain --project kit \
//        --agent codex-sdk --project-dir <state>/projects/kit [--binary-path /abs/fixture] [--role brain]
//
// Refuses any home that is not an owner-scoped kit home (must end in /imcodes-home).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith('--') ? [...acc, [cur.slice(2), all[i + 1]]] : acc), []));
const need = (k) => { if (!args[k]) { console.error(`seed-session: --${k} is required`); process.exit(2); } return args[k]; };
const home = need('home').replace(/\/+$/, '');
if (!home.startsWith('/') || !home.endsWith('/imcodes-home')) {
  console.error(`seed-session: refusing ${home}: only an owner-scoped kit home (absolute, ending in /imcodes-home) can be seeded`);
  process.exit(2);
}
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
  ...(agent === 'shell' ? { shellBin: '/bin/bash' } : {}),
  ...(args['binary-path'] ? { transportConfig: { binaryPath: args['binary-path'] } } : {}),
};
writeFileSync(file, JSON.stringify(store, null, 2));
console.log(`seeded ${name} (${agent}${args['binary-path'] ? `, binaryPath=${args['binary-path']}` : ', NO binaryPath'}) into ${file}`);
