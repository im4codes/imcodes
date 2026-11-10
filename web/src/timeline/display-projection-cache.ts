import { TIMELINE_ASSISTANT_TEXT_EVENT_TYPE } from '@shared/timeline-protocol.js';
import type { TimelineEvent } from '../ws-client.js';

// Callers already own the legacy projection dependency. Inject those two pure
// operations instead of adding another web → src runtime import or migrating
// the old shared module as part of a foreground-recovery fix.
export function createTimelineDisplayProjectionCache<Projection>(
  project: (text: unknown) => Projection,
  isVisible: (event: TimelineEvent, projection?: Projection) => boolean,
) {
  // Historical payload objects survive tail appends/foreground refreshes. Cache
  // their derived display text, not a full-text hash. Weak ownership bounds the
  // lifetime to the source events; the raw-value check also handles an in-place
  // payload edit. Non-string legacy values keep the uncached coercion semantics.
  const projections = new WeakMap<object, { text: string; value: Projection }>();
  // IDB structured-clones rows on foreground reload. A small weak index can find
  // the still-live prior payload without retaining abandoned sessions/large text.
  // Equality is the actual projection input, never a lossy version/hash heuristic.
  type WeakPayloadReference = { deref(): object | undefined };
  const WeakPayloadRef = (globalThis as { WeakRef?: new (value: object) => WeakPayloadReference }).WeakRef;
  const restoredPayloads = new Map<string, WeakPayloadReference>();
  const MAX_RESTORED_PROJECTION_KEYS = 512;
  function projectAssistantEventForDisplay(event: TimelineEvent): Projection {
    const text = event.payload.text;
    if (typeof text !== 'string') return project(text);
    const cached = projections.get(event.payload);
    if (cached?.text === text) return cached.value;
    // sessionId is re-stamped to a server-scoped ID on IDB read. eventId is
    // only a lookup hint: exact text equality (the complete pure-function input)
    // is required even for colliding IDs, so neither owner nor text can leak.
    const key = event.eventId;
    const prior = restoredPayloads.get(key)?.deref();
    const restored = prior ? projections.get(prior) : undefined;
    const value = restored?.text === text ? restored.value : project(text);
    projections.set(event.payload, { text, value });
    if (WeakPayloadRef) {
      restoredPayloads.delete(key);
      restoredPayloads.set(key, new WeakPayloadRef(event.payload));
      if (restoredPayloads.size > MAX_RESTORED_PROJECTION_KEYS) restoredPayloads.delete(restoredPayloads.keys().next().value!);
    }
    return value;
  }

  // Keep the shared visibility predicate authoritative. Its assistant-text scan
  // is otherwise repeated for every unchanged row on each stream/cache update.
  const visibility = new WeakMap<object, {
    type: string; hidden: boolean | undefined; text: unknown; streaming: unknown; pending: unknown; value: boolean;
  }>();
  function isGuaranteedVisibleTimelineEventCached(event: TimelineEvent): boolean {
    const { type, hidden, payload } = event;
    if (!payload) return isVisible(event);
    const { text, streaming, pending } = payload;
    // Objects with a custom String coercion can change without changing identity.
    if ((text !== null && typeof text === 'object') || typeof text === 'function') return isVisible(event);
    const cached = visibility.get(event);
    if (cached && cached.type === type && cached.hidden === hidden && cached.text === text
      && cached.streaming === streaming && cached.pending === pending) return cached.value;
    const value = isVisible(event,
      type === TIMELINE_ASSISTANT_TEXT_EVENT_TYPE && !hidden ? projectAssistantEventForDisplay(event) : undefined);
    visibility.set(event, { type, hidden, text, streaming, pending, value });
    return value;
  }
  return { projectAssistantEventForDisplay, isGuaranteedVisibleTimelineEventCached };
}
