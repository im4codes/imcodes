import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import {
  AGENT_SKILL_FILE_NAME,
  AGENT_SKILLS_PROJECT_ROOT_SEGMENTS,
  AGENT_SKILLS_USER_ROOT_SEGMENTS,
  isAgentSkillName,
} from '../../shared/agent-skills.js';
import {
  getProjectSkillEscapeHatchDir,
  getUserSkillRoot,
  type SkillLayer,
} from '../../shared/skill-store.js';
import { imcodesStateDirForHome } from '../util/imcodes-state-dir.js';

export type ManagedSkillRootKind = 'user' | 'project';
export type ManagedSkillPathRejectReason =
  | 'nul_byte'
  | 'outside_managed_root'
  | 'managed_root_missing'
  | 'symlink_component'
  | 'not_file'
  | 'oversize';

export class ManagedSkillPathError extends Error {
  constructor(readonly reason: ManagedSkillPathRejectReason, message: string = reason) {
    super(message);
    this.name = 'ManagedSkillPathError';
  }
}

export interface ManagedSkillPathAssertion {
  rootKind: ManagedSkillRootKind;
  path: string;
  realPath: string;
  root: string;
  realRoot: string;
  size: number;
  externalAgentRoot?: boolean;
}

function isUnderRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function assertNoSymlinkDirectoryComponent(root: string, target: string): void {
  const rel = relative(root, dirname(target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
  let current = root;
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    current = `${current}${sep}${part}`;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new ManagedSkillPathError('symlink_component', `skill path contains symlink directory: ${current}`);
    }
  }
}

function assertNoSymlinkFileUnderRootSync(input: {
  rootKind: ManagedSkillRootKind;
  root: string;
  absolute: string;
  maxBytes?: number;
}): ManagedSkillPathAssertion {
  let realRoot: string;
  try {
    realRoot = realpathSync(input.root);
  } catch {
    throw new ManagedSkillPathError('managed_root_missing');
  }
  assertNoSymlinkDirectoryComponent(input.root, input.absolute);
  let lstat;
  try {
    lstat = lstatSync(input.absolute);
  } catch {
    throw new ManagedSkillPathError('not_file');
  }
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw new ManagedSkillPathError('not_file');
  if (input.maxBytes !== undefined && lstat.size > input.maxBytes) throw new ManagedSkillPathError('oversize');
  let realPath: string;
  try {
    realPath = realpathSync(input.absolute);
  } catch {
    throw new ManagedSkillPathError('not_file');
  }
  if (!isUnderRoot(realPath, realRoot)) throw new ManagedSkillPathError('outside_managed_root');
  const stat = statSync(realPath);
  if (!stat.isFile()) throw new ManagedSkillPathError('not_file');
  if (input.maxBytes !== undefined && stat.size > input.maxBytes) throw new ManagedSkillPathError('oversize');
  return {
    rootKind: input.rootKind,
    path: input.absolute,
    realPath,
    root: input.root,
    realRoot,
    size: stat.size,
  };
}

export function assertManagedSkillPathSync(input: {
  path: string;
  projectDir?: string;
  homeDir?: string;
  maxBytes?: number;
}): ManagedSkillPathAssertion {
  if (input.path.includes('\0')) throw new ManagedSkillPathError('nul_byte');
  const absolute = resolve(input.path);
  const candidates: Array<{ kind: ManagedSkillRootKind; root: string }> = [
    { kind: 'user', root: resolve(getUserSkillRoot(input.homeDir ?? homedir(), imcodesStateDirForHome(input.homeDir ?? homedir()))) },
  ];
  if (input.projectDir) {
    candidates.push({ kind: 'project', root: resolve(getProjectSkillEscapeHatchDir(input.projectDir)) });
  }

  for (const candidate of candidates) {
    if (!isUnderRoot(absolute, candidate.root)) continue;
    return assertNoSymlinkFileUnderRootSync({
      rootKind: candidate.kind,
      root: candidate.root,
      absolute,
      maxBytes: input.maxBytes,
    });
  }
  throw new ManagedSkillPathError('outside_managed_root');
}

/**
 * Validate a skill path for read/preview/runtime resolution.
 * Managed IM.codes stores (`~/.imcodes/skills`, `.imc/skills`) retain strict
 * no-symlink enforcement via `assertManagedSkillPathSync`.
 * External agent roots (`~/.claude/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`,
 * etc.) allow cross-agent symlinks/junctions (as created by `npx skills`)
 * provided the canonical skill directory remains inside `realHome` (for user
 * roots) or `realProject` (for project roots) and `SKILL.md` resolves directly
 * inside that canonical directory.
 */
export function assertReadableSkillPathSync(input: {
  path: string;
  projectDir?: string;
  homeDir?: string;
  maxBytes?: number;
}): ManagedSkillPathAssertion {
  if (input.path.includes('\0')) throw new ManagedSkillPathError('nul_byte');
  const absolute = resolve(input.path);
  const homeDir = input.homeDir ?? homedir();
  const userManagedRoot = resolve(getUserSkillRoot(homeDir, imcodesStateDirForHome(homeDir)));
  const projectManagedRoot = input.projectDir ? resolve(getProjectSkillEscapeHatchDir(input.projectDir)) : undefined;
  if (isUnderRoot(absolute, userManagedRoot) || (projectManagedRoot && isUnderRoot(absolute, projectManagedRoot))) {
    return assertManagedSkillPathSync(input);
  }

  const externalCandidates: Array<{ kind: ManagedSkillRootKind; root: string; scopeRoot: string }> = [];
  if (input.projectDir) {
    const resolvedProject = resolve(input.projectDir);
    for (const segments of AGENT_SKILLS_PROJECT_ROOT_SEGMENTS) {
      externalCandidates.push({
        kind: 'project',
        root: resolve(resolvedProject, ...segments),
        scopeRoot: resolvedProject,
      });
    }
  }
  const resolvedHome = resolve(homeDir);
  for (const segments of AGENT_SKILLS_USER_ROOT_SEGMENTS) {
    externalCandidates.push({
      kind: 'user',
      root: resolve(resolvedHome, ...segments),
      scopeRoot: resolvedHome,
    });
  }

  for (const candidate of externalCandidates) {
    if (!isUnderRoot(absolute, candidate.root)) continue;
    const rel = relative(candidate.root, absolute);
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    if (parts.length !== 2) throw new ManagedSkillPathError('outside_managed_root');
    const [skillName, fileName] = parts;
    if (!skillName || skillName.startsWith('.') || !isAgentSkillName(skillName) || fileName !== AGENT_SKILL_FILE_NAME) {
      throw new ManagedSkillPathError('outside_managed_root');
    }

    let realScopeRoot: string;
    try {
      realScopeRoot = realpathSync(candidate.scopeRoot);
    } catch {
      throw new ManagedSkillPathError('managed_root_missing');
    }

    const skillDir = dirname(absolute);
    let realDir: string;
    try {
      if (!statSync(skillDir).isDirectory()) throw new ManagedSkillPathError('not_file');
      realDir = realpathSync(skillDir);
    } catch (error) {
      if (error instanceof ManagedSkillPathError) throw error;
      throw new ManagedSkillPathError('not_file');
    }
    if (!isUnderRoot(realDir, realScopeRoot)) throw new ManagedSkillPathError('outside_managed_root');

    let realPath: string;
    try {
      realPath = realpathSync(absolute);
    } catch {
      throw new ManagedSkillPathError('not_file');
    }
    if (dirname(realPath) !== realDir) throw new ManagedSkillPathError('outside_managed_root');

    let stat;
    try {
      stat = statSync(realPath);
    } catch {
      throw new ManagedSkillPathError('not_file');
    }
    if (!stat.isFile()) throw new ManagedSkillPathError('not_file');
    if (input.maxBytes !== undefined && stat.size > input.maxBytes) throw new ManagedSkillPathError('oversize');

    return {
      rootKind: candidate.kind,
      path: absolute,
      realPath,
      root: candidate.root,
      realRoot: realDir,
      size: stat.size,
      externalAgentRoot: true,
    };
  }

  throw new ManagedSkillPathError('outside_managed_root');
}

/**
 * Validate a local registry `entry.path` payload before listing or reading it
 * via fallback/expansion:
 * - Managed stores (`~/.imcodes/skills`, `.imc/skills`) enforce strict
 *   no-symlink containment via `assertManagedSkillPathSync`.
 * - External agent roots enforce `assertReadableSkillPathSync` plus layer/scope
 *   parity (`project_escape_hatch` -> project root, user layers -> home root).
 * - Any legacy/custom non-managed non-agent registry path must stay strictly
 *   within the matching scope root with zero symlink components.
 */
export function assertSafeRegistryPayloadPathSync(input: {
  path: string;
  layer: SkillLayer;
  projectDir?: string;
  homeDir?: string;
  maxBytes?: number;
}): ManagedSkillPathAssertion {
  if (input.path.includes('\0')) throw new ManagedSkillPathError('nul_byte');
  const absolute = resolve(input.path);
  const homeDir = input.homeDir ?? homedir();
  const resolvedHome = resolve(homeDir);
  const resolvedProject = input.projectDir ? resolve(input.projectDir) : undefined;
  const userManagedRoot = resolve(getUserSkillRoot(homeDir, imcodesStateDirForHome(homeDir)));
  const projectManagedRoot = resolvedProject ? resolve(getProjectSkillEscapeHatchDir(resolvedProject)) : undefined;

  const expectProject = input.layer === 'project_escape_hatch';
  if (expectProject && !resolvedProject) {
    throw new ManagedSkillPathError('outside_managed_root');
  }

  if (isUnderRoot(absolute, userManagedRoot) || (projectManagedRoot && isUnderRoot(absolute, projectManagedRoot))) {
    const asserted = assertManagedSkillPathSync(input);
    if (expectProject && asserted.rootKind !== 'project') throw new ManagedSkillPathError('outside_managed_root');
    if (!expectProject && asserted.rootKind !== 'user') throw new ManagedSkillPathError('outside_managed_root');
    return asserted;
  }

  const matchesExternalProject = Boolean(resolvedProject && AGENT_SKILLS_PROJECT_ROOT_SEGMENTS.some(
    (segments) => isUnderRoot(absolute, resolve(resolvedProject, ...segments)),
  ));
  const matchesExternalUser = AGENT_SKILLS_USER_ROOT_SEGMENTS.some(
    (segments) => isUnderRoot(absolute, resolve(resolvedHome, ...segments)),
  );
  if (matchesExternalProject || matchesExternalUser) {
    const asserted = assertReadableSkillPathSync(input);
    if (expectProject && asserted.rootKind !== 'project') throw new ManagedSkillPathError('outside_managed_root');
    if (!expectProject && asserted.rootKind !== 'user') throw new ManagedSkillPathError('outside_managed_root');
    return asserted;
  }

  const scopeRoot = expectProject ? resolvedProject : resolvedHome;
  if (!scopeRoot || !isUnderRoot(absolute, scopeRoot)) {
    throw new ManagedSkillPathError('outside_managed_root');
  }
  return assertNoSymlinkFileUnderRootSync({
    rootKind: expectProject ? 'project' : 'user',
    root: scopeRoot,
    absolute,
    maxBytes: input.maxBytes,
  });
}
