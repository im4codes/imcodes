/**
 * Upgrade-time repair for node-datachannel's native addon.
 *
 * Daemon auto-upgrades deliberately install the global package with
 * `--ignore-scripts` to avoid sharp's unreliable global-install hook. That
 * also skips node-datachannel's install script, leaving its JavaScript files
 * present but `build/Release/node_datachannel.node` absent. The daemon then
 * correctly falls back to relay, but LAN direct transfer is unavailable.
 *
 * Keep the top-level install script-free and repair this one optional native
 * dependency explicitly. Failure is non-fatal: relay upload remains usable
 * and runtime diagnostics report the native module as unavailable.
 */

/**
 * Bash repair block inlined into the Linux/macOS daemon upgrade script.
 *
 * Assumes the surrounding script provides `$NPM_RUN`, `$NODE`, `$LOG`, and
 * the `log()` shell helper.
 */
export function buildBashNodeDatachannelRepair(): string {
  return `# node-datachannel repair: the global install above uses
# --ignore-scripts, so explicitly run this optional dependency's native
# lifecycle when its addon cannot be imported. This is best effort: relay
# remains available when a platform has no compatible binary/toolchain.
GLOBAL_ROOT_CHECK=$(eval "$NPM_RUN root -g" 2>/dev/null)
IMCODES_PACKAGE_DIR="$GLOBAL_ROOT_CHECK/imcodes"
verify_node_datachannel() {
  [ -d "$IMCODES_PACKAGE_DIR" ] || return 1
  (cd "$IMCODES_PACKAGE_DIR" && "$NODE" -e "import('node-datachannel').then(() => process.exit(0)).catch(() => process.exit(1))") >/dev/null 2>&1
}
if ! verify_node_datachannel; then
  log "[step 2.2] node-datachannel native addon unavailable — rebuilding with lifecycle scripts enabled"
  if (cd "$IMCODES_PACKAGE_DIR" && eval "$NPM_RUN rebuild node-datachannel --ignore-scripts=false --foreground-scripts") >> "$LOG" 2>&1; then
    if verify_node_datachannel; then
      log "[step 2.2] node-datachannel repair succeeded"
    else
      log "[step 2.2] node-datachannel repair FAILED verification — direct transfer unavailable; relay remains enabled"
    fi
  else
    log "[step 2.2] node-datachannel repair FAILED (exit $?) — direct transfer unavailable; relay remains enabled"
  fi
fi`;
}
