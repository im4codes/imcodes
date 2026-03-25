import { describe, it, expect, afterEach } from 'vitest';
import { saveConfig, loadConfig, removeConfig } from '../../src/agent/openclaw-config.js';
import { existsSync, statSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

const CONFIG_PATH = join(homedir(), '.imcodes', 'openclaw.json');

afterEach(async () => {
  // Clean up after each test
  try { await removeConfig(); } catch { /* ignore */ }
});

describe('openclaw-config', () => {
  it('saves config and creates file with 0600 permissions', async () => {
    await saveConfig({ url: 'ws://localhost:18789', token: 'tok-123' });
    expect(existsSync(CONFIG_PATH)).toBe(true);
    const stat = statSync(CONFIG_PATH);
    expect((stat.mode & 0o777).toString(8)).toBe('600');
  });

  it('loads saved config', async () => {
    await saveConfig({ url: 'ws://example.com', token: 'abc', agentId: 'agent-1' });
    const cfg = await loadConfig();
    expect(cfg).toEqual({ url: 'ws://example.com', token: 'abc', agentId: 'agent-1' });
  });

  it('returns null when no config exists', async () => {
    await removeConfig(); // ensure clean
    const cfg = await loadConfig();
    expect(cfg).toBeNull();
  });

  it('removes config file', async () => {
    await saveConfig({ url: 'ws://localhost', token: 't' });
    expect(existsSync(CONFIG_PATH)).toBe(true);
    await removeConfig();
    expect(existsSync(CONFIG_PATH)).toBe(false);
  });

  it('removeConfig is safe when file does not exist', async () => {
    await removeConfig(); // first remove
    await removeConfig(); // second remove — should not throw
  });

  it('overwrites existing config', async () => {
    await saveConfig({ url: 'ws://old', token: 'old' });
    await saveConfig({ url: 'ws://new', token: 'new' });
    const cfg = await loadConfig();
    expect(cfg?.url).toBe('ws://new');
    expect(cfg?.token).toBe('new');
  });
});
