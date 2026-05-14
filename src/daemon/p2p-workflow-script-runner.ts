/**
 * Daemon-side runner for P2P workflow script nodes (tasks 7.2 – 7.12).
 *
 * spec.md "Script nodes SHALL use structured contracts and safe machine output":
 *   - argv-only spawn (no shell) — Scenario "Script command is argv-only"
 *   - executable allowlist enforcement — Scenario "Bind enforces full daemon
 *     static policy authority" (`script_executable_denied`)
 *   - interpreter capability check — Scenario "Interpreter script requires
 *     interpreter capability"
 *   - cwd = repo root, env from allowlist, PATH default empty —
 *     Scenario "Script runtime environment is constrained"
 *   - stdin / stdout / stderr / machineOutput byte caps with utf-8-safe
 *     truncation — Scenario "Script runtime environment is constrained"
 *   - NDJSON `p2p_script_machine_output_v1` parsing — Scenario "Machine
 *     output frame is authoritative"
 *   - timeout + AbortSignal cancellation with process-group SIGTERM→SIGKILL
 *     escalation — Scenario "Script cancellation terminates the process group"
 *   - display output (raw stdout/stderr) is non-authoritative; only the
 *     parsed `finalFrame` drives routing/variables/artifacts
 *
 * design.md §"Script Node Execution":
 *   - argv-only by default
 *   - cwd is repo root
 *   - stdin cap defaults to 64 KiB
 *   - SIGTERM with up to 5 s grace, then SIGKILL
 *
 * This runner is permission-scope-agnostic. Bind-time policy enforcement is
 * handled by `validateCompiledWorkflowAgainstBindPolicy` in
 * `src/daemon/p2p-workflow-bind.ts` (e.g. rejecting implementation-permission
 * nodes when `policy.allowImplementationPermission` is false). The runner
 * here only enforces the executable / env / cap contract.
 *
 * NOTE: callers must pair every successful run with `releaseScriptSlot()` if
 * they acquired one — see `src/daemon/p2p-workflow-script-concurrency.ts`.
 * Slot acquisition is intentionally NOT done in this file so the caller can
 * fail fast on `daemon_busy` before constructing runner inputs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from '../../shared/p2p-workflow-diagnostics.js';
import {
  DEFAULT_P2P_SCRIPT_CAPS,
  DEFAULT_P2P_SCRIPT_MACHINE_OUTPUT_FRAME_MAX_BYTES,
  parseP2pScriptMachineOutput,
  type P2pScriptMachineOutputParseResult,
} from '../../shared/p2p-workflow-script.js';
import type { P2pScriptNodeContract, P2pStaticPolicy } from '../../shared/p2p-workflow-types.js';
import { P2P_SCRIPT_MACHINE_OUTPUT_KIND } from '../../shared/p2p-workflow-constants.js';

export interface RunP2pScriptNodeArgs {
  script: P2pScriptNodeContract;
  policy: P2pStaticPolicy;
  repoRoot: string;
  runId: string;
  nodeId: string;
  signal?: AbortSignal;
}

export interface RunP2pScriptNodeResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: { stdout: boolean; stderr: boolean; machineOutput: boolean };
  /** Only populated when the script's caps allow machine-output collection
   *  AND `requireFrameKind` (i.e. the contract asked for structured frames).
   *  Spec: stdout buffer is the SAME source the parser walks; only the
   *  parsed `finalFrame` may drive routing/variables/artifacts. */
  machineOutput?: P2pScriptMachineOutputParseResult;
  diagnostics: P2pWorkflowDiagnostic[];
}

/** Default grace period before SIGKILL escalation. design.md "up to 5 seconds". */
const DEFAULT_SIGKILL_ESCALATION_MS = 5_000;

/** Internal spawn outcome. Bridges between Node child_process events and
 *  our return type. `signal` is null when no signal was used to terminate. */
interface ChildExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

const isWindows = process.platform === 'win32';
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/** Slice a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 *  multi-byte character. Mirrors the helper in `shared/p2p-workflow-script.ts`. */
function byteSlice(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const encoded = TEXT_ENCODER.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let decoded = TEXT_DECODER.decode(encoded.slice(0, maxBytes));
  while (decoded.endsWith('�')) decoded = decoded.slice(0, -1);
  return decoded;
}

function byteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

/**
 * R3 v1b follow-up — Names that MUST NEVER reach the script's spawn env,
 * even if the workflow author allowlists them. These are dynamic-loader
 * / interpreter hooks that let an attacker subvert the process before
 * `argv[0]` runs (`LD_PRELOAD` ⇒ inject shared object;
 * `DYLD_INSERT_LIBRARIES` ⇒ macOS analogue; `NODE_OPTIONS` ⇒ inject node
 * `--require`; etc). Hardening is unconditional — the allowlist is a
 * convenience for benign envs, not an authority over loader hooks.
 */
export const P2P_SCRIPT_ENV_DENYLIST = [
  // dynamic loader hooks (Linux ld.so / macOS dyld)
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  // language runtime hooks
  'NODE_OPTIONS',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5LIB',
  'PERL5OPT',
  'RUBYOPT',
  'RUBYLIB',
  'LUA_PATH',
  'LUA_CPATH',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'PSModulePath',
  // shell hooks (R3 v2 PR-ζ M4 / O3)
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PROMPT_COMMAND',
  'IFS',
  // package source overrides
  'PIP_INDEX_URL',
  'npm_config_registry',
  // git internals (CVE-attack-surface)
  'GIT_EXEC_PATH',
] as const;

/**
 * Build the spawn env from `script.envAllowlist`. Each allowed name is
 * copied from `process.env` only if present AND not in the deny-list.
 * `PATH` defaults to '' unless explicitly allowlisted.
 *
 * spec.md "Script runtime environment is constrained": `PATH` SHALL be empty
 * or fixed minimal; environment variables SHALL come only from an allowlist;
 * dynamic-loader hooks SHALL NEVER be inherited.
 *
 * NEVER passes `process.env` wholesale.
 */
export function buildScriptSpawnEnv(envAllowlist: readonly string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  const allowlist = new Set(envAllowlist ?? []);
  const denylist = new Set<string>(P2P_SCRIPT_ENV_DENYLIST);
  for (const name of allowlist) {
    if (denylist.has(name)) continue; // hardened: deny-list wins over allowlist
    const value = process.env[name];
    if (typeof value === 'string') env[name] = value;
  }
  // PATH is always present (potentially empty) so child resolves nothing
  // implicitly through PATH lookup. argv[0] must be an absolute or
  // repo-relative path validated by the bind layer's executable allowlist.
  if (!('PATH' in env)) env.PATH = '';
  return env;
}

/** Validate `script.argv[0]` (or `script.interpreter`) against the daemon
 *  static policy. Returns a diagnostic if execution is not authorised, else
 *  `null` (caller proceeds with spawn).
 *
 *  NOTE: bind-time `validateCompiledWorkflowAgainstBindPolicy` SHOULD already
 *  have caught these — but the runner re-checks at execute time so a future
 *  policy downgrade between bind and spawn is still fail-closed. */
function checkExecutablePolicy(
  script: P2pScriptNodeContract,
  policy: P2pStaticPolicy,
  runId: string,
  nodeId: string,
): P2pWorkflowDiagnostic | null {
  // Interpreter capability check first — design.md "interpreter execution is
  // a DISTINCT security boundary from argv execution".
  if (script.commandKind === 'interpreter' && !policy.allowInterpreterScripts) {
    return makeP2pWorkflowDiagnostic('script_executable_denied', 'execute', {
      runId,
      nodeId,
      fieldPath: 'script.commandKind',
      summary: 'Daemon policy does not allow interpreter scripts.',
    });
  }
  const executable = script.commandKind === 'interpreter'
    ? script.interpreter
    : script.argv[0];
  if (!executable) {
    return makeP2pWorkflowDiagnostic('script_executable_denied', 'execute', {
      runId,
      nodeId,
      fieldPath: 'script.argv[0]',
      summary: 'Script command is missing an executable.',
    });
  }
  // Empty allowlist means "no script execution permitted" (v1a fail-closed
  // default until daemon explicitly configures executables).
  const allowed = new Set(policy.allowedExecutables);
  if (!allowed.has(executable)) {
    return makeP2pWorkflowDiagnostic('script_executable_denied', 'execute', {
      runId,
      nodeId,
      fieldPath: 'script.argv[0]',
      summary: `Executable ${executable} is not allowlisted by daemon policy.`,
    });
  }
  return null;
}

/** Validate that `repoRoot` exists and is a directory. realpath is used so
 *  the runner refuses to spawn into a symlink target that no longer points to
 *  a real directory. */
async function validateRepoRoot(
  repoRoot: string,
  runId: string,
  nodeId: string,
): Promise<{ ok: true; resolved: string } | { ok: false; diagnostic: P2pWorkflowDiagnostic }> {
  try {
    const resolved = await realpath(repoRoot);
    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      return {
        ok: false,
        diagnostic: makeP2pWorkflowDiagnostic('invalid_script_contract', 'bind', {
          runId,
          nodeId,
          fieldPath: 'bindContext.repoRoot',
          summary: `repoRoot ${repoRoot} is not a directory.`,
        }),
      };
    }
    return { ok: true, resolved };
  } catch (error) {
    return {
      ok: false,
      diagnostic: makeP2pWorkflowDiagnostic('invalid_script_contract', 'bind', {
        runId,
        nodeId,
        fieldPath: 'bindContext.repoRoot',
        summary: `repoRoot ${repoRoot} could not be resolved: ${(error as Error).message ?? String(error)}.`,
      }),
    };
  }
}

/** Compute spawn args. For `commandKind === 'argv'`, executable is `argv[0]`
 *  and args are `argv.slice(1)`. For `commandKind === 'interpreter'`,
 *  executable is `script.interpreter` and args are the full `argv` (which
 *  presumably includes the script path the interpreter should run). */
function deriveSpawnCommand(script: P2pScriptNodeContract): { executable: string; args: string[] } {
  if (script.commandKind === 'interpreter') {
    return { executable: script.interpreter ?? '', args: [...script.argv] };
  }
  return { executable: script.argv[0]!, args: script.argv.slice(1) };
}

/** Append data to a buffer up to `maxBytes`. Returns whether the buffer was
 *  truncated. UTF-8-safe — multi-byte characters are not split. */
function appendCapped(
  buffer: { value: string; byteCount: number },
  chunk: string,
  maxBytes: number,
): boolean {
  if (buffer.byteCount >= maxBytes) return true;
  const chunkBytes = byteLength(chunk);
  if (buffer.byteCount + chunkBytes <= maxBytes) {
    buffer.value += chunk;
    buffer.byteCount += chunkBytes;
    return false;
  }
  const remaining = maxBytes - buffer.byteCount;
  const sliced = byteSlice(chunk, remaining);
  buffer.value += sliced;
  buffer.byteCount += byteLength(sliced);
  return true;
}

/** Send SIGTERM to the process group on POSIX, falling back to single-pid
 *  on Windows (no process group concept). Errors are swallowed because the
 *  child may already be dead. */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (!isWindows && typeof child.pid === 'number' && child.pid > 0) {
      // process.kill(-pid, signal) targets the entire process group.
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Child already exited; nothing to do.
  }
}

/** Run a P2P script node end-to-end (argv-only spawn, env allowlist,
 *  stdin/stdout/stderr caps, machine-output parsing, timeout/cancel with
 *  process-group SIGTERM→SIGKILL escalation).
 *
 *  This function never throws — all failures land in `diagnostics` and the
 *  result's `ok` flag.
 *
 *  Concurrency note: callers MUST acquire/release `acquireScriptSlot` /
 *  `releaseScriptSlot` from `src/daemon/p2p-workflow-script-concurrency.ts`
 *  themselves (see header comment). */
export async function runP2pScriptNode(args: RunP2pScriptNodeArgs): Promise<RunP2pScriptNodeResult> {
  const { script, policy, repoRoot, runId, nodeId, signal } = args;
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const caps = {
    stdinBytes: script.caps?.stdinBytes ?? DEFAULT_P2P_SCRIPT_CAPS.stdinBytes,
    stdoutBytes: script.caps?.stdoutBytes ?? DEFAULT_P2P_SCRIPT_CAPS.stdoutBytes,
    stderrBytes: script.caps?.stderrBytes ?? DEFAULT_P2P_SCRIPT_CAPS.stderrBytes,
    machineOutputBytes: script.caps?.machineOutputBytes ?? DEFAULT_P2P_SCRIPT_CAPS.machineOutputBytes,
  };

  // ── 1. Executable / interpreter policy enforcement (audit:R3 PR-β / V-6)
  const denyDiagnostic = checkExecutablePolicy(script, policy, runId, nodeId);
  if (denyDiagnostic) {
    diagnostics.push(denyDiagnostic);
    return failClosedResult(diagnostics);
  }

  // ── 2. Repo root validation
  const repoResult = await validateRepoRoot(repoRoot, runId, nodeId);
  if (!repoResult.ok) {
    diagnostics.push(repoResult.diagnostic);
    return failClosedResult(diagnostics);
  }
  const cwd = repoResult.resolved;

  // ── 3. Build spawn args + env
  const { executable, args: spawnArgs } = deriveSpawnCommand(script);
  const env = buildScriptSpawnEnv(script.envAllowlist);

  // ── 4. Spawn (argv-only — shell flag MUST be false)
  let child: ChildProcess;
  try {
    child = spawn(executable, spawnArgs, {
      cwd,
      env,
      // detached:true on POSIX so a process group exists and we can SIGTERM
      // the entire group via `process.kill(-pid, ...)`. Windows has no
      // process group concept; child.kill() targets the single process.
      detached: !isWindows,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Critical: shell MUST be false. Audit reverse-regression guard #29.
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    diagnostics.push(makeP2pWorkflowDiagnostic('script_executable_denied', 'execute', {
      runId,
      nodeId,
      fieldPath: 'script.argv[0]',
      summary: `Failed to spawn ${executable}: ${(error as Error).message ?? String(error)}.`,
    }));
    return failClosedResult(diagnostics);
  }

  // ── 5. Wire stdin (capped, utf-8-safe)
  if (typeof script.stdin === 'string' && child.stdin) {
    const stdinPayload = byteSlice(script.stdin, caps.stdinBytes);
    try {
      child.stdin.write(stdinPayload);
    } catch {
      // child stdin may already be closed; ignore.
    }
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
  } else if (child.stdin) {
    try { child.stdin.end(); } catch { /* ignore */ }
  }

  // ── 6. Buffered stdout/stderr capture with caps
  const stdout = { value: '', byteCount: 0 };
  const stderr = { value: '', byteCount: 0 };
  const truncated = { stdout: false, stderr: false, machineOutput: false };

  if (child.stdout) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      if (appendCapped(stdout, chunk, caps.stdoutBytes)) truncated.stdout = true;
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      if (appendCapped(stderr, chunk, caps.stderrBytes)) truncated.stderr = true;
    });
  }

  // ── 7. Wait for exit, with timeout + AbortSignal cooperative cancel +
  //      process-group SIGTERM→SIGKILL escalation.
  const exit: ChildExit = await waitForChild(child, {
    timeoutMs: script.timeoutMs,
    signal,
    diagnostics,
    runId,
    nodeId,
  });

  // ── 8. Parse machine output ONLY if the contract demands structured frames.
  //      Spec: stdout/stderr are display-only; ONLY the parsed final frame
  //      drives routing/variables/artifacts.
  let machineOutput: P2pScriptMachineOutputParseResult | undefined;
  if (script.requiredMachineOutput) {
    machineOutput = parseP2pScriptMachineOutput(stdout.value, {
      mode: 'lenient_last_valid',
      maxTotalBytes: caps.machineOutputBytes,
      maxFrameBytes: DEFAULT_P2P_SCRIPT_MACHINE_OUTPUT_FRAME_MAX_BYTES,
    });
    truncated.machineOutput = Boolean(machineOutput.truncated);
    diagnostics.push(...machineOutput.diagnostics);
    if (!machineOutput.ok && !diagnostics.some((d) => d.code === 'script_machine_output_invalid' && d.severity === 'error')) {
      // Defensive — parse helper already emits diagnostics, but make sure a
      // failed required parse becomes ok:false.
    }
  }

  // ── 9. Surface spawn errors (e.g. ENOENT, EACCES) as diagnostics.
  if (exit.spawnError) {
    diagnostics.push(makeP2pWorkflowDiagnostic('script_executable_denied', 'execute', {
      runId,
      nodeId,
      fieldPath: 'script.argv[0]',
      summary: `Spawn error: ${exit.spawnError.message}.`,
    }));
  }

  const ok = exit.spawnError == null
    && exit.signal == null
    && exit.exitCode === 0
    && (script.requiredMachineOutput ? Boolean(machineOutput?.ok) : true)
    && !diagnostics.some((d) => d.severity === 'error');

  return {
    ok,
    exitCode: exit.exitCode,
    signal: exit.signal,
    stdoutBytes: stdout.byteCount,
    stderrBytes: stderr.byteCount,
    truncated,
    ...(machineOutput ? { machineOutput } : {}),
    diagnostics,
  };
}

/** Wait for the child to exit, honoring `script.timeoutMs` and the caller's
 *  `AbortSignal`. On timeout/cancel, SIGTERM the process group, wait up to
 *  `DEFAULT_SIGKILL_ESCALATION_MS`, then SIGKILL. */
function waitForChild(
  child: ChildProcess,
  options: {
    timeoutMs: number | undefined;
    signal: AbortSignal | undefined;
    diagnostics: P2pWorkflowDiagnostic[];
    runId: string;
    nodeId: string;
  },
): Promise<ChildExit> {
  return new Promise<ChildExit>((resolve) => {
    let settled = false;
    let spawnError: Error | undefined;

    const finalize = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, signal, ...(spawnError ? { spawnError } : {}) });
    };

    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (abortListener && options.signal) {
        try { options.signal.removeEventListener('abort', abortListener); } catch { /* ignore */ }
      }
    };

    const escalateToKill = () => {
      // Already SIGTERMed; if child is still alive after grace period,
      // SIGKILL the process group.
      killProcessGroup(child, 'SIGKILL');
    };

    const triggerTermination = (reason: 'timeout' | 'cancelled') => {
      if (settled) return;
      const code = reason === 'timeout' ? 'script_timeout' : 'script_cancelled';
      options.diagnostics.push(makeP2pWorkflowDiagnostic(code, 'execute', {
        runId: options.runId,
        nodeId: options.nodeId,
        summary: reason === 'timeout'
          ? `Script exceeded ${options.timeoutMs} ms timeout; SIGTERM sent to process group.`
          : 'Script cancelled by AbortSignal; SIGTERM sent to process group.',
      }));
      killProcessGroup(child, 'SIGTERM');
      // Schedule SIGKILL escalation if the child does not exit gracefully.
      killTimer = setTimeout(escalateToKill, DEFAULT_SIGKILL_ESCALATION_MS);
      // Allow the unref so the test process can exit even if the child is
      // somehow still alive after SIGKILL (it shouldn't be — but defensive).
      try { (killTimer as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => triggerTermination('timeout'), options.timeoutMs);
      try { (timeoutTimer as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
    }

    if (options.signal) {
      if (options.signal.aborted) {
        // Already cancelled before we got here — terminate immediately.
        triggerTermination('cancelled');
      } else {
        abortListener = () => triggerTermination('cancelled');
        try { options.signal.addEventListener('abort', abortListener, { once: true }); } catch { /* ignore */ }
      }
    }

    child.on('error', (err) => {
      spawnError = err;
      // 'error' is emitted before 'exit' on spawn failures; ensure we resolve.
      finalize(null, null);
    });

    // Use 'close' rather than 'exit': 'exit' fires when the child process
    // terminates, but stdio streams may still be draining (especially under
    // heavy stdout). 'close' fires after all stdio streams have been closed,
    // so any data listeners on stdout/stderr have observed the full output.
    child.on('close', (code, signal) => {
      finalize(code, signal);
    });
  });
}

function failClosedResult(diagnostics: P2pWorkflowDiagnostic[]): RunP2pScriptNodeResult {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: { stdout: false, stderr: false, machineOutput: false },
    diagnostics,
  };
}

/** Re-export the machine-output kind so callers can compare frame kinds
 *  without re-importing constants directly. */
export { P2P_SCRIPT_MACHINE_OUTPUT_KIND };
