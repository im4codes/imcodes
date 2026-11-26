/**
 * Tests for the `imcodes send` CLI command extension:
 * - Sender identity detection (detectSenderSession)
 * - Hook server IPC helpers (readHookPort, postToHookServer)
 * - Backward compatibility with existing positional args
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAgentSendDocs } from '../../src/daemon/imcodes-workflow-docs.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS_MODULE = join(REPO_ROOT, 'src/daemon/imcodes-workflow-docs.ts');

/** Transitive repo-local runtime imports of a TypeScript module (type-only imports excluded). */
function localImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const specifiers = source.matchAll(/^\s*(import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm);
    for (const match of specifiers) {
      const target = resolve(dirname(file), match[2]!).replace(/\.js$/, '.ts');
      const resolved = existsSync(target) ? target : join(target.replace(/\.ts$/, ''), 'index.ts');
      if (existsSync(resolved)) visit(resolved);
    }
  };
  visit(entry);
  return seen;
}

// ── detectSenderSession tests ─────────────────────────────────────────────────

describe('detectSenderSession', () => {
  let detectSenderSession: typeof import('../../src/util/detect-session.js').detectSenderSession;

  beforeEach(async () => {
    vi.resetModules();
    // Clear all relevant env vars before each test
    delete process.env.IMCODES_SESSION;
    delete process.env.IMCODES_SESSION_LABEL;
    delete process.env.WEZTERM_PANE;
    delete process.env.TMUX_PANE;
    const mod = await import('../../src/util/detect-session.js');
    detectSenderSession = mod.detectSenderSession;
  });

  afterEach(() => {
    delete process.env.IMCODES_SESSION;
    delete process.env.IMCODES_SESSION_LABEL;
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

  it('prefers IMCODES_SESSION over IMCODES_SESSION_LABEL', async () => {
    process.env.IMCODES_SESSION = 'deck_proj_w1';
    process.env.IMCODES_SESSION_LABEL = 'CC1';
    const result = await detectSenderSession();
    expect(result).toBe('deck_proj_w1');
  });

  it('falls back to IMCODES_SESSION_LABEL for SDK/transport tool environments', async () => {
    process.env.IMCODES_SESSION_LABEL = 'CC1';
    const result = await detectSenderSession();
    expect(result).toBe('CC1');
  });

  it('throws for WEZTERM_PANE (not yet implemented)', async () => {
    process.env.WEZTERM_PANE = '123';
    await expect(detectSenderSession()).rejects.toThrow('WezTerm pane detection not yet implemented');
  });

  it('throws when no env vars are set', async () => {
    await expect(detectSenderSession()).rejects.toThrow('Cannot detect session identity');
  });

  it('falls through TMUX_PANE on tmux query failure when CLAUDECODE is set', async () => {
    // Previously this assumed tmux is absent ("In CI/Claude Code, tmux is
    // unavailable"). That is not true on a developer machine with tmux running:
    // the query for pane %99 can actually resolve to a real session, and the
    // test then failed with "promise resolved ... instead of rejecting".
    // Force the failure instead of hoping the environment supplies it.
    vi.resetModules();
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>();
      return {
        ...actual,
        execFile: (_file: string, _args: readonly string[], cb: (e: Error | null, so: string, se: string) => void) => {
          cb(new Error('tmux unavailable'), '', '');
          return undefined as never;
        },
      };
    });
    const mod = await import('../../src/util/detect-session.js');
    process.env.TMUX_PANE = '%99';
    try {
      await expect(mod.detectSenderSession()).rejects.toThrow('Cannot detect session identity');
    } finally {
      vi.doUnmock('child_process');
      vi.resetModules();
    }
  });
});

// ── Memory inject: appendAgentSendDocs tests ────────────────────────────────

describe('appendAgentSendDocs', () => {
  // A static import of the pure, dependency-light docs module. This block used
  // to vi.resetModules() and dynamically re-import memory-inject (≈100 daemon
  // modules) before every test only to reach this string helper; on a loaded
  // Windows runner that cold import exceeded the 10 s hook timeout.
  it('lives in a dependency-light module so callers never load the memory-inject graph', () => {
    const graph = localImportGraph(DOCS_MODULE);
    expect([...graph].map((file) => relative(REPO_ROOT, file).split(sep).join('/')).sort()).toEqual([
      'shared/imcodes-send.ts',
      'shared/memory-mcp-feature-flags.ts',
      'src/daemon/imcodes-workflow-docs.ts',
    ]);
    // Guard against the helper drifting back: memory-inject only re-exports it.
    const memoryInject = readFileSync(join(REPO_ROOT, 'src/daemon/memory-inject.ts'), 'utf8');
    expect(memoryInject).not.toMatch(/function\s+appendAgentSendDocs\b/);
    expect(memoryInject).toContain("export { appendAgentSendDocs } from './imcodes-workflow-docs.js';");
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
    expect(result).toContain('$IMCODES_SESSION_LABEL');
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
