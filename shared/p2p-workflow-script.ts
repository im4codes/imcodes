import {
  P2P_SCRIPT_DEFAULT_MACHINE_OUTPUT_MAX_BYTES,
  P2P_SCRIPT_DEFAULT_STDERR_MAX_BYTES,
  P2P_SCRIPT_DEFAULT_STDIN_MAX_BYTES,
  P2P_SCRIPT_DEFAULT_STDOUT_MAX_BYTES,
  P2P_WORKFLOW_MAX_VARIABLE_BYTES,
  P2P_SCRIPT_MACHINE_OUTPUT_KIND,
} from './p2p-workflow-constants.js';
import { makeP2pWorkflowDiagnostic, makeP2pWorkflowWarning, type P2pWorkflowDiagnostic } from './p2p-workflow-diagnostics.js';
import type { P2pScriptMachineOutputFrame, P2pScriptNodeContract, P2pWorkflowVariableValue } from './p2p-workflow-types.js';
import { isP2pArtifactRelativePath } from './p2p-workflow-artifacts.js';

export type P2pScriptContractValidationResult =
  | { ok: true; contract: P2pScriptNodeContract; diagnostics: P2pWorkflowDiagnostic[] }
  | { ok: false; diagnostics: P2pWorkflowDiagnostic[] };

export type P2pScriptMachineOutputParseResult =
  | { ok: true; frames: P2pScriptMachineOutputFrame[]; finalFrame: P2pScriptMachineOutputFrame; diagnostics: P2pWorkflowDiagnostic[]; truncated?: boolean }
  | { ok: false; diagnostics: P2pWorkflowDiagnostic[]; truncated?: boolean };

export type P2pScriptMachineOutputParseMode = 'lenient_last_valid' | 'strict';

export interface P2pScriptMachineOutputParseOptions {
  mode?: P2pScriptMachineOutputParseMode;
  maxTotalBytes?: number;
  maxFrameBytes?: number;
  requiredFields?: Array<'routingKey' | 'variables' | 'artifacts'>;
}

export const DEFAULT_P2P_SCRIPT_CAPS: Required<NonNullable<P2pScriptNodeContract['caps']>> = {
  stdinBytes: P2P_SCRIPT_DEFAULT_STDIN_MAX_BYTES,
  stdoutBytes: P2P_SCRIPT_DEFAULT_STDOUT_MAX_BYTES,
  stderrBytes: P2P_SCRIPT_DEFAULT_STDERR_MAX_BYTES,
  machineOutputBytes: P2P_SCRIPT_DEFAULT_MACHINE_OUTPUT_MAX_BYTES,
};

export const DEFAULT_P2P_SCRIPT_MACHINE_OUTPUT_FRAME_MAX_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Slice a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 * multi-byte character. Used by lenient mode to truncate machine output
 * before walking back to the last `\n` boundary.
 */
function byteSlice(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  // Decode the prefix; TextDecoder's non-fatal mode returns U+FFFD for any
  // partial multi-byte sequence at the tail. We then strip the trailing
  // replacement character so a downstream `lastIndexOf('\n')` is unaffected.
  let decoded = decoder.decode(encoded.slice(0, maxBytes));
  while (decoded.endsWith('�')) decoded = decoded.slice(0, -1);
  return decoded;
}

export function validateP2pScriptContract(input: unknown, fieldPath = 'script'): P2pScriptContractValidationResult {
  if (!isRecord(input)) return invalidScriptContract(fieldPath);

  const commandKind = input.commandKind ?? 'argv';
  if (commandKind !== 'argv' && commandKind !== 'interpreter') {
    return invalidScriptContract(`${fieldPath}.commandKind`);
  }
  if (!Array.isArray(input.argv) || input.argv.length === 0 || typeof input.argv[0] !== 'string' || input.argv[0] === '') {
    return invalidScriptContract(`${fieldPath}.argv`);
  }
  if (input.argv.some((entry) => typeof entry !== 'string')) {
    return invalidScriptContract(`${fieldPath}.argv`);
  }
  if (commandKind === 'interpreter' && (typeof input.interpreter !== 'string' || input.interpreter === '')) {
    return invalidScriptContract(`${fieldPath}.interpreter`);
  }

  const caps = normalizeScriptCaps(input.caps);
  if (!caps) return invalidScriptContract(`${fieldPath}.caps`);
  if (typeof input.stdin === 'string' && byteLength(input.stdin) > caps.stdinBytes) {
    return invalidScriptContract(`${fieldPath}.stdin`);
  }
  if (Array.isArray(input.envAllowlist) && !input.envAllowlist.every((entry) => isSafeEnvironmentName(entry))) {
    return invalidScriptContract(`${fieldPath}.envAllowlist`);
  }
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    return invalidScriptContract(`${fieldPath}.timeoutMs`);
  }

  const contract: P2pScriptNodeContract = {
    commandKind,
    argv: [...input.argv],
    ...(commandKind === 'interpreter' ? { interpreter: input.interpreter as string } : {}),
    ...(typeof input.stdin === 'string' ? { stdin: input.stdin } : {}),
    ...(Array.isArray(input.envAllowlist) && input.envAllowlist.every((entry) => typeof entry === 'string') ? { envAllowlist: [...input.envAllowlist] } : {}),
    ...(typeof input.requiredMachineOutput === 'boolean' ? { requiredMachineOutput: input.requiredMachineOutput } : {}),
    ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    caps,
  };
  return { ok: true, contract, diagnostics: [] };
}

export function parseP2pScriptMachineOutput(
  input: string,
  options: P2pScriptMachineOutputParseOptions = {},
): P2pScriptMachineOutputParseResult {
  const mode = options.mode ?? 'lenient_last_valid';
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_P2P_SCRIPT_CAPS.machineOutputBytes;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_P2P_SCRIPT_MACHINE_OUTPUT_FRAME_MAX_BYTES;
  const totalBytes = byteLength(input);
  // Audit:R3 PR-β / M-3 / V-2 — over-cap behavior depends on mode:
  //  - strict: reject the entire run (preserves "all frames must validate"
  //    invariant). Long-running streaming scripts must opt out of strict.
  //  - lenient_last_valid: TRUNCATE at the last `\n` boundary <= cap and
  //    continue parsing; emit `truncated: true`. Truncating at byte cap
  //    would split a frame mid-JSON; line-boundary truncation preserves
  //    parser invariants. spec.md §Server / web size limits clause.
  let truncated = false;
  let parseInput = input;
  if (totalBytes > maxTotalBytes) {
    if (mode === 'strict') {
      return invalidMachineOutput(`machine output exceeds total byte cap (${totalBytes}/${maxTotalBytes}).`);
    }
    // Lenient: byte-truncate first, then walk back to last `\n` boundary so
    // we never split a JSON frame. If no newline exists below cap, drop all
    // input (no valid frames could have completed before the cap).
    const truncatedBytes = byteSlice(input, maxTotalBytes);
    const lastNewline = truncatedBytes.lastIndexOf('\n');
    parseInput = lastNewline >= 0 ? truncatedBytes.slice(0, lastNewline + 1) : '';
    truncated = true;
  }

  const frames: P2pScriptMachineOutputFrame[] = [];
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (truncated) {
    diagnostics.push(makeP2pWorkflowWarning('script_machine_output_invalid', 'execute', {
      summary: `machine output truncated at ${maxTotalBytes} bytes; some trailing frames discarded.`,
    }));
  }
  const lines = parseInput.split(/\r?\n/).filter((line) => line.trim() !== '');
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const frameBytes = byteLength(line);
    if (frameBytes > maxFrameBytes) {
      const diagnostic = machineOutputDiagnostic(`line ${lineNumber} exceeds frame byte cap (${frameBytes}/${maxFrameBytes}).`, mode);
      if (mode === 'strict') return { ok: false, diagnostics: [diagnostic] };
      diagnostics.push(diagnostic);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const diagnostic = machineOutputDiagnostic(`line ${lineNumber} is not valid JSON.`, mode);
      if (mode === 'strict') return { ok: false, diagnostics: [diagnostic] };
      diagnostics.push(diagnostic);
      continue;
    }
    if (!isP2pScriptMachineOutputFrame(parsed) || !hasRequiredFields(parsed, options.requiredFields ?? [])) {
      const diagnostic = machineOutputDiagnostic(`line ${lineNumber} is not a valid ${P2P_SCRIPT_MACHINE_OUTPUT_KIND} frame.`, mode);
      if (mode === 'strict') return { ok: false, diagnostics: [diagnostic] };
      diagnostics.push(diagnostic);
      continue;
    }
    frames.push(parsed);
  }
  const finalFrame = frames.length > 0 ? frames[frames.length - 1] : undefined;
  if (!finalFrame) {
    const result = invalidMachineOutput('no valid machine output frames were found.');
    return truncated ? { ...result, truncated: true } : result;
  }
  return truncated
    ? { ok: true, frames, finalFrame, diagnostics, truncated: true }
    : { ok: true, frames, finalFrame, diagnostics };
}

function isP2pScriptMachineOutputFrame(value: unknown): value is P2pScriptMachineOutputFrame {
  if (!isRecord(value) || value.kind !== P2P_SCRIPT_MACHINE_OUTPUT_KIND) return false;
  if (value.status !== undefined && value.status !== 'ok' && value.status !== 'fail') return false;
  if (value.routingKey !== undefined && typeof value.routingKey !== 'string') return false;
  if (value.displaySummary !== undefined && typeof value.displaySummary !== 'string') return false;
  if (value.variables !== undefined && !isVariablesRecord(value.variables)) return false;
  if (value.artifacts !== undefined && !isArtifactOutputArray(value.artifacts)) return false;
  return true;
}

function isVariablesRecord(value: unknown): value is Record<string, P2pWorkflowVariableValue> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => /^[a-z][a-z0-9_]{0,63}$/.test(key) &&
    isWorkflowVariableValue(entry) &&
    byteLength(JSON.stringify(entry)) <= P2P_WORKFLOW_MAX_VARIABLE_BYTES);
}

function isWorkflowVariableValue(value: unknown): value is P2pWorkflowVariableValue {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

function isArtifactOutputArray(value: unknown): value is P2pScriptMachineOutputFrame['artifacts'] {
  return Array.isArray(value) && value.every((entry) => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !isP2pArtifactRelativePath(entry.path)) return false;
    return entry.sha256 === undefined || typeof entry.sha256 === 'string';
  });
}

function normalizeScriptCaps(value: unknown): Required<NonNullable<P2pScriptNodeContract['caps']>> | null {
  if (value === undefined) return { ...DEFAULT_P2P_SCRIPT_CAPS };
  if (!isRecord(value)) return null;
  const caps = { ...DEFAULT_P2P_SCRIPT_CAPS };
  for (const key of Object.keys(value)) {
    if (!(key in caps)) return null;
    const capValue = value[key];
    if (!Number.isInteger(capValue) || (capValue as number) < 0) return null;
    caps[key as keyof typeof caps] = capValue as number;
  }
  return caps;
}

function isSafeEnvironmentName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value);
}

function hasRequiredFields(frame: P2pScriptMachineOutputFrame, fields: Array<'routingKey' | 'variables' | 'artifacts'>): boolean {
  return fields.every((field) => frame[field] !== undefined);
}

function invalidScriptContract(fieldPath: string): P2pScriptContractValidationResult {
  return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('invalid_script_contract', 'compile', { fieldPath })] };
}

function invalidMachineOutput(summary: string): P2pScriptMachineOutputParseResult {
  return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('script_machine_output_invalid', 'execute', { summary })] };
}

function machineOutputDiagnostic(summary: string, mode: P2pScriptMachineOutputParseMode): P2pWorkflowDiagnostic {
  return mode === 'strict'
    ? makeP2pWorkflowDiagnostic('script_machine_output_invalid', 'execute', { summary })
    : makeP2pWorkflowWarning('script_machine_output_invalid', 'execute', { summary });
}
