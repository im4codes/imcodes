import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
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
import { assertManagedSkillPathSync } from './managed-skill-path.js';

const MAX_SKILL_FILES = 64;
const MAX_SCAN_DEPTH = 4;
const SKILL_REGISTRY_BUILDER_SOURCE = 'skill-registry-builder';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function listMarkdownFiles(root: string, options: { maxFiles?: number; maxDepth?: number } = {}): string[] {
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

export function buildUserSkillRegistry(input: { homeDir?: string; context?: SkillProjectContext } = {}): SkillRegistrySnapshot {
  const homeDir = input.homeDir ?? homedir();
  const root = getUserSkillRoot(homeDir);
  const entries: SkillRegistryEntry[] = [];
  for (const path of listMarkdownFiles(root)) {
    try {
      assertManagedSkillPathSync({ path, homeDir, maxBytes: SKILL_MAX_BYTES });
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
  return writeRegistry(join(root, SKILL_REGISTRY_FILE_NAME), entries);
}

export function buildProjectSkillRegistry(input: { projectDir: string }): SkillRegistrySnapshot {
  const root = getProjectSkillEscapeHatchDir(input.projectDir);
  const entries: SkillRegistryEntry[] = [];
  for (const path of listMarkdownFiles(root)) {
    try {
      assertManagedSkillPathSync({ path, projectDir: input.projectDir, maxBytes: SKILL_MAX_BYTES });
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
  return writeRegistry(join(root, SKILL_REGISTRY_FILE_NAME), entries);
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
