import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  agentResourceOwner,
  bindAgentProcessResource,
} from '../../src/agent/providers/agent-process-resource.js';

/**
 * The startup-sweep lease depends on a THREE-LINK chain, and an audit found the
 * first link broken while tests on the third link still passed:
 *
 *   1. session-manager passes the persisted identity into runtime.initialize
 *   2. each per-session provider stores agentResourceOwner(config) on its state
 *   3. bindAgentProcessResource registers an AGENT lease for that owner
 *
 * Link 2 was covered. Link 1 was not: the restore path passed only
 * `sessionName`, so `agentResourceOwner()` returned null, no lease was written,
 * and a later daemon crash recreated the original orphan leak. Because the
 * failure is a MISSING property at a call site, the contract has to be asserted
 * at that call site — which is what the AST case below does.
 *
 * Scope, stated plainly: this does not boot a daemon. It pins the exact link
 * that broke (every runtime.initialize call carries the full identity) and the
 * exact consequence of breaking it (a partial identity yields no owner, and no
 * owner registers nothing).
 */

const IDENTITY_FIELDS = ['sessionName', 'sessionInstanceId', 'runtimeEpoch'];

function initializeCallSites(relative: string): { line: number; provided: string[] }[] {
  const path = join(process.cwd(), relative);
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const sites: { line: number; provided: string[] }[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.getText() === 'initialize'
    ) {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const provided: string[] = [];
        for (const prop of options.properties) {
          // Plain `sessionName: x`
          if (ts.isPropertyAssignment(prop)) provided.push(prop.name.getText());
          // Conditional spread `...(x ? { sessionInstanceId: x } : {})`
          if (ts.isSpreadAssignment(prop)) {
            for (const field of IDENTITY_FIELDS) {
              if (prop.expression.getText().includes(field)) provided.push(field);
            }
          }
        }
        sites.push({
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          provided,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return sites;
}

describe('a restored session keeps its startup-sweep lease authority', () => {
  it('every runtime.initialize call passes the full owner identity', () => {
    const sites = initializeCallSites('src/agent/session-manager.ts');
    expect(sites.length, 'both the fresh-launch and restore call sites are found').toBeGreaterThanOrEqual(2);

    const offenders: string[] = [];
    for (const site of sites) {
      const missing = IDENTITY_FIELDS.filter((field) => !site.provided.includes(field));
      if (missing.length > 0) offenders.push(`line ${site.line} omits ${missing.join(', ')}`);
    }
    expect(
      offenders,
      'a call site that omits any identity field silently disables crash recovery for that session',
    ).toEqual([]);
  });

  it('a partial identity yields no owner at all, so nothing would be registered', () => {
    const complete = {
      sessionName: 'deck_alpha_w1',
      sessionInstanceId: 'instance-a',
      runtimeEpoch: 'epoch-a',
    };
    expect(agentResourceOwner(complete)).toEqual(complete);

    // Exactly the restore-path shape that was broken: name only.
    expect(agentResourceOwner({ sessionName: 'deck_alpha_w1' })).toBeNull();
    for (const field of IDENTITY_FIELDS) {
      const partial = { ...complete, [field]: undefined };
      expect(
        agentResourceOwner(partial),
        `${field} is required, so omitting it must not produce a half-owner`,
      ).toBeNull();
    }
    // Blank strings are not an identity either.
    expect(agentResourceOwner({ ...complete, runtimeEpoch: '   ' })).toBeNull();
  });

  it('binding with no owner registers nothing and stays harmless', async () => {
    // The consequence of link 1 breaking: bind is called, and silently does
    // nothing. Proven here so the null path is a known state rather than a
    // surprise, and so it cannot throw into a live session.
    const fakeChild = { pid: 424242, once: () => {} } as unknown as Parameters<typeof bindAgentProcessResource>[1];
    const resource = bindAgentProcessResource(null, fakeChild);
    await expect(resource.release()).resolves.toBeUndefined();
  });

  it('binding with an owner but no usable pid also registers nothing', async () => {
    const owner = { sessionName: 'deck_alpha_w1', sessionInstanceId: 'i', runtimeEpoch: 'e' };
    for (const pid of [undefined, 0, -1]) {
      const fakeChild = { pid, once: () => {} } as unknown as Parameters<typeof bindAgentProcessResource>[1];
      const resource = bindAgentProcessResource(owner, fakeChild);
      await expect(resource.release()).resolves.toBeUndefined();
    }
  });
});
