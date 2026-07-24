/**
 * Resolve the working directory a sub-session should launch in. Sub-sessions
 * belong to their parent project, so when the creator supplied no usable cwd we
 * inherit the parent session's project directory (then any previously persisted
 * one). Without this the shell/agent launches in the terminal backend's default
 * directory — "/" under tmux, the daemon's cwd under ConPTY — instead of the
 * project. Returns undefined only when nothing usable is available.
 *
 * Kept in its own dependency-free module so command-handler (and anyone else)
 * can import it without pulling in the heavy subsession-manager runtime, which
 * many tests replace with a mock — a mock that omits this pure helper would
 * otherwise make callers throw.
 */
export function resolveSubSessionCwd(
  ownCwd: string | null | undefined,
  parentProjectDir: string | null | undefined,
  storedProjectDir?: string | null | undefined,
): string | undefined {
  const usable = (value: string | null | undefined): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;
  return usable(ownCwd) ?? usable(parentProjectDir) ?? usable(storedProjectDir);
}
