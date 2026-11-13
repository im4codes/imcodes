import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  AGENT_SKILL_FILE_NAME,
  AGENT_SKILLS_LOCK_FILE_SEGMENTS,
  AGENT_SKILLS_PROJECT_LOCK_FILE,
  AGENT_SKILLS_PROJECT_ROOT_SEGMENTS,
  AGENT_SKILLS_USER_ROOT_SEGMENTS,
  isAgentSkillName,
} from '../../shared/agent-skills.js';
import {
  SKILL_REGISTRY_FILE_NAME,
  SKILL_REGISTRY_SCHEMA_VERSION,
  makeSkillUri,
  type SkillRegistryEntry,
  type SkillRegistrySnapshot,
} from '../../shared/skill-registry-types.js';
import {
  PROJECT_SKILL_ESCAPE_HATCH_DIR,
  SKILL_FILE_EXTENSION,
  classifyUserSkillLayer,
  createSkillSource,
  getProjectSkillEscapeHatchDir,
  getUserSkillRoot,
  parseSkillMarkdown,
  type SkillLayer,
  type SkillProjectContext,
  type SkillSource,
} from '../../shared/skill-store.js';
import { SKILL_MAX_BYTES } from '../../shared/skill-envelope.js';
import { computeMemoryFingerprint } from '../../shared/memory-fingerprint.js';
import { invalidateSkillRegistryCache } from './skill-registry.js';
import { incrementCounter } from '../util/metrics.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { assertManagedSkillPathSync, assertReadableSkillPathSync } from './managed-skill-path.js';
import { parseExternalAgentSkillMarkdown } from './agent-skill-markdown.js';
import {
  MANAGED_SKILL_DIRECTORY,
  isManagedSkillStoreEstablished,
} from '../capability/managed-skill-paths.js';
import { imcodesStateDirForHome } from '../util/imcodes-state-dir.js';

const MAX_SKILL_FILES = 64;
const MAX_SCAN_DEPTH = 4;
const SKILL_REGISTRY_BUILDER_SOURCE = 'skill-registry-builder';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function listMarkdownFiles(root: string, options: {
  maxFiles?: number;
  maxDepth?: number;
  excludeRootDirectories?: readonly string[];
} = {}): string[] {
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_SKILL_FILES);
  const maxDepth = Math.max(0, options.maxDepth ?? MAX_SCAN_DEPTH);
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (depth === 0 && options.excludeRootDirectories?.includes(entry)) continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }
      if (stat.isFile() && fullPath.endsWith(SKILL_FILE_EXTENSION) && stat.size <= SKILL_MAX_BYTES * 2) files.push(fullPath);
    }
  };
  if (existsSync(root)) visit(root, 0);
  return files;
}

function displayPathFor(path: string, input: { homeDir?: string; projectDir?: string }): string {
  const home = input.homeDir?.replace(/[\\/]+$/, '');
  if (home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))) return `~${path.slice(home.length)}`;
  const project = input.projectDir?.replace(/[\\/]+$/, '');
  if (project && (path === project || path.startsWith(`${project}/`) || path.startsWith(`${project}\\`))) {
    const rel = relative(project, path);
    if (rel && !rel.startsWith('..')) return rel;
  }
  return path;
}

function fallbackNameFromPath(path: string): string | undefined {
  const file = path.split(/[\\/]/).pop();
  return file?.endsWith(SKILL_FILE_EXTENSION) ? file.slice(0, -SKILL_FILE_EXTENSION.length) : file;
}

export function skillRegistryEntryFromSource(source: SkillSource, input: {
  path: string;
  homeDir?: string;
  projectDir?: string;
  contentHash?: string;
  mtimeMs?: number;
  updatedAt?: number;
}): SkillRegistryEntry {
  const fingerprint = computeMemoryFingerprint({
    kind: 'skill',
    content: `${source.layer}\n${source.key}\n${source.metadata.description ?? ''}\n${input.contentHash ?? ''}`,
  });
  return {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    key: source.key,
    layer: source.layer,
    metadata: source.metadata,
    path: input.path,
    displayPath: displayPathFor(input.path, input),
    uri: makeSkillUri(source.layer, source.key),
    fingerprint,
    contentHash: input.contentHash,
    mtimeMs: input.mtimeMs,
    enforcement: source.enforcement,
    project: source.metadata.project,
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

function readSkillSource(path: string, layer: SkillLayer, fallback: { name?: string; category?: string }): SkillSource | null {
  try {
    const markdown = readFileSync(path, 'utf8');
    const parsed = parseSkillMarkdown(markdown, fallback);
    return createSkillSource({
      layer,
      metadata: parsed.metadata,
      content: parsed.content,
      path,
    });
  } catch (error) {
    incrementCounter('mem.skill.sanitize_rejected', { source: SKILL_REGISTRY_BUILDER_SOURCE });
    warnOncePerHour('skill_registry_builder.parse_failed', { path, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function writeRegistry(path: string, entries: SkillRegistryEntry[]): SkillRegistrySnapshot {
  const snapshot: SkillRegistrySnapshot = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    generatedAt: Date.now(),
    entries: entries.sort((a, b) => `${a.layer}:${a.key}`.localeCompare(`${b.layer}:${b.key}`)),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, path);
  invalidateSkillRegistryCache();
  return snapshot;
}

function isUnderDir(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function statSyncSafe(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function collectExternalAgentEntries(input: {
  scope: 'user' | 'project';
  layer: 'user_default' | 'project_escape_hatch';
  scopeRoot: string;
  rootSegmentsList: readonly (readonly [string, string])[];
  homeDir?: string;
  projectDir?: string;
  maxEntries?: number;
  seenRealFiles: Set<string>;
}): SkillRegistryEntry[] {
  const maxEntries = input.maxEntries ?? MAX_SKILL_FILES;
  const resolvedScopeRoot = resolve(input.scopeRoot);
  let realScopeRoot: string;
  try {
    realScopeRoot = realpathSync(resolvedScopeRoot);
  } catch {
    return [];
  }

  const entries: SkillRegistryEntry[] = [];
  const seenRealDirs = new Set<string>();
  const seenNames = new Set<string>();

  for (const [dir, sub] of input.rootSegmentsList) {
    if (entries.length >= maxEntries) break;
    const rootPath = join(resolvedScopeRoot, dir, sub);
    if (!existsSync(rootPath)) continue;
    let names: string[];
    try {
      names = readdirSync(rootPath).sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    const displayPrefix = input.scope === 'user' ? `~/${dir}/${sub}` : `${dir}/${sub}`;
    for (const name of names) {
      if (entries.length >= maxEntries) break;
      if (name.startsWith('.') || !isAgentSkillName(name)) continue;
      const lowerName = name.toLocaleLowerCase();
      if (seenNames.has(lowerName)) continue;

      const skillDir = join(rootPath, name);
      const skillFile = join(skillDir, AGENT_SKILL_FILE_NAME);
      let realDir: string;
      let realFile: string;
      try {
        if (!statSync(skillDir).isDirectory()) continue;
        realDir = realpathSync(skillDir);
        if (!isUnderDir(realDir, realScopeRoot) || seenRealDirs.has(realDir)) continue;
        if (!statSync(skillFile).isFile()) continue;
        realFile = realpathSync(skillFile);
        if (dirname(realFile) !== realDir || input.seenRealFiles.has(realFile)) continue;
        assertReadableSkillPathSync({
          path: skillFile,
          homeDir: input.homeDir,
          projectDir: input.projectDir,
          maxBytes: SKILL_MAX_BYTES,
        });
      } catch {
        incrementCounter('mem.skill.sanitize_rejected', { source: SKILL_REGISTRY_BUILDER_SOURCE });
        continue;
      }

      try {
        const markdown = readFileSync(realFile, 'utf8');
        const parsed = parseExternalAgentSkillMarkdown(markdown, {
          name,
          category: 'agent',
        });
        const source = createSkillSource({
          layer: input.layer,
          metadata: parsed.metadata,
          content: parsed.content,
          path: skillFile,
        });
        const stat = statSync(realFile);
        const entry = skillRegistryEntryFromSource(source, {
          path: skillFile,
          homeDir: input.homeDir,
          projectDir: input.projectDir,
          contentHash: sha256(markdown),
          mtimeMs: stat.mtimeMs,
          updatedAt: stat.mtimeMs,
        });
        // Always emit redacted root-relative/tilde displayPath regardless of home/project symlinks.
        entry.displayPath = `${displayPrefix}/${name}/${AGENT_SKILL_FILE_NAME}`;
        entries.push(entry);
        seenNames.add(lowerName);
        seenRealDirs.add(realDir);
        input.seenRealFiles.add(realFile);
      } catch (error) {
        incrementCounter('mem.skill.sanitize_rejected', { source: SKILL_REGISTRY_BUILDER_SOURCE });
        warnOncePerHour('skill_registry_builder.parse_failed', { path: skillFile, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return entries;
}

export function buildUserSkillRegistry(input: { homeDir?: string; context?: SkillProjectContext } = {}): SkillRegistrySnapshot {
  const homeDir = input.homeDir ?? homedir();
  const root = getUserSkillRoot(homeDir, imcodesStateDirForHome(homeDir));
  const entries: SkillRegistryEntry[] = [];
  const seenRealFiles = new Set<string>();
  const excludeRootDirectories = isManagedSkillStoreEstablished(homeDir) ? [MANAGED_SKILL_DIRECTORY] : [];
  for (const path of listMarkdownFiles(root, { excludeRootDirectories })) {
    try {
      const checked = assertManagedSkillPathSync({ path, homeDir, maxBytes: SKILL_MAX_BYTES });
      seenRealFiles.add(checked.realPath);
    } catch {
      incrementCounter('mem.skill.sanitize_rejected', { source: SKILL_REGISTRY_BUILDER_SOURCE });
      continue;
    }
    const source = readSkillSource(path, 'user_default', {
      name: fallbackNameFromPath(path),
      category: relative(root, path).split(/[\\/]/)[0] || 'general',
    });
    const layer = source ? classifyUserSkillLayer(source.metadata, input.context) : null;
    if (!source || !layer) continue;
    const normalized = { ...source, layer, id: `${layer}:${source.key}:${path}` } satisfies SkillSource;
    const stat = statSync(path);
    entries.push(skillRegistryEntryFromSource(normalized, {
      path,
      homeDir,
      contentHash: sha256(readFileSync(path, 'utf8')),
      mtimeMs: stat.mtimeMs,
      updatedAt: stat.mtimeMs,
    }));
  }
  entries.push(...collectExternalAgentEntries({
    scope: 'user',
    layer: 'user_default',
    scopeRoot: homeDir,
    rootSegmentsList: AGENT_SKILLS_USER_ROOT_SEGMENTS,
    homeDir,
    seenRealFiles,
  }));
  return writeRegistry(join(root, SKILL_REGISTRY_FILE_NAME), entries);
}

export function buildProjectSkillRegistry(input: { projectDir: string }): SkillRegistrySnapshot {
  const root = getProjectSkillEscapeHatchDir(input.projectDir);
  const entries: SkillRegistryEntry[] = [];
  const seenRealFiles = new Set<string>();
  for (const path of listMarkdownFiles(root)) {
    try {
      const checked = assertManagedSkillPathSync({ path, projectDir: input.projectDir, maxBytes: SKILL_MAX_BYTES });
      seenRealFiles.add(checked.realPath);
    } catch {
      incrementCounter('mem.skill.sanitize_rejected', { source: SKILL_REGISTRY_BUILDER_SOURCE });
      continue;
    }
    const source = readSkillSource(path, 'project_escape_hatch', {
      name: fallbackNameFromPath(path),
      category: relative(root, path).split(/[\\/]/)[0] || 'project',
    });
    if (!source) continue;
    const stat = statSync(path);
    entries.push(skillRegistryEntryFromSource(source, {
      path,
      projectDir: input.projectDir,
      contentHash: sha256(readFileSync(path, 'utf8')),
      mtimeMs: stat.mtimeMs,
      updatedAt: stat.mtimeMs,
    }));
  }
  entries.push(...collectExternalAgentEntries({
    scope: 'project',
    layer: 'project_escape_hatch',
    scopeRoot: input.projectDir,
    rootSegmentsList: AGENT_SKILLS_PROJECT_ROOT_SEGMENTS,
    projectDir: input.projectDir,
    seenRealFiles,
  }));
  return writeRegistry(join(root, SKILL_REGISTRY_FILE_NAME), entries);
}

function isRegistryFileStale(registryPath: string, roots: readonly string[], lockPath?: string): boolean {
  const regStat = statSyncSafe(registryPath);
  if (!regStat) return false;
  if (lockPath) {
    const lockStat = statSyncSafe(lockPath);
    if (lockStat && lockStat.mtimeMs > regStat.mtimeMs) return true;
  }
  for (const root of roots) {
    const rootStat = statSyncSafe(root);
    if (rootStat && rootStat.mtimeMs > regStat.mtimeMs) return true;
  }
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as { entries?: Array<{ path?: string }> };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (!entry.path) continue;
      const entryStat = statSyncSafe(entry.path);
      if (!entryStat || entryStat.mtimeMs > regStat.mtimeMs) return true;
    }
  } catch {
    return true;
  }
  return false;
}

function hasAnyExternalAgentSkill(scopeRoot: string, rootSegmentsList: readonly (readonly [string, string])[]): boolean {
  for (const [dir, sub] of rootSegmentsList) {
    const rootPath = join(scopeRoot, dir, sub);
    if (!existsSync(rootPath)) continue;
    try {
      for (const name of readdirSync(rootPath)) {
        if (name.startsWith('.') || !isAgentSkillName(name)) continue;
        if (statSyncSafe(join(rootPath, name, AGENT_SKILL_FILE_NAME))?.isFile()) return true;
      }
    } catch { /* ignore unreadable root */ }
  }
  return false;
}

/**
 * Automatically build missing or refresh stale skill registries before querying
 * Skills Index. Clean projects without any managed or agent skill directories
 * are left untouched so empty `.imc/skills/registry.json` files are never created.
 */
export function ensureFreshSkillRegistries(input: {
  homeDir?: string;
  projectDir?: string;
  context?: SkillProjectContext;
} = {}): { rebuiltUser: boolean; rebuiltProject: boolean } {
  const homeDir = input.homeDir ?? homedir();
  const userManagedRoot = getUserSkillRoot(homeDir, imcodesStateDirForHome(homeDir));
  const userRegPath = join(userManagedRoot, SKILL_REGISTRY_FILE_NAME);
  const userRoots = [userManagedRoot, ...AGENT_SKILLS_USER_ROOT_SEGMENTS.map(([dir, sub]) => join(homeDir, dir, sub))];
  const userLockPath = join(homeDir, ...AGENT_SKILLS_LOCK_FILE_SEGMENTS);

  let rebuiltUser = false;
  if (!existsSync(userRegPath)) {
    const excludeRootDirectories = isManagedSkillStoreEstablished(homeDir) ? [MANAGED_SKILL_DIRECTORY] : [];
    const hasUserSkills = listMarkdownFiles(userManagedRoot, { maxFiles: 1, excludeRootDirectories }).length > 0
      || hasAnyExternalAgentSkill(homeDir, AGENT_SKILLS_USER_ROOT_SEGMENTS);
    if (hasUserSkills) {
      buildUserSkillRegistry({ homeDir, context: input.context });
      rebuiltUser = true;
    }
  } else if (isRegistryFileStale(userRegPath, userRoots, userLockPath)) {
    buildUserSkillRegistry({ homeDir, context: input.context });
    rebuiltUser = true;
  }

  let rebuiltProject = false;
  const projectDir = input.projectDir?.trim();
  if (projectDir) {
    const projManagedRoot = getProjectSkillEscapeHatchDir(projectDir);
    const projRegPath = join(projManagedRoot, SKILL_REGISTRY_FILE_NAME);
    const projRoots = [projManagedRoot, ...AGENT_SKILLS_PROJECT_ROOT_SEGMENTS.map(([dir, sub]) => join(projectDir, dir, sub))];
    const projLockPath = join(projectDir, AGENT_SKILLS_PROJECT_LOCK_FILE);

    if (!existsSync(projRegPath)) {
      const hasProjSkills = listMarkdownFiles(projManagedRoot, { maxFiles: 1 }).length > 0
        || hasAnyExternalAgentSkill(projectDir, AGENT_SKILLS_PROJECT_ROOT_SEGMENTS);
      if (hasProjSkills) {
        buildProjectSkillRegistry({ projectDir });
        rebuiltProject = true;
      }
    } else if (isRegistryFileStale(projRegPath, projRoots, projLockPath)) {
      buildProjectSkillRegistry({ projectDir });
      rebuiltProject = true;
    }
  }

  return { rebuiltUser, rebuiltProject };
}

export function buildSkillRegistryEntryForWrittenUserSkill(input: {
  homeDir: string;
  path: string;
  skillName: string;
  category: string;
  description?: string;
  project?: SkillProjectContext;
  now?: number;
}): SkillRegistryEntry {
  const metadata = {
    schemaVersion: 1 as const,
    name: input.skillName,
    category: input.category,
    description: input.description,
    project: input.project,
  };
  const source = createSkillSource({
    layer: input.project ? 'user_project' : 'user_default',
    metadata,
    content: '',
    path: input.path,
  });
  return skillRegistryEntryFromSource(source, {
    path: input.path,
    homeDir: input.homeDir,
    updatedAt: input.now ?? Date.now(),
  });
}

export const SKILL_REGISTRY_BUILDER_TESTING = {
  listMarkdownFiles,
  displayPathFor,
  fallbackNameFromPath,
  constants: {
    projectSkillEscapeHatchDir: PROJECT_SKILL_ESCAPE_HATCH_DIR,
  },
};
