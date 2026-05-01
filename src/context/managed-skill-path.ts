import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { getProjectSkillEscapeHatchDir, getUserSkillRoot } from '../../shared/skill-store.js';

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
    { kind: 'user', root: resolve(getUserSkillRoot(input.homeDir ?? homedir())) },
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
