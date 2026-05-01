import { join } from 'node:path';
import {
  validateBuiltinSkillManifest,
  type BuiltinSkillManifestEntry,
} from './builtin-skill-manifest.js';
import type { MemoryOrigin } from './memory-origin.js';

export const SKILL_FRONT_MATTER_DELIMITER = '---';
export const SKILL_FILE_EXTENSION = '.md';
export const PROJECT_SKILL_ESCAPE_HATCH_DIR = '.imc/skills';
export const USER_SKILL_ROOT_DIR = '.imcodes/skills';
export const DEFAULT_SKILL_CATEGORY = 'general';
export const SKILL_IMPORT_ORIGIN = 'skill_import' satisfies MemoryOrigin;

export const SKILL_LAYERS = [
  'project_escape_hatch',
  'user_project',
  'user_default',
  'workspace_shared',
  'org_shared',
  'builtin_fallback',
] as const;
export type SkillLayer = (typeof SKILL_LAYERS)[number];

export const SHARED_SKILL_LAYERS = ['workspace_shared', 'org_shared'] as const;
export type SharedSkillLayer = (typeof SHARED_SKILL_LAYERS)[number];

export const SKILL_ENFORCEMENT_MODES = ['additive', 'enforced'] as const;
export type SkillEnforcementMode = (typeof SKILL_ENFORCEMENT_MODES)[number];
export const DEFAULT_SHARED_SKILL_ENFORCEMENT = 'additive' as const satisfies SkillEnforcementMode;

export const SKILL_ADMIN_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type SkillAdminRole = (typeof SKILL_ADMIN_ROLES)[number];
export const SKILL_PUSH_SAFE_REJECTION_CODE = 'not_found_or_unauthorized' as const;
export const SKILL_PUSH_ACCEPTED_CODE = 'accepted' as const;
export const SKILL_PUSH_INVALID_REQUEST_CODE = 'invalid_request' as const;
export const SKILL_PUSH_INVALID_SCOPE_REASON = 'invalid_scope' as const;
export const SKILL_PUSH_INVALID_SKILL_REASON = 'invalid_skill' as const;

export interface SkillProjectAssociation {
  canonicalRepoId?: string;
  projectId?: string;
  workspaceId?: string;
  orgId?: string;
  rootPath?: string;
}

export interface SkillProjectContext extends SkillProjectAssociation {}

export interface SkillMetadata {
  schemaVersion: 1;
  name: string;
  category: string;
  description?: string;
  project?: SkillProjectAssociation;
  enforcement?: SkillEnforcementMode;
}

export interface ParsedSkillMarkdown {
  metadata: SkillMetadata;
  content: string;
  frontMatter: Record<string, unknown>;
}

export interface SkillSource {
  id: string;
  key: string;
  layer: SkillLayer;
  metadata: SkillMetadata;
  content: string;
  origin: typeof SKILL_IMPORT_ORIGIN;
  path?: string;
  enforcement?: SkillEnforcementMode;
}

export interface SkillSourceInput {
  layer: SkillLayer;
  metadata: SkillMetadata | Record<string, unknown>;
  content: string;
  path?: string;
  enforcement?: SkillEnforcementMode;
  fallbackName?: string;
  fallbackCategory?: string;
}

export interface SkillMarkdownSourceInput {
  layer: SkillLayer;
  markdown: string;
  path?: string;
  fallbackName?: string;
  fallbackCategory?: string;
  enforcement?: SkillEnforcementMode;
}

export interface SharedSkillMirrorRecord {
  layer: SharedSkillLayer;
  scopeId: string;
  markdown: string;
  path?: string;
  enforcement?: SkillEnforcementMode;
}

export type SharedSkillPushAuthorizationResult =
  | { ok: true; enforcement: SkillEnforcementMode }
  | { ok: false; code: typeof SKILL_PUSH_SAFE_REJECTION_CODE };

export interface SharedSkillPushAuthorizationInput {
  targetLayer: SharedSkillLayer | string;
  actorRole: SkillAdminRole | string;
  enforcement?: SkillEnforcementMode;
}

export interface SharedSkillPushInput extends SharedSkillPushAuthorizationInput {
  scopeId: string;
  markdown: string;
  path?: string;
}

export type SharedSkillPushResult =
  | {
    ok: true;
    code: typeof SKILL_PUSH_ACCEPTED_CODE;
    record: SharedSkillMirrorRecord;
    source: SkillSource;
  }
  | {
    ok: false;
    code: typeof SKILL_PUSH_SAFE_REJECTION_CODE;
  }
  | {
    ok: false;
    code: typeof SKILL_PUSH_INVALID_REQUEST_CODE;
    reason: typeof SKILL_PUSH_INVALID_SCOPE_REASON | typeof SKILL_PUSH_INVALID_SKILL_REASON;
  };

export interface BuiltinSkillLoadOptions {
  builtinRoot?: string;
  readSkillContent?: (path: string, entry: BuiltinSkillManifestEntry) => string;
}

export interface SkillSelectionResult {
  ordinary: SkillSource[];
  enforced: SkillSource[];
  skipped: Array<{ id: string; reason: 'project_mismatch' | 'lower_precedence' }>;
}

export type SkillReviewWriteTarget =
  | { action: 'update_user_skill'; source: SkillSource }
  | { action: 'create_user_skill'; key: string };

const SKILL_LAYER_SET: ReadonlySet<string> = new Set(SKILL_LAYERS);
const SHARED_SKILL_LAYER_SET: ReadonlySet<string> = new Set(SHARED_SKILL_LAYERS);
const SKILL_ENFORCEMENT_MODE_SET: ReadonlySet<string> = new Set(SKILL_ENFORCEMENT_MODES);
const SKILL_ADMIN_ROLE_SET: ReadonlySet<string> = new Set(SKILL_ADMIN_ROLES);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid skill ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new Error(`Invalid skill metadata: ${key} must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function optionalVersion(record: Record<string, unknown>): 1 {
  const value = record.schemaVersion ?? record.schema_version ?? record.version;
  if (value === undefined || value === null) return 1;
  if (value !== 1) {
    throw new Error('Invalid skill metadata: schemaVersion must be 1');
  }
  return 1;
}

function normalizeSkillProjectAssociation(value: unknown): SkillProjectAssociation | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const canonicalRepoId = value.trim();
    if (canonicalRepoId.length === 0) return undefined;
    return { canonicalRepoId };
  }
  const record = asRecord(value, 'project association');
  const project = {
    canonicalRepoId: optionalString(record, 'canonicalRepoId', 'canonical_repo_id', 'repo', 'repoId', 'repo_id'),
    projectId: optionalString(record, 'projectId', 'project_id'),
    workspaceId: optionalString(record, 'workspaceId', 'workspace_id'),
    orgId: optionalString(record, 'orgId', 'org_id', 'enterpriseId', 'enterprise_id'),
    rootPath: optionalString(record, 'rootPath', 'root_path'),
  } satisfies SkillProjectAssociation;
  return Object.values(project).some((entry) => entry !== undefined) ? project : undefined;
}

function normalizeSkillEnforcement(value: unknown): SkillEnforcementMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !SKILL_ENFORCEMENT_MODE_SET.has(value)) {
    throw new Error('Invalid skill metadata: enforcement must be additive or enforced');
  }
  return value as SkillEnforcementMode;
}

export function isSkillLayer(value: unknown): value is SkillLayer {
  return typeof value === 'string' && SKILL_LAYER_SET.has(value);
}

export function isSharedSkillLayer(value: unknown): value is SharedSkillLayer {
  return typeof value === 'string' && SHARED_SKILL_LAYER_SET.has(value);
}

export function isSkillEnforcementMode(value: unknown): value is SkillEnforcementMode {
  return typeof value === 'string' && SKILL_ENFORCEMENT_MODE_SET.has(value);
}

export function isSkillAdminRole(value: unknown): value is SkillAdminRole {
  return typeof value === 'string' && SKILL_ADMIN_ROLE_SET.has(value);
}

export function normalizeSkillMetadata(
  value: SkillMetadata | Record<string, unknown>,
  fallback?: { name?: string; category?: string },
): SkillMetadata {
  const record = asRecord(value, 'metadata');
  const name = optionalString(record, 'name') ?? fallback?.name?.trim();
  const category = optionalString(record, 'category') ?? fallback?.category?.trim() ?? DEFAULT_SKILL_CATEGORY;
  if (!name || name.length === 0) {
    throw new Error('Invalid skill metadata: name is required');
  }
  if (!category || category.length === 0) {
    throw new Error('Invalid skill metadata: category is required');
  }
  return {
    schemaVersion: optionalVersion(record),
    name,
    category,
    description: optionalString(record, 'description'),
    project: normalizeSkillProjectAssociation(record.project),
    enforcement: normalizeSkillEnforcement(record.enforcement),
  };
}

function parseSkillScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const singleQuoted = trimmed.match(/^'(.*)'$/s);
  if (singleQuoted) return singleQuoted[1]?.replace(/''/g, "'") ?? '';
  const doubleQuoted = trimmed.match(/^"(.*)"$/s);
  if (doubleQuoted) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return doubleQuoted[1] ?? '';
    }
  }
  return trimmed;
}

function parseSkillFrontMatter(rawFrontMatter: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let currentObject: Record<string, unknown> | null = null;

  for (const rawLine of rawFrontMatter.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const topLevel = !/^\s/.test(rawLine);
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) {
      throw new Error(`Invalid skill front matter: unsupported YAML line "${trimmed}"`);
    }
    const key = match[1]!;
    const value = match[2] ?? '';
    if (topLevel) {
      if (value.trim().length === 0) {
        const nested: Record<string, unknown> = {};
        root[key] = nested;
        currentObject = nested;
        continue;
      }
      root[key] = parseSkillScalar(value);
      currentObject = null;
      continue;
    }
    if (!currentObject) {
      throw new Error(`Invalid skill front matter: nested key "${key}" has no parent`);
    }
    currentObject[key] = parseSkillScalar(value);
  }

  return root;
}

export function extractSkillFrontMatter(markdown: string): { frontMatter: Record<string, unknown>; content: string } {
  if (!markdown.startsWith(`${SKILL_FRONT_MATTER_DELIMITER}\n`) && !markdown.startsWith(`${SKILL_FRONT_MATTER_DELIMITER}\r\n`)) {
    return { frontMatter: {}, content: markdown };
  }
  const lineEnding = markdown.startsWith(`${SKILL_FRONT_MATTER_DELIMITER}\r\n`) ? '\r\n' : '\n';
  const close = `${lineEnding}${SKILL_FRONT_MATTER_DELIMITER}`;
  const closeIndex = markdown.indexOf(close, SKILL_FRONT_MATTER_DELIMITER.length + lineEnding.length);
  if (closeIndex < 0) {
    throw new Error('Invalid skill front matter: missing closing delimiter');
  }
  const rawFrontMatter = markdown.slice(SKILL_FRONT_MATTER_DELIMITER.length + lineEnding.length, closeIndex);
  const afterClose = closeIndex + close.length;
  const contentStart = markdown.startsWith(lineEnding, afterClose) ? afterClose + lineEnding.length : afterClose;
  const parsed = rawFrontMatter.trim().length === 0 ? {} : parseSkillFrontMatter(rawFrontMatter);
  return { frontMatter: asRecord(parsed, 'front matter'), content: markdown.slice(contentStart) };
}

export function parseSkillMarkdown(
  markdown: string,
  fallback?: { name?: string; category?: string },
): ParsedSkillMarkdown {
  const extracted = extractSkillFrontMatter(markdown);
  return {
    frontMatter: extracted.frontMatter,
    content: extracted.content,
    metadata: normalizeSkillMetadata(extracted.frontMatter, fallback),
  };
}

export function normalizeSkillKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

export function makeSkillKey(category: string, name: string): string {
  return `${normalizeSkillKeyPart(category)}/${normalizeSkillKeyPart(name)}`;
}

export function normalizeSkillPathSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (
    normalized.length === 0
    || normalized === '.'
    || normalized === '..'
    || normalized.includes('/')
    || normalized.includes('\\')
    || !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)
  ) {
    throw new Error(`Invalid skill path segment: ${value}`);
  }
  return normalized;
}

export function getProjectSkillEscapeHatchDir(projectRoot: string): string {
  return join(projectRoot, '.imc', 'skills');
}

export function getProjectSkillEscapeHatchPath(input: { projectRoot: string; category: string; skillName: string }): string {
  return join(
    getProjectSkillEscapeHatchDir(input.projectRoot),
    normalizeSkillPathSegment(input.category),
    `${normalizeSkillPathSegment(input.skillName)}${SKILL_FILE_EXTENSION}`,
  );
}

export function getUserSkillRoot(homeDir: string): string {
  return join(homeDir, '.imcodes', 'skills');
}

export function getUserSkillPath(input: { homeDir: string; category: string; skillName: string }): string {
  return join(
    getUserSkillRoot(input.homeDir),
    normalizeSkillPathSegment(input.category),
    `${normalizeSkillPathSegment(input.skillName)}${SKILL_FILE_EXTENSION}`,
  );
}

export function skillHasProjectAssociation(metadata: SkillMetadata): boolean {
  return metadata.project !== undefined;
}

export function skillMatchesProject(metadata: SkillMetadata, context: SkillProjectContext | undefined): boolean {
  if (!metadata.project) return true;
  if (!context) return false;
  const project = metadata.project;
  const comparisons: Array<keyof SkillProjectAssociation> = [
    'canonicalRepoId',
    'projectId',
    'workspaceId',
    'orgId',
    'rootPath',
  ];
  return comparisons.every((key) => {
    const expected = project[key];
    if (expected === undefined) return true;
    const actual = context[key];
    return typeof actual === 'string' && actual.trim() === expected;
  });
}

export function classifyUserSkillLayer(
  metadata: SkillMetadata,
  context: SkillProjectContext | undefined,
): 'user_project' | 'user_default' | null {
  if (!skillHasProjectAssociation(metadata)) return 'user_default';
  return skillMatchesProject(metadata, context) ? 'user_project' : null;
}

export function createSkillSource(input: SkillSourceInput): SkillSource {
  if (!isSkillLayer(input.layer)) {
    throw new Error(`Invalid skill layer: ${String(input.layer)}`);
  }
  const metadata = normalizeSkillMetadata(input.metadata, {
    name: input.fallbackName,
    category: input.fallbackCategory,
  });
  const key = makeSkillKey(metadata.category, metadata.name);
  const enforcement = isSharedSkillLayer(input.layer)
    ? (input.enforcement ?? metadata.enforcement ?? DEFAULT_SHARED_SKILL_ENFORCEMENT)
    : input.enforcement ?? metadata.enforcement;
  if (enforcement !== undefined && !isSkillEnforcementMode(enforcement)) {
    throw new Error('Invalid skill enforcement mode');
  }
  return {
    id: `${input.layer}:${key}${input.path ? `:${input.path}` : ''}`,
    key,
    layer: input.layer,
    metadata,
    content: input.content,
    origin: SKILL_IMPORT_ORIGIN,
    path: input.path,
    enforcement,
  };
}

export function skillSourceFromMarkdown(input: SkillMarkdownSourceInput): SkillSource {
  const parsed = parseSkillMarkdown(input.markdown, {
    name: input.fallbackName,
    category: input.fallbackCategory,
  });
  return createSkillSource({
    layer: input.layer,
    metadata: parsed.metadata,
    content: parsed.content,
    path: input.path,
    enforcement: input.enforcement,
  });
}

export function sharedSkillMirrorRecordToSource(record: SharedSkillMirrorRecord): SkillSource {
  if (!isSharedSkillLayer(record.layer)) {
    throw new Error(`Invalid shared skill mirror layer: ${String(record.layer)}`);
  }
  if (record.scopeId.trim().length === 0) {
    throw new Error('Invalid shared skill mirror: scopeId is required');
  }
  return skillSourceFromMarkdown({
    layer: record.layer,
    markdown: record.markdown,
    path: record.path,
    enforcement: record.enforcement,
  });
}

export function authorizeSharedSkillPush(input: SharedSkillPushAuthorizationInput): SharedSkillPushAuthorizationResult {
  if (!isSharedSkillLayer(input.targetLayer)) {
    return { ok: false, code: SKILL_PUSH_SAFE_REJECTION_CODE };
  }
  if (input.actorRole !== 'owner' && input.actorRole !== 'admin') {
    return { ok: false, code: SKILL_PUSH_SAFE_REJECTION_CODE };
  }
  return {
    ok: true,
    enforcement: input.enforcement ?? DEFAULT_SHARED_SKILL_ENFORCEMENT,
  };
}

/**
 * Shared server helper for admin-pushed workspace/org skills.
 *
 * Authorization intentionally runs before scope/content parsing so unauthorized
 * callers receive the same rejection shape for invalid layer, missing scope,
 * malformed markdown, and non-existent inventory.
 */
export function prepareSharedSkillPush(input: SharedSkillPushInput): SharedSkillPushResult {
  const authorized = authorizeSharedSkillPush(input);
  if (!authorized.ok) return authorized;

  const scopeId = input.scopeId.trim();
  if (scopeId.length === 0) {
    return {
      ok: false,
      code: SKILL_PUSH_INVALID_REQUEST_CODE,
      reason: SKILL_PUSH_INVALID_SCOPE_REASON,
    };
  }

  const record: SharedSkillMirrorRecord = {
    layer: input.targetLayer as SharedSkillLayer,
    scopeId,
    markdown: input.markdown,
    path: input.path,
    enforcement: authorized.enforcement,
  };

  try {
    return {
      ok: true,
      code: SKILL_PUSH_ACCEPTED_CODE,
      record,
      source: sharedSkillMirrorRecordToSource(record),
    };
  } catch {
    return {
      ok: false,
      code: SKILL_PUSH_INVALID_REQUEST_CODE,
      reason: SKILL_PUSH_INVALID_SKILL_REASON,
    };
  }
}

export function loadBuiltinSkillSources(manifestValue: unknown, options: BuiltinSkillLoadOptions = {}): SkillSource[] {
  const manifest = validateBuiltinSkillManifest(manifestValue);
  if (manifest.skills.length === 0) return [];
  if (!options.readSkillContent) {
    throw new Error('Built-in skill manifest contains skills but no readSkillContent adapter was provided');
  }
  return manifest.skills.map((entry) => {
    const skillPath = options.builtinRoot ? join(options.builtinRoot, entry.path) : entry.path;
    const markdown = options.readSkillContent?.(skillPath, entry);
    if (markdown === undefined) {
      throw new Error(`Built-in skill content missing: ${entry.path}`);
    }
    return skillSourceFromMarkdown({
      layer: 'builtin_fallback',
      markdown,
      path: skillPath,
      fallbackName: entry.name,
      fallbackCategory: entry.category,
    });
  });
}

const ORDINARY_LAYER_PRIORITY: Record<SkillLayer, number> = {
  project_escape_hatch: 0,
  user_project: 1,
  user_default: 2,
  workspace_shared: 3,
  org_shared: 4,
  builtin_fallback: 5,
};

export function selectSkillSourcesForContext(
  sources: readonly SkillSource[],
  context?: SkillProjectContext,
): SkillSelectionResult {
  const skipped: SkillSelectionResult['skipped'] = [];
  const ordinaryByKey = new Map<string, SkillSource>();
  const enforced: SkillSource[] = [];

  const sorted = [...sources].sort((a, b) => {
    const priorityDiff = ORDINARY_LAYER_PRIORITY[a.layer] - ORDINARY_LAYER_PRIORITY[b.layer];
    if (priorityDiff !== 0) return priorityDiff;
    return a.id.localeCompare(b.id);
  });

  for (const source of sorted) {
    if (!skillMatchesProject(source.metadata, context)) {
      skipped.push({ id: source.id, reason: 'project_mismatch' });
      continue;
    }
    if (source.enforcement === 'enforced') {
      enforced.push(source);
      continue;
    }
    if (ordinaryByKey.has(source.key)) {
      skipped.push({ id: source.id, reason: 'lower_precedence' });
      continue;
    }
    ordinaryByKey.set(source.key, source);
  }

  return {
    ordinary: [...ordinaryByKey.values()],
    enforced,
    skipped,
  };
}

export function chooseSkillReviewWriteTarget(input: {
  candidateKey: string;
  userSkillSources: readonly SkillSource[];
  context?: SkillProjectContext;
}): SkillReviewWriteTarget {
  const matchingUserSkill = input.userSkillSources.find((source) => (
    source.key === input.candidateKey
    && (source.layer === 'user_project' || source.layer === 'user_default')
    && skillMatchesProject(source.metadata, input.context)
  ));
  if (matchingUserSkill) {
    return { action: 'update_user_skill', source: matchingUserSkill };
  }
  return { action: 'create_user_skill', key: input.candidateKey };
}
