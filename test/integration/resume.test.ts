/**
 * Integration test: verify each driver builds the correct resume command.
 */
import { describe, it, expect } from 'vitest';
import { ClaudeCodeDriver } from '../../src/agent/drivers/claude-code.js';
import { CodexDriver } from '../../src/agent/drivers/codex.js';
import { OpenCodeDriver } from '../../src/agent/drivers/opencode.js';

describe('resume command building', () => {
  it('CC uses -c flag for resume', () => {
    const driver = new ClaudeCodeDriver();
    const cmd = driver.buildResumeCommand('deck_proj_brain');
    expect(cmd).toContain('-c');
  });

  it('Codex builds a resume command', () => {
    const driver = new CodexDriver();
    const cmd = driver.buildResumeCommand('deck_proj_w1');
    expect(cmd).toBeTruthy();
    expect(typeof cmd).toBe('string');
  });

  it('OpenCode uses -c flag for resume', () => {
    const driver = new OpenCodeDriver();
    const cmd = driver.buildResumeCommand('deck_proj_w1');
    expect(cmd).toContain('-c');
  });
});

describe('multi-sample idle detection', () => {
  it('idle prompt at end of screen means idle', async () => {
    const { detectStatus } = await import('../../src/agent/detect.js');
    const lines = ['  Previous output', '❯'];
    expect(detectStatus(lines, 'claude-code')).toBe('idle');
  });

  it('spinner at end of screen means streaming/thinking', async () => {
    const { detectStatus } = await import('../../src/agent/detect.js');
    const lines = ['  Working...', '⠹'];
    const status = detectStatus(lines, 'claude-code');
    expect(['streaming', 'thinking']).toContain(status);
  });
});
