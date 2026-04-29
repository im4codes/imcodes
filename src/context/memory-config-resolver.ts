import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { listSessions } from '../store/session-store.js';
import { serializeContextNamespace } from './context-keys.js';
import { DEFAULT_MEMORY_CONFIG, loadMemoryConfig, type MemoryConfig } from './memory-config.js';

export type MemoryConfigResolver = (
  namespace: ContextNamespace,
  target?: ContextTargetRef,
) => MemoryConfig;

export type MemoryProjectDirResolver = (
  namespace: ContextNamespace,
  target?: ContextTargetRef,
) => string | undefined;

const namespaceProjectDirs = new Map<string, string>();

export function rememberMemoryConfigProjectDir(namespace: ContextNamespace | undefined, projectDir: string | undefined): void {
  const trimmed = projectDir?.trim();
  if (!namespace || !trimmed) return;
  namespaceProjectDirs.set(serializeContextNamespace(namespace), trimmed);
}

export function forgetMemoryConfigProjectDir(namespace: ContextNamespace): void {
  namespaceProjectDirs.delete(serializeContextNamespace(namespace));
}

export function resetMemoryConfigResolverForTests(): void {
  namespaceProjectDirs.clear();
}

export function getRememberedMemoryConfigProjectDir(namespace: ContextNamespace): string | undefined {
  return namespaceProjectDirs.get(serializeContextNamespace(namespace));
}

export function resolveMemoryConfigForNamespace(
  namespace: ContextNamespace,
  options: {
    target?: ContextTargetRef;
    projectDirResolver?: MemoryProjectDirResolver;
    fallbackCwd?: string;
    fallbackConfig?: MemoryConfig;
  } = {},
): MemoryConfig {
  const projectDir = options.projectDirResolver?.(namespace, options.target)
    ?? getRememberedMemoryConfigProjectDir(namespace)
    ?? findSessionProjectDirForNamespace(namespace)
    ?? options.fallbackCwd;
  if (projectDir) return loadMemoryConfig(projectDir);
  return options.fallbackConfig ?? { ...DEFAULT_MEMORY_CONFIG, redactPatterns: [], extraRedactPatterns: [] };
}

function findSessionProjectDirForNamespace(namespace: ContextNamespace): string | undefined {
  for (const session of listSessions()) {
    if (session.contextNamespace && sameNamespace(session.contextNamespace, namespace)) {
      const projectDir = session.projectDir?.trim();
      if (projectDir) return projectDir;
    }
  }
  return undefined;
}

function sameNamespace(a: ContextNamespace, b: ContextNamespace): boolean {
  return a.scope === b.scope
    && a.projectId === b.projectId
    && (a.userId ?? undefined) === (b.userId ?? undefined)
    && (a.workspaceId ?? undefined) === (b.workspaceId ?? undefined)
    && (a.enterpriseId ?? undefined) === (b.enterpriseId ?? undefined);
}

export function createMemoryConfigResolver(options: {
  fixedConfig?: MemoryConfig;
  projectDirResolver?: MemoryProjectDirResolver;
  fallbackCwd?: string;
} = {}): MemoryConfigResolver {
  if (options.fixedConfig) return () => options.fixedConfig as MemoryConfig;
  return (namespace, target) => resolveMemoryConfigForNamespace(namespace, {
    target,
    projectDirResolver: options.projectDirResolver,
    fallbackCwd: options.fallbackCwd,
  });
}
