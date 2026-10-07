import { basename, dirname, join } from 'node:path';
import {
  CONTROLLED_NODE_LINUX_WATCHDOG_SURVIVAL_MS,
  CONTROLLED_NODE_SERVICE,
  CONTROLLED_NODE_UPGRADE_BACKUP_SUFFIX,
  CONTROLLED_NODE_UPGRADE_RESULT_FILE,
  CONTROLLED_NODE_UPGRADE_RESULT_STATUS,
  CONTROLLED_NODE_WINDOWS_UPGRADE_PREFLIGHT_FAILED,
  CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT,
} from '../../shared/controlled-node-service.js';
import { REMOTE_DESKTOP_LINUX_WORKER_FILENAME } from '../../shared/remote-desktop-worker.js';
import { CONTROLLED_NODE_HEALTH_LEASE_FILE } from './health-lease.js';
import { LINUX_UNIT_PATH, MACOS_PLIST_PATH, MACOS_WATCHDOG_PLIST_PATH } from './installer.js';
import { posixUpgradeHealthWaitScript, posixUpgradePrimitivesScript } from './upgrade-health-script.js';

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface PosixControlledNodeUpgradeScriptInput {
  platform: 'darwin' | 'linux';
  stagedArtifactPath: string;
  stagedManifestPath: string;
  stagedComputerUseHelperDir?: string;
  // Swap the platform-root as one directory, matching Windows' own
  // stagedRemoteDesktopWorkerDir convention, so the installed layout stays
  // remote-desktop-worker/linux-x64/<worker+manifest> -- the exact path
  // resolveLinuxRemoteDesktopWorkerPath (linux-remote-desktop-worker-host.ts)
  // expects next to the main executable. darwin never passes this: its
  // remote-desktop component set is fetched by its own always-running
  // bootstrap coordinator (macos-remote-desktop-production.ts), not staged
  // through this upgrade script.
  stagedRemoteDesktopWorkerDir?: string;
  stagedJournalPath?: string;
  destinationPath: string;
  destinationManifestPath: string;
  destinationJournalPath?: string;
  /** Recorded in the durable result; the node compares it with the version it runs. */
  targetVersion?: string;
  /** Verified against the staged executable before anything is replaced. */
  artifactSha256?: string;
  /** Service definitions snapshotted and restored on rollback (defaults: the installed unit/plists). */
  serviceDefinitionPaths?: readonly string[];
  stagingOwnership?: {
    directoryPath: string;
    markerPath: string;
    ownerToken: string;
  };
}

/**
 * The POSIX self-upgrade, as one transaction.
 *
 *   preflight     verify the staged artifact (sha256, macOS signature) and stage every
 *                 replacement NEXT TO its destination. Nothing live is touched; any
 *                 failure (disk full, bad hash, bad signature) ends here with the
 *                 service still running the old node.
 *   install       record `in_progress`, stop the service, keep a rollback image of every
 *                 replaced artifact (hard link / rename: the old inode, and on macOS its
 *                 code-signing state, is never rewritten), publish the new ones by
 *                 rename(2).
 *   health        start the service and wait for the NEW node to publish a health lease
 *                 naming the service's own pid (see posixUpgradeHealthWaitScript for the
 *                 window, crash-loop and survival rules), sharing every number with the
 *                 Windows path.
 *   success       record `success`, drop the rollback images.
 *   rollback      anything above failing (or the script being asked to stop) restores the
 *                 old artifacts and service definitions, restarts the old node and
 *                 records `rolled_back`, or `rollback_failed` with what could not be
 *                 restored. The node reports the durable outcome to the server on its
 *                 next authenticated start (reconcilePreviousUpgrade).
 *
 * The result file and the vocabulary are the Windows ones (CONTROLLED_NODE_UPGRADE_RESULT_*).
 */
export function buildPosixControlledNodeUpgradeScript(input: PosixControlledNodeUpgradeScriptInput): string {
  const S = CONTROLLED_NODE_UPGRADE_RESULT_STATUS;
  const backup = CONTROLLED_NODE_UPGRADE_BACKUP_SUFFIX;
  const installDir = dirname(input.destinationJournalPath ?? input.destinationPath);
  const resultPath = join(installDir, CONTROLLED_NODE_UPGRADE_RESULT_FILE);
  const leasePath = join(installDir, CONTROLLED_NODE_HEALTH_LEASE_FILE);
  const helperDir = join(dirname(input.destinationPath), 'computer-use-helper');
  const workerRoot = join(dirname(input.destinationPath), 'remote-desktop-worker');
  const helperChmod = input.platform === 'darwin'
    ? `find "$IMCODES_HELPER_NEW" -type f -name 'open-computer-use.app.zip' -exec chmod 644 {} \\; 2>/dev/null`
    : `find "$IMCODES_HELPER_NEW" -type f -name 'open-computer-use' -exec chmod 755 {} \\; 2>/dev/null`;
  const serviceDefinitions = input.serviceDefinitionPaths
    ?? (input.platform === 'linux' ? [LINUX_UNIT_PATH] : [MACOS_PLIST_PATH, MACOS_WATCHDOG_PLIST_PATH]);
  const hasJournal = Boolean(input.stagedJournalPath && input.destinationJournalPath);

  const stagingCleanup = input.stagingOwnership
    ? [
      `cleanup_staging() {`,
      `  [ -d ${shQuote(input.stagingOwnership.directoryPath)} ] || return 0`,
      `  [ ! -L ${shQuote(input.stagingOwnership.directoryPath)} ] || return 0`,
      `  marker=${shQuote(input.stagingOwnership.markerPath)}`,
      `  [ -f "$marker" ] || return 0`,
      `  [ ! -L "$marker" ] || return 0`,
      `  grep -Fq ${shQuote(`"product":"${CONTROLLED_NODE_WINDOWS_UPGRADE_PRODUCT}"`)} "$marker" || return 0`,
      `  grep -Fq ${shQuote(`"directoryName":"${basename(input.stagingOwnership.directoryPath)}"`)} "$marker" || return 0`,
      `  grep -Fq ${shQuote(`"ownerToken":"${input.stagingOwnership.ownerToken}"`)} "$marker" || return 0`,
      `  rm -rf -- ${shQuote(input.stagingOwnership.directoryPath)}`,
      `}`,
      `trap cleanup_staging EXIT`,
    ].join('\n')
    : '';

  // Linux and macOS differ only in how the service is stopped/started/introspected.
  const serviceControl = input.platform === 'linux'
    ? [
      `imcodes_service_stop() { sleep 3; systemctl stop ${CONTROLLED_NODE_SERVICE.LINUX_UNIT}; }`,
      `imcodes_service_stop_for_rollback() { systemctl stop ${CONTROLLED_NODE_SERVICE.LINUX_UNIT}; }`,
      `imcodes_service_start() { systemctl reset-failed ${CONTROLLED_NODE_SERVICE.LINUX_UNIT} 2>/dev/null; systemctl start ${CONTROLLED_NODE_SERVICE.LINUX_UNIT}; }`,
      `imcodes_service_reload_definitions() { systemctl daemon-reload; }`,
      `imcodes_supervisor_resume() { :; }`,
    ]
    : [
      `imcodes_service_stop() { launchctl bootout system/${CONTROLLED_NODE_SERVICE.MACOS_WATCHDOG_LABEL}\nsleep 3\nlaunchctl bootout system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}; }`,
      `imcodes_service_stop_for_rollback() { launchctl bootout system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}; }`,
      `imcodes_service_start() { launchctl bootstrap system ${shQuote(MACOS_PLIST_PATH)}\nlaunchctl kickstart -k system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}; }`,
      `imcodes_service_reload_definitions() { :; }`,
      // The periodic health supervisor stays out for the whole transaction: it would
      // otherwise restart the node under the health window it is measuring.
      `imcodes_supervisor_resume() { launchctl bootstrap system ${shQuote(MACOS_WATCHDOG_PLIST_PATH)}; }`,
    ];

  const lines: string[] = [
    `#!/bin/sh`,
    `set +e`,
    `IMCODES_DST=${shQuote(input.destinationPath)}`,
    `IMCODES_DST_MANIFEST=${shQuote(input.destinationManifestPath)}`,
    `IMCODES_SRC=${shQuote(input.stagedArtifactPath)}`,
    `IMCODES_SRC_MANIFEST=${shQuote(input.stagedManifestPath)}`,
    `IMCODES_PENDING=${shQuote(`${input.destinationPath}.new`)}`,
    `IMCODES_BACKUP=${shQuote(`${input.destinationPath}${backup}`)}`,
    `IMCODES_DST_MANIFEST_NEW=${shQuote(`${input.destinationManifestPath}.new`)}`,
    `IMCODES_BACKUP_MANIFEST=${shQuote(`${input.destinationManifestPath}${backup}`)}`,
    `IMCODES_RESULT=${shQuote(resultPath)}`,
    `IMCODES_LEASE=${shQuote(leasePath)}`,
    `IMCODES_TARGET_VERSION=${shQuote(input.targetVersion ?? '')}`,
    `IMCODES_ARTIFACT_SHA=${shQuote(input.artifactSha256 ?? '')}`,
    `IMCODES_LEGACY_SURVIVAL_MS=${input.platform === 'linux' ? CONTROLLED_NODE_LINUX_WATCHDOG_SURVIVAL_MS : 0}`,
    `IMCODES_PHASE=preflight`,
    `IMCODES_FAILURE=''`,
    `IMCODES_PROGRESS=''`,
    `IMCODES_RECOVERY_FAILURES=''`,
    `IMCODES_INTERRUPTED=''`,
    `IMCODES_MAIN_BACKED_UP=0; IMCODES_MAIN_PUBLISHED=0`,
    `IMCODES_MANIFEST_BACKED_UP=0; IMCODES_MANIFEST_PUBLISHED=0`,
    `IMCODES_HELPER_BACKED_UP=0; IMCODES_HELPER_PUBLISHED=0`,
    `IMCODES_WORKER_BACKED_UP=0; IMCODES_WORKER_PUBLISHED=0`,
    `IMCODES_JOURNAL_BACKED_UP=0; IMCODES_JOURNAL_PUBLISHED=0`,
    `IMCODES_DEFS_CHANGED=0`,
    `IMCODES_CURRENT_HASH=''`,
    `IMCODES_STARTED_AT_MS=0`,
    `IMCODES_HELPER_NEW=${shQuote(`${helperDir}.new`)}; IMCODES_HELPER_DIR=${shQuote(helperDir)}; IMCODES_HELPER_BACKUP=${shQuote(`${helperDir}${backup}`)}`,
    `IMCODES_WORKER_NEW=${shQuote(`${workerRoot}.new`)}; IMCODES_WORKER_ROOT=${shQuote(workerRoot)}; IMCODES_WORKER_BACKUP=${shQuote(`${workerRoot}${backup}`)}`,
    ...(hasJournal ? [
      `IMCODES_JOURNAL=${shQuote(input.destinationJournalPath!)}; IMCODES_SRC_JOURNAL=${shQuote(input.stagedJournalPath!)}`,
      `IMCODES_JOURNAL_BACKUP=${shQuote(`${input.destinationJournalPath}${backup}`)}; IMCODES_JOURNAL_NEW=${shQuote(`${input.destinationJournalPath}.new`)}`,
    ] : []),
    ...(stagingCleanup ? [stagingCleanup] : []),
    // A stop request (systemd TimeoutStartSec, an admin, a reboot sequence) ends the
    // health wait as a failure, which rolls back, instead of killing the script mid-transaction.
    `trap 'IMCODES_INTERRUPTED=1' TERM INT HUP`,
    ``,
    // ---- small helpers ----
    `imcodes_sha256() {`,
    `  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | cut -d' ' -f1`,
    `  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1`,
    `  else echo unavailable; fi`,
    `}`,
    // One JSON string value: control characters, quotes and backslashes dropped, 240 chars at most.
    `imcodes_json_str() { printf '%s' "$1" | tr -d '\\000-\\037"\\\\' | cut -c1-240; }`,
    `imcodes_write_result() {`,
    `  # $1 status  $2 phase  $3 terminal(0|1)`,
    `  now=$(imcodes_wall_ms)`,
    `  tmp="$IMCODES_RESULT.pending-$$"`,
    `  (`,
    `    umask 077`,
    `    printf '{"schemaVersion":1,"status":"%s","phase":"%s","targetVersion":"%s","artifactSha256":"%s","recordedAt":%s' "$1" "$2" "$(imcodes_json_str "$IMCODES_TARGET_VERSION")" "$(imcodes_json_str "$IMCODES_ARTIFACT_SHA")" "$now"`,
    `    if [ "$3" = "1" ]; then printf ',"completedAt":%s' "$now"; fi`,
    `    if [ -n "$IMCODES_FAILURE" ]; then printf ',"failedPhase":"%s","error":"%s","reason":"%s"' "$IMCODES_PHASE" "$(imcodes_json_str "$IMCODES_FAILURE")" "$(imcodes_json_str "$IMCODES_FAILURE")"; fi`,
    `    if [ -n "$IMCODES_PROGRESS" ]; then printf ',"rollbackProgress":[%s]' "$IMCODES_PROGRESS"; fi`,
    `    if [ -n "$IMCODES_RECOVERY_FAILURES" ]; then printf ',"recoveryFailures":[%s]' "$IMCODES_RECOVERY_FAILURES"; fi`,
    `    printf '}'`,
    `  ) > "$tmp" 2>/dev/null && mv -f "$tmp" "$IMCODES_RESULT" 2>/dev/null`,
    `  rc=$?`,
    `  [ "$rc" = "0" ] || rm -f "$tmp" 2>/dev/null`,
    `  return "$rc"`,
    `}`,
    // A hard link keeps the old inode (and, on macOS, its signature state) untouched; copy only if the link is refused.
    `imcodes_keep() { ln -f "$1" "$2" 2>/dev/null || cp -p "$1" "$2"; }`,
    `imcodes_restore_file() {`,
    `  # $1 backup  $2 destination: publish the old inode back by rename(2), never an in-place overwrite`,
    `  imcodes_keep "$1" "$2.rollback" && mv -f "$2.rollback" "$2"`,
    `}`,
    ``,
    posixUpgradePrimitivesScript({ platform: input.platform, linuxUnit: CONTROLLED_NODE_SERVICE.LINUX_UNIT, macosLabel: CONTROLLED_NODE_SERVICE.MACOS_LABEL }).trimEnd(),
    posixUpgradeHealthWaitScript().trimEnd(),
    ...serviceControl,
    ``,
    // ---- preflight: the service is still the old node; nothing live changes ----
    `imcodes_preflight() {`,
    `  [ -f "$IMCODES_SRC" ] || { IMCODES_FAILURE='staged controlled node executable is missing'; return 1; }`,
    `  [ -f "$IMCODES_SRC_MANIFEST" ] || { IMCODES_FAILURE='staged controlled node manifest is missing'; return 1; }`,
    `  [ -f "$IMCODES_DST" ] || { IMCODES_FAILURE='installed controlled node executable is missing'; return 1; }`,
    `  src_hash=$(imcodes_sha256 "$IMCODES_SRC")`,
    `  if [ -n "$IMCODES_ARTIFACT_SHA" ] && [ "$src_hash" != "unavailable" ] && [ "$src_hash" != "$IMCODES_ARTIFACT_SHA" ]; then IMCODES_FAILURE='staged controlled node executable hash verification failed'; return 1; fi`,
    // A killed earlier attempt may already have published the target: its rollback image is then the rollback base.
    `  IMCODES_CURRENT_HASH=$(imcodes_sha256 "$IMCODES_DST")`,
    `  if [ -f "$IMCODES_BACKUP" ] && [ -n "$IMCODES_ARTIFACT_SHA" ] && [ "$IMCODES_CURRENT_HASH" = "$IMCODES_ARTIFACT_SHA" ]; then`,
    `    IMCODES_CURRENT_HASH=$(imcodes_sha256 "$IMCODES_BACKUP"); IMCODES_MAIN_BACKED_UP=2`,
    `  else`,
    `    rm -rf -- "$IMCODES_BACKUP" "$IMCODES_BACKUP_MANIFEST" "$IMCODES_HELPER_BACKUP" "$IMCODES_WORKER_BACKUP" ${hasJournal ? '"$IMCODES_JOURNAL_BACKUP"' : ''} 2>/dev/null`,
    `  fi`,
    `  rm -rf -- "$IMCODES_PENDING" "$IMCODES_DST_MANIFEST_NEW" "$IMCODES_HELPER_NEW" "$IMCODES_WORKER_NEW" ${hasJournal ? '"$IMCODES_JOURNAL_NEW"' : ''} 2>/dev/null`,
    `  cp -f "$IMCODES_SRC" "$IMCODES_PENDING" || { IMCODES_FAILURE='staged controlled node executable could not be copied'; rm -f -- "$IMCODES_PENDING"; return 1; }`,
    `  chmod 755 "$IMCODES_PENDING" 2>/dev/null || true`,
    // The copy must equal what was verified: a short write on a full disk is not an upgrade.
    `  pending_hash=$(imcodes_sha256 "$IMCODES_PENDING")`,
    `  if [ "$pending_hash" != "$src_hash" ]; then IMCODES_FAILURE='staged controlled node executable copy is incomplete'; rm -f -- "$IMCODES_PENDING"; return 1; fi`,
    ...(input.platform === 'darwin' ? [
      // Fail-closed: refuse to publish a Mach-O the kernel would SIGKILL on exec.
      // Scoped to actual Mach-O files because codesign is meaningless for anything
      // else -- on arm64 macOS every executable must carry at least an ad-hoc
      // signature, so a Mach-O that fails this check is guaranteed to be unbootable.
      `  if file -b "$IMCODES_PENDING" 2>/dev/null | grep -q 'Mach-O'; then`,
      `    codesign --verify "$IMCODES_PENDING" 2>/dev/null || { IMCODES_FAILURE='staged controlled node executable code signature is invalid'; rm -f -- "$IMCODES_PENDING"; return 1; }`,
      `  fi`,
    ] : []),
    `  cp -f "$IMCODES_SRC_MANIFEST" "$IMCODES_DST_MANIFEST_NEW" || { IMCODES_FAILURE='staged controlled node manifest could not be copied'; return 1; }`,
    ...(input.stagedComputerUseHelperDir ? [
      `  mkdir -p "$IMCODES_HELPER_NEW" && cp -R ${shQuote(`${input.stagedComputerUseHelperDir}/.`)} "$IMCODES_HELPER_NEW/" || { IMCODES_FAILURE='staged computer-use helper could not be copied'; return 1; }`,
      `  ${helperChmod} || true`,
    ] : []),
    ...(input.stagedRemoteDesktopWorkerDir ? [
      `  mkdir -p "$IMCODES_WORKER_NEW" && cp -R ${shQuote(`${input.stagedRemoteDesktopWorkerDir}/.`)} "$IMCODES_WORKER_NEW/" || { IMCODES_FAILURE='staged remote desktop worker could not be copied'; return 1; }`,
      `  find "$IMCODES_WORKER_NEW" -type f -name '${REMOTE_DESKTOP_LINUX_WORKER_FILENAME}' -exec chmod 755 {} \\; 2>/dev/null || { IMCODES_FAILURE='staged remote desktop worker is not executable'; return 1; }`,
      `  [ -f "$IMCODES_WORKER_NEW/${REMOTE_DESKTOP_LINUX_WORKER_FILENAME}" ] || { IMCODES_FAILURE='staged remote desktop worker artifact set is incomplete'; return 1; }`,
    ] : []),
    ...(hasJournal ? [
      `  cp -f "$IMCODES_SRC_JOURNAL" "$IMCODES_JOURNAL_NEW" 2>/dev/null || { IMCODES_FAILURE='staged install journal could not be copied'; return 1; }`,
    ] : []),
    `  return 0`,
    `}`,
    `imcodes_preflight_cleanup() { rm -rf -- "$IMCODES_PENDING" "$IMCODES_DST_MANIFEST_NEW" "$IMCODES_HELPER_NEW" "$IMCODES_WORKER_NEW" ${hasJournal ? '"$IMCODES_JOURNAL_NEW"' : ''} 2>/dev/null; }`,
    ``,
    // ---- service definitions: a new node may rewrite its own unit/plist; rollback puts them back ----
    `imcodes_defs_snapshot() {`,
    `  n=0`,
    ...serviceDefinitions.flatMap((path) => [
      `  if [ -f ${shQuote(path)} ]; then cp -p ${shQuote(path)} "$IMCODES_DST.service-def-$n${backup}" 2>/dev/null; fi; n=$(( n + 1 ))`,
    ]),
    `}`,
    `imcodes_defs_restore() {`,
    `  n=0`,
    ...serviceDefinitions.flatMap((path) => [
      `  if [ -f "$IMCODES_DST.service-def-$n${backup}" ] && ! cmp -s "$IMCODES_DST.service-def-$n${backup}" ${shQuote(path)}; then cp -p "$IMCODES_DST.service-def-$n${backup}" ${shQuote(path)} || return 1; IMCODES_DEFS_CHANGED=1; fi; n=$(( n + 1 ))`,
    ]),
    `  return 0`,
    `}`,
    `imcodes_defs_drop() { rm -f -- "$IMCODES_DST".service-def-*${backup} 2>/dev/null; }`,
    ``,
    // ---- install: backup every replaced artifact, then publish by rename ----
    `imcodes_install() {`,
    `  if [ -n "$IMCODES_INTERRUPTED" ]; then IMCODES_FAILURE='upgrade interrupted before publication'; return 1; fi`,
    `  if [ "$IMCODES_MAIN_BACKED_UP" != "2" ]; then`,
    `    imcodes_keep "$IMCODES_DST" "$IMCODES_BACKUP" || { IMCODES_FAILURE='controlled node rollback image could not be created'; return 1; }`,
    `    IMCODES_MAIN_BACKED_UP=1`,
    `  fi`,
    `  [ "$(imcodes_sha256 "$IMCODES_BACKUP")" = "$IMCODES_CURRENT_HASH" ] || { IMCODES_FAILURE='controlled node rollback image hash mismatch'; return 1; }`,
    // A rollback image kept by an interrupted earlier attempt is the one to restore: never replace it with what that attempt published.
    `  if [ -f "$IMCODES_BACKUP_MANIFEST" ]; then IMCODES_MANIFEST_BACKED_UP=1`,
    `  elif [ -f "$IMCODES_DST_MANIFEST" ]; then cp -p "$IMCODES_DST_MANIFEST" "$IMCODES_BACKUP_MANIFEST" || { IMCODES_FAILURE='controlled node manifest rollback image could not be created'; return 1; }; IMCODES_MANIFEST_BACKED_UP=1; fi`,
    // Publish through rename(2), NEVER cp -f straight onto the destination.
    //
    // cp -f rewrites the EXISTING inode in place. macOS binds code-signing state
    // to that inode, and the outgoing node's image may still be mapped, so an
    // in-place overwrite leaves a file whose bytes no longer match the signature
    // the kernel validated: every later exec is SIGKILLed with
    // OS_REASON_CODESIGNING and launchd respawns it forever -- a bricked node.
    // Linux fails the same write with ETXTBSY. rename(2) publishes a NEW inode
    // atomically: the running image is untouched and the landed file keeps the
    // exact bytes (and signature) that were verified.
    `  mv -f "$IMCODES_PENDING" "$IMCODES_DST" || { IMCODES_FAILURE='controlled node executable could not be published'; return 1; }`,
    `  IMCODES_MAIN_PUBLISHED=1`,
    `  if [ -n "$IMCODES_ARTIFACT_SHA" ] && [ "$(imcodes_sha256 "$IMCODES_DST")" != "$IMCODES_ARTIFACT_SHA" ] && [ "$(imcodes_sha256 "$IMCODES_DST")" != "unavailable" ]; then IMCODES_FAILURE='controlled node published executable hash mismatch'; return 1; fi`,
    `  mv -f "$IMCODES_DST_MANIFEST_NEW" "$IMCODES_DST_MANIFEST" || { IMCODES_FAILURE='controlled node manifest could not be published'; return 1; }`,
    `  IMCODES_MANIFEST_PUBLISHED=1`,
    ...(input.stagedComputerUseHelperDir ? [
      `  if [ -e "$IMCODES_HELPER_BACKUP" ]; then IMCODES_HELPER_BACKED_UP=1; rm -rf -- "$IMCODES_HELPER_DIR"`,
      `  elif [ -e "$IMCODES_HELPER_DIR" ]; then mv -- "$IMCODES_HELPER_DIR" "$IMCODES_HELPER_BACKUP" || { IMCODES_FAILURE='computer-use helper rollback image could not be created'; return 1; }; IMCODES_HELPER_BACKED_UP=1; fi`,
      `  mv -- "$IMCODES_HELPER_NEW" "$IMCODES_HELPER_DIR" || { IMCODES_FAILURE='computer-use helper could not be published'; return 1; }`,
      `  IMCODES_HELPER_PUBLISHED=1`,
    ] : []),
    ...(input.stagedRemoteDesktopWorkerDir ? [
      `  if [ -e "$IMCODES_WORKER_BACKUP" ]; then IMCODES_WORKER_BACKED_UP=1; rm -rf -- "$IMCODES_WORKER_ROOT"`,
      `  elif [ -e "$IMCODES_WORKER_ROOT" ]; then mv -- "$IMCODES_WORKER_ROOT" "$IMCODES_WORKER_BACKUP" || { IMCODES_FAILURE='remote desktop worker rollback image could not be created'; return 1; }; IMCODES_WORKER_BACKED_UP=1; fi`,
      `  mv -- "$IMCODES_WORKER_NEW" "$IMCODES_WORKER_ROOT" || { IMCODES_FAILURE='remote desktop worker could not be published'; return 1; }`,
      `  IMCODES_WORKER_PUBLISHED=1`,
    ] : []),
    ...(hasJournal ? [
      `  if [ -f "$IMCODES_JOURNAL_BACKUP" ]; then IMCODES_JOURNAL_BACKED_UP=1`,
      `  elif [ -f "$IMCODES_JOURNAL" ]; then cp -p "$IMCODES_JOURNAL" "$IMCODES_JOURNAL_BACKUP" || { IMCODES_FAILURE='install journal rollback image could not be created'; return 1; }; IMCODES_JOURNAL_BACKED_UP=1; fi`,
      `  mv -f "$IMCODES_JOURNAL_NEW" "$IMCODES_JOURNAL" || { IMCODES_FAILURE='install journal could not be published'; return 1; }`,
      `  IMCODES_JOURNAL_PUBLISHED=1`,
    ] : []),
    `  return 0`,
    `}`,
    ``,
    // ---- rollback: every step is attempted and recorded; the old node is always restarted ----
    `imcodes_recover() {`,
    `  # $1 label  $2 function`,
    `  if "$2"; then`,
    `    if [ -n "$IMCODES_PROGRESS" ]; then IMCODES_PROGRESS="$IMCODES_PROGRESS,"; fi`,
    `    IMCODES_PROGRESS="$IMCODES_PROGRESS\\"$1\\""`,
    `    imcodes_write_result ${shQuote(S.ROLLBACK_STARTED)} rollback 0 || true`,
    `  else`,
    `    if [ -n "$IMCODES_RECOVERY_FAILURES" ]; then IMCODES_RECOVERY_FAILURES="$IMCODES_RECOVERY_FAILURES,"; fi`,
    `    IMCODES_RECOVERY_FAILURES="$IMCODES_RECOVERY_FAILURES\\"$1 failed\\""`,
    `  fi`,
    `}`,
    `imcodes_rb_stop_new_node() {`,
    `  imcodes_service_stop_for_rollback`,
    `  tries=0`,
    `  while [ "$tries" -lt 30 ]; do`,
    `    pid=$(imcodes_service_pid)`,
    `    imcodes_pid_alive "$pid" || return 0`,
    `    sleep 1; tries=$(( tries + 1 ))`,
    `  done`,
    `  kill -9 "$pid" 2>/dev/null`,
    `  return 0`,
    `}`,
    `imcodes_rb_main() {`,
    `  if [ "$IMCODES_MAIN_BACKED_UP" != "0" ] && [ -f "$IMCODES_BACKUP" ]; then`,
    `    [ "$(imcodes_sha256 "$IMCODES_BACKUP")" = "$IMCODES_CURRENT_HASH" ] || return 1`,
    `    imcodes_restore_file "$IMCODES_BACKUP" "$IMCODES_DST" || return 1`,
    `    [ "$(imcodes_sha256 "$IMCODES_DST")" = "$IMCODES_CURRENT_HASH" ] || return 1`,
    `  fi`,
    `  return 0`,
    `}`,
    `imcodes_rb_manifest() {`,
    `  if [ "$IMCODES_MANIFEST_BACKED_UP" = "1" ] && [ -f "$IMCODES_BACKUP_MANIFEST" ]; then cp -f "$IMCODES_BACKUP_MANIFEST" "$IMCODES_DST_MANIFEST.rollback" && mv -f "$IMCODES_DST_MANIFEST.rollback" "$IMCODES_DST_MANIFEST"`,
    `  elif [ "$IMCODES_MANIFEST_PUBLISHED" = "1" ]; then rm -f -- "$IMCODES_DST_MANIFEST"; fi`,
    `}`,
    ...(input.stagedComputerUseHelperDir ? [
      `imcodes_rb_helper() {`,
      `  if [ "$IMCODES_HELPER_PUBLISHED" = "1" ]; then rm -rf -- "$IMCODES_HELPER_DIR" || return 1; fi`,
      `  if [ "$IMCODES_HELPER_BACKED_UP" = "1" ] && [ -e "$IMCODES_HELPER_BACKUP" ]; then mv -- "$IMCODES_HELPER_BACKUP" "$IMCODES_HELPER_DIR" || return 1; fi`,
      `  rm -rf -- "$IMCODES_HELPER_NEW" 2>/dev/null; return 0`,
      `}`,
    ] : []),
    ...(input.stagedRemoteDesktopWorkerDir ? [
      `imcodes_rb_worker() {`,
      `  if [ "$IMCODES_WORKER_PUBLISHED" = "1" ]; then rm -rf -- "$IMCODES_WORKER_ROOT" || return 1; fi`,
      `  if [ "$IMCODES_WORKER_BACKED_UP" = "1" ] && [ -e "$IMCODES_WORKER_BACKUP" ]; then mv -- "$IMCODES_WORKER_BACKUP" "$IMCODES_WORKER_ROOT" || return 1; fi`,
      `  rm -rf -- "$IMCODES_WORKER_NEW" 2>/dev/null; return 0`,
      `}`,
    ] : []),
    ...(hasJournal ? [
      `imcodes_rb_journal() {`,
      `  if [ "$IMCODES_JOURNAL_BACKED_UP" = "1" ] && [ -f "$IMCODES_JOURNAL_BACKUP" ]; then cp -f "$IMCODES_JOURNAL_BACKUP" "$IMCODES_JOURNAL.rollback" && mv -f "$IMCODES_JOURNAL.rollback" "$IMCODES_JOURNAL"`,
      `  elif [ "$IMCODES_JOURNAL_PUBLISHED" = "1" ]; then rm -f -- "$IMCODES_JOURNAL"; fi`,
      `}`,
    ] : []),
    `imcodes_rb_defs() { imcodes_defs_restore && if [ "$IMCODES_DEFS_CHANGED" = "1" ]; then imcodes_service_reload_definitions; fi; }`,
    `imcodes_rb_start_previous() { imcodes_service_start; }`,
    `imcodes_rollback() {`,
    `  imcodes_write_result ${shQuote(S.ROLLBACK_STARTED)} rollback 0 || true`,
    `  imcodes_recover stop_new_node imcodes_rb_stop_new_node`,
    `  imcodes_recover restore_main imcodes_rb_main`,
    `  imcodes_recover restore_manifest imcodes_rb_manifest`,
    ...(input.stagedComputerUseHelperDir ? [`  imcodes_recover restore_helper imcodes_rb_helper`] : []),
    ...(input.stagedRemoteDesktopWorkerDir ? [`  imcodes_recover restore_remote_desktop imcodes_rb_worker`] : []),
    ...(hasJournal ? [`  imcodes_recover restore_journal imcodes_rb_journal`] : []),
    `  imcodes_recover restore_service_definitions imcodes_rb_defs`,
    // The previous node is restarted even when a restore step failed: a stopped node is the worst outcome.
    `  imcodes_recover start_previous_node imcodes_rb_start_previous`,
    `  if [ -z "$IMCODES_RECOVERY_FAILURES" ]; then status=${shQuote(S.ROLLED_BACK)}; else status=${shQuote(S.ROLLBACK_FAILED)}; fi`,
    `  imcodes_write_result "$status" rollback 1 || printf 'IMCODES_UPGRADE_RESULT_PERSIST_FAILED phase=rollback\\n' >&2`,
    `  imcodes_preflight_cleanup`,
    // The images stay after a FAILED rollback: they are what an operator restores from.
    `  if [ "$status" = ${shQuote(S.ROLLED_BACK)} ]; then imcodes_drop_images; fi`,
    `  imcodes_supervisor_resume`,
    `  [ "$status" = ${shQuote(S.ROLLED_BACK)} ]`,
    `}`,
    ``,
    // ---- success ----
    `imcodes_drop_images() {`,
    `  rm -rf -- "$IMCODES_BACKUP" "$IMCODES_BACKUP_MANIFEST" 2>/dev/null`,
    ...(input.stagedComputerUseHelperDir ? [`  rm -rf -- "$IMCODES_HELPER_BACKUP" 2>/dev/null`] : []),
    ...(input.stagedRemoteDesktopWorkerDir ? [`  rm -rf -- "$IMCODES_WORKER_BACKUP" 2>/dev/null`] : []),
    ...(hasJournal ? [`  rm -f -- "$IMCODES_JOURNAL_BACKUP" 2>/dev/null`] : []),
    `  imcodes_defs_drop`,
    `}`,
    `imcodes_finalize_success() {`,
    `  imcodes_write_result ${shQuote(S.SUCCESS)} complete 1 || printf 'IMCODES_UPGRADE_RESULT_PERSIST_FAILED phase=complete\\n' >&2`,
    `  imcodes_drop_images`,
    `  imcodes_supervisor_resume`,
    `  return 0`,
    `}`,
    ``,
    // ---- the transaction ----
    `imcodes_main() {`,
    `  if ! imcodes_preflight; then`,
    `    imcodes_preflight_cleanup`,
    `    imcodes_write_result ${shQuote(CONTROLLED_NODE_WINDOWS_UPGRADE_PREFLIGHT_FAILED)} preflight 1 || true`,
    // Nothing live changed: the old node was never stopped.
    `    return 1`,
    `  fi`,
    `  IMCODES_PHASE=install`,
    // The previous attempt's outcome is replaced the moment this one begins: a stale
    // rolled_back record must never outlive a transaction that has since succeeded,
    // and in_progress is what a killed script leaves.
    `  imcodes_write_result ${shQuote(S.IN_PROGRESS)} install 0 || printf 'IMCODES_UPGRADE_RESULT_PERSIST_FAILED phase=in_progress\\n' >&2`,
    `  imcodes_defs_snapshot`,
    `  imcodes_service_stop`,
    `  if ! imcodes_install; then imcodes_rollback; return 1; fi`,
    `  rm -f -- "$IMCODES_LEASE" 2>/dev/null`,
    `  IMCODES_STARTED_AT_MS=$(imcodes_wall_ms)`,
    `  IMCODES_PHASE=restart_health`,
    `  if ! imcodes_service_start; then IMCODES_FAILURE='controlled node service could not be started'; imcodes_rollback; return 1; fi`,
    `  if imcodes_wait_node_healthy; then imcodes_finalize_success; return 0; fi`,
    `  IMCODES_FAILURE="controlled node upgrade failed authenticated health verification ($IMCODES_HEALTH_VERDICT after $(( IMCODES_HEALTH_ELAPSED_MS / 1000 ))s)"`,
    `  imcodes_rollback`,
    `  return 1`,
    `}`,
    `imcodes_main`,
    `exit $?`,
    ``,
  ];
  return lines.join('\n');
}
