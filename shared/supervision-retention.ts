import {
  isSupervisionTaskLifecycleStatus,
  isTerminalSupervisionTaskStatus,
} from './supervision-config.js';

/** Bounded retention for daemon-owned, reproducible supervision artifacts. */
export const SUPERVISION_RETENTION_SCAN_LIMIT = 256 as const;
export const SUPERVISION_RETENTION_MAX_CANDIDATES_PER_ROOT = 4096 as const;
export const SUPERVISION_RETENTION_MAX_DESCENT_DEPTH = 32 as const;
export const SUPERVISION_RETENTION_ROTATION_MS = 10 * 60_000;
/** Seven-day fallback for non-finalized terminal scratch. */
export const SUPERVISION_SCRATCH_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** One-day default for scratch whose owning task is finalized/merged. */
export const SUPERVISION_FINALIZED_SCRATCH_RETENTION_MS = 24 * 60 * 60_000;
/** Fourteen-day fallback for non-finalized terminal bundles. */
export const SUPERVISION_BUNDLE_TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60_000;
/** One-hour safety window for a finalized task's immutable bundle. */
export const SUPERVISION_FINALIZED_BUNDLE_RETENTION_MS = 60 * 60_000;
/** Seven-day default for legacy local-only worktree backup patches. */
export const SUPERVISION_WORKTREE_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const SUPERVISION_ARTIFACT_ORPHAN_GRACE_MS = 30 * 24 * 60 * 60_000;
export const SUPERVISION_WORKTREE_HANDOFF_GRACE_MS = 24 * 60 * 60_000;
export const SUPERVISION_QUARANTINE_GRACE_MS = 24 * 60 * 60_000;

export const SUPERVISION_RETENTION_ENV = Object.freeze({
  scratchMs: 'IMCODES_SUPERVISION_SCRATCH_RETENTION_MS',
  bundleMs: 'IMCODES_SUPERVISION_BUNDLE_RETENTION_MS',
  finalizedScratchMs: 'IMCODES_SUPERVISION_FINALIZED_SCRATCH_RETENTION_MS',
  finalizedBundleMs: 'IMCODES_SUPERVISION_FINALIZED_BUNDLE_RETENTION_MS',
  worktreeBackupMs: 'IMCODES_SUPERVISION_WORKTREE_BACKUP_RETENTION_MS',
} as const);

export const SUPERVISION_WORKTREE_TERMINAL_ASSIGNMENT_STATUSES = Object.freeze([
  'finalized', 'cancelled', 'recovered',
] as const);

export function isTerminalSupervisionWorktreeAssignmentStatus(value: string): boolean {
  return (SUPERVISION_WORKTREE_TERMINAL_ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

export function isTerminalSupervisionWorktreeTaskStatus(value: string): boolean {
  return isSupervisionTaskLifecycleStatus(value) && isTerminalSupervisionTaskStatus(value);
}
