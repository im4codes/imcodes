/**
 * Detects a shell command that WRITES git state (reset, checkout, cherry-pick,
 * commit, ...) inside a project's main checkout. Pure string logic (no fs, no
 * node imports) so daemon, tests and any future surface share one classifier.
 *
 * It answers only "does this command definitely write git state in one of these
 * roots?". Anything it cannot resolve (a `$VAR` directory, `--git-dir` elsewhere,
 * an unknown `cd` target) is NOT reported: the guard must never block a command
 * it is unsure about. Read-only git (status, log, diff, show, fetch, worktree
 * list, branch listing...) is never reported.
 *
 * Cost: every tool call first runs one linear regex (`GIT_WRITE_PRECHECK`);
 * commands without a git write verb return before any tokenising. Only the rare
 * command that mentions `git <write verb>` is tokenised.
 */

export interface MainCheckoutGitWrite {
  /** The git subcommand, e.g. `reset`. */
  verb: string;
  /** The directory the command resolves to (inside a root). */
  dir: string;
  /** The root it falls inside. */
  root: string;
}

export interface MainCheckoutGitWriteInput {
  /** The command line, or an argv such as ['/bin/zsh', '-lc', 'git reset --hard']. */
  command: string | readonly string[];
  /** Directory the tool runs in when the command does not `cd`. */
  cwd: string;
  /** Main checkout roots to protect. */
  roots: readonly string[];
  /** Expands a leading `~`; without it a `~` path is unresolved (not reported). */
  home?: string;
}

/** Subcommands that always change git state (index, refs, working tree, stash). */
const ALWAYS_WRITE = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull', 'rebase',
  'reset', 'restore', 'revert', 'rm', 'switch', 'update-ref',
]);
const WRITE_VERB_ALTERNATION = [...ALWAYS_WRITE, 'branch', 'tag', 'stash'].map((verb) => verb.replace('-', '\\-')).join('|');
/** `git` followed (on the same line, allowing global options) by a write verb. Linear: no nested quantifiers. */
const GIT_WRITE_PRECHECK = new RegExp(`\\bgit\\b[^\\n]*?\\b(?:${WRITE_VERB_ALTERNATION})\\b`);

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'powershell', 'pwsh', 'cmd']);
const WRAPPER_WORDS = new Set(['env', 'command', 'sudo', 'time', 'nohup', 'exec', 'builtin']);

interface Word { text: string; dynamic: boolean }
type Token = Word | { op: ';' | '(' | ')' };

function isOp(token: Token): token is { op: ';' | '(' | ')' } {
  return 'op' in token;
}

/** Split a shell line into words and statement separators, honouring quotes. `dynamic` marks $expansions/backticks. */
function tokenize(script: string): Token[] {
  const tokens: Token[] = [];
  let current = '';
  let dynamic = false;
  let inWord = false;
  let quote: '"' | "'" | undefined;
  const flush = () => {
    if (inWord) tokens.push({ text: current, dynamic });
    current = ''; dynamic = false; inWord = false;
  };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (quote) {
      if (char === quote) { quote = undefined; continue; }
      // POSIX double quotes escape only \" \\ \$ \` -- any other backslash is data (a Windows path).
      if (quote === '"' && char === '\\' && index + 1 < script.length && '"\\$`'.includes(script[index + 1]!)) { current += script[++index]; continue; }
      if (quote === '"' && (char === '$' || char === '`')) dynamic = true;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; inWord = true; continue; }
    if (char === '\\' && index + 1 < script.length) {
      // Inside a drive-letter word (C:\\Users\\k) the backslash is a path separator, not an escape.
      if (/^[A-Za-z]:/.test(current)) { current += char; inWord = true; continue; }
      current += script[index + 1]!; index += 1; inWord = true; continue;
    }
    if (char === '$' || char === '`') { dynamic = true; current += char; inWord = true; continue; }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      flush();
      if (script[index + 1] === char && (char === '|' || char === '&')) index += 1;
      tokens.push({ op: ';' });
      continue;
    }
    if (char === '(' || char === ')') { flush(); tokens.push({ op: char }); continue; }
    if (char === ' ' || char === '\t' || char === '\r') { flush(); continue; }
    if (char === '#' && !inWord) { while (index < script.length && script[index] !== '\n') index += 1; index -= 1; continue; }
    current += char; inWord = true;
  }
  flush();
  return tokens;
}

function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const drive = /^[A-Za-z]:/.test(slashed) ? slashed.slice(0, 2).toLowerCase() : '';
  const rest = drive ? slashed.slice(2) : slashed;
  const absolute = rest.startsWith('/');
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(drive ? part.toLowerCase() : part);
  }
  return `${drive}${absolute ? '/' : ''}${parts.join('/')}`;
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path);
}

/** Resolve `target` against `base`; undefined when it depends on something we cannot know. */
function resolveDir(base: string | undefined, word: Word, home: string | undefined): string | undefined {
  if (word.dynamic) return undefined;
  let target = word.text;
  if (target === '~' || target.startsWith('~/')) {
    if (!home) return undefined;
    target = home + target.slice(1);
  } else if (target.startsWith('~')) {
    return undefined;
  }
  if (isAbsolute(target)) return normalize(target);
  return base === undefined ? undefined : normalize(`${base}/${target}`);
}

function isInside(root: string, dir: string): boolean {
  return dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Is `git <verb> <args>` a write? Handles the verbs that are read-only in some forms. */
function isWrite(verb: string, args: readonly string[]): boolean {
  if (ALWAYS_WRITE.has(verb)) return true;
  const flags = args.filter((arg) => arg.startsWith('-'));
  const positionals = args.filter((arg) => !arg.startsWith('-'));
  if (verb === 'branch') {
    if (flags.some((flag) => /^(--list|-l|--show-current|-v|-vv|--verbose|-a|--all|-r|--remotes|--contains|--merged|--no-merged|--points-at)$/.test(flag)) && !flags.some((flag) => /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|-f|--force|-u|--set-upstream-to|--unset-upstream|--edit-description)/.test(flag))) return false;
    return positionals.length > 0 || flags.some((flag) => /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|--set-upstream-to|--unset-upstream|-u)/.test(flag));
  }
  if (verb === 'tag') {
    if (flags.some((flag) => /^(-l|--list|-v|--verify|--contains|--merged|--no-merged|--points-at)$/.test(flag))) return false;
    return positionals.length > 0 || flags.some((flag) => /^(-d|--delete|-a|-s|-f|-m|-u)/.test(flag));
  }
  if (verb === 'stash') {
    const sub = positionals[0];
    return !(sub === 'list' || sub === 'show');
  }
  return false;
}

/**
 * Returns the first git-state write that resolves into one of `roots`, else
 * undefined. Never throws.
 */
export function findMainCheckoutGitWrite(input: MainCheckoutGitWriteInput): MainCheckoutGitWrite | undefined {
  try {
    let script: string;
    if (typeof input.command === 'string') {
      script = input.command;
    } else {
      const argv = input.command;
      const shell = argv[0]?.split(/[\\/]/).pop()?.replace(/\.exe$/i, '');
      const flagIndex = argv.findIndex((arg, i) => i > 0 && /^(-[a-z]*c[a-z]*|\/c|-command)$/i.test(arg));
      script = shell && SHELL_NAMES.has(shell) && flagIndex > 0 && argv[flagIndex + 1] !== undefined ? argv[flagIndex + 1]! : argv.join(' ');
    }
    if (!GIT_WRITE_PRECHECK.test(script)) return undefined;
    const roots = input.roots.map(normalize).filter(Boolean);
    if (roots.length === 0) return undefined;

    const tokens = tokenize(script);
    let cwd: string | undefined = normalize(input.cwd);
    const cwdStack: Array<string | undefined> = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (isOp(token)) {
        if (token.op === '(') cwdStack.push(cwd);
        else if (token.op === ')' && cwdStack.length) cwd = cwdStack.pop();
        index += 1;
        continue;
      }
      // One simple command: words up to the next separator.
      const words: Word[] = [];
      while (index < tokens.length && !isOp(tokens[index]!)) words.push(tokens[index++] as Word);
      let at = 0;
      while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!.text) || WRAPPER_WORDS.has(words[at]!.text) || (words[at]!.text.startsWith('-') && at > 0 && WRAPPER_WORDS.has(words[at - 1]!.text)))) at += 1;
      const head = words[at];
      if (!head) continue;
      if (head.text === 'cd' || head.text === 'pushd') {
        const target = words[at + 1];
        cwd = target && target.text !== '-' ? resolveDir(cwd, target, input.home) : undefined;
        continue;
      }
      if (head.text.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') !== 'git') continue;
      // git [global options] <subcommand> [args]
      let dir = cwd;
      let dirKnown = true;
      let cursor = at + 1;
      let verb: string | undefined;
      while (cursor < words.length) {
        const word = words[cursor]!;
        const text = word.text;
        if (text === '-C') { const next = words[cursor + 1]; dir = next ? resolveDir(dir, next, input.home) : undefined; cursor += 2; continue; }
        if (text === '-c' || text === '--namespace' || text === '--exec-path') { cursor += 2; continue; }
        if (text.startsWith('--git-dir') || text.startsWith('--work-tree')) {
          // Redirected repository: only a --work-tree we can resolve counts; otherwise we cannot tell.
          const value = text.includes('=') ? { text: text.slice(text.indexOf('=') + 1), dynamic: word.dynamic } : words[cursor + 1];
          if (text.startsWith('--work-tree')) dir = value ? resolveDir(dir, value, input.home) : undefined;
          else dirKnown = false;
          cursor += text.includes('=') ? 1 : 2;
          continue;
        }
        if (text.startsWith('-')) { cursor += 1; continue; }
        verb = text;
        break;
      }
      if (!verb || !dirKnown || dir === undefined) continue;
      const args = words.slice(cursor + 1).map((word) => word.text);
      if (!isWrite(verb, args)) continue;
      const root = roots.find((candidate) => isInside(candidate, dir!));
      if (root) return { verb, dir, root };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
