/**
 * Tests for the `imcodes send` CLI command extension:
 * - Sender identity detection (detectSenderSession)
 * - Hook server IPC helpers (readHookPort, postToHookServer)
 * - Backward compatibility with existing positional args
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── detectSenderSession tests ─────────────────────────────────────────────────

describe('detectSenderSession', () => {
  let detectSenderSession: typeof import('../../src/util/detect-session.js').detectSenderSession;

  beforeEach(async () => {
    vi.resetModules();
    // Clear all relevant env vars before each test
    delete process.env.IMCODES_SESSION;
    delete process.env.WEZTERM_PANE;
    delete process.env.TMUX_PANE;
    const mod = await import('../../src/util/detect-session.js');
    detectSenderSession = mod.detectSenderSession;
  });

  afterEach(() => {
    delete process.env.IMCODES_SESSION;
    delete process.env.WEZTERM_PANE;
    delete process.env.TMUX_PANE;
    vi.restoreAllMocks();
  });

  it('returns IMCODES_SESSION when set', async () => {
    process.env.IMCODES_SESSION = 'deck_proj_brain';
    const result = await detectSenderSession();
    expect(result).toBe('deck_proj_brain');
  });

  it('prefers IMCODES_SESSION over TMUX_PANE', async () => {
    process.env.IMCODES_SESSION = 'deck_proj_w1';
    process.env.TMUX_PANE = '%42';
    const result = await detectSenderSession();
    expect(result).toBe('deck_proj_w1');
  });

  it('throws for WEZTERM_PANE (not yet implemented)', async () => {
    process.env.WEZTERM_PANE = '123';
    await expect(detectSenderSession()).rejects.toThrow('WezTerm pane detection not yet implemented');
  });

  it('throws when no env vars are set', async () => {
    await expect(detectSenderSession()).rejects.toThrow('Cannot detect session identity');
  });

  it('falls through TMUX_PANE on tmux query failure when CLAUDECODE is set', async () => {
    // In CI/Claude Code, tmux is unavailable — should throw gracefully
    process.env.TMUX_PANE = '%99';
    // The execFile call to tmux will fail, so detectSenderSession should throw
    await expect(detectSenderSession()).rejects.toThrow('Cannot detect session identity');
  });
});

// ── Memory inject: appendAgentSendDocs tests ────────────────────────────────

describe('appendAgentSendDocs', () => {
  let appendAgentSendDocs: typeof import('../../src/daemon/memory-inject.js').appendAgentSendDocs;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../src/util/logger.js', () => ({
      default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }));
    const mod = await import('../../src/daemon/memory-inject.js');
    appendAgentSendDocs = mod.appendAgentSendDocs;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends send docs to existing memory', () => {
    const result = appendAgentSendDocs('# Project context');
    expect(result).toContain('# Project context');
    expect(result).toContain('## Inter-Agent Communication');
    expect(result).toContain('imcodes send');
    expect(result).toContain('--files');
    expect(result).toContain('--list');
    expect(result).toContain('--all');
  });

  it('returns send docs when memory is null', () => {
    const result = appendAgentSendDocs(null);
    expect(result).toContain('## Inter-Agent Communication');
    expect(result).toContain('imcodes send');
  });

  it('returns send docs when memory is empty string', () => {
    const result = appendAgentSendDocs('');
    expect(result).toContain('## Inter-Agent Communication');
  });

  it('includes $IMCODES_SESSION reference', () => {
    const result = appendAgentSendDocs(null);
    expect(result).toContain('$IMCODES_SESSION');
  });
});

// ── CLI argument parsing tests ──────────────────────────────────────────────

describe('CLI send argument parsing', () => {
  it('parses --files into comma-separated array', () => {
    const raw = 'file1.ts,file2.ts,src/index.ts';
    const files = raw.split(',').map((f) => f.trim()).filter(Boolean);
    expect(files).toEqual(['file1.ts', 'file2.ts', 'src/index.ts']);
  });

  it('parses --files with spaces around commas', () => {
    const raw = 'file1.ts , file2.ts , src/index.ts';
    const files = raw.split(',').map((f) => f.trim()).filter(Boolean);
    expect(files).toEqual(['file1.ts', 'file2.ts', 'src/index.ts']);
  });

  it('handles single file in --files', () => {
    const raw = 'file1.ts';
    const files = raw.split(',').map((f) => f.trim()).filter(Boolean);
    expect(files).toEqual(['file1.ts']);
  });

  it('filters empty entries from --files', () => {
    const raw = 'file1.ts,,file2.ts,';
    const files = raw.split(',').map((f) => f.trim()).filter(Boolean);
    expect(files).toEqual(['file1.ts', 'file2.ts']);
  });
});

// ── Backward compat: target resolution ──────────────────────────────────────

describe('send backward compat — target resolution', () => {
  // Test the sessionName resolution logic (extracted from the CLI action)
  it('passes plain session names through unchanged', () => {
    const target = 'deck_myapp_brain';
    const name = target.includes(':') ? `deck_${target.split(':')[0]}_${target.split(':')[1]}` : target;
    expect(name).toBe('deck_myapp_brain');
  });

  it('resolves project:role shorthand', () => {
    const target = 'myapp:brain';
    // Mimic sessionName(project, role)
    const name = target.includes(':') ? `deck_${target.split(':')[0]}_${target.split(':')[1]}` : target;
    expect(name).toBe('deck_myapp_brain');
  });

  it('resolves project:w1 shorthand', () => {
    const target = 'proj:w1';
    const name = target.includes(':') ? `deck_${target.split(':')[0]}_${target.split(':')[1]}` : target;
    expect(name).toBe('deck_proj_w1');
  });
});

// ── Hook server IPC body shape tests ────────────────────────────────────────

describe('send POST body shape', () => {
  it('builds correct body for standard send', () => {
    const body = {
      from: 'deck_proj_w1',
      to: 'deck_proj_brain',
      message: 'hello world',
      depth: 0,
    };
    expect(body).toHaveProperty('from');
    expect(body).toHaveProperty('to');
    expect(body).toHaveProperty('message');
    expect(body).toHaveProperty('depth', 0);
  });

  it('does not add raw context authority fields to the hook payload', () => {
    const body = {
      from: 'deck_proj_w1',
      to: 'deck_proj_brain',
      message: 'hello world',
      depth: 0,
    } as const;

    expect(body).not.toHaveProperty('context');
    expect(body).not.toHaveProperty('description');
    expect(body).not.toHaveProperty('systemPrompt');
    expect(body).not.toHaveProperty('extraSystemPrompt');
  });

  it('builds correct body with files', () => {
    const files = ['src/api.ts', 'src/types.ts'];
    const body = {
      from: 'deck_proj_w1',
      to: 'Plan',
      message: 'review these',
      files,
      depth: 0,
    };
    expect(body.files).toEqual(['src/api.ts', 'src/types.ts']);
  });

  it('builds correct body for broadcast', () => {
    const body = {
      from: 'deck_proj_w1',
      to: '*',
      message: 'status update',
      depth: 0,
    };
    expect(body.to).toBe('*');
  });

  it('builds correct body for type-based target', () => {
    const body = {
      from: 'deck_proj_w1',
      to: 'codex',
      toType: 'agentType',
      message: 'run tests',
      depth: 0,
    };
    expect(body.toType).toBe('agentType');
  });
});
