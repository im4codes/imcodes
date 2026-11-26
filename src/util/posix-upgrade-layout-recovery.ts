import { DAEMON_UPGRADE_BLOCK_REASON } from '../../shared/daemon-upgrade.js';

export const POSIX_UPGRADE_INSTALL_FAILURE_EXIT_CODE = 75;

export interface PosixUpgradeFailureStatus {
  state: 'blocked';
  reason: typeof DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED;
  retryReason: string;
  attempts: number;
  exitCode: number;
}

/**
 * Parse the status marker written by the detached POSIX upgrade script.
 * Keep this strict: the marker crosses a process boundary and is later
 * forwarded to the server as diagnostics.
 */
export function parsePosixUpgradeFailureStatus(raw: string): PosixUpgradeFailureStatus | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.state !== 'blocked' || value.reason !== DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED) return null;
    if (typeof value.retryReason !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.retryReason)) return null;
    if (!Number.isInteger(value.attempts) || (value.attempts as number) < 1 || (value.attempts as number) > 100) return null;
    if (!Number.isInteger(value.exitCode) || (value.exitCode as number) < 1 || (value.exitCode as number) > 255) return null;
    return {
      state: 'blocked',
      reason: DAEMON_UPGRADE_BLOCK_REASON.INSTALL_FAILED,
      retryReason: value.retryReason,
      attempts: value.attempts as number,
      exitCode: value.exitCode as number,
    };
  } catch {
    return null;
  }
}

/**
 * Bash helpers embedded verbatim in the detached Linux/macOS upgrade script.
 *
 * npm atomically renames the installed global package to a sibling named
 * `.imcodes-<suffix>` during reify. If an earlier install was interrupted,
 * that deterministic staging destination can remain non-empty and every later
 * install fails before the new package's preinstall hook can run.
 */
export function buildPosixUpgradeLayoutRecoveryScript(): string {
  return `
npm_error_field() {
  local output_file="$1"
  local wanted="$2"
  awk -v wanted="$wanted" '
    $1 == "npm" && ($2 == "error" || $2 == "ERR!") && $3 == wanted {
      $1 = ""; $2 = ""; $3 = ""
      sub(/^[[:space:]]+/, "")
      value = $0
    }
    END {
      if (value != "") print value
    }
  ' "$output_file" 2>/dev/null
}

is_safe_global_root() {
  local global_root="$1"
  case "$global_root" in
    /*) ;;
    *) return 1 ;;
  esac
  [ "$global_root" != "/" ] && [ -d "$global_root" ]
}

is_imcodes_staging_path() {
  local global_root="$1"
  local candidate="$2"
  local suffix
  is_safe_global_root "$global_root" || return 1
  case "$candidate" in
    "$global_root"/.imcodes-*) ;;
    *) return 1 ;;
  esac
  suffix=\${candidate#"$global_root"/.imcodes-}
  case "$suffix" in
    ''|*/*) return 1 ;;
  esac
  return 0
}

cleanup_stale_imcodes_staging_dirs() {
  local global_root="$1"
  local min_age_seconds="$2"
  local stale
  local modified_at
  local now
  local age
  local cleanup_failed=0
  if ! is_safe_global_root "$global_root"; then
    log "[step 1.5] refusing stale staging cleanup for unsafe global root: \${global_root:-<empty>}"
    return 1
  fi
  case "$min_age_seconds" in
    ''|*[!0-9]*)
      log "[step 1.5] refusing stale staging cleanup with invalid age threshold: \${min_age_seconds:-<empty>}"
      return 1
      ;;
  esac
  now=$(date +%s)
  for stale in "$global_root"/.imcodes-*; do
    if [ ! -e "$stale" ] && [ ! -L "$stale" ]; then
      continue
    fi
    if ! is_imcodes_staging_path "$global_root" "$stale"; then
      log "[step 1.5] skipped unexpected staging path: $stale"
      cleanup_failed=1
      continue
    fi
    # The daemon upgrade lock cannot coordinate with a user running npm
    # manually. A freshly-created .imcodes-* directory may therefore belong
    # to an active external npm reify and must not be removed by this broad
    # sweep. Recent collisions are handled later from npm's exact rename
    # error, where the reported destination proves which path blocked us.
    modified_at=$(stat -c %Y "$stale" 2>/dev/null || stat -f %m "$stale" 2>/dev/null || true)
    case "$modified_at" in
      ''|*[!0-9]*)
        log "[step 1.5] preserving staging directory with unknown age: $stale"
        continue
        ;;
    esac
    age=$((now - modified_at))
    if [ "$age" -lt 0 ] || [ "$age" -lt "$min_age_seconds" ]; then
      log "[step 1.5] preserving recent npm staging directory (age \${age}s): $stale"
      continue
    fi
    log "[step 1.5] removing stale npm staging directory: $stale"
    if ! rm -rf -- "$stale"; then
      log "[step 1.5] failed to remove stale npm staging directory: $stale"
      cleanup_failed=1
    fi
  done
  return "$cleanup_failed"
}

is_recoverable_layout_output() {
  local output_file="$1"
  local global_root="$2"
  local error_code
  local error_syscall
  local error_path
  local error_dest
  error_code=$(npm_error_field "$output_file" code)
  error_syscall=$(npm_error_field "$output_file" syscall)
  error_path=$(npm_error_field "$output_file" path)
  error_dest=$(npm_error_field "$output_file" dest)
  case "$error_code" in
    ENOTEMPTY|EEXIST) ;;
    *) return 1 ;;
  esac
  [ "$error_syscall" = "rename" ] || return 1
  [ "$error_path" = "$global_root/imcodes" ] || return 1
  is_imcodes_staging_path "$global_root" "$error_dest"
}

recover_stale_layout_from_output() {
  local output_file="$1"
  local global_root="$2"
  local error_dest
  is_recoverable_layout_output "$output_file" "$global_root" || return 1
  error_dest=$(npm_error_field "$output_file" dest)
  if [ ! -e "$error_dest" ] && [ ! -L "$error_dest" ]; then
    log "[step 2] stale npm staging destination already absent: $error_dest"
    return 0
  fi
  log "[step 2] removing npm staging destination from rename failure: $error_dest"
  rm -rf -- "$error_dest"
}
`;
}
