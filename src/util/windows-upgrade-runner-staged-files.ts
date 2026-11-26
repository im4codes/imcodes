/**
 * Relative files copied beside the staged Windows upgrade runner.
 *
 * Keep this list next to the runner's source and validate it against the
 * runner's transitive relative-import closure in tests.  The command handler
 * uses it to make the temporary runner self-contained before npm replaces the
 * installed package.
 */
export const WINDOWS_UPGRADE_RUNNER_STAGED_FILES = [
  'windows-daemon-watchdog.mjs',
  'staged-package-install.mjs',
] as const;
