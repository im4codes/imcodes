/**
 * Fake-timer surface shared by every jsdom vitest project in `web/`.
 *
 * vitest 3 widened the default `toFake` set to include `requestAnimationFrame`
 * and `cancelAnimationFrame`. Components here schedule layout work through rAF
 * (SubSessionWindow's resize/clamp passes, for example), so under the v3 default
 * a suite that calls `vi.useFakeTimers()` silently stops running those
 * callbacks: the test then waits for an effect that can never happen and dies on
 * the 5s timeout, and `vi.useRealTimers()` can leave a trailing jsdom microtask
 * dereferencing an rAF that is no longer installed.
 *
 * Keeping animation frames real restores the vitest 2 behaviour these tests were
 * written against. Adopting the v3 semantics is a worthwhile but separate change
 * — it means teaching each affected test to advance timers for its rAF work, and
 * a security-motivated version bump should not quietly rewrite test semantics.
 *
 * Everything else v3 fakes is kept as-is; only the animation-frame pair is
 * excluded, so this stays the narrowest possible deviation from the default.
 */
export const WEB_FAKE_TIMERS = {
  toFake: [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
    'Date',
    'performance',
    'hrtime',
  ],
} as const;
