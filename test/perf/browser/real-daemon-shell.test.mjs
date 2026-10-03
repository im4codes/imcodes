import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('real shell daemon launches an interactive bash in tmux', async () => {
  const source = await readFile(fileURLToPath(new URL('./real-daemon.mjs', import.meta.url)), 'utf8');
  assert.match(source, /spawn\('tmux', \['new-session', '-d', '-s', sessionName, '\/bin\/bash', '-i'\]/);
});

test('real shell harness exposes the gated block control contract', async () => {
  const source = await readFile(fileURLToPath(new URL('./real-daemon.mjs', import.meta.url)), 'utf8');
  assert.match(source, /req\.url === '\/block' && req\.method === 'POST'/);
  assert.match(source, /req\.url === '\/block-status'/);
  const compose = await readFile(fileURLToPath(new URL('./docker-compose.yml', import.meta.url)), 'utf8');
  assert.match(compose, /IMCODES_TEST_DAEMON: "1"/);
  assert.match(compose, /IMCODES_CORE_LANE_TEST_BLOCK_CONTROL_FILE/);
});
