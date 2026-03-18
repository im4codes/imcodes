import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { detectStatus } from '../../src/agent/detect.js';

function loadFixture(agentType: string, screenName: string): string[] {
  const path = join(__dirname, '../fixtures', `${agentType}-screens`, `${screenName}.txt`);
  return readFileSync(path, 'utf-8').split('\n');
}

describe('detectStatus() — Claude Code', () => {
  it('detects idle from idle screen', () => {
    const lines = loadFixture('cc', 'idle');
    const status = detectStatus(lines, 'claude-code');
    expect(status).toBe('idle');
  });

  it('detects thinking from thinking screen', () => {
    const lines = loadFixture('cc', 'thinking');
    const status = detectStatus(lines, 'claude-code');
    expect(['thinking', 'streaming']).toContain(status);
  });

  it('detects streaming from streaming screen', () => {
    const lines = loadFixture('cc', 'streaming');
    const status = detectStatus(lines, 'claude-code');
    expect(['streaming', 'thinking']).toContain(status);
  });

  it('detects tool_running from tool screen', () => {
    const lines = loadFixture('cc', 'tool_running');
    const status = detectStatus(lines, 'claude-code');
    expect(['tool_running', 'thinking', 'streaming']).toContain(status);
  });
});

describe('detectStatus() — Codex', () => {
  it('detects idle from codex idle screen', () => {
    const lines = loadFixture('codex', 'idle');
    const status = detectStatus(lines, 'codex');
    expect(status).toBe('idle');
  });

  it('detects streaming from codex streaming screen', () => {
    const lines = loadFixture('codex', 'streaming');
    const status = detectStatus(lines, 'codex');
    expect(['streaming', 'thinking']).toContain(status);
  });
});

describe('detectStatus() — OpenCode', () => {
  it('detects idle from opencode idle screen', () => {
    const lines = loadFixture('opencode', 'idle');
    const status = detectStatus(lines, 'opencode');
    expect(status).toBe('idle');
  });

  it('detects streaming from opencode streaming screen', () => {
    const lines = loadFixture('opencode', 'streaming');
    const status = detectStatus(lines, 'opencode');
    expect(['streaming', 'thinking']).toContain(status);
  });
});

describe('detectStatus() edge cases', () => {
  it('returns idle for empty lines array', () => {
    const status = detectStatus([], 'claude-code');
    expect(status).toBe('idle');
  });

  it('returns idle for blank lines', () => {
    const status = detectStatus(['', '   ', ''], 'claude-code');
    expect(status).toBe('idle');
  });
});

describe('detectStatus() — Shell', () => {
  it('detects idle on $ prompt', () => {
    expect(detectStatus(['user@host:~$ '], 'shell')).toBe('idle');
  });

  it('detects idle on % prompt (zsh)', () => {
    expect(detectStatus(['user@host ~ %'], 'shell')).toBe('idle');
  });

  it('detects idle on # prompt (root)', () => {
    expect(detectStatus(['root@host:~# '], 'shell')).toBe('idle');
  });

  it('detects idle on › prompt (fish)', () => {
    expect(detectStatus(['~/projects ›'], 'shell')).toBe('idle');
  });

  it('detects idle on > prompt', () => {
    expect(detectStatus(['C:\\Users\\k>'], 'shell')).toBe('idle');
  });

  it('returns idle (fallthrough) for running output with no prompt yet', () => {
    // No active signal → default idle fallthrough
    const status = detectStatus(['npm install', 'added 42 packages'], 'shell');
    expect(status).toBe('idle');
  });
});
