import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/normalize-controlled-node-artifacts.mjs');

describe('normalize-controlled-node-artifacts', () => {
  it('merges download layouts and moves archive-root targets under remote-desktop-worker', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'imcodes-artifacts-'));
    try {
      mkdirSync(path.join(root, 'dist-node-exe', 'remote-desktop-worker', 'linux-x64'), { recursive: true });
      mkdirSync(path.join(root, 'darwin-arm64'), { recursive: true });
      writeFileSync(path.join(root, 'dist-node-exe', 'remote-desktop-worker', 'linux-x64', 'linux.bin'), 'linux');
      writeFileSync(path.join(root, 'darwin-arm64', 'mac.bin'), 'mac');
      execFileSync(process.execPath, [SCRIPT, root], { stdio: 'pipe' });
      expect(readFileSync(path.join(root, 'remote-desktop-worker/linux-x64/linux.bin'), 'utf8')).toBe('linux');
      expect(readFileSync(path.join(root, 'remote-desktop-worker/darwin-arm64/mac.bin'), 'utf8')).toBe('mac');
      expect(existsSync(path.join(root, 'dist-node-exe'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on conflicting duplicate artifact files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'imcodes-artifacts-'));
    try {
      mkdirSync(path.join(root, 'remote-desktop-worker', 'darwin-arm64'), { recursive: true });
      mkdirSync(path.join(root, 'dist-node-exe', 'remote-desktop-worker', 'darwin-arm64'), { recursive: true });
      writeFileSync(path.join(root, 'remote-desktop-worker/darwin-arm64/component'), 'one');
      writeFileSync(path.join(root, 'dist-node-exe/remote-desktop-worker/darwin-arm64/component'), 'two');
      expect(() => execFileSync(process.execPath, [SCRIPT, root], { stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
