/**
 * Shared helpers that emit the sharp self-heal block used by every upgrade
 * script (bash + Windows batch). Centralizing the trigger condition fixes a
 * regression seen in 2026.4.1948-dev.1927 where `npm install -g
 * --ignore-scripts imcodes@dev` left several of sharp's transitive deps
 * (`detect-libc`, `semver`, `@img/colour`) as empty placeholder directories
 * while sharp itself looked fine. The previous self-heal only checked
 * `sharp/package.json`, missed the empty siblings, and so the daemon
 * still crashed on `Cannot find module 'detect-libc'` the next time it
 * tried to import `@huggingface/transformers`.
 *
 * Trigger condition (both bash and batch):
 *   - any of {sharp, detect-libc, semver, @img/colour} is missing or empty
 *
 * Repair: `npm install --no-save --ignore-scripts sharp@0.34.5` from inside
 * the global imcodes package. The nested install does not hit the same
 * empty-dir edge case as the top-level global install and reconciles every
 * sharp transitive dep at once.
 *
 * The list of deps is intentionally derived from sharp@0.34.5's actual
 * `dependencies` field — keep it in sync if sharp's deps change.
 */

/** Sharp@0.34.5's runtime dependencies that must be present after global install. */
export const SHARP_REQUIRED_DEPS = ['sharp', 'detect-libc', 'semver', '@img/colour'] as const;

/**
 * Bash version of the sharp repair block. Inlined into `command-handler.ts`'s
 * upgrade heredoc.
 *
 * Assumes the surrounding script provides:
 *   - $NPM_RUN     — npm command (e.g. "npm" or "/usr/local/bin/npm")
 *   - $LOG         — log file path
 *   - log() shell function — `log "msg"` appends one line to $LOG
 *
 * The emitted block is idempotent and safe to run on a clean install.
 */
export function buildBashSharpRepair(): string {
  // Each dep gets a -f check on its package.json. If ANY is missing, the
  // whole sharp subtree is rebuilt by a nested `npm install`.
  //
  // The for-loop builds a single SHARP_BROKEN flag instead of running the
  // npm install inside the loop because the repair is one shot — even if
  // multiple deps are missing, one nested install fixes them all.
  return `# Sharp repair: detect the npm-global empty-dir bug for sharp OR any of
# its transitive deps (detect-libc, semver, @img/colour). Real-world hit
# in 2026.4.1948-dev.1927: sharp itself was extracted but its peers were
# left as empty placeholder dirs, so loading @huggingface/transformers
# crashed on \`Cannot find module 'detect-libc'\` and semantic search
# permanently sticky-disabled. This costs ~2 s when needed, ~0 s when
# the install was clean.
GLOBAL_ROOT_CHECK=$(eval "$NPM_RUN root -g" 2>/dev/null)
SHARP_BROKEN=0
SHARP_BROKEN_DEP=""
for dep in ${SHARP_REQUIRED_DEPS.join(' ')}; do
  if [ ! -f "$GLOBAL_ROOT_CHECK/imcodes/node_modules/$dep/package.json" ]; then
    SHARP_BROKEN=1
    SHARP_BROKEN_DEP="$dep"
    break
  fi
done
if [ "$SHARP_BROKEN" = "1" ]; then
  log "[step 2.1] sharp subtree broken (\${SHARP_BROKEN_DEP}/package.json missing) — repairing via nested npm install"
  # Remove every empty placeholder so npm install repopulates them cleanly.
  for dep in ${SHARP_REQUIRED_DEPS.join(' ')}; do
    if [ ! -f "$GLOBAL_ROOT_CHECK/imcodes/node_modules/$dep/package.json" ]; then
      rmdir "$GLOBAL_ROOT_CHECK/imcodes/node_modules/$dep" 2>/dev/null || true
    fi
  done
  if (cd "$GLOBAL_ROOT_CHECK/imcodes" && eval "$NPM_RUN install --no-save --ignore-scripts sharp@0.34.5") >> "$LOG" 2>&1; then
    log "[step 2.1] sharp repair succeeded"
  else
    log "[step 2.1] sharp repair FAILED (exit $?) — semantic memory recall will sticky-disable"
  fi
fi`;
}

/**
 * Windows batch version of the sharp repair block. Inlined into
 * `windows-upgrade-script.ts`'s upgrade batch.
 *
 * Returns a string with `\r\n` line endings already applied so callers don't
 * have to remember.
 */
export function buildBatchSharpRepair(opts: { npmCmd: string }): string {
  const { npmCmd } = opts;
  // Batch's quoted token expansion + delayed expansion is fragile, so we
  // emit one explicit `if not exist` per dep instead of a loop. The list
  // is short and stable.
  const depChecks = SHARP_REQUIRED_DEPS.map((dep) => {
    const winDep = dep.replace(/\//g, '\\');
    return `  if not exist "!GLOBAL_ROOT_CHECK!\\imcodes\\node_modules\\${winDep}\\package.json" (\r\n` +
      `    set "SHARP_BROKEN=1"\r\n` +
      `    if not defined SHARP_BROKEN_DEP set "SHARP_BROKEN_DEP=${dep}"\r\n` +
      `  )`;
  }).join('\r\n');

  // Cleanup pass — only attempts rmdir on dirs whose package.json is missing.
  const depCleanups = SHARP_REQUIRED_DEPS.map((dep) => {
    const winDep = dep.replace(/\//g, '\\');
    return `    if not exist "!GLOBAL_ROOT_CHECK!\\imcodes\\node_modules\\${winDep}\\package.json" rmdir "!GLOBAL_ROOT_CHECK!\\imcodes\\node_modules\\${winDep}" 2>nul`;
  }).join('\r\n');

  return [
    `rem Sharp repair: detect the npm-global empty-dir bug for sharp OR any\r`,
    `rem of its transitive deps (detect-libc, semver, @img/colour). Real-world\r`,
    `rem hit in 2026.4.1948-dev.1927: sharp itself was extracted but its peers\r`,
    `rem were empty placeholder dirs, so loading @huggingface/transformers\r`,
    `rem crashed on "Cannot find module 'detect-libc'" and semantic search\r`,
    `rem permanently sticky-disabled.  Failure here doesn't block the upgrade.\r`,
    `set "GLOBAL_ROOT_CHECK="\r`,
    `for /f "usebackq delims=" %%p in (\`call "${npmCmd}" root -g 2^>nul\`) do if not defined GLOBAL_ROOT_CHECK set "GLOBAL_ROOT_CHECK=%%p"\r`,
    `set "SHARP_BROKEN="\r`,
    `set "SHARP_BROKEN_DEP="\r`,
    `if defined GLOBAL_ROOT_CHECK (\r`,
    `${depChecks}\r`,
    `)\r`,
    `if "!SHARP_BROKEN!"=="1" (\r`,
    `  echo sharp subtree broken (!SHARP_BROKEN_DEP!/package.json missing) — repairing via nested npm install >> "%LOG_FILE%"\r`,
    `${depCleanups}\r`,
    `  pushd "!GLOBAL_ROOT_CHECK!\\imcodes" >nul 2>&1\r`,
    `  call "${npmCmd}" install --no-save --ignore-scripts sharp@0.34.5 >> "%LOG_FILE%" 2>&1\r`,
    `  set "REPAIR_EXIT=!errorlevel!"\r`,
    `  popd >nul 2>&1\r`,
    `  if !REPAIR_EXIT! equ 0 (\r`,
    `    echo sharp repair succeeded >> "%LOG_FILE%"\r`,
    `  ) else (\r`,
    `    echo sharp repair FAILED (exit !REPAIR_EXIT!) — semantic memory recall will sticky-disable >> "%LOG_FILE%"\r`,
    `  )\r`,
    `)\r`,
  ].join('\n');
}
