import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CHANGE_DIR = 'openspec/changes/memory-system-post-1-1-integration';

const TRACEABILITY_EVIDENCE: Record<string, string[]> = {
  'POST11-R1': ['test/daemon/command-handler-transport-queue.test.ts'],
  'POST11-R2': ['test/context/memory-fingerprint-v1.test.ts'],
  'POST11-R3': ['test/context/memory-scope-policy.test.ts', 'server/test/shared-context-processed-remote.test.ts'],
  'POST11-R4': ['test/context/memory-feature-flags.test.ts'],
  'POST11-R5': ['test/context/memory-post11-shared-contracts.test.ts'],
  'POST11-R6': ['test/context/startup-memory.test.ts', 'test/spec/design-defaults-coverage.test.ts'],
  'POST11-R7': ['test/context/memory-render-policy.test.ts', 'test/context/skill-envelope.test.ts'],
  'POST11-R8': ['test/context/self-learning.test.ts', 'test/context/materialization-repair.test.ts'],
  'POST11-R9': ['server/test/memory-search-auth.test.ts', 'server/test/memory-scope-authorization.test.ts', 'test/context/memory-search-semantic.test.ts'],
  'POST11-R10': ['test/context/memory-citation-drift.test.ts', 'test/context/memory-cite-count.test.ts', 'server/test/memory-scope-authorization.test.ts'],
  'POST11-R11': ['test/context/md-ingest.test.ts'],
  'POST11-R12': ['test/context/preferences-trust-origin.test.ts'],
  'POST11-R13': ['test/context/skill-precedence.test.ts', 'test/context/skill-store.test.ts', 'test/context/skill-envelope.test.ts'],
  'POST11-R14': ['test/context/skill-store.test.ts'],
  'POST11-R15': ['web/test/i18n-memory-post11.test.ts'],
  'POST11-R16': ['test/context/memory-retention.test.ts', 'test/context/materialization-repair.test.ts'],
  'POST11-R17': ['test/context/context-observation-store.test.ts'],
  'POST11-R18': ['test/context/memory-scope-policy.test.ts', 'server/test/memory-scope-authorization.test.ts'],
  'POST11-R19': ['server/test/shared-context-org-authored-context.test.ts'],
  'POST11-R20': ['server/test/bridge-memory-management.test.ts', 'test/daemon/command-handler-transport-queue.test.ts'],
};

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function explicitTestAnchorPaths(...artifacts: string[]): string[] {
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    for (const match of artifact.matchAll(/`((?:test|server\/test|web\/test)\/[^`]+)`/g)) {
      const path = match[1];
      if (path) paths.add(path);
    }
  }
  return [...paths].sort();
}

function anchorExists(path: string): boolean {
  if (path.endsWith('/**')) return existsSync(path.slice(0, -3));
  if (path.includes('*')) return existsSync(path.slice(0, path.indexOf('*')).replace(/\/$/, ''));
  return existsSync(path);
}

describe('post-1.1 traceability coverage', () => {
  it('keeps every POST11 requirement anchored to tasks and existing test evidence', () => {
    const spec = read(`${CHANGE_DIR}/specs/daemon-memory-post-foundations/spec.md`);
    const tasks = read(`${CHANGE_DIR}/tasks.md`);
    const requirementIds = [...spec.matchAll(/Requirement: (POST11-R\d+)/g)].map((match) => match[1]);

    expect(requirementIds).toHaveLength(20);
    expect(Object.keys(TRACEABILITY_EVIDENCE).sort()).toEqual([...requirementIds].sort());

    for (const requirementId of requirementIds) {
      expect(tasks, `${requirementId} missing from traceability matrix`).toContain(requirementId);
      for (const evidencePath of TRACEABILITY_EVIDENCE[requirementId]) {
        expect(existsSync(evidencePath), `${requirementId} evidence file missing: ${evidencePath}`).toBe(true);
      }
    }
  });

  it('does not reference phantom explicit test anchor paths in OpenSpec artifacts', () => {
    const spec = read(`${CHANGE_DIR}/specs/daemon-memory-post-foundations/spec.md`);
    const tasks = read(`${CHANGE_DIR}/tasks.md`);
    for (const anchorPath of explicitTestAnchorPaths(spec, tasks)) {
      expect(anchorExists(anchorPath), `OpenSpec explicit test anchor missing: ${anchorPath}`).toBe(true);
    }
  });
});
