import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, type Stats } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { CAPABILITY_LIMITS } from '../../shared/capability-management.js';
import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';

export const MANAGED_SKILL_PACKAGE_LIMITS = {
  maxFiles: CAPABILITY_LIMITS.FILE_COUNT,
  maxDepth: CAPABILITY_LIMITS.TREE_DEPTH,
  maxFileBytes: CAPABILITY_LIMITS.FILE_BYTES,
  maxPackageBytes: CAPABILITY_LIMITS.PACKAGE_BYTES,
  maxSkillMarkdownBytes: 256 * 1024,
  maxDescriptionChars: 1024,
  maxCompatibilityChars: 500,
} as const;

export const AGENT_SKILL_FILE_NAME = 'SKILL.md' as const;
export const MANAGED_SKILL_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANAGED_SKILL_PACKAGE_KINDS = ['skill'] as const;

export interface AgentSkillFrontMatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

export interface AgentSkillPackageFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}

export interface AgentSkillPackageInventory {
  root: string;
  frontMatter: AgentSkillFrontMatter;
  instructions: string;
  files: AgentSkillPackageFile[];
  treeDigest: string;
  totalBytes: number;
}

export interface AgentSkillInventoryOptions {
  /** Test-only race seam invoked after the package file descriptor is open. */
  afterFileOpen?: (path: string) => void;
}

export interface ManagedSkillVersionManifest {
  schemaVersion: typeof MANAGED_SKILL_MANIFEST_SCHEMA_VERSION;
  kind: 'skill';
  registryId: string;
  versionId: string;
  treeDigest: string;
  name: string;
  description: string;
  source: string;
  createdAt: number;
  files: AgentSkillPackageFile[];
  scannerDigest: string;
  auditDigest: string;
  auditPolicyVersion: string;
}

export type AgentSkillPackageErrorCode =
  | 'invalid_frontmatter'
  | 'invalid_skill_name'
  | 'invalid_description'
  | 'missing_skill_markdown'
  | 'path_escape'
  | 'link_not_allowed'
  | 'special_file_not_allowed'
  | 'package_too_large'
  | typeof FS_READ_ERROR_CODES.FILE_TOO_LARGE
  | 'too_many_files'
  | 'too_deep'
  | 'invalid_utf8';

export class AgentSkillPackageError extends Error {
  constructor(readonly code: AgentSkillPackageErrorCode, message: string = code) {
    super(message);
    this.name = 'AgentSkillPackageError';
  }
}

const AGENT_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertBoundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new AgentSkillPackageError('invalid_frontmatter', `${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new AgentSkillPackageError('invalid_frontmatter', `${label} is outside its length bound`);
  }
  return normalized;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSkillPackageError('invalid_frontmatter', 'metadata must be a string map');
  }
  const entries = Object.entries(value);
  if (entries.length > 64) throw new AgentSkillPackageError('invalid_frontmatter', 'metadata has too many entries');
  return Object.fromEntries(entries.map(([key, entry]) => [
    assertBoundedString(key, 'metadata key', 128),
    assertBoundedString(entry, `metadata.${key}`, 1024),
  ]));
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === 'string' ? value.split(/\s+/) : value;
  if (!Array.isArray(raw) || raw.length > 64) {
    throw new AgentSkillPackageError('invalid_frontmatter', 'allowed-tools must be a bounded string list');
  }
  return raw.map((item) => assertBoundedString(item, 'allowed-tools item', 128));
}

export function parseAgentSkillMarkdown(markdown: string): { frontMatter: AgentSkillFrontMatter; instructions: string } {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) {
    throw new AgentSkillPackageError('invalid_frontmatter', 'SKILL.md must start with YAML frontmatter');
  }
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new AgentSkillPackageError('invalid_frontmatter', 'SKILL.md frontmatter is not closed');
  const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) throw new AgentSkillPackageError('invalid_frontmatter');
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentSkillPackageError('invalid_frontmatter');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new AgentSkillPackageError('invalid_frontmatter', `Unsupported frontmatter key: ${unknown}`);
  const name = assertBoundedString(record.name, 'name', 64);
  if (!AGENT_SKILL_NAME_PATTERN.test(name)) throw new AgentSkillPackageError('invalid_skill_name');
  const description = assertBoundedString(
    record.description,
    'description',
    MANAGED_SKILL_PACKAGE_LIMITS.maxDescriptionChars,
  );
  const compatibility = record.compatibility === undefined
    ? undefined
    : assertBoundedString(record.compatibility, 'compatibility', MANAGED_SKILL_PACKAGE_LIMITS.maxCompatibilityChars);
  return {
    frontMatter: {
      name,
      description,
      ...(record.license === undefined ? {} : { license: assertBoundedString(record.license, 'license', 256) }),
      ...(compatibility ? { compatibility } : {}),
      ...(record.metadata === undefined ? {} : { metadata: stringMap(record.metadata) }),
      ...(record['allowed-tools'] === undefined ? {} : { allowedTools: parseAllowedTools(record['allowed-tools']) }),
    },
    instructions: match[2].trim(),
  };
}

function normalizedRelativePath(root: string, path: string): string {
  const rel = relative(root, path).split(sep).join('/');
  if (!rel || rel.startsWith('../') || rel.includes('\0') || rel.includes(':') || isAbsolute(rel)) {
    throw new AgentSkillPackageError('path_escape');
  }
  return rel.normalize('NFC');
}

function assertUtf8(buffer: Buffer): void {
  const decoded = buffer.toString('utf8');
  if (decoded.includes('\uFFFD') || !Buffer.from(decoded, 'utf8').equals(buffer)) {
    throw new AgentSkillPackageError('invalid_utf8');
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readConsistentRegularFile(
  path: string,
  expected: Stats | undefined,
  afterFileOpen?: (path: string) => void,
): { bytes: Buffer; stat: Stats } {
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink > 1 || (expected && (!sameFile(before, expected)
      || before.size !== expected.size || before.mode !== expected.mode))) {
      throw new AgentSkillPackageError('link_not_allowed', 'Package file changed before its bounded read');
    }
    afterFileOpen?.(path);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    const currentPath = lstatSync(path);
    if (offset !== before.size || !sameFile(before, after) || !sameFile(after, currentPath)
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !currentPath.isFile() || currentPath.nlink > 1) {
      throw new AgentSkillPackageError('path_escape', 'Package file changed during its bounded read');
    }
    return { bytes, stat: after };
  } finally {
    closeSync(descriptor);
  }
}

export function readInventoryFileConsistent(inventory: AgentSkillPackageInventory, relativePath: string): Buffer {
  const entry = inventory.files.find((candidate) => candidate.path === relativePath);
  if (!entry) throw new AgentSkillPackageError('path_escape', 'File is outside the reviewed package inventory');
  const path = resolve(inventory.root, relativePath);
  if (normalizedRelativePath(inventory.root, path) !== relativePath) throw new AgentSkillPackageError('path_escape');
  const { bytes, stat } = readConsistentRegularFile(path, undefined);
  if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256
    || ((stat.mode & 0o111) !== 0) !== entry.executable) {
    throw new AgentSkillPackageError('path_escape', 'Package file no longer matches the reviewed inventory');
  }
  return bytes;
}

export function inventoryAgentSkillPackage(rootInput: string, options: AgentSkillInventoryOptions = {}): AgentSkillPackageInventory {
  const root = resolve(rootInput);
  const files: AgentSkillPackageFile[] = [];
  const foldedPaths = new Set<string>();
  let skillMarkdown: Buffer | undefined;
  let totalBytes = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > MANAGED_SKILL_PACKAGE_LIMITS.maxDepth) throw new AgentSkillPackageError('too_deep');
    for (const name of readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new AgentSkillPackageError('link_not_allowed');
      if (stat.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new AgentSkillPackageError('special_file_not_allowed');
      if (stat.nlink > 1) throw new AgentSkillPackageError('link_not_allowed', 'Hard-linked files are not allowed');
      if (files.length >= MANAGED_SKILL_PACKAGE_LIMITS.maxFiles) throw new AgentSkillPackageError('too_many_files');
      if (stat.size > MANAGED_SKILL_PACKAGE_LIMITS.maxFileBytes) {
        throw new AgentSkillPackageError(FS_READ_ERROR_CODES.FILE_TOO_LARGE);
      }
      totalBytes += stat.size;
      if (totalBytes > MANAGED_SKILL_PACKAGE_LIMITS.maxPackageBytes) throw new AgentSkillPackageError('package_too_large');
      const relativePath = normalizedRelativePath(root, path);
      const folded = relativePath.normalize('NFKC').toLocaleLowerCase('en-US');
      if (foldedPaths.has(folded)) throw new AgentSkillPackageError('path_escape', 'Duplicate normalized package path');
      foldedPaths.add(folded);
      const { bytes: content } = readConsistentRegularFile(path, stat, options.afterFileOpen);
      if (/\.(?:md|txt|json|ya?ml|toml|js|mjs|cjs|ts|tsx|jsx|py|rb|sh|bash|zsh|ps1|cmd|bat)$/i.test(relativePath)) {
        assertUtf8(content);
      }
      files.push({
        path: relativePath,
        size: stat.size,
        sha256: sha256(content),
        executable: (stat.mode & 0o111) !== 0,
      });
      if (relativePath === AGENT_SKILL_FILE_NAME) skillMarkdown = content;
    }
  };
  visit(root, 0);
  // Locale-dependent collation would make the signed tree digest vary across
  // machines. Sort normalized UTF-8 paths by JavaScript code-point order.
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const skillEntry = files.find((file) => file.path === AGENT_SKILL_FILE_NAME);
  if (!skillEntry) throw new AgentSkillPackageError('missing_skill_markdown');
  if (skillEntry.size > MANAGED_SKILL_PACKAGE_LIMITS.maxSkillMarkdownBytes) {
    throw new AgentSkillPackageError(FS_READ_ERROR_CODES.FILE_TOO_LARGE);
  }
  if (!skillMarkdown) throw new AgentSkillPackageError('missing_skill_markdown');
  const markdown = skillMarkdown.toString('utf8');
  const parsed = parseAgentSkillMarkdown(markdown);
  const treeDigest = sha256(files.map((file) => `${file.path}\0${file.size}\0${file.sha256}\0${file.executable ? 1 : 0}`).join('\n'));
  return { root, ...parsed, files, treeDigest, totalBytes };
}

export function assertManifestMatchesPackage(manifest: ManagedSkillVersionManifest, packageRoot: string): AgentSkillPackageInventory {
  const inventory = inventoryAgentSkillPackage(packageRoot);
  const filesMatch = manifest.files.length === inventory.files.length
    && manifest.files.every((entry, index) => {
      const actual = inventory.files[index];
      return actual?.path === entry.path
        && actual.size === entry.size
        && actual.sha256 === entry.sha256
        && actual.executable === entry.executable;
    });
  if (manifest.treeDigest !== inventory.treeDigest
    || manifest.name !== inventory.frontMatter.name
    || manifest.description !== inventory.frontMatter.description
    || !filesMatch) {
    throw new AgentSkillPackageError('path_escape', 'Managed Skill manifest does not match package');
  }
  return inventory;
}

export const AGENT_SKILL_PACKAGE_TESTING = {
  basename,
};
