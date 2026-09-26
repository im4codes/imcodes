import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when this module is the script Node was actually asked to run.
 *
 * The obvious spelling of this check is wrong on macOS:
 *
 *     fileURLToPath(import.meta.url) === resolve(process.argv[1])
 *
 * `os.tmpdir()` returns `/var/folders/...`, and `/var` is a symlink to
 * `/private/var`. Node resolves `import.meta.url` through that symlink and
 * leaves `process.argv[1]` exactly as it was typed, so for any script invoked
 * by an absolute path under the temporary directory the two sides never match.
 *
 * Nothing about that failure looks like a failure. `main()` simply does not
 * run: the process prints nothing and exits 0. That is how it surfaced -- SDK
 * promotion shells out to `libwebrtc-sdk-artifacts.mjs fingerprint` inside a
 * temporary git worktree, read an empty string where a digest was expected,
 * and refused to advance the lock with "SDK inputs changed while the SDK was
 * building". The inputs were identical; the fingerprint was never computed.
 *
 * It survived on Windows only because `RUNNER_TEMP` there is not a symlink.
 */
export function isModuleEntry(importMetaUrl) {
  const entryArgument = process.argv[1];
  if (!entryArgument) return false;
  const modulePath = fileURLToPath(importMetaUrl);
  const entryPath = resolve(entryArgument);
  if (modulePath === entryPath) return true;
  try {
    // Both sides, because either one may be the unresolved spelling.
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    // A path that cannot be resolved is not the entry point; falling back to
    // the plain comparison keeps this from throwing during module evaluation.
    return false;
  }
}
