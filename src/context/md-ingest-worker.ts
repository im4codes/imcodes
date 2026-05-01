import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextNamespace } from '../../shared/context-types.js';
import type { MemoryScope } from '../../shared/memory-scope.js';
import {
  MD_INGEST_FEATURE_FLAG,
  MD_INGEST_ORIGIN,
  MD_INGEST_SUPPORTED_PATHS,
  parseMdIngestDocument,
} from '../../shared/md-ingest.js';
import {
  MEMORY_FEATURE_FLAGS,
  memoryFeatureFlagEnvKey,
  resolveEffectiveMemoryFeatureFlagValue,
  type MemoryFeatureFlag,
  type MemoryFeatureFlagValues,
} from '../../shared/feature-flags.js';
import { writeProcessedProjection } from '../store/context-store.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { incrementCounter } from '../util/metrics.js';
import { serializeContextNamespace } from './context-keys.js';

const scheduledKeys = new Set<string>();
const MD_INGEST_ALLOWED_SCOPES: ReadonlySet<MemoryScope> = new Set(['personal', 'project_shared']);

function isMdIngestEnabled(): boolean {
  const environmentStartupDefault = Object.fromEntries(
    MEMORY_FEATURE_FLAGS.flatMap((flag): Array<[MemoryFeatureFlag, boolean]> => {
      const raw = process.env[memoryFeatureFlagEnvKey(flag)];
      return raw == null ? [] : [[flag, raw === 'true' || raw === '1']];
    }),
  ) as MemoryFeatureFlagValues;
  return resolveEffectiveMemoryFeatureFlagValue(MD_INGEST_FEATURE_FLAG, {
    environmentStartupDefault,
  });
}

function validateMarkdownIngestNamespace(namespace: ContextNamespace): ContextNamespace | null {
  if (MD_INGEST_ALLOWED_SCOPES.has(namespace.scope)) return namespace;
  incrementCounter('mem.ingest.scope_dropped', { from: namespace.scope, reason: 'unsupported_scope' });
  warnOncePerHour('md_ingest.scope_dropped', {
    scope: namespace.scope,
    reason: 'unsupported_scope',
    projectId: namespace.projectId,
  });
  return null;
}

export async function runMarkdownMemoryIngest(input: {
  projectDir: string | undefined;
  namespace: ContextNamespace;
  featureEnabled?: boolean;
  now?: number;
}): Promise<{ filesChecked: number; observationsWritten: number; droppedReason?: 'unsupported_scope' }> {
  const projectDir = input.projectDir?.trim();
  if (!projectDir) return { filesChecked: 0, observationsWritten: 0 };
  const featureEnabled = input.featureEnabled ?? isMdIngestEnabled();
  if (!featureEnabled) return { filesChecked: 0, observationsWritten: 0 };

  const namespace = validateMarkdownIngestNamespace(input.namespace);
  if (!namespace) return { filesChecked: 0, observationsWritten: 0, droppedReason: 'unsupported_scope' };
  const scopeKey = serializeContextNamespace(namespace);
  let filesChecked = 0;
  let observationsWritten = 0;

  for (const relativePath of MD_INGEST_SUPPORTED_PATHS) {
    const fullPath = join(projectDir, relativePath);
    try {
      const stat = await lstat(fullPath);
      filesChecked += 1;
      const content = stat.isSymbolicLink() ? new Uint8Array() : await readFile(fullPath);
      const result = parseMdIngestDocument({
        path: relativePath,
        content,
        scopeKey,
        featureEnabled,
        isSymlink: stat.isSymbolicLink(),
      });
      for (const section of result.sections) {
        writeProcessedProjection({
          id: `md-ingest:${scopeKey}:${relativePath}:${section.fingerprint}`,
          namespace,
          class: 'durable_memory_candidate',
          sourceEventIds: [`md-ingest:${relativePath}:${section.fingerprint}`],
          summary: section.text,
          content: {
            text: section.text,
            title: section.heading,
            path: relativePath,
            observationClass: section.class,
            origin: MD_INGEST_ORIGIN,
            fingerprint: section.fingerprint,
            provenanceFingerprint: `${relativePath}:${section.fingerprint}`,
          },
          origin: MD_INGEST_ORIGIN,
          createdAt: input.now,
          updatedAt: input.now,
        });
        observationsWritten += 1;
      }
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code === 'ENOENT') continue;
      incrementCounter('mem.ingest.skipped_unsafe', { reason: 'read_failed' });
      warnOncePerHour('md_ingest.read_failed', {
        path: relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { filesChecked, observationsWritten };
}

export function scheduleMarkdownMemoryIngest(input: {
  projectDir: string | undefined;
  namespace: ContextNamespace;
}): void {
  const projectDir = input.projectDir?.trim();
  if (!projectDir || !isMdIngestEnabled()) return;
  const key = `${projectDir}\u0000${serializeContextNamespace(input.namespace)}`;
  if (scheduledKeys.has(key)) return;
  scheduledKeys.add(key);
  const timer = setTimeout(() => {
    void runMarkdownMemoryIngest(input)
      .catch((error) => {
        incrementCounter('mem.ingest.skipped_unsafe', { reason: 'worker_failed' });
        warnOncePerHour('md_ingest.worker_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        scheduledKeys.delete(key);
      });
  }, 0);
  timer.unref?.();
}

export function resetMarkdownMemoryIngestForTests(): void {
  scheduledKeys.clear();
}
