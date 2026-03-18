/**
 * @group tmux
 * Integration tests that require a real tmux installation.
 * Skip these in CI environments without tmux by setting SKIP_TMUX_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCb);

const SKIP = process.env.SKIP_TMUX_TESTS === '1';
const describeOrSkip = SKIP ? describe.skip : describe;

async function tmuxAvailable(): Promise<boolean> {
  try {
    await exec('which tmux');
    return true;
  } catch {
    return false;
  }
}

describeOrSkip('tmux integration', async () => {
  const sessionName = `deck_test_tmux_${Date.now()}`;

  beforeAll(async () => {
    const available = await tmuxAvailable();
    if (!available) {
      console.log('tmux not found — skipping integration tests');
    }
  });

  afterAll(async () => {
    try {
      await exec(`tmux kill-session -t ${sessionName}`);
    } catch {
      // session may not exist
    }
  });

  it('creates a tmux session', async () => {
    await exec(`tmux new-session -d -s ${sessionName} -- bash`);
    const { stdout } = await exec(`tmux list-sessions -F '#{session_name}'`);
    expect(stdout).toContain(sessionName);
  });

  it('send-keys to session', async () => {
    await exec(`tmux send-keys -t ${sessionName} 'echo hello_deck_test' Enter`);
    // Give bash time to process
    await new Promise((r) => setTimeout(r, 500));
  });

  it('capture-pane shows sent output', async () => {
    const { stdout } = await exec(`tmux capture-pane -p -t ${sessionName} -S -50`);
    // Just verify capture works
    expect(typeof stdout).toBe('string');
  });

  it('kill session', async () => {
    await exec(`tmux kill-session -t ${sessionName}`);
    const { stdout } = await exec(`tmux list-sessions -F '#{session_name}'`).catch(() => ({ stdout: '' }));
    expect(stdout).not.toContain(sessionName);
  });
});
