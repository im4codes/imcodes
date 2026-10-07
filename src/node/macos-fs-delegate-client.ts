/**
 * The node's side of macOS filesystem delegation (see shared/macos-fs-delegate.ts for the protocol and why it exists).
 *
 * The node is a root daemon whose bare executable has no app identity; Full Disk Access for it shows up in System Settings as an
 * unnamed exec. When the node itself is denied a directory, it asks the signed aiDesk.to by IM.codes app (the identity the user sees
 * and granted permissions to) to do that one read, as the user, and decides for itself what to do with the answer.
 *
 * What this module does NOT decide: which paths are readable. The caller (the file-transfer handler) applies the same path policy it
 * applies to its own reads, to the real path the app reports, before anything leaves the node. This module only moves bytes.
 *
 * Every failure to delegate is a value, never an exception, and the caller falls back to the node's own behaviour: an app that is
 * missing, older, unsigned, or refused leaves things exactly as they were before delegation existed.
 */
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import logger from '../util/logger.js';
import {
  MACOS_FS_DELEGATE_INFO_PLIST_OPS_KEY,
  MACOS_FS_DELEGATE_INFO_PLIST_VERSION_KEY,
  MACOS_FS_DELEGATE_LIMITS,
  MACOS_FS_DELEGATE_OP,
  MACOS_FS_DELEGATE_REASON,
  MACOS_FS_DELEGATE_REQUEST_FLAG,
  MACOS_FS_DELEGATE_RUNTIME_ROOT,
  parseMacosFsDelegateAnswer,
  parseMacosFsDelegateOps,
  serializeMacosFsDelegateRequest,
  type MacosFsDelegateEntryMetadata,
  type MacosFsDelegateOp,
  type MacosFsDelegateReason,
} from '../../shared/macos-fs-delegate.js';
import { resolveMacosUserSession, type MacosUserSession } from './user-session-launcher.js';
import {
  MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH,
  executeMacosAideskAppCommand,
} from './macos-remote-desktop-responsible-spawn.js';

export type MacosFsDelegateListResult =
  | {
    kind: 'ok';
    realPath: string;
    entries: Array<{ name: string; kind: 'd' | 'f' | 'o'; meta?: MacosFsDelegateEntryMetadata }>;
    truncated: boolean;
    /** The answer carries size/time per entry (the app implements `list_meta` and was asked for it). Otherwise the node has none to order by. */
    hasMetadata: boolean;
  }
  /** The app ran and macOS refused IT: the app lacks Full Disk Access (the user must enable the app, not the node). */
  | { kind: 'app_denied' }
  /** The app ran and answered another definite error (not_found, not_directory, ...). */
  | { kind: 'refused'; reason: string }
  /** No usable app (missing, too old, no user session, spawn failed, timed out, unparseable): the caller keeps its own behaviour. */
  | { kind: 'unavailable'; reason: MacosFsDelegateReason };

export interface MacosFsDelegateClientDeps {
  platform?: NodeJS.Platform;
  now?: () => number;
  appPath?: string;
  runtimeRoot?: string;
  /** Resolve the signed-in GUI user (root-owned requests are made for this user's session). */
  resolveUser?: () => Promise<MacosUserSession>;
  /** Read the app's Info.plist text; `null` when the app is not there. */
  readInfoPlist?: (appPath: string) => Promise<string | null>;
  /** Run the app's command (the real implementation verifies the app's signature and launches it through LaunchServices). */
  runApp?: (input: { user: MacosUserSession; appPath: string; args: readonly string[] }) => Promise<{ stdout: string }>;
  /** Ownership of the node process: the request tree is created root-owned, and refused otherwise. */
  getuid?: () => number;
  randomHex?: (bytes: number) => string;
}

let activeRuns = 0;
/**
 * Request files a run of THIS process has written and not yet removed. The stale-request sweep never removes one of them: a concurrent run
 * sweeping the shared directory must not delete a file whose owner is still using it (judged by the file's mtime against the sweeper's
 * clock, a live request can look stale -- under a clock that is ahead of the file system's, or a very slow run).
 */
const inFlightRequestFiles = new Set<string>();

/** Test seam. */
export function resetMacosFsDelegateClientForTests(): void { activeRuns = 0; inFlightRequestFiles.clear(); }

async function defaultReadInfoPlist(appPath: string): Promise<string | null> {
  try {
    return await readFile(join(appPath, 'Contents', 'Info.plist'), 'utf8');
  } catch {
    return null;
  }
}

/** The two capability keys, read from the XML Info.plist the packaging script writes. Anything else (binary plist, missing keys) = no capability. */
export function readMacosFsDelegateCapabilityFromInfoPlist(plist: string): readonly MacosFsDelegateOp[] {
  const version = new RegExp(`<key>${MACOS_FS_DELEGATE_INFO_PLIST_VERSION_KEY}</key>\\s*<integer>(\\d{1,4})</integer>`, 'u').exec(plist);
  const ops = new RegExp(`<key>${MACOS_FS_DELEGATE_INFO_PLIST_OPS_KEY}</key>\\s*<string>([a-z_ ]{1,64})</string>`, 'u').exec(plist);
  return parseMacosFsDelegateOps(version ? Number(version[1]) : undefined, ops ? ops[1] : undefined);
}

/**
 * The per-user directory the request is written into: `<root>/<uid>`, created root:wheel 0755 (and the root with it). A directory that
 * already exists is accepted only if it is a real directory owned by root that nobody else can write; otherwise there is no safe place
 * for a request and delegation is not attempted.
 */
async function ensureRequestDirectory(root: string, uid: number, ownerUid: number): Promise<string | null> {
  const directory = join(root, String(uid));
  for (const path of [root, directory]) {
    try {
      await mkdir(path, { mode: 0o755 });
      await chmod(path, 0o755);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid || (stat.mode & 0o022) !== 0) return null;
  }
  return directory;
}

const STALE_REQUEST_MS = 60_000;

async function sweepStaleRequests(directory: string, now: number): Promise<void> {
  let names: string[];
  try { names = await readdir(directory); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.req')) continue;
    const path = join(directory, name);
    if (inFlightRequestFiles.has(path)) continue;
    const stat = await lstat(path).catch(() => null);
    if (stat?.isFile() && now - stat.mtimeMs > STALE_REQUEST_MS) await rm(path, { force: true }).catch(() => {});
  }
}

function unavailable(reason: MacosFsDelegateReason, path: string): MacosFsDelegateListResult {
  logger.info({ reason, path }, 'macos fs delegate unavailable');
  return { kind: 'unavailable', reason };
}

/**
 * List `requestedPath` through the aiDesk.to app. `requestedPath` must already have passed the node's path policy (lexically); the
 * real path the app reports is returned for the caller to judge again.
 */
export async function listDirectoryViaMacosApp(
  requestedPath: string,
  deps: MacosFsDelegateClientDeps = {},
  options: { withMetadata?: boolean } = {},
): Promise<MacosFsDelegateListResult> {
  if ((deps.platform ?? process.platform) !== 'darwin') return { kind: 'unavailable', reason: MACOS_FS_DELEGATE_REASON.APP_UNAVAILABLE };
  if (Buffer.byteLength(requestedPath) > MACOS_FS_DELEGATE_LIMITS.MAX_PATH_BYTES || !requestedPath.startsWith('/')) {
    return { kind: 'refused', reason: MACOS_FS_DELEGATE_REASON.BAD_PATH };
  }
  const appPath = deps.appPath ?? MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH;
  const plist = await (deps.readInfoPlist ?? defaultReadInfoPlist)(appPath);
  if (plist === null) return unavailable(MACOS_FS_DELEGATE_REASON.APP_UNAVAILABLE, requestedPath);
  const capability = readMacosFsDelegateCapabilityFromInfoPlist(plist);
  if (!capability.includes(MACOS_FS_DELEGATE_OP.LIST)) {
    return unavailable(MACOS_FS_DELEGATE_REASON.APP_TOO_OLD, requestedPath);
  }
  // Metadata only when asked for AND the app implements it; an older app lists without it and the caller says so truthfully.
  const op = options.withMetadata && capability.includes(MACOS_FS_DELEGATE_OP.LIST_META) ? MACOS_FS_DELEGATE_OP.LIST_META : MACOS_FS_DELEGATE_OP.LIST;
  if (activeRuns >= MACOS_FS_DELEGATE_LIMITS.MAX_CONCURRENT_RUNS) return unavailable(MACOS_FS_DELEGATE_REASON.BUSY, requestedPath);
  activeRuns += 1;
  let requestFile: string | null = null;
  try {
    let user: MacosUserSession;
    try {
      user = await (deps.resolveUser ?? resolveMacosUserSession)();
    } catch {
      return unavailable(MACOS_FS_DELEGATE_REASON.NO_USER_SESSION, requestedPath);
    }
    const now = (deps.now ?? Date.now)();
    const ownerUid = (deps.getuid ?? (() => process.getuid?.() ?? -1))();
    const directory = await ensureRequestDirectory(deps.runtimeRoot ?? MACOS_FS_DELEGATE_RUNTIME_ROOT, user.uid, ownerUid);
    if (!directory) return unavailable(MACOS_FS_DELEGATE_REASON.REQUEST_DIR_UNTRUSTED, requestedPath);
    await sweepStaleRequests(directory, now);
    const nonce = (deps.randomHex ?? ((bytes) => randomBytes(bytes).toString('hex')))(16);
    requestFile = join(directory, `${nonce}.req`);
    inFlightRequestFiles.add(requestFile);
    await writeFile(requestFile, serializeMacosFsDelegateRequest({
      op,
      path: requestedPath,
      nonce,
      createdMs: now,
      expiresMs: now + MACOS_FS_DELEGATE_LIMITS.REQUEST_TTL_MS,
    }), { flag: 'wx', mode: 0o644 });
    await chmod(requestFile, 0o644);
    let stdout: string;
    try {
      const run = deps.runApp ?? (async ({ user: runUser, appPath: runApp, args }) => await executeMacosAideskAppCommand({
        user: runUser,
        appPath: runApp,
        args,
        timeoutMs: MACOS_FS_DELEGATE_LIMITS.RUN_TIMEOUT_MS,
        maxBufferBytes: MACOS_FS_DELEGATE_LIMITS.MAX_STDOUT_BYTES,
      }));
      stdout = (await run({ user, appPath, args: [MACOS_FS_DELEGATE_REQUEST_FLAG, requestFile] })).stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return unavailable(/timed? ?out|ETIMEDOUT|killed/iu.test(message) ? MACOS_FS_DELEGATE_REASON.TIMEOUT : MACOS_FS_DELEGATE_REASON.SPAWN_FAILED, requestedPath);
    }
    const answer = parseMacosFsDelegateAnswer(stdout);
    if (!answer) return unavailable(MACOS_FS_DELEGATE_REASON.BAD_ANSWER, requestedPath);
    if (!answer.ok) {
      logger.info({ reason: answer.reason, path: requestedPath }, 'macos fs delegate refused');
      // macOS refused the app itself (the app lacks Full Disk Access), or the helper could not verify that it holds it and refused to risk a
      // consent prompt nobody can answer: either way the visible state is "enable the app under Full Disk Access".
      if (answer.reason === MACOS_FS_DELEGATE_REASON.PERMISSION_DENIED || answer.reason === MACOS_FS_DELEGATE_REASON.PERMISSION_UNKNOWN) return { kind: 'app_denied' };
      // A definite answer about the path: report it as the node's own read would have.
      if (answer.reason === MACOS_FS_DELEGATE_REASON.NOT_FOUND || answer.reason === MACOS_FS_DELEGATE_REASON.NOT_DIRECTORY) {
        return { kind: 'refused', reason: answer.reason };
      }
      // Everything else says the helper declined to act (request rejected, symlink, changed under it, I/O): not an answer about the
      // path, so the caller keeps its own behaviour.
      const known = (Object.values(MACOS_FS_DELEGATE_REASON) as string[]).includes(answer.reason);
      return { kind: 'unavailable', reason: known ? answer.reason as MacosFsDelegateReason : MACOS_FS_DELEGATE_REASON.BAD_ANSWER };
    }
    // An app that was asked for metadata must send it for every entry (an empty listing has none to send); anything else is a broken app.
    if (op === MACOS_FS_DELEGATE_OP.LIST_META && answer.entries.some((entry) => entry.meta === undefined)) {
      return unavailable(MACOS_FS_DELEGATE_REASON.BAD_ANSWER, requestedPath);
    }
    if (op === MACOS_FS_DELEGATE_OP.LIST && answer.entries.some((entry) => entry.meta !== undefined)) {
      return unavailable(MACOS_FS_DELEGATE_REASON.BAD_ANSWER, requestedPath);
    }
    return { kind: 'ok', realPath: answer.realPath, entries: answer.entries, truncated: answer.truncated, hasMetadata: op === MACOS_FS_DELEGATE_OP.LIST_META };
  } finally {
    activeRuns -= 1;
    if (requestFile) {
      await rm(requestFile, { force: true }).catch(() => {});
      inFlightRequestFiles.delete(requestFile);
    }
  }
}
