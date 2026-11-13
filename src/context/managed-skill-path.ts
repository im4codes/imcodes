import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import {
  AGENT_SKILL_FILE_NAME,
  AGENT_SKILLS_PROJECT_ROOT_SEGMENTS,
  AGENT_SKILLS_USER_ROOT_SEGMENTS,
  isAgentSkillName,
} from '../../shared/agent-skills.js';
import { getProjectSkillEscapeHatchDir, getUserSkillRoot } from '../../shared/skill-store.js';
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
    let realRoot: string;
    try {
      realRoot = realpathSync(candidate.root);
    } catch {
      throw new ManagedSkillPathError('managed_root_missing');
    }
    assertNoSymlinkDirectoryComponent(candidate.root, absolute);
    let lstat;
    try {
      lstat = lstatSync(absolute);
    } catch {
      throw new ManagedSkillPathError('not_file');
    }
    if (!lstat.isFile() || lstat.isSymbolicLink()) throw new ManagedSkillPathError('not_file');
    if (input.maxBytes !== undefined && lstat.size > input.maxBytes) throw new ManagedSkillPathError('oversize');
    let realPath: string;
    try {
      realPath = realpathSync(absolute);
    } catch {
      throw new ManagedSkillPathError('not_file');
    }
    if (!isUnderRoot(realPath, realRoot)) throw new ManagedSkillPathError('outside_managed_root');
    const stat = statSync(realPath);
    if (!stat.isFile()) throw new ManagedSkillPathError('not_file');
    if (input.maxBytes !== undefined && stat.size > input.maxBytes) throw new ManagedSkillPathError('oversize');
    return {
      rootKind: candidate.kind,
      path: absolute,
      realPath,
      root: candidate.root,
      realRoot,
      size: stat.size,
    };
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
