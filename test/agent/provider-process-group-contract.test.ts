import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Structural binding between a spawned agent process and its reaper.
 *
 * The runtime cases in test/util/owned-process-group.test.ts prove that an
 * owned process group is reaped whole. They spawn their own detached child, so
 * they cannot notice a PROVIDER that stops creating a group, or one that
 * creates a group and then tears it down with a leader-only signal — the exact
 * shape found in cursor-headless during audit.
 *
 * Counting occurrences is not enough either: a file with three spawns and three
 * reaps can still pair them wrongly. So this walks the AST and binds each
 * spawned ChildProcess to the handle it is retained on, and each retained
 * handle to a killProcessTree call that asserts ownsProcessGroup on it.
 */

/** Providers that spawn a session-owned agent CLI. */
const SESSION_OWNED = [
  'claude-code-sdk',
  'cursor-headless',
  'pi',
  'qwen',
  'deepseek-harness',
];

/**
 * Providers that share ONE process across every session. They must own a group
 * and reap it, but they must NOT take a per-session registry lease: registering
 * a shared process under one session's owner would let that session's teardown
 * reap another session's live agent.
 */
const DAEMON_SHARED = ['codex-sdk', 'gemini-sdk', 'kimi-sdk'];

const ALL = [...SESSION_OWNED, ...DAEMON_SHARED];

interface SpawnFacts {
  /** Spawn option objects that declare a POSIX process group. */
  detachedSpawns: number;
  /** Spawn option objects that do not. */
  ungroupedSpawns: string[];
  /** Handle expressions a spawn result is retained on, e.g. `state.child`. */
  retainedHandles: Set<string>;
  /** Handle expressions passed to killProcessTree with ownsProcessGroup: true. */
  ownedReaps: Set<string>;
  /** killProcessTree calls that do NOT assert ownership. */
  unownedReaps: string[];
  /** killProcessTree calls whose promise is discarded. */
  discardedReaps: string[];
  /**
   * Local aliases of a retained handle, e.g. `const child = state.currentChild`.
   * Teardown routinely reads the handle into a local first, so a reap on the
   * alias is a reap on the handle. Without this the check would report false
   * offenders and pressure production to satisfy a naive text match.
   */
  aliases: Map<string, string>;
}

function parse(relative: string): ts.SourceFile {
  const path = join(process.cwd(), relative);
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function objectHasTruthyProp(node: ts.Expression | undefined, name: string): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((prop) => (
    ts.isPropertyAssignment(prop)
    && prop.name.getText() === name
    && prop.initializer.getText() !== 'false'
  ));
}

function collect(relative: string): SpawnFacts {
  const source = parse(relative);
  const facts: SpawnFacts = {
    detachedSpawns: 0,
    ungroupedSpawns: [],
    retainedHandles: new Set(),
    ownedReaps: new Set(),
    unownedReaps: [],
    discardedReaps: [],
    aliases: new Map(),
  };

  const visit = (node: ts.Node): void => {
    // spawn(cmd, args, options) — the options object is the last object literal arg
    if (ts.isCallExpression(node) && node.expression.getText() === 'spawn') {
      const options = [...node.arguments].reverse()
        .find((arg): arg is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(arg));
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (objectHasTruthyProp(options, 'detached')) facts.detachedSpawns += 1;
      else facts.ungroupedSpawns.push(`line ${line}`);
    }

    // `state.child = child` / `this.child = child` — the retained handle
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && /child$/i.test(node.left.name.getText())
      && !ts.isIdentifier(node.right) === false
    ) {
      facts.retainedHandles.add(node.left.getText());
    }

    // `const child = state.currentChild` — an alias of a retained handle
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isPropertyAccessExpression(node.initializer)
      && /child$/i.test(node.initializer.name.getText())
    ) {
      facts.aliases.set(node.name.getText(), node.initializer.getText());
    }

    // killProcessTree(handle, { ownsProcessGroup: true })
    if (ts.isCallExpression(node) && node.expression.getText() === 'killProcessTree') {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const target = node.arguments[0]?.getText() ?? '(none)';
      const options = node.arguments[1];
      if (objectHasTruthyProp(options, 'ownsProcessGroup')) facts.ownedReaps.add(target);
      else facts.unownedReaps.push(`line ${line}: ${target}`);

      // A discarded promise cannot complete its SIGTERM->SIGKILL escalation.
      const parent = node.parent;
      const chained = ts.isPropertyAccessExpression(parent) ? parent.parent?.parent : parent;
      const text = (chained ?? parent).getText();
      const isAwaited = ts.isAwaitExpression(parent)
        || (ts.isPropertyAccessExpression(parent) && ts.isAwaitExpression(parent.parent?.parent ?? parent));
      const isRetained = ts.isVariableDeclaration(parent) || ts.isBinaryExpression(parent);
      if (!isAwaited && !isRetained && text.trimStart().startsWith('void ')) {
        facts.discardedReaps.push(`line ${line}: ${target}`);
      }
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return facts;
}

describe('every spawned agent process is bound to a group-owning reaper', () => {
  it('every provider spawn declares its own POSIX process group', () => {
    const offenders: string[] = [];
    for (const provider of ALL) {
      const facts = collect(`src/agent/providers/${provider}.ts`);
      expect(facts.detachedSpawns, `${provider} has no detached spawn`).toBeGreaterThan(0);
      for (const site of facts.ungroupedSpawns) offenders.push(`${provider} ${site}`);
    }
    expect(
      offenders,
      'a spawn without a group leaves no token teardown can use after the parent dies',
    ).toEqual([]);
  });

  it('every retained child handle is reaped with declared group ownership', () => {
    const offenders: string[] = [];
    for (const provider of ALL) {
      const facts = collect(`src/agent/providers/${provider}.ts`);
      // This is the pairing the audit asked for: not counts, but the specific
      // handle a spawn was stored on appearing as a group-owning reap target.
      expect(facts.retainedHandles.size, `${provider} retains no child handle`).toBeGreaterThan(0);
      const reapedHandles = new Set<string>();
      for (const target of facts.ownedReaps) {
        reapedHandles.add(target);
        const aliased = facts.aliases.get(target);
        if (aliased) reapedHandles.add(aliased);
      }
      for (const handle of facts.retainedHandles) {
        if (!reapedHandles.has(handle)) offenders.push(`${provider}: ${handle} is spawned but never group-reaped`);
      }
      for (const site of facts.unownedReaps) offenders.push(`${provider}: ${site} reaps without declaring ownership`);
    }
    expect(offenders, 'a group that nobody signals is not an improvement').toEqual([]);
  });

  it('no teardown discards its escalation promise', () => {
    const offenders: string[] = [];
    for (const provider of ALL) {
      const facts = collect(`src/agent/providers/${provider}.ts`);
      for (const site of facts.discardedReaps) offenders.push(`${provider}: ${site}`);
    }
    expect(
      offenders,
      'a discarded promise is how a SIGTERM lands with its SIGKILL never following',
    ).toEqual([]);
  });

  it('only per-session providers take a registry lease', () => {
    for (const provider of SESSION_OWNED) {
      const source = readFileSync(join(process.cwd(), `src/agent/providers/${provider}.ts`), 'utf8');
      expect(source, `${provider} must register its session-owned child`).toContain('bindAgentProcessResource(');
    }
    for (const provider of DAEMON_SHARED) {
      const source = readFileSync(join(process.cwd(), `src/agent/providers/${provider}.ts`), 'utf8');
      expect(
        source,
        `${provider} shares one process across sessions, so a per-session lease would let one session reap another's agent`,
      ).not.toContain('bindAgentProcessResource(');
    }
  });

  it('the agent registrar declares group ownership on the lease it stores', () => {
    // Source-level on purpose: `registerAgentProcessResource` binds the daemon's
    // real on-disk ledger singleton, and a test must not write to that. The
    // behavioural half is covered in test/daemon/agent-process-startup-sweep.ts
    // against an injected registry; this pins the one field that test cannot
    // observe through the production registrar.
    const source = readFileSync(join(process.cwd(), 'src/daemon/session-resource-service.ts'), 'utf8');
    const registrar = source.slice(source.indexOf('export async function registerAgentProcessResource'));
    const body = registrar.slice(0, registrar.indexOf('\n}'));
    expect(
      body,
      'without killTree the sweep signals the leader only, and the survivors are exactly the incident',
    ).toContain('killTree: true');
    expect(body).toContain('SESSION_RESOURCE_KIND.AGENT');
  });

  it('every per-session provider derives its owner from the session config', () => {
    // A lease with a null owner is never registered, so breaking the derivation
    // silently removes crash coverage while every other check still passes.
    const offenders: string[] = [];
    for (const provider of SESSION_OWNED) {
      const source = readFileSync(join(process.cwd(), `src/agent/providers/${provider}.ts`), 'utf8');
      if (!/resourceOwner:\s*agentResourceOwner\(config\)/.test(source)) offenders.push(provider);
    }
    expect(offenders, 'the owner tuple must come from SessionConfig, not be left null').toEqual([]);
  });

  it('does not claim ownership where no group was created', () => {
    // codex-runtime-config spawns short-lived probe children WITHOUT a group.
    const facts = collect('src/agent/codex-runtime-config.ts');
    expect(facts.ownedReaps.size, 'a probe that owns no group must not claim one').toBe(0);
  });
});
