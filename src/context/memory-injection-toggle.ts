/**
 * Per-namespace toggle for the startup-memory auto-injection pipeline
 * (`src/context/startup-memory.ts`'s durable/recent/pinned/project_docs
 * selection into a newly launched session's initial context).
 *
 * Backed by the existing `context_meta` key-value table (via the
 * `getContextMeta`/`setContextMeta` L1 ops) rather than a new table, since
 * this is a single boolean per namespace with no need for the richer
 * revision/scope machinery `session_identity` uses for cross-device-synced
 * text content.
 *
 * Scope is the project's `ContextNamespace`, not a single session, so a
 * project's Brain toggling this off also stops it for every sub-session —
 * they all bootstrap under the same namespace. Default is enabled ("默认放开"):
 * an absent key means injection stays on.
 */
import { getContextStoreClient } from '../store/context-store-worker-client.js';
import { serializeContextNamespace } from './context-keys.js';
import type { ContextNamespace } from '../../shared/context-types.js';

const MEMORY_INJECTION_META_KEY_PREFIX = 'memory_injection_enabled::';

export function memoryInjectionMetaKey(namespace: ContextNamespace): string {
  return `${MEMORY_INJECTION_META_KEY_PREFIX}${serializeContextNamespace(namespace)}`;
}

export async function isMemoryInjectionEnabled(namespace: ContextNamespace): Promise<boolean> {
  const raw = await getContextStoreClient().run<string | undefined>('getContextMeta', [memoryInjectionMetaKey(namespace)]);
  return raw !== '0';
}

export async function setMemoryInjectionEnabled(namespace: ContextNamespace, enabled: boolean): Promise<void> {
  await getContextStoreClient().run<void>('setContextMeta', [memoryInjectionMetaKey(namespace), enabled ? '1' : '0']);
}
