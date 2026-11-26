import { useRef } from 'preact/hooks';
import { looselyEqual } from '../session-state-updates.js';

/**
 * Keep the previous reference while the new value is structurally equal.
 *
 * Derived arrays/objects recomputed from fast-changing sources (session list,
 * token usage) are usually equal in content; handing children a new reference
 * anyway defeats their memoization.
 */
export function useStructuralIdentity<T>(value: T): T {
  const ref = useRef(value);
  if (ref.current !== value && !looselyEqual(ref.current, value)) ref.current = value;
  return ref.current;
}
