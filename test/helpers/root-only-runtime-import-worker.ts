// Pure static analysis only: no daemon/server modules or test runners are loaded.
import { readFileSync } from 'node:fs';
import { rootOnlyRuntimeDependencies } from './root-only-runtime-imports.js';
const { root, entries } = JSON.parse(readFileSync(0, 'utf8')) as { root: string; entries: string[] };
console.log(JSON.stringify(rootOnlyRuntimeDependencies(root, entries)));
