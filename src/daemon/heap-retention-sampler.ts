/**
 * Which code allocated what is still alive: a bounded "largest retained allocations" report for the memory-guard diagnostic.
 *
 * It wraps V8's sampling heap profiler (an in-process inspector session). The profiler is started at boot because an
 * allocation can only be attributed to the stack that made it while the profiler was running; asking at 85 % is too late to
 * start. Live samples only (objects a collection freed are not reported). The report holds byte counts and code locations
 * (function name, file relative to the package, line) and nothing else: no value, no argument, no absolute path.
 */
import inspector from 'node:inspector';
import {
  DAEMON_HEAP_RETAINED_FRAMES,
  DAEMON_HEAP_RETAINED_MAX_NODES,
  DAEMON_HEAP_RETAINED_TOP_N,
  DAEMON_HEAP_SAMPLER_ENV,
  DAEMON_HEAP_SAMPLER_INTERVAL_BYTES,
} from '../../shared/daemon-memory-guard.js';

interface SamplingNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: SamplingNode[];
}

export interface RetainedAllocation {
  /** Estimated live bytes allocated at exactly this stack. */
  bytes: number;
  /** Innermost frame first: `function (file:line)`. */
  frames: string[];
}

export interface RetainedAllocationReport {
  status: 'ok' | 'unavailable';
  reason?: string;
  /** Sum over every node of the profile, not only the listed ones. */
  totalBytes?: number;
  truncated?: boolean;
  top: RetainedAllocation[];
}

/** Source of the sampling profile; the production one is the inspector session, tests inject a tree. */
export interface SamplingProfileSource {
  profile(): { head: SamplingNode } | undefined;
}

let session: inspector.Session | null = null;

/** `file:///home/u/.nvm/.../imcodes/dist/src/daemon/x.js` -> `dist/src/daemon/x.js`; never the home directory. */
export function relativeCodeLocation(url: string): string {
  if (!url) return '(native)';
  const cleaned = url.replace(/^file:\/\//, '').replace(/\\/g, '/');
  const marker = cleaned.match(/(?:^|\/)((?:node_modules\/[^/]+\/)?(?:dist|src|shared|server|web)\/.*)$/);
  if (marker?.[1]) return marker[1];
  const parts = cleaned.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function describeFrame(frame: SamplingNode['callFrame']): string {
  const name = frame.functionName || '(anonymous)';
  // Inspector line numbers are zero-based.
  return `${name} (${relativeCodeLocation(frame.url)}:${Math.max(0, frame.lineNumber) + 1})`;
}

/** Fold a profile into the heaviest stacks. Walks iteratively and at most DAEMON_HEAP_RETAINED_MAX_NODES nodes. */
export function summarizeSamplingProfile(head: SamplingNode, topN = DAEMON_HEAP_RETAINED_TOP_N): RetainedAllocationReport {
  const stack: Array<{ node: SamplingNode; parent: number }> = [{ node: head, parent: -1 }];
  const nodes: Array<{ node: SamplingNode; parent: number }> = [];
  let totalBytes = 0;
  let truncated = false;
  while (stack.length > 0) {
    if (nodes.length >= DAEMON_HEAP_RETAINED_MAX_NODES) { truncated = true; break; }
    const entry = stack.pop()!;
    const index = nodes.push(entry) - 1;
    if (entry.node.selfSize > 0) totalBytes += entry.node.selfSize;
    for (const child of entry.node.children ?? []) stack.push({ node: child, parent: index });
  }
  const heaviest = nodes
    .filter((entry) => entry.node.selfSize > 0)
    .sort((left, right) => right.node.selfSize - left.node.selfSize)
    .slice(0, topN);
  const top = heaviest.map((entry) => {
    const frames: string[] = [];
    let cursor: { node: SamplingNode; parent: number } | undefined = entry;
    while (cursor && frames.length < DAEMON_HEAP_RETAINED_FRAMES) {
      const frame = cursor.node.callFrame;
      // The root and engine-internal frames carry no location; they say nothing about the code.
      if (frame.functionName !== '(root)' && (frame.url || frame.functionName)) frames.push(describeFrame(frame));
      cursor = cursor.parent >= 0 ? nodes[cursor.parent] : undefined;
    }
    return { bytes: Math.round(entry.node.selfSize), frames };
  });
  return { status: 'ok', totalBytes: Math.round(totalBytes), ...(truncated ? { truncated } : {}), top };
}

/** Start the process-wide sampler. Returns false (and does nothing) when it is switched off or cannot start. */
export function startHeapRetentionSampler(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[DAEMON_HEAP_SAMPLER_ENV] === '0') return false;
  if (session) return true;
  try {
    const next = new inspector.Session();
    next.connect();
    next.post('HeapProfiler.enable');
    next.post('HeapProfiler.startSampling', {
      samplingInterval: DAEMON_HEAP_SAMPLER_INTERVAL_BYTES,
      includeObjectsCollectedByMajorGC: false,
      includeObjectsCollectedByMinorGC: false,
    });
    session = next;
    return true;
  } catch {
    try { session?.disconnect(); } catch { /* nothing to release */ }
    session = null;
    return false;
  }
}

export function stopHeapRetentionSampler(): void {
  if (!session) return;
  try { session.post('HeapProfiler.stopSampling'); } catch { /* already stopped */ }
  try { session.disconnect(); } catch { /* already disconnected */ }
  session = null;
}

const processProfileSource: SamplingProfileSource = {
  profile() {
    if (!session) return undefined;
    let head: SamplingNode | undefined;
    // An in-process session answers synchronously: the guard writes its diagnostic synchronously too.
    session.post('HeapProfiler.getSamplingProfile', (error, result) => {
      if (!error) head = (result as { profile?: { head: SamplingNode } } | undefined)?.profile?.head;
    });
    return head ? { head } : undefined;
  },
};

/** The report the guard embeds in its diagnostic. Never throws. */
export function largestRetainedAllocations(source: SamplingProfileSource = processProfileSource): RetainedAllocationReport {
  try {
    const profile = source.profile();
    if (!profile) return { status: 'unavailable', reason: 'sampler not running', top: [] };
    return summarizeSamplingProfile(profile.head);
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.name : 'unknown', top: [] };
  }
}
