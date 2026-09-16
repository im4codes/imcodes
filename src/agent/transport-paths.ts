import path from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';

export function normalizeTransportCwd(cwd?: string): string | undefined {
  if (typeof cwd !== 'string' || !cwd.trim()) return undefined;
  if (process.platform === 'win32') {
    const absolute = path.win32.isAbsolute(cwd) ? path.win32.normalize(cwd) : path.win32.resolve(cwd);
    return absolute.replace(/\\/g, '/');
  }
  return path.resolve(cwd);
}

/** Canonical directory identity used when matching provider-owned sessions. */
export function canonicalizeTransportCwd(cwd?: string): string | undefined {
  const normalized = normalizeTransportCwd(cwd);
  if (!normalized) return undefined;
  let canonical = normalized;
  try {
    canonical = normalizeTransportCwd(realpathSync.native(normalized)) ?? normalized;
  } catch {
    // The project may be temporarily unavailable; the absolute normalized
    // path is still the safest fail-closed identity available.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
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
  const pathDirs = uniqueNonEmpty([
    ...(process.env.PATH ?? '').split(WIN_DELIMITER),
    ...getWindowsGlobalCliDirs(),
  ]);
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

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function getWindowsGlobalCliDirs(): string[] {
  return uniqueNonEmpty([
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : undefined,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm') : undefined,
  ]);
}

function getWindowsClaudeInstallCandidates(name: string): string[] {
  const basename = path.basename(name);
  const hasExt = /\.[^\\/]+$/.test(basename);
  const fileNames = hasExt ? [basename] : [basename, `${basename}.exe`, `${basename}.cmd`, `${basename}.bat`];
  const dirs = uniqueNonEmpty([
    ...getWindowsGlobalCliDirs(),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Claude') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Claude Code') : undefined,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Claude') : undefined,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Claude Code') : undefined,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Claude') : undefined,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Claude Code') : undefined,
  ]);
  return dirs.flatMap((dir) => fileNames.map((fileName) => path.join(dir, fileName)));
}

export function resolveBinaryWithWindowsFallbacks(name: string, windowsCandidates: string[] = []): string {
  if (process.platform !== 'win32') return name;
  for (const candidate of windowsCandidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return resolveBinaryOnWindows(name);
}

/** Common per-user `claude` install locations on macOS/Linux, checked when the
 *  daemon's (systemd/launchd) PATH is too sparse to contain `claude`. */
function getUnixClaudeInstallCandidates(): string[] {
  const home = process.env.HOME;
  return uniqueNonEmpty([
    home ? path.join(home, '.local', 'bin', 'claude') : undefined,
    home ? path.join(home, '.claude', 'local', 'claude') : undefined,
    home ? path.join(home, '.npm-global', 'bin', 'claude') : undefined,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]);
}

/** Binary-specific extras beyond the generic package/version-manager
 *  directories every CLI might land in — e.g. an installer that also drops a
 *  copy under a tool-named XDG-ish path (`~/.claude/local/claude`), which
 *  isn't a location any OTHER CLI would plausibly use. */
export interface CliInstallCandidateOptions {
  /** Extra HOME-relative paths, already including the binary name, e.g.
   *  `['.claude/local/claude']`. */
  extraHomeRelative?: string[];
  /** Extra absolute paths, already including the binary name. */
  extraAbsolute?: string[];
}

/** Common per-user/system CLI install locations on macOS/Linux, checked when
 *  the daemon's (systemd/launchd) PATH is too sparse to contain `binaryName`
 *  — a daemon started by systemd/launchd inherits none of a login shell's rc
 *  files, so PATH alone cannot be trusted to contain any of these. Shared
 *  across every agent CLI we spawn (claude, codex, ...): the package/version
 *  manager directory shape is identical for all of them, only the binary
 *  name (and the rare tool-specific extra location, see
 *  `CliInstallCandidateOptions`) changes. */
export function getUnixCliInstallCandidates(binaryName: string, options: CliInstallCandidateOptions = {}): string[] {
  const home = process.env.HOME;
  return uniqueNonEmpty([
    home ? path.join(home, '.local', 'bin', binaryName) : undefined,
    home ? path.join(home, '.npm-global', 'bin', binaryName) : undefined,
    home ? path.join(home, 'bin', binaryName) : undefined, // XDG user bin
    home ? path.join(home, '.bun', 'bin', binaryName) : undefined,
    home ? path.join(home, '.cargo', 'bin', binaryName) : undefined,
    home ? path.join(home, '.yarn', 'bin', binaryName) : undefined,
    home ? path.join(home, '.asdf', 'shims', binaryName) : undefined,
    // Native-installer-style XDG data variant. Deliberately shallow: this
    // does not enumerate version dirs.
    home ? path.join(home, '.local', 'share', binaryName, binaryName) : undefined,
    ...(home ? (options.extraHomeRelative ?? []).map((rel) => path.join(home, rel)) : []),
    path.join('/usr/local/bin', binaryName),
    path.join('/opt/homebrew/bin', binaryName),
    path.join('/opt', binaryName, 'bin', binaryName),
    path.join('/snap/bin', binaryName),
    path.join('/var/lib/snapd/snap/bin', binaryName),
    path.join('/nix/var/nix/profiles/default/bin', binaryName),
    ...(options.extraAbsolute ?? []),
  ]);
}

/** Last-resort fallback: walk PATH directories looking for an executable
 *  file named `binaryName`, for hosts where the CLI lives somewhere
 *  PATH-manageable (a custom install dir, a version-manager shim directory
 *  not covered above) that isn't in the fixed per-user candidate list.
 *  Unix-only — Windows has its own PATH+PATHEXT walker
 *  (`resolveBinaryOnWindows`) because it also needs extension matching. */
export function walkPathForBinary(binaryName: string, pathEnv = process.env.PATH): string | undefined {
  if (!pathEnv) return undefined;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binaryName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Options for {@link resolveCliPathForSdk}; every field is optional so a
 *  CLI with no bundled binary and no Windows-specific install dirs (e.g.
 *  codex, today) can still get candidate-list + PATH-walk + env-override
 *  hardening for free. */
export interface ResolveCliPathOptions {
  /** Env var checked before any resolution when `name` is still the
   *  default, e.g. `'IMCODES_CODEX_BINARY_PATH'`. Omit to skip this tier. */
  envOverrideVar?: string;
  /** Passed through to {@link getUnixCliInstallCandidates}. */
  candidateOptions?: CliInstallCandidateOptions;
  /** Locate a binary bundled inside our own dependency tree, checked before
   *  the fixed per-user candidates (mirrors `resolveBundledClaudeBinary`). */
  resolveBundled?: () => string | undefined;
  /** Windows-specific install directories for this binary, beyond the
   *  generic PATH+PATHEXT walk `resolveBinaryOnWindows` already does. */
  windowsCandidates?: (name: string) => string[];
}

/** Generic form of {@link resolveClaudeCodePathForSdk} for any CLI binary we
 *  spawn programmatically (no shell) from a systemd/launchd-started daemon.
 *  Precedence, highest first: explicit caller-provided name/path → env
 *  override (default name only, both platforms) → Windows-specific dirs →
 *  bundled binary → fixed per-user/system candidates → PATH walk → bare
 *  name. See `resolveClaudeCodePathForSdk`'s doc comment for the full
 *  rationale; this only generalizes the *mechanism*, not the specific
 *  per-binary knowledge (bundled-binary lookup, Windows install dirs, extra
 *  candidate paths) — that comes from `options`. */
export function resolveCliPathForSdk(binaryName: string, name = binaryName, options: ResolveCliPathOptions = {}): string {
  if (name === binaryName && options.envOverrideVar) {
    const override = process.env[options.envOverrideVar];
    if (override && existsSync(override)) return override;
  }
  if (process.platform === 'win32') {
    const resolved = resolveBinaryWithWindowsFallbacks(name, options.windowsCandidates?.(name) ?? []);
    if (/\.(cmd|bat)$/i.test(resolved)) {
      return parseNpmCmdShim(resolved) ?? resolved;
    }
    return resolved;
  }
  if (name !== binaryName) return name;
  const bundled = options.resolveBundled?.();
  if (bundled) return bundled;
  for (const candidate of getUnixCliInstallCandidates(binaryName, options.candidateOptions)) {
    if (existsSync(candidate)) return candidate;
  }
  return walkPathForBinary(name) ?? name;
}

/** Env var an operator can set (e.g. a systemd unit's `Environment=`) to pin
 *  the codex binary path, for the same reason `IMCODES_CLAUDE_BINARY_PATH`
 *  exists — a daemon-wide override that doesn't require touching every
 *  session's config. Per-binary (not a single shared "IMCODES_AGENT_..."
 *  variable) because a deployment may need to pin different binaries to
 *  different paths at once; a single shared variable could only ever name
 *  one of them. */
export const IMCODES_CODEX_BINARY_PATH_ENV = 'IMCODES_CODEX_BINARY_PATH';

/** Resolve a `codex` binary path for programmatic (no-shell) spawning —
 *  see `codex-sdk.ts`'s `connect()`/`startAppServer()`, which previously
 *  passed a bare `'codex'` straight to `child_process.spawn()` and hit the
 *  exact "spawn ENOENT" failure `resolveClaudeCodePathForSdk` already fixed
 *  for claude on a sparse-PATH systemd/launchd daemon.
 *
 *  Unlike claude, this does NOT attempt to resolve a bundled binary out of
 *  `@openai/codex-<platform>-<arch>`: that package nests the real binary
 *  under a Rust target-triple directory (e.g.
 *  `vendor/aarch64-apple-darwin/bin/codex`) whose naming this repo can only
 *  verify on the one platform it happens to run tests on. Guessing the
 *  triple for every platform risked shipping a silently wrong path, which is
 *  worse than the pre-existing behavior; the candidate-list + PATH-walk
 *  tiers below are the actual fix for the sparse-PATH bug and carry no such
 *  risk. Revisit if/when the triple mapping is verified for every supported
 *  platform. */
export function resolveCodexPathForSdk(name = 'codex'): string {
  return resolveCliPathForSdk('codex', name, { envOverrideVar: IMCODES_CODEX_BINARY_PATH_ENV });
}

/** Resolve `claude` to an absolute path suitable for embedding directly into
 *  a shell command string (see `ClaudeCodeDriver.buildLaunchCommand`), as
 *  opposed to `resolveClaudeCodePathForSdk`'s target of a no-shell
 *  `child_process.spawn` call.
 *
 *  Deliberately narrower than `resolveClaudeCodePathForSdk`:
 *  - No bundled-binary preference: an interactive session should keep
 *    running whatever `claude` the user actually has installed (their own
 *    version, any wrapper/shim/version-manager they rely on), not silently
 *    switch to the version pinned inside our own SDK dependency just
 *    because it happens to exist.
 *  - Windows/ConPTY: returns the bare name unchanged. A resolved Windows
 *    path is often a `.cmd` shim or an extracted `(node, script.js)` pair
 *    (see `resolveExecutableForSpawn`) — neither embeds into a plain
 *    command string the same simple way an absolute Unix binary path does,
 *    and the sparse-PATH bug this hardens against was systemd/launchd-
 *    specific (Unix). A typed `claude` command still resolves through the
 *    interactive shell's own PATH here, exactly as before this change.
 *
 *  Falls through to the bare name whenever nothing resolves, which
 *  reproduces the exact pre-hardening command string — an existing user
 *  whose interactive shell already resolves `claude` fine sees no change. */
export function resolveClaudeCodePathForTmux(name = 'claude'): string {
  if (process.platform === 'win32') return name;
  return resolveCliPathForSdk('claude', name, {
    envOverrideVar: 'IMCODES_CLAUDE_BINARY_PATH',
    candidateOptions: { extraHomeRelative: [path.join('.claude', 'local', 'claude')] },
  });
}

/** Locate the native `claude` binary that ships inside our own
 *  `@anthropic-ai/claude-agent-sdk` dependency. The SDK publishes the binary in
 *  a platform-specific sibling package (e.g. `@anthropic-ai/claude-agent-sdk-linux-x64`),
 *  so we resolve it from our dependency tree rather than trusting PATH — a daemon
 *  started by systemd/launchd has a sparse PATH that usually lacks `claude`. */
function resolveBundledClaudeBinary(): string | undefined {
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const req = createRequire(import.meta.url);
  // 1) Resolve the platform package directly.
  try {
    const pkgJson = req.resolve(`${platformPkg}/package.json`);
    const candidate = path.join(path.dirname(pkgJson), 'claude');
    if (existsSync(candidate)) return candidate;
  } catch {
    // platform package not resolvable from here — try via the main package
  }
  // 2) Resolve the main SDK, then its sibling platform package.
  try {
    const mainPkgJson = req.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const scopeDir = path.dirname(path.dirname(mainPkgJson)); // .../node_modules/@anthropic-ai
    const candidate = path.join(scopeDir, `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude');
    if (existsSync(candidate)) return candidate;
  } catch {
    // give up — caller falls back to per-user locations / PATH
  }
  return undefined;
}

/** Resolve a CLI path suitable for passing to an SDK option like
 *  `pathToClaudeCodeExecutable`.
 *
 *  Windows: npm global installs expose `claude.cmd`; SDKs that spawn the path
 *  without `shell: true` need the underlying `.js`/`.exe`, so we convert shims
 *  and search common install dirs.
 *
 *  macOS/Linux: a daemon launched by systemd/launchd has a sparse PATH that
 *  usually lacks `claude`, which made the SDK fail with "Claude Code native
 *  binary not found at claude". So for the default name we resolve the binary
 *  bundled with our `@anthropic-ai/claude-agent-sdk` dependency, then common
 *  per-user install locations, and only fall back to a bare PATH lookup last.
 *  An explicit caller-provided name/path is always honoured as-is. */
export function resolveClaudeCodePathForSdk(name = 'claude'): string {
  if (process.platform === 'win32') {
    const resolved = resolveBinaryWithWindowsFallbacks(name, getWindowsClaudeInstallCandidates(name));
    if (/\.(cmd|bat)$/i.test(resolved)) {
      return parseNpmCmdShim(resolved) ?? resolved;
    }
    return resolved;
  }
  if (name !== 'claude') return name;
  const bundled = resolveBundledClaudeBinary();
  if (bundled) return bundled;
  for (const candidate of getUnixClaudeInstallCandidates()) {
    if (existsSync(candidate)) return candidate;
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

export function terminateChildProcess(child: ChildProcess, escalationMs = 1_500): void {
  if (child.exitCode != null || child.signalCode != null) return;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const markClosed = () => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  child.once('close', markClosed);
  child.kill('SIGTERM');
  timer = setTimeout(() => {
    if (!closed) child.kill('SIGKILL');
  }, escalationMs);
  timer.unref?.();
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
