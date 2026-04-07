import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export function normalizeTransportCwd(cwd?: string): string | undefined {
  if (typeof cwd !== 'string' || !cwd.trim()) return undefined;
  if (process.platform === 'win32') {
    const absolute = path.win32.isAbsolute(cwd) ? path.win32.normalize(cwd) : path.win32.resolve(cwd);
    return absolute.replace(/\\/g, '/');
  }
  return path.resolve(cwd);
}

/** Resolve a CLI binary name to an absolute path on Windows.
 *
 *  Node's child_process.spawn(name, args) on Windows does NOT search PATH for
 *  `.cmd`/`.bat` extensions when `shell: false`.  npm-installed CLIs are
 *  almost always `.cmd` shims (e.g. `claude.cmd`, `codex.cmd`); npm also
 *  drops a Unix-style extensionless file in the same directory which Windows
 *  cannot execute.
 *
 *  This helper walks PATH manually and tries PATHEXT extensions FIRST so we
 *  prefer `codex.cmd` over the extensionless `codex` shim.  Returns the
 *  absolute path if found, or the original name if not. */
export function resolveBinaryOnWindows(name: string): string {
  if (process.platform !== 'win32') return name;
  // Already absolute and exists? Use as-is.
  if (path.isAbsolute(name) && existsSync(name)) return name;
  // Windows path/ext delimiter is always ';'.  Hard-code it instead of
  // importing `delimiter` from node:path because that constant is the host
  // OS delimiter (':' on Linux), which breaks tests that fake
  // `process.platform = 'win32'` on a posix CI runner.
  const WIN_DELIMITER = ';';
  const pathDirs = (process.env.PATH ?? '').split(WIN_DELIMITER).filter(Boolean);
  const pathExtRaw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = pathExtRaw.split(WIN_DELIMITER).filter(Boolean);
  const hasExt = exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  // If the user already gave a known extension, try it directly.  Otherwise
  // try every PATHEXT (so we hit `.cmd` before the extensionless Unix shim),
  // then fall back to the bare name as a last resort.
  const extsToTry = hasExt ? [''] : [...exts, ''];
  for (const dir of pathDirs) {
    for (const ext of extsToTry) {
      // Use path.join (native) — works on both Windows runtime and tests
      // that fake `process.platform = 'win32'` on a posix host.
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

/** Result of resolving a binary that may be an npm .cmd shim.
 *  When the resolved path is a real .exe, just `{ executable }`.
 *  When it's a Windows .cmd shim, returns the underlying node script so
 *  callers can spawn `node + scriptPath` directly (works with SDKs that don't
 *  use `shell: true`). */
export interface ResolvedExecutable {
  /** Path that is safe to pass to child_process.spawn without shell:true. */
  executable: string;
  /** Extra args to prepend (e.g. the .js path when executable is node). */
  prependArgs: string[];
}

/** Resolve a CLI to a `(executable, prependArgs)` pair that's safe to pass
 *  directly to `spawn(executable, [...prependArgs, ...userArgs])` without
 *  needing `shell: true`.
 *
 *  - On non-Windows: returns the input unchanged.
 *  - On Windows .exe: returns the .exe.
 *  - On Windows .cmd npm shim: parses the shim, extracts the underlying
 *    `node script.js` invocation, and returns `(node.exe, [scriptPath])`.
 *    This is what the @anthropic-ai/claude-agent-sdk needs because it spawns
 *    `pathToClaudeCodeExecutable` directly without `shell: true`. */
export function resolveExecutableForSpawn(name: string): ResolvedExecutable {
  if (process.platform !== 'win32') {
    return { executable: name, prependArgs: [] };
  }
  const resolved = resolveBinaryOnWindows(name);
  // Real binary (.exe / .com): use directly.
  if (/\.(exe|com)$/i.test(resolved)) {
    return { executable: resolved, prependArgs: [] };
  }
  // .cmd / .bat npm shim: parse out the underlying node script path.
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const scriptPath = parseNpmCmdShim(resolved);
    if (scriptPath) {
      return { executable: process.execPath, prependArgs: [scriptPath] };
    }
    // Couldn't parse the shim — return as-is. Caller (e.g. codex-sdk) can
    // still spawn it via shell:true as a fallback.
    return { executable: resolved, prependArgs: [] };
  }
  // Fallback: pass through.
  return { executable: resolved, prependArgs: [] };
}

/** Parse an npm-generated `.cmd` shim and return the absolute path of the
 *  node script it invokes. Returns null if the shim format isn't recognized. */
export function parseNpmCmdShim(cmdPath: string): string | null {
  let content: string;
  try {
    content = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  // npm shims contain a line like:
  //   "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
  // We extract the "...js" path. The %dp0% expands to the directory of the .cmd.
  const dp0 = path.dirname(cmdPath);
  const match = content.match(/"%dp0%[\\/]([^"]+\.(?:js|mjs|cjs))"/i);
  if (!match) return null;
  // Convert any windows-style separators in the captured path to native, then join.
  const inner = match[1].split(/[\\/]/).join(path.sep);
  return path.normalize(path.join(dp0, inner));
}
