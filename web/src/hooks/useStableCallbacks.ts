import { useRef } from 'preact/hooks';

/**
 * Give every function-valued prop a stable identity that always calls the
 * LATEST function passed in.
 *
 * Parents build handlers inline (`onSend={(…) => …}`), so a memoized child
 * would otherwise see a "changed" prop on every parent render. The stable
 * wrapper reads the newest closure at call time, so behaviour is identical to
 * receiving the fresh function each render; only the identity stops changing.
 * Non-function values pass through untouched (an undefined handler stays
 * undefined, so "is this handler provided?" checks in the child still work).
 */
export function useStableCallbacks<T extends Record<string, unknown>>(props: T): T {
  const latest = useRef(props);
  latest.current = props;
  const wrappers = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (typeof value !== 'function') {
      out[key] = value;
      continue;
    }
    let wrapper = wrappers.current.get(key);
    if (!wrapper) {
      wrapper = (...args: unknown[]) => (latest.current[key] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
      wrappers.current.set(key, wrapper);
    }
    out[key] = wrapper;
  }
  return out as T;
}
