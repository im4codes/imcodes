import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import {
  AGENT_SKILL_FILE_NAME,
  AGENT_SKILLS_ACTION,
  AGENT_SKILLS_CLI_PACKAGE,
  AGENT_SKILLS_ERROR,
  AGENT_SKILLS_LIMITS,
  AGENT_SKILLS_LOCK_FILE_SEGMENTS,
  AGENT_SKILLS_MSG,
  AGENT_SKILLS_PROJECT_LOCK_FILE,
  AGENT_SKILLS_PROJECT_ROOT_SEGMENTS,
  AGENT_SKILLS_USER_ROOT_SEGMENTS,
  PROJECT_AGENT_SKILL_DISPLAY_ROOTS,
  USER_AGENT_SKILL_DISPLAY_ROOTS,
  isAgentSkillBinName,
  isAgentSkillName,
  readAgentSkillsRunRequest,
  type AgentSkillEntry,
  type AgentSkillsError,
  type AgentSkillsRunRequest,
} from '../../shared/agent-skills.js';
import { isTopLevelAgentSkillEntry, parseAgentSkillMarkers, parseAgentSkillReference } from '../../shared/agent-skill-references.js';
import { resolveNpmCliJs } from '../util/node-datachannel-repair.mjs';
import { getSkillRegistryManagementSnapshot } from '../context/skill-registry.js';
import { assertSafeRegistryPayloadPathSync } from '../context/managed-skill-path.js';
import type { SkillLayer } from '../../shared/skill-store.js';

/** A SKILL.md larger than this is not read for its description. */
const MAX_SKILL_FILE_BYTES = 256 * 1024;

const SKILL_CONTENT_START = '[skill:';

async function validateRegistryPayloadPath(
  path: string,
  layer: SkillLayer,
  context: { homeDir: string; projectDir?: string },
): Promise<{ candidatePath: string; realPath: string } | undefined> {
  try {
    let candidatePath = path;
    if ((await stat(path)).isDirectory()) {
      candidatePath = join(path, AGENT_SKILL_FILE_NAME);
    }
    const asserted = assertSafeRegistryPayloadPathSync({
      path: candidatePath,
      layer,
      homeDir: context.homeDir,
      projectDir: context.projectDir,
      maxBytes: MAX_SKILL_FILE_BYTES,
    });
    return { candidatePath, realPath: asserted.realPath };
  } catch {
    return undefined;
  }
}

export interface AgentSkillExpansion {
  text: string;
  unresolved: string[];
  expanded: string[];
}

/** Resolve a marker without silently choosing between same-name sources. */
export function resolveAgentSkillReference(
  reference: { name: string; source?: string },
  skills: readonly AgentSkillEntry[],
): AgentSkillEntry | undefined {
  const candidates = skills.filter((skill) => skill.name === reference.name);
  if (reference.source) {
    return candidates.find((skill) => skill.source === reference.source || skill.sourceUrl === reference.source || skill.uri === reference.source || skill.displayPath === reference.source || `${skill.layer ?? ''}:${skill.name}` === reference.source);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function firstString(record: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isAgentSkillBinName) : [];
}

/** `requires.bins` under `metadata`, or under OpenClaw's `metadata.openclaw`. */
function requiredBins(frontMatter: Record<string, unknown>): string[] {
  const metadata = frontMatter.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const record = metadata as Record<string, unknown>;
  const openclaw = record.openclaw && typeof record.openclaw === 'object' ? record.openclaw as Record<string, unknown> : {};
  const requires = (candidate: unknown) => (candidate && typeof candidate === 'object'
    ? stringList((candidate as Record<string, unknown>).bins)
    : []);
  return [...new Set([...requires(record.requires), ...requires(openclaw.requires)])];
}

/**
 * The description and required commands from a SKILL.md frontmatter.
 * Third-party skills carry keys of their own, so only these are read and
 * nothing else about the file is judged here: the agents that load it decide
 * what it means.
 */
async function readFrontMatter(skillDirectory: string): Promise<{ description: string; bins: string[] }> {
  const none = { description: '', bins: [] };
  try {
    const path = join(skillDirectory, AGENT_SKILL_FILE_NAME);
    const facts = await stat(path);
    if (!facts.isFile() || facts.size > MAX_SKILL_FILE_BYTES) return none;
    const text = await readFile(path, 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
    if (!match) return none;
    const value = parseDocument(match[1], { prettyErrors: false }).toJS({ maxAliasCount: 0 }) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return none;
    const record = value as Record<string, unknown>;
    return {
      description: firstString(record, 'description', AGENT_SKILLS_LIMITS.DESCRIPTION_CHARS) ?? '',
      bins: requiredBins(record),
    };
  } catch {
    return none;
  }
}

/** Whether `name` is a command on this daemon's PATH (PATHEXT on Windows). */
export async function hasCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const extensions = platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        await access(join(directory, `${name}${extension}`), platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

async function readLockFile(lockPath: string): Promise<Record<string, Record<string, unknown>>> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
    const skills = (value as { skills?: unknown } | null)?.skills;
    return skills && typeof skills === 'object' && !Array.isArray(skills)
      ? skills as Record<string, Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
}

function isUnderDir(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function isExternalAgentDisplayPath(displayPath: string | undefined): boolean {
  if (!displayPath) return false;
  const normalized = displayPath.trim().replace(/\\/gu, '/');
  for (const root of USER_AGENT_SKILL_DISPLAY_ROOTS) {
    if (root === '~/.imcodes/skills') continue;
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  for (const root of PROJECT_AGENT_SKILL_DISPLAY_ROOTS) {
    if (root === '.imc/skills') continue;
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

interface AgentSkillExpandTarget {
  path: string;
  layer: SkillLayer;
}

interface AgentSkillScanResult {
  skills: AgentSkillEntry[];
  targetByEntry: WeakMap<AgentSkillEntry, AgentSkillExpandTarget>;
}

/**
 * Every skill across project and user agent skill directories (plus IM.codes
 * registry entries): a directory (or symlink/junction resolving inside
 * homeDir/projectDir) holding a SKILL.md that resolves inside that skill
 * directory. Pure offline filesystem scan (never spawns `npx`).
 */
async function listAgentSkillsInternal(
  homeDir: string,
  context: { projectDir?: string },
  topLevelOnly: boolean,
): Promise<AgentSkillScanResult> {
  const resolvedHome = resolve(homeDir);
  const realHome = await realpath(resolvedHome).catch(() => resolvedHome);
  const userLockPromise = readLockFile(join(homeDir, ...AGENT_SKILLS_LOCK_FILE_SEGMENTS));

  const projectDir = context.projectDir?.trim() ? resolve(context.projectDir.trim()) : undefined;
  const realProjectPromise = projectDir ? realpath(projectDir).catch(() => projectDir) : Promise.resolve(undefined);
  const projectLockPromise = projectDir ? readLockFile(join(projectDir, AGENT_SKILLS_PROJECT_LOCK_FILE)) : Promise.resolve({});

  const [userLock, realProject, projectLock] = await Promise.all([userLockPromise, realProjectPromise, projectLockPromise]);

  const commandCache = new Map<string, Promise<boolean>>();
  const checkCommand = (bin: string): Promise<boolean> => {
    let pending = commandCache.get(bin);
    if (!pending) {
      pending = hasCommand(bin);
      commandCache.set(bin, pending);
    }
    return pending;
  };

  const skills: AgentSkillEntry[] = [];
  const targetByEntry = new WeakMap<AgentSkillEntry, AgentSkillExpandTarget>();
  const seenRealDirs = new Set<string>();
  const seenRealFiles = new Set<string>();
  const seenScopeNames = new Set<string>();

  interface ScanRootSpec {
    scope: 'project' | 'user';
    layer: 'project_escape_hatch' | 'user_default';
    rootPath: string;
    realScopeRoot: string;
    displayPrefix: string;
    lock: Record<string, Record<string, unknown>>;
  }

  const scanSpecs: ScanRootSpec[] = [];
  if (projectDir && realProject) {
    for (const segments of AGENT_SKILLS_PROJECT_ROOT_SEGMENTS) {
      scanSpecs.push({
        scope: 'project',
        layer: 'project_escape_hatch',
        rootPath: join(projectDir, ...segments),
        realScopeRoot: realProject,
        displayPrefix: `${segments[0]}/${segments[1]}`,
        lock: projectLock,
      });
    }
  }
  for (const segments of AGENT_SKILLS_USER_ROOT_SEGMENTS) {
    scanSpecs.push({
      scope: 'user',
      layer: 'user_default',
      rootPath: join(resolvedHome, ...segments),
      realScopeRoot: realHome,
      displayPrefix: `~/${segments[0]}/${segments[1]}`,
      lock: userLock,
    });
  }

  // Read all candidate root directory listings concurrently for <20ms cold latency.
  const rootListings = await Promise.all(
    scanSpecs.map(async (spec) => {
      try {
        return await readdir(spec.rootPath);
      } catch {
        return [] as string[];
      }
    }),
  );

  for (let i = 0; i < scanSpecs.length; i++) {
    if (skills.length >= AGENT_SKILLS_LIMITS.SKILLS) break;
    const spec = scanSpecs[i]!;
    const names = rootListings[i]!.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (skills.length >= AGENT_SKILLS_LIMITS.SKILLS) break;
      if (name.startsWith('.') || !isAgentSkillName(name)) continue;
      const scopeNameKey = `${spec.scope}\u0000${name.toLocaleLowerCase()}`;
      if (seenScopeNames.has(scopeNameKey)) continue;

      const directory = join(spec.rootPath, name);
      const skillFile = join(directory, AGENT_SKILL_FILE_NAME);
      let realDir: string;
      let realSkillFile: string;
      try {
        if (!(await stat(directory)).isDirectory()) continue;
        realDir = await realpath(directory);
        if (!isUnderDir(realDir, spec.realScopeRoot)) continue;
        if (seenRealDirs.has(realDir)) continue;
        if (!(await stat(skillFile)).isFile()) continue;
        realSkillFile = await realpath(skillFile);
        if (dirname(realSkillFile) !== realDir) continue;
        if (seenRealFiles.has(realSkillFile)) continue;
      } catch {
        continue;
      }

      const locked = spec.lock[name] ?? {};
      const frontMatter = await readFrontMatter(realDir);
      const missingBins: string[] = [];
      for (const bin of frontMatter.bins) {
        if (!(await checkCommand(bin))) missingBins.push(bin);
      }

      const entry: AgentSkillEntry = {
        name,
        description: frontMatter.description,
        layer: spec.layer,
        displayPath: `${spec.displayPrefix}/${name}`,
        uri: `skill://${spec.layer}/${encodeURIComponent(name)}`,
        ...(missingBins.length > 0 ? { missingBins } : {}),
        ...(firstString(locked, 'source', AGENT_SKILLS_LIMITS.SOURCE_CHARS) ? { source: firstString(locked, 'source', AGENT_SKILLS_LIMITS.SOURCE_CHARS) } : {}),
        ...(firstString(locked, 'sourceUrl', AGENT_SKILLS_LIMITS.SOURCE_CHARS) ? { sourceUrl: firstString(locked, 'sourceUrl', AGENT_SKILLS_LIMITS.SOURCE_CHARS) } : {}),
        ...(firstString(locked, 'installedAt', 40) ? { installedAt: firstString(locked, 'installedAt', 40) } : {}),
        ...(firstString(locked, 'updatedAt', 40) ? { updatedAt: firstString(locked, 'updatedAt', 40) } : {}),
      };
      seenScopeNames.add(scopeNameKey);
      seenRealDirs.add(realDir);
      seenRealFiles.add(realSkillFile);
      targetByEntry.set(entry, { path: skillFile, layer: spec.layer });
      skills.push(entry);
    }
  }

  try {
    const snapshot = getSkillRegistryManagementSnapshot({ projectDir: context.projectDir, homeDir });
    for (const entry of snapshot.entries) {
      // The picker is device-local: registry metadata without a validated local
      // payload inside scope must not be offered as an installable/expandable skill.
      if (!entry.path) continue;
      const payload = await validateRegistryPayloadPath(entry.path, entry.layer, {
        homeDir: resolvedHome,
        projectDir,
      });
      if (!payload) continue;
      if (seenRealFiles.has(payload.realPath)) continue;
      const name = entry.metadata.name?.trim() || entry.key;
      if (!name || skills.length >= AGENT_SKILLS_LIMITS.SKILLS * 2) break;
      const entryScope = entry.layer === 'project_escape_hatch' ? 'project' : 'user';
      const scopeNameKey = `${entryScope}\u0000${name.toLocaleLowerCase()}`;
      if (isExternalAgentDisplayPath(entry.displayPath) && seenScopeNames.has(scopeNameKey)) continue;

      const listed = { name, description: entry.metadata.description ?? '', layer: entry.layer, displayPath: entry.displayPath, uri: entry.uri } satisfies AgentSkillEntry;
      if (topLevelOnly && !isTopLevelAgentSkillEntry(listed)) continue;
      seenRealFiles.add(payload.realPath);
      targetByEntry.set(listed, { path: payload.candidatePath, layer: entry.layer });
      skills.push(listed);
    }
  } catch { /* registry is optional; local skills remain available */ }
  return { skills, targetByEntry };
}

/** List only the direct skills that the composer should offer. */
export async function listAgentSkills(homeDir: string = homedir(), context: { projectDir?: string } = {}): Promise<AgentSkillEntry[]> {
  return (await listAgentSkillsInternal(homeDir, context, true)).skills;
}

/**
 * Expand composer `$$()` references using discovered agent skills and
 * validated registry entries on this daemon. The marker remains in the timeline
 * text; this copy is provider-bound and never logged. Repeated references are
 * removed after the first expansion so retries/queue drains cannot duplicate
 * a skill body in one prompt.
 */
export async function expandAgentSkillReferences(
  text: string,
  homeDir: string = homedir(),
  context: { projectDir?: string } = {},
): Promise<AgentSkillExpansion> {
  const markers = parseAgentSkillMarkers(text);
  if (markers.length === 0) return { text, unresolved: [], expanded: [] };
  // Expansion keeps compatibility with explicit legacy/nested references;
  // only the picker-facing list is narrowed to top-level entries.
  const { skills, targetByEntry } = await listAgentSkillsInternal(homeDir, context, false);
  const resolvedHome = resolve(homeDir);
  const resolvedProject = context.projectDir?.trim() ? resolve(context.projectDir.trim()) : undefined;
  const unresolved: string[] = [];
  const expanded: string[] = [];
  const emitted = new Set<string>();
  const pattern = /\$\$\(([^()\r\n]{1,300})\)/gu;
  const result = [] as string[];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const body = match[1]?.trim() ?? '';
    const reference = parseAgentSkillReference(body);
    if (!reference) continue;
    result.push(text.slice(last, index));
    last = index + match[0].length;
    const skill = resolveAgentSkillReference(reference, skills);
    if (!skill) {
      unresolved.push(body);
      result.push(match[0]);
      continue;
    }
    if (emitted.has(body)) continue;
    try {
      const target = targetByEntry.get(skill);
      if (!target) {
        unresolved.push(body);
        result.push(match[0]);
        continue;
      }
      const validated = assertSafeRegistryPayloadPathSync({
        path: target.path,
        layer: target.layer,
        homeDir: resolvedHome,
        projectDir: resolvedProject,
        maxBytes: MAX_SKILL_FILE_BYTES,
      });
      const content = await readFile(validated.realPath, 'utf8');
      if (!content.trim() || Buffer.byteLength(content, 'utf8') > MAX_SKILL_FILE_BYTES) {
        unresolved.push(body);
        result.push(match[0]);
        continue;
      }
      emitted.add(body);
      expanded.push(body);
      result.push(`\n${SKILL_CONTENT_START} ${skill.name}]\n${content.trim()}\n[/skill: ${skill.name}]`);
    } catch {
      unresolved.push(body);
      result.push(match[0]);
    }
  }
  result.push(text.slice(last));
  return { text: result.join(''), unresolved: [...new Set(unresolved)], expanded };
}

/** The CLI arguments for one request; the request is already validated. */
export function agentSkillsCliArguments(request: Omit<AgentSkillsRunRequest, 'type' | 'requestId'>): string[] {
  const names = request.names ?? [];
  switch (request.action) {
    case AGENT_SKILLS_ACTION.ADD:
      // Global, every detected agent linked, no prompt: the one install the
      // person asked for, on this machine, for this machine's user.
      return ['add', request.source!, ...names.flatMap((name) => ['--skill', name]), '--global', '--yes'];
    case AGENT_SKILLS_ACTION.UPDATE:
      return ['update', ...names, '--global', '--yes'];
    case AGENT_SKILLS_ACTION.REMOVE:
      return ['remove', ...names, '--global', '--yes'];
  }
  return [];
}

export type AgentSkillsCliRunner = (args: readonly string[]) => Promise<{ ok: boolean; output: string; error?: AgentSkillsError }>;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '').replace(/\r/gu, '');
}

function tail(text: string): string {
  const clean = stripAnsi(text).trim();
  return clean.length > AGENT_SKILLS_LIMITS.OUTPUT_CHARS ? clean.slice(-AGENT_SKILLS_LIMITS.OUTPUT_CHARS) : clean;
}

/**
 * Run `npm exec --yes skills@<pinned> -- ...` through this daemon's own Node.js
 * and npm: no shell anywhere (on Windows `npx` is a `.cmd`, which would need
 * one), and no dependency on what happens to be first on PATH.
 */
export const runAgentSkillsCli: AgentSkillsCliRunner = (args) => new Promise((resolve) => {
  const npmCli = resolveNpmCliJs(undefined);
  if (!npmCli) {
    resolve({ ok: false, output: '', error: AGENT_SKILLS_ERROR.CLI_UNAVAILABLE });
    return;
  }
  const child = spawn(process.execPath, [npmCli, 'exec', '--yes', AGENT_SKILLS_CLI_PACKAGE, '--', ...args], {
    cwd: homedir(),
    env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', DO_NOT_TRACK: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  let output = '';
  const append = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > AGENT_SKILLS_LIMITS.OUTPUT_CHARS * 4) output = output.slice(-AGENT_SKILLS_LIMITS.OUTPUT_CHARS * 2);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, AGENT_SKILLS_LIMITS.RUN_TIMEOUT_MS);
  timer.unref?.();
  child.once('error', () => {
    clearTimeout(timer);
    resolve({ ok: false, output: tail(output), error: AGENT_SKILLS_ERROR.CLI_UNAVAILABLE });
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (timedOut) resolve({ ok: false, output: tail(output), error: AGENT_SKILLS_ERROR.TIMEOUT });
    else if (code === 0) resolve({ ok: true, output: tail(output) });
    else resolve({ ok: false, output: tail(output), error: AGENT_SKILLS_ERROR.CLI_FAILED });
  });
});

/**
 * One add, update or remove at a time on a machine: two CLIs rewriting the same
 * directory and lock file would leave either one's result half applied.
 */
export function createAgentSkillsRunner(options: {
  homeDir?: string;
  runCli?: AgentSkillsCliRunner;
} = {}) {
  let running = false;
  return async (request: Omit<AgentSkillsRunRequest, 'type' | 'requestId'>): Promise<{
    ok: boolean;
    error?: AgentSkillsError;
    output?: string;
    skills: AgentSkillEntry[];
  }> => {
    if (running) {
      return { ok: false, error: AGENT_SKILLS_ERROR.BUSY, skills: await listAgentSkills(options.homeDir) };
    }
    running = true;
    try {
      const result = await (options.runCli ?? runAgentSkillsCli)(agentSkillsCliArguments(request));
      return {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.output ? { output: result.output } : {}),
        skills: await listAgentSkills(options.homeDir),
      };
    } finally {
      running = false;
    }
  };
}

/**
 * This machine's one runner, shared by the server-routed requests and the
 * agent-facing install tool so both honour the same one-at-a-time rule.
 */
export const runAgentSkillsOnThisMachine = createAgentSkillsRunner();

/**
 * Answer one agent-skills request from the server. The request comes from a
 * browser the server has already authorised for this machine; everything in
 * it is still validated here before anything runs.
 */
export async function handleAgentSkillsCommand(
  cmd: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  run: ReturnType<typeof createAgentSkillsRunner> = runAgentSkillsOnThisMachine,
): Promise<void> {
  const requestId = typeof cmd.requestId === 'string' && cmd.requestId.length <= 128 ? cmd.requestId : undefined;
  if (!requestId) return;
  if (cmd.type === AGENT_SKILLS_MSG.LIST_REQUEST) {
    const projectDir = typeof cmd.projectDir === 'string' && cmd.projectDir.length < 4096 ? cmd.projectDir : undefined;
    send({ type: AGENT_SKILLS_MSG.LIST_RESPONSE, requestId, skills: await listAgentSkills(homedir(), { projectDir }) });
    return;
  }
  if (cmd.type !== AGENT_SKILLS_MSG.RUN_REQUEST) return;
  const request = readAgentSkillsRunRequest(cmd);
  if (!request) {
    send({ type: AGENT_SKILLS_MSG.RUN_RESPONSE, requestId, ok: false, error: AGENT_SKILLS_ERROR.INVALID_REQUEST });
    return;
  }
  send({ type: AGENT_SKILLS_MSG.RUN_RESPONSE, requestId, ...(await run(request)) });
}
