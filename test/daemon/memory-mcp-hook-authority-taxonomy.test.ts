/**
 * Error-taxonomy regression: hook endpoint drift MUST NOT masquerade as a
 * memory/context worker outage.
 *
 * The field incident: `~/.imcodes/hook-port` pointed at 51915 while the live
 * daemon served 51941, so `resolveLiveHookPort()` returned null and
 * `memory-mcp-server.ts` did:
 *
 *     if (!port) throw new Error('daemon_memory_worker_unavailable');
 *
 * The memory worker was healthy the entire time. Every reader of that error —
 * humans and automation — went looking at the wrong subsystem. These tests pin
 * that hook resolution failures surface as `HOOK_AUTHORITY_ERROR` codes with the
 * reason preserved, and that the memory-worker code is never produced by the
 * endpoint path.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HOOK_AUTHORITY_ERROR,
  RETRYABLE_HOOK_AUTHORITY_ERRORS,
  type HookAuthorityResolution,
} from '../../shared/hook-authority.js';
import { HookAuthorityUnavailableError } from '../../src/daemon/hook-port.js';
import { mergeDefaultToolDeps } from '../../src/daemon/memory-mcp-server.js';
import type { McpRuntimeCaller } from '../../shared/memory-mcp-contracts.js';

const caller = {
  userId: 'user-1',
  namespace: { scope: 'personal', userId: 'user-1' },
  sessionName: 'deck_sub_worker',
  projectName: 'proj',
  projectRoot: '/tmp/proj',
  serverId: 'srv-1',
  transport: 'stdio',
} as unknown as McpRuntimeCaller;

const owner = {
  sessionName: 'deck_sub_worker',
  sessionInstanceId: 'instance-1',
  runtimeEpoch: 'epoch-1',
};

function unavailable(reason: (typeof HOOK_AUTHORITY_ERROR)[keyof typeof HOOK_AUTHORITY_ERROR], detail?: string) {
  const resolution: HookAuthorityResolution = detail === undefined
    ? { ok: false, reason }
    : { ok: false, reason, detail };
  return vi.fn(async () => resolution);
}

describe('daemon memory tool relay reports endpoint-authority failures accurately', () => {
  it.each([
    ['a stale record', HOOK_AUTHORITY_ERROR.staleHookAuthority],
    ['an unpublished record', HOOK_AUTHORITY_ERROR.hookUnavailable],
    ['malformed record bytes', HOOK_AUTHORITY_ERROR.unreadable],
  ])('surfaces %s as its own reason, not a memory-worker outage', async (_label, reason) => {
    const resolveHookAuthority = unavailable(reason, 'record says 51915, live daemon serves 51941');
    const merged = mergeDefaultToolDeps(caller, {}, owner, { resolveHookAuthority });
    expect(typeof merged.invokeDaemonMemoryTool).toBe('function');

    const invoke = merged.invokeDaemonMemoryTool!('search_memory', { query: 'x' });
    await expect(invoke).rejects.toBeInstanceOf(HookAuthorityUnavailableError);
    await expect(invoke).rejects.toMatchObject({ reason });
    // The exact regression: this string must never come back.
    await expect(invoke).rejects.not.toThrow('daemon_memory_worker_unavailable');
    expect(resolveHookAuthority).toHaveBeenCalled();
  });

  it('keeps the operation and detail on the error so the endpoint is identifiable', async () => {
    const merged = mergeDefaultToolDeps(caller, {}, owner, {
      resolveHookAuthority: unavailable(HOOK_AUTHORITY_ERROR.staleHookAuthority, 'owner pid 15017 is gone'),
    });
    const error = await merged.invokeDaemonMemoryTool!('search_memory', {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HookAuthorityUnavailableError);
    const typed = error as HookAuthorityUnavailableError;
    expect(typed.reason).toBe(HOOK_AUTHORITY_ERROR.staleHookAuthority);
    expect(typed.operation).toBeTruthy();
    expect(typed.detail).toBe('owner pid 15017 is gone');
    expect(typed.message).toContain(HOOK_AUTHORITY_ERROR.staleHookAuthority);
  });

  it('classifies which endpoint failures a caller may retry', () => {
    // Drift and absence are transient: the daemon republishes on rebind.
    expect(RETRYABLE_HOOK_AUTHORITY_ERRORS.has(HOOK_AUTHORITY_ERROR.staleHookAuthority)).toBe(true);
    expect(RETRYABLE_HOOK_AUTHORITY_ERRORS.has(HOOK_AUTHORITY_ERROR.hookUnavailable)).toBe(true);
    // These need daemon/operator action, so a blind retry loop is wrong.
    expect(RETRYABLE_HOOK_AUTHORITY_ERRORS.has(HOOK_AUTHORITY_ERROR.unreadable)).toBe(false);
    expect(RETRYABLE_HOOK_AUTHORITY_ERRORS.has(HOOK_AUTHORITY_ERROR.publishFenced)).toBe(false);
    expect(RETRYABLE_HOOK_AUTHORITY_ERRORS.has(HOOK_AUTHORITY_ERROR.publishSuppressedForTests)).toBe(false);
  });

  it('keeps every endpoint code disjoint from the memory-worker namespace', () => {
    for (const code of Object.values(HOOK_AUTHORITY_ERROR)) {
      expect(code.startsWith('daemon_memory_worker')).toBe(false);
    }
  });
});
