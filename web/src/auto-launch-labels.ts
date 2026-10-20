import { getAutoSessionLabelPrefix } from './agent-display.js';

export interface AutoLaunchLabelSibling {
  type: string;
  label?: string | null;
}

/**
 * Assigns one label per requested sub-session launch, reusing create()'s own
 * prefix+increment convention (cc1/cc2/... when no label is given) instead of
 * a generic "type N" name, and label/label2/label3/... when a label is given.
 * Precomputed up front so a multi-launch loop never re-derives labels from a
 * stale subSessions closure between iterations.
 */
export function computeAutoLaunchLabels(
  siblings: AutoLaunchLabelSibling[],
  type: string,
  label: string | undefined,
  count: number,
): (string | undefined)[] {
  if (count <= 1) return [label];
  const taken = new Set(siblings.map((s) => s.label).filter((l): l is string => !!l));
  const labels: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let candidate: string;
    if (label) {
      candidate = label;
      let n = 2;
      while (taken.has(candidate)) {
        candidate = `${label}${n}`;
        n += 1;
      }
    } else {
      const prefix = getAutoSessionLabelPrefix(type);
      let n = siblings.filter((s) => s.type === type).length + 1;
      candidate = `${prefix}${n}`;
      while (taken.has(candidate)) {
        n += 1;
        candidate = `${prefix}${n}`;
      }
    }
    taken.add(candidate);
    labels.push(candidate);
  }
  return labels;
}
