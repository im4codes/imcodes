import {
  P2P_WORKFLOW_ARTIFACT_MAX_DEPTH,
  P2P_WORKFLOW_MAX_ACTIVE_RUNS,
  P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS,
  P2P_WORKFLOW_MAX_EDGES,
  P2P_WORKFLOW_MAX_NODES,
  P2P_WORKFLOW_MAX_PROMPT_APPEND_BYTES,
} from './p2p-workflow-constants.js';
import type { P2pJsonValue, P2pStaticPolicy } from './p2p-workflow-types.js';

export const DEFAULT_P2P_STATIC_POLICY: P2pStaticPolicy = {
  policyVersion: 1,
  maxNodes: P2P_WORKFLOW_MAX_NODES,
  maxEdges: P2P_WORKFLOW_MAX_EDGES,
  maxLoopBudget: 8,
  allowedExecutables: [],
  allowInterpreterScripts: false,
  allowOpenSpecArtifacts: false,
  allowImplementationPermission: false,
  maxPromptAppendBytes: P2P_WORKFLOW_MAX_PROMPT_APPEND_BYTES,
  concurrency: {
    maxAdvancedRuns: P2P_WORKFLOW_MAX_ACTIVE_RUNS,
    maxScripts: P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS,
  },
};

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalizeP2pStaticPolicy(policy: P2pStaticPolicy): P2pStaticPolicy {
  const { policyHash: _policyHash, ...rest } = policy;
  return {
    ...rest,
    allowedExecutables: [...rest.allowedExecutables].sort(),
  };
}

export function hashP2pStaticPolicy(policy: P2pStaticPolicy): string {
  return stableHash(stableStringify(canonicalizeP2pStaticPolicy(policy)));
}

export function buildDefaultP2pStaticPolicy(overrides: Partial<P2pStaticPolicy> = {}): P2pStaticPolicy {
  const policy = {
    ...DEFAULT_P2P_STATIC_POLICY,
    ...overrides,
    allowedExecutables: [...(overrides.allowedExecutables ?? DEFAULT_P2P_STATIC_POLICY.allowedExecutables)],
    concurrency: {
      ...DEFAULT_P2P_STATIC_POLICY.concurrency,
      ...(overrides.concurrency ?? {}),
    },
  };
  return {
    ...policy,
    policyHash: hashP2pStaticPolicy(policy),
  };
}

export function stableHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function canonicalize(value: unknown): P2pJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (typeof value === 'object') {
    const result: Record<string, P2pJsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = canonicalize(entry);
    }
    return result;
  }
  return null;
}

export function getDefaultArtifactDepthLimit(): number {
  return P2P_WORKFLOW_ARTIFACT_MAX_DEPTH;
}
