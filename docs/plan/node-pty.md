# node-pty Integration Plan — Windows Terminal Streaming

## Problem

WezTerm CLI polling on Windows is fundamentally slow (~2-5s per `get-text` call due to `CreateProcess` overhead). Phase 1 optimizations improved it from ~0.3fps to ~1-2fps, but this is still far below the Unix tmux `pipe-pane` experience (~24fps).

## Goal

Replace WezTerm as the terminal backend on Windows with `node-pty` (Microsoft's ConPTY wrapper). This gives the daemon direct PTY streaming via `onData` callback — identical architecture to Unix `pipe-pane`, sub-millisecond latency.

## Architecture

### Current (WezTerm)

```
Agent (claude/codex/gemini)
    ↓ runs inside
WezTerm pane (GUI)
    ↓ wezterm cli get-text (2-5s per call)
Daemon (Node.js) — polls every 250-1000ms
    ↓ binary frames
Server → Browser xterm.js
```

### Proposed (node-pty)

```
Agent (claude/codex/gemini)
    ↓ spawned by
ConPTY (node-pty) — streaming onData callback
    ↓ raw PTY bytes (<1ms)
Daemon (Node.js) — event-driven, no polling
    ↓ binary frames
Server → Browser xterm.js
```

## Prerequisites

- **ConPTY**: Built into Windows 10 1809+ (October 2018). No installation needed.
- **node-pty**: `npm install node-pty`. Native C++ addon, requires:
  - Node.js headers (bundled with Node)
  - On Windows: Visual Studio Build Tools or `windows-build-tools` npm package
  - On Linux/macOS: gcc/clang (already available for tmux users)
- **Prebuild binaries**: `node-pty` publishes prebuilt `.node` files for common platforms via `prebuild-install`. Most users won't need a compiler.

## Implementation Plan

### Phase 1: New backend type `conpty`

**File: `src/agent/tmux.ts`**

Add `'conpty'` to `TerminalBackend` type:

```typescript
type TerminalBackend = 'tmux' | 'wezterm' | 'conpty';
```

Detection priority:
```typescript
function detectBackend(): TerminalBackend {
  if (process.env.IMCODES_MUX) return process.env.IMCODES_MUX;
  if (process.platform === 'win32') {
    // Prefer node-pty if available (much faster than WezTerm CLI)
    try { require('node-pty'); return 'conpty'; } catch {}
    // Fall back to WezTerm
    try { execFileSync('where', ['wezterm'], { stdio: 'ignore' }); return 'wezterm'; } catch {}
    throw new Error('Install node-pty (npm install node-pty) or WezTerm');
  }
  // Unix: tmux preferred
  ...
}
```

### Phase 2: ConPTY session manager

**New file: `src/agent/conpty.ts`**

```typescript
import * as pty from 'node-pty';

interface ConPtySession {
  ptyProcess: pty.IPty;
  name: string;
  dataBuffer: string;
}

const sessions = new Map<string, ConPtySession>();

export function conptyNewSession(
  name: string,
  command: string,
  opts?: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number }
): void {
  // Parse command into shell + args
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
  const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];

  const ptyProc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: opts?.cols ?? 80,
    rows: opts?.rows ?? 24,
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env } as Record<string, string>,
  });

  sessions.set(name, { ptyProcess: ptyProc, name, dataBuffer: '' });
}

export function conptyOnData(name: string, callback: (data: string) => void): void {
  const session = sessions.get(name);
  if (!session) return;
  session.ptyProcess.onData(callback);
}

export function conptyWrite(name: string, data: string): void {
  sessions.get(name)?.ptyProcess.write(data);
}

export function conptyResize(name: string, cols: number, rows: number): void {
  sessions.get(name)?.ptyProcess.resize(cols, rows);
}

export function conptyKill(name: string): void {
  const session = sessions.get(name);
  if (!session) return;
  session.ptyProcess.kill();
  sessions.delete(name);
}

export function conptySessionExists(name: string): boolean {
  return sessions.has(name);
}

export function conptyListSessions(): string[] {
  return [...sessions.keys()];
}
```

### Phase 3: Wire into tmux.ts dispatch

Each function in `tmux.ts` needs a `conpty` branch:

```typescript
export async function newSession(name: string, command?: string, opts?: NewSessionOptions) {
  if (BACKEND === 'conpty') {
    conptyNewSession(name, command ?? '', {
      cwd: opts?.cwd,
      env: opts?.env,
      cols: 80,
      rows: 24,
    });
    return;
  }
  // existing tmux/wezterm code...
}

export async function sendRawInput(session: string, data: string) {
  if (BACKEND === 'conpty') {
    conptyWrite(session, data);  // Direct write to PTY — no key mapping needed!
    return;
  }
  // existing code...
}

export async function startPipePaneStream(session: string): PipePaneHandle {
  if (BACKEND === 'conpty') {
    const { Readable } = await import('stream');
    const stream = new Readable({ read() {} });
    conptyOnData(session, (data) => stream.push(data));
    return {
      stream,
      cleanup: async () => { stream.push(null); },
    };
  }
  // existing code...
}
```

### Phase 4: Key differences from tmux/WezTerm

| Feature | tmux | WezTerm | node-pty |
|---------|------|---------|----------|
| Session creation | `tmux new-session` | `wezterm cli spawn` | `pty.spawn()` |
| Terminal streaming | `pipe-pane` (FIFO) | `get-text` (polling) | `onData` (callback) |
| Input | `send-keys` | `send-text --no-paste` | `pty.write()` |
| Resize | `resize-window` | `set-pane-size` | `pty.resize()` |
| Capture snapshot | `capture-pane -e -p` | `get-text --escapes` | Read from internal buffer |
| Key mapping | tmux key names | Escape sequences | None needed — raw bytes |
| Session persistence | Survives daemon restart | Survives daemon restart | **Dies with daemon** |
| GUI visibility | tmux attach | WezTerm tabs | **None** |

### Phase 5: Handle missing features

**Session persistence**: tmux/WezTerm sessions survive daemon restarts. ConPTY sessions die when the Node process exits. Options:
1. Accept it — daemon restarts are rare, agents can resume via `--resume`
2. Re-spawn on daemon restart using stored session records (already done for tmux reconnect)
3. Mirror output to a log file for session recovery

**GUI visibility**: Users can't see what the agent is doing locally. Options:
1. Accept it — web terminal is the primary UI
2. Optional: mirror PTY output to a WezTerm pane via `send-text` (hybrid mode)
3. Optional: log raw PTY output to `~/.imcodes/logs/session-{name}.log`

**Scrollback/capture**: `node-pty` doesn't maintain a scrollback buffer. For `capturePane`/`capturePaneVisible`:
1. Maintain an in-process xterm.js headless terminal (`xterm-headless` npm package)
2. Feed PTY data into it, query for visible content
3. Or simpler: keep a ring buffer of raw PTY output (last 50KB) and return that

## Dependencies

```json
{
  "optionalDependencies": {
    "node-pty": "^1.0.0"
  }
}
```

Using `optionalDependencies` so `npm install` doesn't fail on systems without a C++ compiler. The daemon checks at runtime:

```typescript
try {
  require('node-pty');
  // conpty available
} catch {
  // fall back to wezterm or tmux
}
```

## Migration Path

1. **node-pty is optional** — WezTerm remains the fallback on Windows
2. **Auto-detect**: if `node-pty` is installed, prefer it; if not, use WezTerm
3. **`IMCODES_MUX=wezterm` env var** overrides auto-detection for users who prefer WezTerm GUI
4. **No changes to Unix** — tmux remains the default on Linux/macOS
5. **node-pty also works on Unix** — could be used as tmux alternative for users who don't want tmux, but lower priority

## Risks

- **Native addon build failures**: `node-pty` requires C++ compiler. Mitigated by prebuild binaries and `optionalDependencies`.
- **No session persistence**: Agent sessions die with daemon. Mitigated by `--resume` support in all agents.
- **No local GUI**: Users can't see agent activity locally. Mitigated by web terminal being the primary interface.
- **Scrollback capture**: Need additional work for `capturePane`. Can use ring buffer initially.

## Timeline Estimate

- Phase 1-2 (backend + conpty.ts): 1 day
- Phase 3 (wire into tmux.ts): 1 day
- Phase 4-5 (handle edge cases): 1 day
- Testing on Windows: 1 day
- Total: ~4 days

## Success Criteria

- Windows terminal streaming matches Unix performance (~10-24fps)
- `imcodes send` input delivery is instant (no polling delay)
- Agent startup time same as Unix
- All existing daemon tests pass (Unix unchanged)
- Windows CI tests pass with node-pty
