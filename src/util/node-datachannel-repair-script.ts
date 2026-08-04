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
  return `# node-datachannel repair: invoke the newly installed package's
# pure-builtins repair utility. This is best effort: relay remains available
# when a platform has no compatible binary/toolchain.
GLOBAL_ROOT_CHECK=$(eval "$NPM_RUN root -g" 2>/dev/null)
IMCODES_PACKAGE_DIR="$GLOBAL_ROOT_CHECK/imcodes"
NODE_DATACHANNEL_REPAIR="$IMCODES_PACKAGE_DIR/dist/src/util/node-datachannel-repair.mjs"
if [ -f "$NODE_DATACHANNEL_REPAIR" ]; then
  if ! IMCODES_NPM_BIN="npm" IMCODES_NPM_CLI="\${NPM_CLI:-}" "$NODE" "$NODE_DATACHANNEL_REPAIR" "$IMCODES_PACKAGE_DIR" >> "$LOG" 2>&1; then
    log "[step 2.2] node-datachannel repair unavailable — direct transfer unavailable; relay remains enabled"
  fi
else
  log "[step 2.2] node-datachannel repair utility absent — relay remains enabled"
fi`;
}
