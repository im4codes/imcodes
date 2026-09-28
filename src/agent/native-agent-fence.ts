/**
 * Provider-side capability metadata for native-agent collaboration.
 * Native-agent calls remain available; the IM.codes pair contract is advisory
 * and never installs a provider-side deny/fence.
 *
 * A fence is decided on the path that launches, loads or sends, from the
 * daemon's authority resolver, and it is proven only from facts about the
 * live runtime: what that runtime was actually started with, or what the
 * provider itself durably recorded for the exact conversation.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  NATIVE_AGENT_ADMISSION_MODES,
  NATIVE_AGENT_FENCES,
  type NativeAgentAdmissionMode,
  type NativeAgentFence,
} from '../../shared/native-collaboration-policy.js';
import type { ProcessAgent } from './detect.js';
import { findCodexRolloutPathByUuid } from '../util/codex-rollout-path.js';
import logger from '../util/logger.js';
import type { NativeAgentFenceResolver } from './transport-provider.js';

/** Claude Code tools that start, orchestrate or hand more work to a native agent. */
export const CLAUDE_NATIVE_AGENT_TOOLS = ['Agent', 'Task', 'Workflow', 'SendMessage'] as const;

/** Copilot CLI tools that start a native agent or hand one more work. */
export const COPILOT_NATIVE_AGENT_TOOLS = ['task', 'write_agent'] as const;

/**
 * Codex features that expose native multi-agent tools. Codex fixes them per
 * THREAD when the thread is created and keeps them across every later resume;
 * neither resume config nor process flags change an existing thread.
 */
export const CODEX_NATIVE_AGENT_FEATURES = ['multi_agent', 'multi_agent_v2'] as const;

/** The per-turn value Codex records in a rollout `turn_context` for a fenced thread. */
export const CODEX_MULTI_AGENT_VERSION_DISABLED = 'disabled' as const;

/** Qwen Code native sub-agent tools (`agent`, legacy `task`). */
export const QWEN_NATIVE_AGENT_TOOLS = ['agent', 'task'] as const;

/** Qoder native sub-agent tool. */
export const QODER_NATIVE_AGENT_TOOLS = ['Agent'] as const;

/** OpenCode native sub-agent tool. */
export const OPENCODE_NATIVE_AGENT_TOOLS = ['task'] as const;

/** Gemini CLI native sub-agent tool. */
export const GEMINI_NATIVE_AGENT_TOOLS = ['invoke_agent'] as const;

export const fenceOf = (fenced: boolean): NativeAgentFence => (
  fenced ? NATIVE_AGENT_FENCES.DISABLED : NATIVE_AGENT_FENCES.PROVIDER_DEFAULT
);

/**
 * The resolver a `session_fence` provider holds. Without an installed
 * resolver the provider serves no IM.codes-managed session, so it keeps
 * defaults AND never reports a next-launch fence as proven.
 */
export class NativeAgentFenceSlot {
  private resolver: NativeAgentFenceResolver | undefined;

  constructor(private readonly providerId: string) {}

  install(resolver: NativeAgentFenceResolver): void {
    this.resolver = resolver;
  }

/** Query provider capability metadata without withholding native agent tools. */
  required(providerSessionId: string, sessionName?: string): boolean {
    const resolver = this.resolver;
    if (!resolver) return false;
    try {
      void resolver(providerSessionId, sessionName);
    } catch (error) {
      logger.warn({ provider: this.providerId, providerSessionId, error }, 'native agent fence resolver advisory failed');
    }
    return false;
  }

  /**
   * The fence of a launch that has not happened yet. It is proven only when
   * the resolver is installed and requires the fence NOW: the caller's own
   * launch/load/send path applies it before any bytes reach the agent.
   */
  nextLaunchFence(providerSessionId: string, sessionName?: string): NativeAgentFence {
    return this.resolver && this.required(providerSessionId, sessionName)
      ? NATIVE_AGENT_FENCES.DECIDED_AT_NEXT_LAUNCH
      : NATIVE_AGENT_FENCES.PROVIDER_DEFAULT;
  }
}

const ROLLOUT_READ_CHUNK_BYTES = 256 * 1024;
const ROLLOUT_MAX_SCAN_BYTES = 64 * 1024 * 1024;
/** A `turn_context` record is small; a longer line can never be one. */
const ROLLOUT_MAX_TURN_CONTEXT_LINE_BYTES = 1024 * 1024;
const TURN_CONTEXT_NEEDLE = Buffer.from('"turn_context"');

type TurnContextReading = { found: false } | { found: true; multiAgentVersion?: string };

function readTurnContextLine(line: Buffer): TurnContextReading {
  if (line.length === 0 || line.indexOf(TURN_CONTEXT_NEEDLE) < 0) return { found: false };
  try {
    const record = JSON.parse(line.toString('utf8')) as { type?: unknown; payload?: { multi_agent_version?: unknown } };
    if (record.type !== 'turn_context') return { found: false };
    const version = record.payload?.multi_agent_version;
    return { found: true, ...(typeof version === 'string' ? { multiAgentVersion: version } : {}) };
  } catch {
    return { found: false };
  }
}

/**
 * The `multi_agent_version` of the LAST `turn_context` in a Codex rollout,
 * read backwards in bounded chunks. `undefined` when no turn context carries
 * one (a thread that never ran a turn, an older CLI, an unreadable file).
 */
export async function readLastCodexTurnContextMultiAgentVersion(rolloutPath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(rolloutPath, 'r');
    const { size } = await handle.stat();
    let position = size;
    let scanned = 0;
    let carry: Buffer = Buffer.alloc(0);
    // True while `carry` holds the unread tail of an over-long line.
    let skippingLongLine = false;
    while (position > 0 && scanned < ROLLOUT_MAX_SCAN_BYTES) {
      const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      scanned += length;
      const data = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let end = data.length;
      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 0x0a) continue;
        if (skippingLongLine) {
          skippingLongLine = false;
        } else {
          const reading = readTurnContextLine(data.subarray(index + 1, end));
          if (reading.found) return reading.multiAgentVersion;
        }
        end = index;
      }
      carry = data.subarray(0, end);
      if (carry.length > ROLLOUT_MAX_TURN_CONTEXT_LINE_BYTES) {
        carry = Buffer.alloc(0);
        skippingLongLine = true;
      }
    }
    if (position === 0 && !skippingLongLine && carry.length > 0) {
      const reading = readTurnContextLine(carry);
      if (reading.found) return reading.multiAgentVersion;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The fence Codex will apply to the next turn of an EXISTING thread, from the
 * thread's own rollout. Codex keeps the multi-agent state a thread was created
 * with, so only a rollout that records `disabled` proves the fence; a missing,
 * unreadable or unfenced rollout proves nothing.
 */
export async function readCodexThreadNativeAgentFence(
  threadId: string,
  opts: { rolloutPath?: string; env?: Record<string, string | undefined> } = {},
): Promise<NativeAgentFence> {
  const rolloutPath = opts.rolloutPath ?? await findCodexRolloutPathByUuid(threadId, { env: opts.env }).catch(() => null);
  if (!rolloutPath) return NATIVE_AGENT_FENCES.PROVIDER_DEFAULT;
  const version = await readLastCodexTurnContextMultiAgentVersion(rolloutPath);
  return version === CODEX_MULTI_AGENT_VERSION_DISABLED
    ? NATIVE_AGENT_FENCES.DISABLED
    : NATIVE_AGENT_FENCES.PROVIDER_DEFAULT;
}

/** Codex thread config that withholds native multi-agent tools from a NEW thread. */
export function withCodexNativeAgentFence(config: Record<string, unknown> | undefined): Record<string, unknown> {
  // Kept as a compatibility helper for callers that still pass a capability
  // flag. The pair contract no longer mutates provider config to suppress
  // native tools.
  return { ...(config ?? {}) };
}

// ── Process (tmux / ConPTY) runtimes ────────────────────────────────────────

/**
 * How each process agent keeps native agent tools out of managed work. The
 * fence is applied as launch flags scoped to that one agent process and
 * recorded with the exact instance and runtime epoch it was launched for.
 */
export const PROCESS_NATIVE_AGENT_ADMISSION: Readonly<Record<ProcessAgent, NativeAgentAdmissionMode>> = {
  // Formerly a Claude launch-flag fence; now advisory capability metadata.
  'claude-code': NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE,
  // Formerly Codex feature flags; existing thread state remains diagnostic only.
  codex: NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE,
  // Formerly a Gemini policy file; native tools remain available.
  gemini: NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE,
  // The runtime reports capability metadata without changing provider config.
  opencode: NATIVE_AGENT_ADMISSION_MODES.UNENFORCEABLE,
  shell: NATIVE_AGENT_ADMISSION_MODES.NO_NATIVE_AGENT_TOOLS,
  script: NATIVE_AGENT_ADMISSION_MODES.NO_NATIVE_AGENT_TOOLS,
};

export function readProcessNativeAgentAdmission(agentType: string): NativeAgentAdmissionMode {
  return Object.prototype.hasOwnProperty.call(PROCESS_NATIVE_AGENT_ADMISSION, agentType)
    ? PROCESS_NATIVE_AGENT_ADMISSION[agentType as ProcessAgent]
    : NATIVE_AGENT_ADMISSION_MODES.UNENFORCEABLE;
}

/** Compatibility helper: native-agent launch flags are intentionally empty. */
export function claudeNativeAgentFenceFlag(): string {
  return '';
}

/** Compatibility helper: native-agent launch flags are intentionally empty. */
export function codexNativeAgentFenceFlags(): string {
  return '';
}

/** Advisory-only policy file retained for backwards-compatible launch plumbing. */
export const GEMINI_NATIVE_AGENT_POLICY_TOML = [
  '# Written by the IM.codes daemon for advisory telemetry only.',
  '# Native-agent calls are never denied or withheld by this file.',
  '',
].join('\n');

/** Gemini CLI's own user policy directory (`$GEMINI_CLI_HOME` or home, `.gemini/policies`). */
export function geminiUserPoliciesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GEMINI_CLI_HOME || homedir(), '.gemini', 'policies');
}

/** Write (idempotently) and return the daemon-owned Gemini advisory file. */
export function ensureGeminiNativeAgentPolicyFile(root: string = join(homedir(), '.imcodes', 'policies')): string {
  const path = join(root, 'gemini-native-agent-deny.toml');
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== GEMINI_NATIVE_AGENT_POLICY_TOML) {
    mkdirSync(root, { recursive: true });
    writeFileSync(path, GEMINI_NATIVE_AGENT_POLICY_TOML, 'utf8');
  }
  return path;
}

/**
 * Compatibility helper for the former policy plumbing. It now returns no
 * policy flags, so the user's native-agent defaults remain untouched.
 */
export function geminiNativeAgentFenceFlags(policyFile: string, env: NodeJS.ProcessEnv = process.env): string {
  void policyFile;
  void env;
  return '';
}

/** The fence a process launch establishes for the conversation that process runs. */
export type ProcessLaunchFence = 'disabled' | 'provider_default';

/**
 * What a process launch actually proves. Launch flags fence Claude Code and
 * Gemini processes whatever conversation they resume; Codex flags fence only a
 * thread the process creates, so a Codex launch that may resume an existing
 * thread proves nothing (that thread's rollout decides instead).
 */
export function processLaunchFence(
  agentType: string,
  input: { nativeAgentsFenced: boolean; resumesExistingConversation: boolean },
): ProcessLaunchFence {
  // Native-agent routing is governed by the IM.codes pair contract, not by
  // launch-time tool suppression. Keep this helper for capability plumbing,
  // but never produce a disabling fence.
  void agentType;
  void input;
  return NATIVE_AGENT_FENCES.PROVIDER_DEFAULT;
}
