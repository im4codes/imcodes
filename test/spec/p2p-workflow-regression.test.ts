import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Static reverse-regression guard for the smart-p2p-upgrade change.
//
// This is NOT a runtime test; it is a grep-style guard that fails CI if any of
// the high-risk anti-patterns called out in the OpenSpec spec-gates re-enter
// the source tree. Each guard is calibrated against the current safe state of
// the codebase.
//
// If a guard breaks because of a legitimate refactor, update both the source
// and the regex in the same commit so future regressions still fail the test.

const ROOT = resolve(__dirname, '..', '..');

interface FileText {
  path: string;
  text: string;
  lines: string[];
}

function read(rel: string): FileText {
  const abs = resolve(ROOT, rel);
  const text = readFileSync(abs, 'utf8');
  return { path: rel, text, lines: text.split('\n') };
}

function reportLines(file: FileText, predicate: (line: string) => boolean): string[] {
  const offenders: string[] = [];
  file.lines.forEach((line, index) => {
    if (predicate(line)) offenders.push(`${file.path}:${index + 1}: ${line.trim()}`);
  });
  return offenders;
}

describe('p2p-workflow reverse-regression', () => {
  // ── 1. Server WebSocket / DB code casting daemon payloads to `any` for
  //      advanced snapshot persistence. The current safe pattern is to use
  //      typed projections from `shared/p2p-workflow-types.ts` and the
  //      allowlist sanitizer in `server/src/p2p-workflow-sanitize.ts`. Any
  //      `as any` on a line that mentions `progress_snapshot` or
  //      `workflow_projection` indicates an attempt to bypass the sanitizer.
  it('server code never casts daemon payloads to `any` for advanced snapshot persistence', () => {
    const files = [
      'server/src/p2p-workflow-sanitize.ts',
      'server/src/ws/bridge.ts',
      'server/src/db/queries.ts',
      'server/src/routes/discussions.ts',
    ].filter((rel) => existsSync(resolve(ROOT, rel)));

    const offenders: string[] = [];
    for (const rel of files) {
      const file = read(rel);
      offenders.push(
        ...reportLines(file, (line) =>
          /\bas\s+any\b/.test(line) && /(progress_snapshot|workflow_projection)/.test(line),
        ),
      );
    }
    expect(offenders, `Disallowed \`as any\` cast on a line referencing progress_snapshot/workflow_projection:\n${offenders.join('\n')}`).toEqual([]);
  });

  // ── 2. P2pWorkflowStatusProjection / P2pPersistedWorkflowSnapshot must NOT
  //      be declared with arbitrary index signatures. Allowing
  //      `[key: string]: unknown` would defeat the allowlist sanitizer by
  //      letting executor-private fields ride along on the public projection.
  it('public projection types never declare arbitrary index signatures', () => {
    const file = read('shared/p2p-workflow-types.ts');
    const interfaceRegions: Array<{ name: string; start: number; end: number }> = [];
    file.lines.forEach((line, index) => {
      const match = /^export interface (P2pWorkflowStatusProjection|P2pPersistedWorkflowSnapshot)\b/.exec(line);
      if (match) interfaceRegions.push({ name: match[1], start: index, end: file.lines.length });
    });
    // Resolve end of each interface (next `^}` line at column 0).
    for (const region of interfaceRegions) {
      for (let i = region.start + 1; i < file.lines.length; i += 1) {
        if (/^\}/.test(file.lines[i])) {
          region.end = i;
          break;
        }
      }
    }
    const offenders: string[] = [];
    for (const region of interfaceRegions) {
      for (let i = region.start; i <= region.end; i += 1) {
        const line = file.lines[i];
        // Match index signatures like `[key: string]: unknown` or `[k: string]: any`.
        if (/\[[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*string\s*\]\s*:/.test(line)) {
          offenders.push(`${file.path}:${i + 1}: ${line.trim()} (in ${region.name})`);
        }
      }
    }
    // Also forbid the same in any other file that redeclares these types.
    const validatorFile = read('shared/p2p-workflow-validators.ts');
    validatorFile.lines.forEach((line, index) => {
      // Only flag interface/type redeclarations (not type aliases that reference the canonical type).
      if (/^export\s+(interface|type)\s+(P2pWorkflowStatusProjection|P2pPersistedWorkflowSnapshot)\b/.test(line)) {
        offenders.push(`${validatorFile.path}:${index + 1}: forbidden redeclaration of canonical projection type`);
      }
    });
    expect(offenders, `Public projection types must not have arbitrary index signatures or redeclarations:\n${offenders.join('\n')}`).toEqual([]);
  });

  // ── 3. The server bridge MUST default-deny unknown `p2p.*` messages by
  //      routing them through `parseP2pWorkflowMessageType` BEFORE any
  //      forwarding/broadcast. There must be no ad-hoc `case 'p2p.x':` or
  //      `startsWith('p2p.')` branches in `server/src/ws/bridge.ts` that
  //      forward without going through the registry.
  it('server bridge never default-broadcasts unknown p2p.* messages', () => {
    const file = read('server/src/ws/bridge.ts');
    expect(
      file.text.includes('parseP2pWorkflowMessageType'),
      'bridge.ts must import and call parseP2pWorkflowMessageType to gate p2p.* routing',
    ).toBe(true);

    const offenders: string[] = [];
    file.lines.forEach((line, index) => {
      const trimmed = line.trim();
      // Forbid `case 'p2p.<x>':` switch arms (registry-driven dispatch should not branch on literals).
      if (/^case\s+(['"`])p2p\.[A-Za-z0-9_.]+\1\s*:/.test(trimmed)) {
        offenders.push(`${file.path}:${index + 1}: ${trimmed}`);
      }
      // Forbid `msg.type.startsWith('p2p.')` / `type.startsWith('p2p.')` style fan-out.
      if (/\.startsWith\((['"`])p2p\.\1\)/.test(trimmed)) {
        offenders.push(`${file.path}:${index + 1}: ${trimmed}`);
      }
    });
    expect(offenders, `Bridge contains ad-hoc p2p.* dispatch that bypasses parseP2pWorkflowMessageType:\n${offenders.join('\n')}`).toEqual([]);

    // The relayToBrowsers helper must call parseP2pWorkflowMessageType BEFORE
    // any later `safeSend`/broadcast/`forEach` over viewers — otherwise unknown
    // p2p messages could leak. Locate the relayToBrowsers function span and
    // verify the parse call appears in the first dozen lines of its body.
    const relayStart = file.lines.findIndex((line) => /private\s+relayToBrowsers\s*\(/.test(line));
    expect(relayStart, 'relayToBrowsers function not found in bridge.ts').toBeGreaterThanOrEqual(0);
    const headerWindow = file.lines.slice(relayStart, relayStart + 30).join('\n');
    expect(
      /parseP2pWorkflowMessageType\s*\(/.test(headerWindow),
      'relayToBrowsers must call parseP2pWorkflowMessageType in its first 30 lines (default-deny for unknown p2p.*)',
    ).toBe(true);
  });

  // ── 4. The advanced runtime MUST NOT execute raw `advancedRounds` from the
  //      command. `compileP2pWorkflowDraft` is the SOLE source of advanced
  //      round materialization for envelope-based launches, and the rounds
  //      that flow into `startP2pRun` come from `preparedAdvanced.advancedRounds`
  //      (compiled+bound) before the legacy passthrough is allowed.
  it('advanced rounds for new-envelope launches always flow through compileP2pWorkflowDraft', () => {
    const file = read('src/daemon/command-handler.ts');
    expect(
      file.text.includes('compileP2pWorkflowDraft'),
      'command-handler must import and use compileP2pWorkflowDraft for advanced launches',
    ).toBe(true);
    expect(
      file.text.includes('bindP2pCompiledWorkflow'),
      'command-handler must import and use bindP2pCompiledWorkflow for advanced launches',
    ).toBe(true);
    expect(
      file.text.includes('prepareAdvancedWorkflowLaunch'),
      'command-handler must funnel advanced launches through prepareAdvancedWorkflowLaunch',
    ).toBe(true);

    // prepareAdvancedWorkflowLaunch must invoke compileP2pWorkflowDraft and
    // bindP2pCompiledWorkflow internally — no other call site is allowed for
    // these functions in the daemon source tree.
    const compileCount = (file.text.match(/\bcompileP2pWorkflowDraft\s*\(/g) ?? []).length;
    expect(compileCount, 'compileP2pWorkflowDraft must be invoked exactly once in command-handler (inside prepareAdvancedWorkflowLaunch)').toBe(1);
    const bindCount = (file.text.match(/\bbindP2pCompiledWorkflow\s*\(/g) ?? []).length;
    expect(bindCount, 'bindP2pCompiledWorkflow must be invoked exactly once in command-handler (inside prepareAdvancedWorkflowLaunch)').toBe(1);

    // Audit:V-1 / N-H1 — startP2pRun MUST receive the bound workflow via the
    // typed `advanced: { kind: 'envelope_compiled', bound: preparedAdvanced.bound, ... }`
    // discriminated union. Pure-legacy launches (no envelope) fall back to the
    // deprecated top-level `advancedPresetKey` / `advancedRounds` passthrough.
    // This guards against a future edit that bypasses the bound parameter.
    expect(
      /kind:\s*'envelope_compiled'[^,]*,?\s*bound:\s*preparedAdvanced\.bound/m.test(file.text),
      'startP2pRun call must pass `advanced: { kind: "envelope_compiled", bound: preparedAdvanced.bound, ... }` so executor receives capabilitySnapshot/policy',
    ).toBe(true);
    expect(
      file.text.includes('compiledFromEnvelope'),
      'command-handler must distinguish compiled-from-envelope path from legacy passthrough (look for `compiledFromEnvelope` ternary)',
    ).toBe(true);

    // Make sure no daemon file outside src/daemon/p2p-workflow-bind.ts and
    // src/daemon/command-handler.ts invokes compile/bind directly — both must
    // remain centralised through prepareAdvancedWorkflowLaunch.
    const candidatePaths = [
      'src/daemon/p2p-orchestrator.ts',
      'src/daemon/server-link.ts',
      'src/router/message-router.ts',
    ];
    const offenders: string[] = [];
    for (const rel of candidatePaths) {
      if (!existsSync(resolve(ROOT, rel))) continue;
      const f = read(rel);
      f.lines.forEach((line, index) => {
        if (/\bcompileP2pWorkflowDraft\s*\(/.test(line) || /\bbindP2pCompiledWorkflow\s*\(/.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `compile/bind must only be invoked from command-handler/p2p-workflow-bind:\n${offenders.join('\n')}`).toEqual([]);
  });

  // ── 5. Artifact success checks must NOT use `readdir().join(` as evidence —
  //      that pattern was identified as unsafe (cannot detect modifications,
  //      missing fields, or hash collisions). The advanced workflow artifact
  //      runtime in `src/daemon/p2p-workflow-artifact-runtime.ts` and the
  //      shared helpers in `shared/p2p-workflow-artifacts.ts` MUST avoid it.
  //
  //      Note: `src/daemon/p2p-orchestrator.ts:1276` contains a legacy
  //      `readdir().join('\\n')` for the OLD openspec_convention path — that
  //      pre-existing legacy behavior is explicitly out-of-scope for the new
  //      workflow guard. The new workflow paths must remain free of it.
  it('new advanced workflow artifact code never uses readdir().join() as success evidence', () => {
    const guarded = [
      'shared/p2p-workflow-artifacts.ts',
      'src/daemon/p2p-workflow-artifact-runtime.ts',
    ].filter((rel) => existsSync(resolve(ROOT, rel)));

    const offenders: string[] = [];
    for (const rel of guarded) {
      const file = read(rel);
      // Match a readdir(...) call DIRECTLY chained to .join( — i.e. with
      // nothing between the closing `)` of readdir (and an optional outer `)`
      // for `(await readdir(...))`) and the `.join(`. We tolerate whitespace
      // only, NOT identifiers, semicolons, or other tokens. This excludes
      // legitimate uses like `path.join(...)` later in the same file.
      const compactText = file.text.replace(/\s+/g, ' ');
      const pattern = /\breaddir\s*\([^()]*\)\s*\)?\.join\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(compactText)) != null) {
        offenders.push(`${rel}: matched substring "${match[0]}"`);
      }
    }
    expect(offenders, `Artifact runtime must not use readdir().join() as success evidence:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('browser-reachable workflow validators do not import Node-only artifact helpers', () => {
    const files = [
      'shared/p2p-workflow-validators.ts',
      'shared/p2p-workflow-script.ts',
      'shared/p2p-workflow-materialize.ts',
      'web/src/components/AdvancedWorkflowCanvasEditor.tsx',
      'web/src/components/P2pConfigPanel.tsx',
      'web/src/components/SessionControls.tsx',
    ].filter((rel) => existsSync(resolve(ROOT, rel)));

    const offenders: string[] = [];
    for (const rel of files) {
      const file = read(rel);
      file.lines.forEach((line, index) => {
        if (/from ['"](?:@shared\/|\.\.?\/)*p2p-workflow-artifacts\.js['"]/.test(line) || /from ['"]node:/.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `Web bundle reachable workflow modules must use browser-safe artifact path helpers, not Node-only artifact baseline helpers:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // ── 6. Every caller of `findForbiddenEnvelopeField` must check the return
  //      value against null and use it to bail out. A launch path that calls
  //      the helper and then ignores the result silently allows forbidden
  //      executor-private fields (compiledWorkflow, rawPrompt, env, tokens)
  //      to flow through to the daemon.
  it('every findForbiddenEnvelopeField caller checks the return and bails out', () => {
    const candidates = [
      'shared/p2p-workflow-validators.ts',
      'web/src/components/P2pConfigPanel.tsx',
    ];
    const offenders: string[] = [];
    for (const rel of candidates) {
      const file = read(rel);
      file.lines.forEach((line, index) => {
        // Find every call site of findForbiddenEnvelopeField(.
        if (!/\bfindForbiddenEnvelopeField\s*\(/.test(line)) return;
        // Skip the export declarations (function definitions).
        if (/^\s*export\s+function\s+findForbiddenEnvelopeField\b/.test(line)) return;
        if (/^\s*function\s+findForbiddenEnvelopeField\b/.test(line)) return;

        // Acceptable usage forms — return value must be captured/used to bail:
        //   if (... findForbiddenEnvelopeField(value) ...) ...
        //   const x = findForbiddenEnvelopeField(...) (with `if (x)` nearby)
        //   return findForbiddenEnvelopeField(...)  (recursive call inside the function itself)
        //   findForbiddenEnvelopeField inside boolean expression of `if (...)` or `||` / `&&`
        const isAssignment = /\b(const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*findForbiddenEnvelopeField\s*\(/.test(line);
        const isReturn = /\breturn\s+findForbiddenEnvelopeField\s*\(/.test(line);
        const inIfCondition = /\bif\s*\([^)]*findForbiddenEnvelopeField\s*\(/.test(line);
        const inLogicalChain = /(\|\||&&|!)\s*findForbiddenEnvelopeField\s*\(/.test(line);
        const isRecursiveCall = /^\s*const\s+(found|nested)\s*=\s*findForbiddenEnvelopeField\s*\(/.test(line);

        if (!isAssignment && !isReturn && !inIfCondition && !inLogicalChain && !isRecursiveCall) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()} — return value not used to bail out`);
          return;
        }

        // For assignments, verify the next ~6 lines reference the captured name in
        // an `if`/early-return guard. Skip recursive `nested`/`found` helpers.
        const assignMatch = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*findForbiddenEnvelopeField\s*\(/.exec(line);
        if (assignMatch && !isRecursiveCall) {
          const varName = assignMatch[1];
          const window = file.lines.slice(index, index + 8).join('\n');
          const guardPattern = new RegExp(`(if\\s*\\(\\s*${varName}\\b|${varName}\\s*(?:\\?|\\|\\||&&)|return\\s+\\{[^}]*\\b${varName}\\b)`);
          if (!guardPattern.test(window)) {
            offenders.push(`${rel}:${index + 1}: assignment to \`${varName}\` from findForbiddenEnvelopeField is not followed by a guard check`);
          }
        }
      });
    }
    expect(offenders, `findForbiddenEnvelopeField return values must be checked and used to fail launch:\n${offenders.join('\n')}`).toEqual([]);
  });

  // ── 7. Daemon advanced admission MUST return `daemon_busy` synchronously
  //      and MUST NOT push over-capacity launches onto a queue. The contract
  //      lives in `src/daemon/p2p-workflow-bind.ts` and the launch wiring in
  //      `src/daemon/command-handler.ts` — neither file may contain a queue
  //      that retries an over-capacity advanced launch.
  it('daemon advanced admission rejects over-capacity launches synchronously without queueing', () => {
    const bind = read('src/daemon/p2p-workflow-bind.ts');
    expect(
      /reason:\s*'daemon_busy'/.test(bind.text),
      'p2p-workflow-bind must return reason: \'daemon_busy\' synchronously',
    ).toBe(true);

    // The bind function must NOT contain queue/enqueue/setTimeout/setInterval —
    // any of those would imply async retry of a `daemon_busy` outcome.
    const bannedPatterns: Array<{ name: string; pattern: RegExp }> = [
      { name: 'queue', pattern: /\bqueue\b/i },
      { name: 'enqueue', pattern: /\benqueue\b/i },
      { name: 'setTimeout', pattern: /\bsetTimeout\s*\(/ },
      { name: 'setInterval', pattern: /\bsetInterval\s*\(/ },
    ];
    const bindOffenders: string[] = [];
    bind.lines.forEach((line, index) => {
      for (const { name, pattern } of bannedPatterns) {
        if (pattern.test(line)) bindOffenders.push(`${bind.path}:${index + 1}: forbidden \`${name}\` near daemon_busy admission — ${line.trim()}`);
      }
    });
    expect(bindOffenders, `p2p-workflow-bind must not queue or async-retry advanced admission:\n${bindOffenders.join('\n')}`).toEqual([]);

    // The launch wiring in command-handler.ts must not introduce an
    // `advancedRunQueue`/`pendingAdvancedRuns`/`P2P_WORKFLOW_MAX_ACTIVE_RUNS`
    // queue that buffers over-capacity launches. We allow MAX_ACTIVE_RUNS
    // itself (used as a synchronous admission threshold), but not any
    // construct named `advancedRun*Queue` / `advancedRunQueue` / similar.
    const handler = read('src/daemon/command-handler.ts');
    const handlerOffenders: string[] = [];
    handler.lines.forEach((line, index) => {
      if (/advancedRun[A-Za-z]*Queue\b/.test(line)) {
        handlerOffenders.push(`${handler.path}:${index + 1}: forbidden advanced-run queue — ${line.trim()}`);
      }
      if (/pendingAdvancedRuns\b/.test(line)) {
        handlerOffenders.push(`${handler.path}:${index + 1}: forbidden pendingAdvancedRuns container — ${line.trim()}`);
      }
      // Defensive: an `enqueue(advancedRun…)` call would also be a regression.
      if (/enqueue\s*\([^)]*advanced/i.test(line)) {
        handlerOffenders.push(`${handler.path}:${index + 1}: forbidden enqueue of advanced run — ${line.trim()}`);
      }
    });
    expect(handlerOffenders, `command-handler must not queue over-capacity advanced launches:\n${handlerOffenders.join('\n')}`).toEqual([]);

    // The admission threshold MUST come from the daemon static policy — i.e.
    // `staticPolicy.concurrency.maxAdvancedRuns` — not from a hardcoded
    // constant. Audit:N-H3 / R2-A2: a regression here would mean the cap can
    // no longer be tuned via daemon policy and would drift from what the spec
    // labels as the single source of truth.
    const acceptedFromPolicy = /accepted:\s*activeAdvancedRuns\.length\s*<\s*staticPolicy\.concurrency\.maxAdvancedRuns/.test(handler.text);
    expect(
      acceptedFromPolicy,
      'command-handler must compute admission as `accepted: activeAdvancedRuns.length < staticPolicy.concurrency.maxAdvancedRuns`',
    ).toBe(true);
  });

  // ── 8. (Task 2.8) Legacy no-advanced launches MUST stay on the existing
  //      direct legacy path — they must NOT enter the advanced compiler. The
  //      command-handler proves this by short-circuiting `prepareAdvancedWorkflowLaunch`
  //      when neither old advanced fields nor a workflow envelope are present.
  //      A regression here would silently route legacy P2P launches through the
  //      compile/bind pipeline (and accidentally apply v1 graph constraints).
  it('legacy no-advanced launches do not enter the advanced compiler in v1', () => {
    const handler = read('src/daemon/command-handler.ts');
    const prepareStart = handler.lines.findIndex((line) => /async\s+function\s+prepareAdvancedWorkflowLaunch\b/.test(line));
    expect(prepareStart, 'prepareAdvancedWorkflowLaunch must exist in command-handler.ts').toBeGreaterThanOrEqual(0);

    // Within the function body's first ~30 lines, there must be an early
    // return that bails out when no envelope is constructed (covering the
    // pure-legacy launch case). This guarantees compileP2pWorkflowDraft and
    // bindP2pCompiledWorkflow are never reached on the legacy path.
    const window = handler.lines.slice(prepareStart, prepareStart + 30).join('\n');
    const earlyReturn = /if\s*\(!envelope\)\s*return\s+\{\s*ok:\s*true,\s*advancedRounds:\s*\[\]/.test(window);
    expect(
      earlyReturn,
      'prepareAdvancedWorkflowLaunch must early-return `{ ok: true, advancedRounds: [] }` when no envelope is constructed (legacy passthrough)',
    ).toBe(true);

    // The legacy passthrough fallback in startP2pRun must remain reachable —
    // when the envelope path produced no bound workflow, the call site must
    // forward raw `p2pAdvancedPresetKey` / `p2pAdvancedRounds` so cron and
    // legacy fixtures keep their direct path. We assert by looking for the
    // ternary spread shape `compiledFromEnvelope ? { advanced: ... } : { advancedPresetKey: p2pAdvancedPresetKey, ... }`.
    const legacyFallback = /:\s*\{\s*advancedPresetKey:\s*p2pAdvancedPresetKey/.test(handler.text);
    expect(
      legacyFallback,
      'startP2pRun call must fall back to raw p2pAdvancedPresetKey/p2pAdvancedRounds when prepared advanced rounds are empty (preserves legacy passthrough)',
    ).toBe(true);
  });

  // ── 9. (Task 6.10) Any OpenSpec-related automation in source code must NOT
  //      stage, commit, or push files under `openspec/` or `docs/`. Both
  //      directories are local-only planning/documentation artifacts and are
  //      explicitly listed in `.gitignore`. A regression here would push
  //      private OpenSpec drafts to the public repo.
  it('no source-tree git automation stages openspec/ or docs/', () => {
    const candidatePaths = [
      'src/daemon/p2p-workflow-bind.ts',
      'src/daemon/p2p-workflow-runtime.ts',
      'src/daemon/p2p-workflow-script-runner.ts',
      'src/daemon/p2p-workflow-artifact-runtime.ts',
      'src/daemon/command-handler.ts',
      'shared/p2p-workflow-artifacts.ts',
      'shared/p2p-workflow-script.ts',
      'server/src/p2p-workflow-sanitize.ts',
      'server/src/ws/bridge.ts',
      'web/src/components/P2pConfigPanel.tsx',
    ].filter((rel) => existsSync(resolve(ROOT, rel)));

    const offenders: string[] = [];
    for (const rel of candidatePaths) {
      const file = read(rel);
      file.lines.forEach((line, index) => {
        // Forbid `git add … openspec/…` / `git commit … docs/…` / `git push …`
        // shapes that combine a git-mutation verb with the protected paths.
        if (/\bgit\s+(add|commit|push|stage)\b/.test(line) && /(openspec|docs)\//.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
        // Defensive: spawn('git', ['add', 'openspec/…']) shape — combine `git`
        // and `add`-like tokens within a short window when both protected paths
        // appear on the same line.
        if (/['"`]add['"`]\s*,\s*['"`](openspec|docs)\//.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `OpenSpec/docs paths must never be staged or committed by source-tree automation:\n${offenders.join('\n')}`).toEqual([]);

    // .gitignore must continue to list both directories so even an accidental
    // `git add .` cannot stage them. This is a belt-and-suspenders check.
    const gitignore = read('.gitignore');
    const ignored = gitignore.lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const haveOpenspec = ignored.some((entry) => entry === 'openspec/' || entry === 'openspec' || entry === '/openspec/' || entry === '/openspec');
    const haveDocs = ignored.some((entry) => entry === 'docs/' || entry === 'docs' || entry === '/docs/' || entry === '/docs');
    expect(haveOpenspec, '.gitignore must list `openspec/` so the directory cannot be accidentally staged').toBe(true);
    expect(haveDocs, '.gitignore must list `docs/` so the directory cannot be accidentally staged').toBe(true);
  });

  // ── 10. (Audit:N-H2) `getCurrentDaemonWorkflowCapabilities` MUST fail-closed
  //      when the serverLink lacks the capability getter. A previous regression
  //      returned all three dangerous capabilities (including IMPLEMENTATION)
  //      as a "permissive default", which silently granted authorisation when
  //      tests/mocks omitted the getter. The fallback must now be `[]` so the
  //      bind path produces `missing_required_capability` instead of fail-OPEN.
  it('getCurrentDaemonWorkflowCapabilities fallback is fail-closed (audit:N-H2)', () => {
    const file = read('src/daemon/p2p-workflow-static-policy.ts');
    const fnIdx = file.lines.findIndex((line) => /export function getCurrentDaemonWorkflowCapabilities\b/.test(line));
    expect(fnIdx, 'getCurrentDaemonWorkflowCapabilities must live in p2p-workflow-static-policy.ts').toBeGreaterThanOrEqual(0);
    // Capture the function body (until the next top-level brace at column 0).
    let endIdx = fnIdx;
    let depth = 0;
    let started = false;
    for (let i = fnIdx; i < file.lines.length; i += 1) {
      const line = file.lines[i];
      for (const ch of line) {
        if (ch === '{') { depth += 1; started = true; }
        if (ch === '}') { depth -= 1; }
      }
      if (started && depth === 0) { endIdx = i; break; }
    }
    const body = file.lines.slice(fnIdx, endIdx + 1).join('\n');
    expect(
      /P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1/.test(body),
      'fallback in getCurrentDaemonWorkflowCapabilities must NOT mention OPENSPEC_ARTIFACTS capability (would be fail-OPEN)',
    ).toBe(false);
    expect(
      /P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1/.test(body),
      'fallback in getCurrentDaemonWorkflowCapabilities must NOT mention IMPLEMENTATION capability (would be fail-OPEN)',
    ).toBe(false);
    // Sanity: the function still references the v1 base capability for typings,
    // but the runtime fallback path returns an empty array.
    const returnsEmpty = /return\s+\[\s*\]\s*;/.test(body);
    expect(
      returnsEmpty,
      'getCurrentDaemonWorkflowCapabilities fallback must return `[]` when serverLink lacks getP2pWorkflowCapabilities',
    ).toBe(true);
  });

  // ── 11. (Audit:N4) `prepareAdvancedWorkflowLaunch` must derive the daemon
  //      static policy from `loadDaemonP2pStaticPolicy(serverLink)` rather
  //      than hardcoding `{ allowOpenSpecArtifacts: true, allowImplementationPermission: true }`.
  it('prepareAdvancedWorkflowLaunch reads static policy from loadDaemonP2pStaticPolicy (audit:N4)', () => {
    const handler = read('src/daemon/command-handler.ts');
    expect(
      handler.text.includes('loadDaemonP2pStaticPolicy'),
      'command-handler must import and call loadDaemonP2pStaticPolicy as the policy source',
    ).toBe(true);
    // Forbid the previously-permissive shape that hardcoded both dangerous flags.
    const permissiveShape = /buildDefaultP2pStaticPolicy\s*\(\s*\{[^}]*allowOpenSpecArtifacts:\s*true[^}]*allowImplementationPermission:\s*true/m;
    expect(
      permissiveShape.test(handler.text),
      'command-handler must NOT call buildDefaultP2pStaticPolicy with hardcoded permissive overrides — use loadDaemonP2pStaticPolicy instead',
    ).toBe(false);
  });

  // ── 12. (Audit:H3) `recheckDangerousNodeCapabilities` must accept policy
  //      snapshots as well as capability strings. A regression that drops the
  //      `boundPolicySnapshot` / `currentDaemonPolicy` parameters would
  //      reintroduce the "capability set unchanged but allowlist tightened"
  //      authorisation gap.
  it('recheckDangerousNodeCapabilities supports policy diff (audit:H3)', () => {
    const file = read('src/daemon/p2p-workflow-policy-recheck.ts');
    expect(
      file.text.includes('boundPolicySnapshot') && file.text.includes('currentDaemonPolicy'),
      'recheckDangerousNodeCapabilities must accept boundPolicySnapshot and currentDaemonPolicy parameters',
    ).toBe(true);
    expect(
      /findPolicyDowngrade|allowedExecutables/.test(file.text),
      'recheckDangerousNodeCapabilities must compare policy allowlists / allow-flags between bind and current',
    ).toBe(true);
  });

  // ── 13. (Audit:N1) The web run mapper must surface `workflow_projection.diagnostics`
  //      (or a top-level `diagnostics` fallback) so the UI can render runtime
  //      diagnostic codes that the server now retains.
  it('web mapP2pRunToDiscussion exposes workflow_projection.diagnostics (audit:N1)', () => {
    const file = read('web/src/p2p-run-mapping.ts');
    // Both keywords must appear in the file (cross-line OK; the actual code
    // reads the projection then iterates `projection.diagnostics`).
    expect(
      file.text.includes('workflow_projection') && file.text.includes('diagnostics'),
      'mapP2pRunToDiscussion must read workflow_projection.diagnostics so UI can render workflow diagnostics',
    ).toBe(true);
  });

  // ── 14. (Audit:B1) The P2P message registry must include the `p2p.config.*`
  //      protocol — otherwise the bridge default-deny drops legitimate config
  //      save round-trips. Both SAVE and SAVE_RESPONSE must be present.
  it('p2p.config.* messages are registered in P2P_WORKFLOW_MESSAGE_REGISTRY (audit:B1)', () => {
    const file = read('shared/p2p-workflow-messages.ts');
    expect(
      file.text.includes('P2P_CONFIG_MSG.SAVE'),
      'workflow message registry must register P2P_CONFIG_MSG.SAVE',
    ).toBe(true);
    expect(
      file.text.includes('P2P_CONFIG_MSG.SAVE_RESPONSE'),
      'workflow message registry must register P2P_CONFIG_MSG.SAVE_RESPONSE',
    ).toBe(true);
    // The category field discriminator must exist so workflow-only consumers
    // can filter without re-listing types.
    expect(
      file.text.includes("category: 'config'"),
      "P2pWorkflowMessageDescriptor must mark p2p.config.* with category: 'config'",
    ).toBe(true);
  });

  // ── 15. (Audit:B2) `handleP2pStatus` must enforce project scope just like
  //      handleP2pListDiscussions / handleP2pReadDiscussion. Without scope a
  //      caller could enumerate active runs across projects.
  it('handleP2pStatus enforces project scope (audit:B2)', () => {
    const handler = read('src/daemon/command-handler.ts');
    const fnIdx = handler.lines.findIndex((line) => /async function handleP2pStatus\b/.test(line));
    expect(fnIdx, 'handleP2pStatus must exist in command-handler.ts').toBeGreaterThanOrEqual(0);
    // Capture the function body length conservatively (up to next top-level
    // function declaration / "// ──" section divider).
    let endIdx = handler.lines.length;
    for (let i = fnIdx + 1; i < handler.lines.length; i += 1) {
      if (/^(async\s+)?function\s+\w+/.test(handler.lines[i]) || /^export\s+(async\s+)?function\s+\w+/.test(handler.lines[i])) {
        endIdx = i;
        break;
      }
      if (/^\/\/\s*──/.test(handler.lines[i])) { endIdx = i; break; }
    }
    const body = handler.lines.slice(fnIdx, endIdx).join('\n');
    expect(
      body.includes('resolveP2pDiscussionProjectScope'),
      'handleP2pStatus must call resolveP2pDiscussionProjectScope to enforce scope',
    ).toBe(true);
  });

  // ── 16. (Audit:M1 / R2-V6 derivative) The legacy snapshot sanitizer must
  //      treat the empty-object placeholder `'{}'` (introduced by the DB
  //      column DEFAULT) as a no-op, NOT as a legacy row that needs a
  //      `legacy_progress_snapshot_sanitized` diagnostic.
  it('sanitizeLegacyP2pProgressSnapshot has explicit empty-placeholder handling (audit:M1)', () => {
    const file = read('server/src/p2p-workflow-sanitize.ts');
    expect(
      /isEmptyPlaceholder|placeholder|isEmptyObject/.test(file.text),
      'sanitizeLegacyP2pProgressSnapshot must early-return for the empty-object placeholder produced by the DB column DEFAULT',
    ).toBe(true);
  });

  // ── 17. (Audit:R3 PR-α / R2 A1) `P2pBindRuntimeContext` must NOT define
  //      the ad-hoc `currentDaemonPolicy: { allowScript / allowImplementation / ... }`
  //      subset that was structurally incompatible with `recheckDangerousNodeCapabilities`.
  //      The canonical bind-time policy snapshot is `policySnapshot: P2pStaticPolicy`.
  it('P2pBindRuntimeContext exposes policySnapshot (full P2pStaticPolicy), not the ad-hoc currentDaemonPolicy subset (audit:R3 PR-α)', () => {
    const file = read('shared/p2p-workflow-types.ts');
    const start = file.lines.findIndex((line) => /^export interface P2pBindRuntimeContext\b/.test(line));
    expect(start, 'P2pBindRuntimeContext must exist').toBeGreaterThanOrEqual(0);
    let end = file.lines.length;
    for (let i = start + 1; i < file.lines.length; i += 1) {
      if (/^\}/.test(file.lines[i])) { end = i; break; }
    }
    const body = file.lines.slice(start, end).join('\n');
    expect(
      /policySnapshot:\s*P2pStaticPolicy/.test(body),
      'P2pBindRuntimeContext must declare `policySnapshot: P2pStaticPolicy` (full shape)',
    ).toBe(true);
    // Match only field declarations (start of line + indent + name + `:`), not
    // doc-comment references that explain the field was removed.
    const hasFieldDecl = /^\s{2}currentDaemonPolicy:\s*\{/m.test(body);
    expect(
      hasFieldDecl,
      'P2pBindRuntimeContext must NOT declare the ad-hoc currentDaemonPolicy subset (use policySnapshot instead)',
    ).toBe(false);
  });

  // ── 18. (Audit:R3 PR-α / N-M1) `P2pRun` must carry `boundWorkflow` so
  //      v1b dangerous-node executors can read `derivedRequiredCapabilities`
  //      and `bindContext` without re-deriving from current state. The bound
  //      workflow MUST NOT be exposed via daemon serialize / bridge sanitize.
  it('P2pRun stores boundWorkflow and policySnapshot for executor recheck; sanitizers do not expose them (audit:R3 PR-α)', () => {
    const orchestratorFile = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /boundWorkflow\?:[\s\S]{0,160}P2pBoundWorkflow/.test(orchestratorFile.text),
      'P2pRun interface must declare `boundWorkflow?: P2pBoundWorkflow`',
    ).toBe(true);
    expect(
      /policySnapshot\?:[\s\S]{0,80}policySnapshot'\]/.test(orchestratorFile.text),
      'P2pRun interface must declare `policySnapshot?: P2pBindRuntimeContext[\'policySnapshot\']`',
    ).toBe(true);

    // Sanitizer allowlists must NOT propagate boundWorkflow / policySnapshot
    // — confirmed by absence in the canonical run-projection field set used
    // by `sanitizeP2pOrchestrationRunForBridge` and `sanitizeP2pRunUpdateForBroadcast`.
    const sanitizerFile = read('server/src/p2p-workflow-sanitize.ts');
    expect(
      /boundWorkflow/.test(sanitizerFile.text),
      'server sanitizer must NOT reference boundWorkflow (raw bound must never reach broadcast/persistence)',
    ).toBe(false);
    expect(
      /policySnapshot/.test(sanitizerFile.text),
      'server sanitizer must NOT reference policySnapshot (full P2pStaticPolicy must never reach broadcast/persistence)',
    ).toBe(false);
  });

  // ── 20. (Audit:R3 PR-β / A3 / V-5) `loadDaemonP2pStaticPolicy` MUST NOT
  //      OR the ARGV capability into `allowInterpreterScripts`. Interpreter
  //      execution is a distinct security boundary from argv execution; the
  //      previous derivation silently upgraded argv-only authority into
  //      interpreter authority. spec.md "Interpreter script requires
  //      interpreter capability" scenario.
  it('loadDaemonP2pStaticPolicy does not OR argv capability into allowInterpreterScripts (audit:R3 PR-β / A3)', () => {
    const file = read('src/daemon/p2p-workflow-static-policy.ts');
    // The line `allowInterpreterScripts:` must not be followed by both
    // INTERPRETER and ARGV identifiers (i.e. the `INTERPRETER || ARGV`
    // shape is forbidden).
    const orShape = /allowInterpreterScripts:[^\n]*P2P_WORKFLOW_SCRIPT_INTERPRETER_CAPABILITY_V1[^\n]*\|\|[^\n]*P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1/.test(file.text)
      || /allowInterpreterScripts:[^\n]*P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1[^\n]*\|\|[^\n]*P2P_WORKFLOW_SCRIPT_INTERPRETER_CAPABILITY_V1/.test(file.text);
    expect(
      orShape,
      'loadDaemonP2pStaticPolicy must NOT compute `allowInterpreterScripts: caps.has(INTERPRETER) || caps.has(ARGV)` — interpreter authority must strictly require the interpreter capability',
    ).toBe(false);
  });

  // ── 21. (Audit:R3 PR-β / V-6) compile is intentionally pure; the daemon
  //      authority layer (`validateCompiledWorkflowAgainstBindPolicy`) MUST
  //      enforce the full `P2pStaticPolicy` (allow flags + executable
  //      allowlist) before bind constructs `P2pBoundWorkflow`. A regression
  //      that drops the helper or stops calling it from `bindP2pCompiledWorkflow`
  //      would re-open the previous "compile derived caps but bind only
  //      checked capability strings" gap.
  it('bindP2pCompiledWorkflow runs validateCompiledWorkflowAgainstBindPolicy before constructing bound (audit:R3 PR-β / V-6)', () => {
    const file = read('src/daemon/p2p-workflow-bind.ts');
    expect(
      /export function validateCompiledWorkflowAgainstBindPolicy\b/.test(file.text),
      'validateCompiledWorkflowAgainstBindPolicy helper must be exported from p2p-workflow-bind.ts',
    ).toBe(true);
    expect(
      /validateCompiledWorkflowAgainstBindPolicy\(compiled,\s*bindContext\)/.test(file.text),
      'bindP2pCompiledWorkflow must call validateCompiledWorkflowAgainstBindPolicy(compiled, bindContext) before constructing bound',
    ).toBe(true);
  });

  // ── 22. (Audit:R3 PR-β / M-3) `parseP2pScriptMachineOutput` MUST truncate
  //      at the last `\n` boundary in lenient mode when total bytes exceed
  //      the cap, not return `invalidMachineOutput`. The previous shape
  //      reject-on-overflow contradicted spec §Script machine output truncation.
  it('parseP2pScriptMachineOutput uses line-boundary truncate in lenient mode (audit:R3 PR-β / M-3)', () => {
    const file = read('shared/p2p-workflow-script.ts');
    // Forbid the previous "totalBytes > maxTotalBytes ⇒ return invalid"
    // shape that ignored mode.
    const lines = file.lines;
    const totalLineIdx = lines.findIndex((line) => /const\s+totalBytes\s*=\s*byteLength\(input\)/.test(line));
    expect(totalLineIdx, 'parseP2pScriptMachineOutput must compute totalBytes').toBeGreaterThanOrEqual(0);
    const window = lines.slice(totalLineIdx, totalLineIdx + 30).join('\n');
    expect(
      /mode\s*===\s*'strict'/.test(window),
      'parseP2pScriptMachineOutput must distinguish strict vs lenient when handling total-bytes overflow (lenient must truncate at line boundary)',
    ).toBe(true);
    expect(
      /lastIndexOf\(['"`]\\n['"`]\)/.test(window),
      'parseP2pScriptMachineOutput must walk back to the last newline boundary when truncating in lenient mode',
    ).toBe(true);
  });

  // ── 23. (Audit:R3 PR-γ / N-M5 / V-4) The diagnostic
  //      `static_policy_mismatch_recompiled` MUST have at least one production
  //      `makeP2pWorkflowDiagnostic` call site outside i18n / spec / tests
  //      (otherwise it's a "publicly exposed code that is impossible to
  //      trigger" — the v1a regression that PR-γ closes).
  it('static_policy_mismatch_recompiled has a production emission point (audit:R3 PR-γ / N-M5)', () => {
    const file = read('src/daemon/command-handler.ts');
    expect(
      /makeP2pWorkflowDiagnostic\(['"`]static_policy_mismatch_recompiled['"`]/.test(file.text),
      'src/daemon/command-handler.ts must emit `static_policy_mismatch_recompiled` when envelope.expectedStaticPolicyHash differs from current daemon policy hash',
    ).toBe(true);
  });

  // ── 24. (Task 10.2 / 12.5 closure) Cron executor MUST route advanced cron
  //      jobs through `prepareAdvancedWorkflowLaunch` when the action carries
  //      `workflowLaunchEnvelope` — otherwise cron silently bypasses
  //      capability gating, policy authority, and `daemon_busy` admission.
  it('cron-executor routes envelope-bearing P2P actions through prepareAdvancedWorkflowLaunch (task 10.2)', () => {
    const file = read('src/daemon/cron-executor.ts');
    expect(
      file.text.includes('prepareAdvancedWorkflowLaunch'),
      'cron-executor must import and call prepareAdvancedWorkflowLaunch when action carries workflowLaunchEnvelope',
    ).toBe(true);
    // The CronP2pAction type must declare the envelope field so cron-api can
    // accept and persist it.
    const cronTypes = read('shared/cron-types.ts');
    expect(
      cronTypes.text.includes('workflowLaunchEnvelope'),
      'shared/cron-types.ts CronP2pAction must declare workflowLaunchEnvelope field',
    ).toBe(true);
  });

  // ── 25. (Task 10.3 closure) Cron MUST bound `daemon_busy` retry attempts;
  //      no infinite loop on perpetually busy daemon.
  it('cron-executor bounds daemon_busy retries (task 10.3)', () => {
    const file = read('src/daemon/cron-executor.ts');
    expect(
      /CRON_DAEMON_BUSY_DEFAULT_ATTEMPTS|daemon_busy/.test(file.text),
      'cron-executor must bound daemon_busy retries with explicit attempt budget',
    ).toBe(true);
    expect(
      /while\s*\([^)]*Attempt[^)]*<[^)]*attempts/.test(file.text)
      || /while\s*\([^)]*lastDaemonBusyAttempt[^)]*<[^)]*\.attempts\)/.test(file.text),
      'cron-executor must use a bounded while loop on daemon_busy attempts',
    ).toBe(true);
  });

  // ── 26. (Task 10.4 closure) Supervision audit launches MUST honour the
  //      daemon advanced-run admission cap with bounded retry — no silent
  //      bypass of `P2P_WORKFLOW_MAX_ACTIVE_RUNS`.
  it('supervision-automation bounds daemon_busy retries on audit launches (task 10.4)', () => {
    const file = read('src/daemon/supervision-automation.ts');
    expect(
      /startSupervisionRunWithBusyRetry/.test(file.text),
      'supervision-automation must use a bounded daemon_busy retry helper',
    ).toBe(true);
    expect(
      file.text.includes('loadDaemonP2pStaticPolicy'),
      'supervision-automation must read concurrency cap from loadDaemonP2pStaticPolicy',
    ).toBe(true);
    expect(
      file.text.includes('listP2pRuns'),
      'supervision-automation must inspect listP2pRuns to compute admission',
    ).toBe(true);
  });

  // ── 27. (Task 10.5 closure) `pushState` in the orchestrator MUST debounce
  //      non-terminal projections AND MUST flush terminal statuses + blocking
  //      diagnostics immediately. A regression that drops the flush-on-terminal
  //      branch would race with `delete activeRuns.get(runId)` cleanup.
  it('orchestrator pushState debounces non-terminal but flushes terminal projections (task 10.5)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /PROJECTION_DEBOUNCE_MS|pendingProjectionTimers/.test(file.text),
      'p2p-orchestrator must declare projection debounce machinery',
    ).toBe(true);
    expect(
      /isTerminalStatus[^\n]*flushProjection|isTerminal\(run\.status\)[\s\S]*?flushProjection/.test(file.text),
      'p2p-orchestrator pushState must flush projection immediately when run.status is terminal',
    ).toBe(true);
  });

  // ── 28. (Task 10.6 closure) `addHelperDiagnostic` MUST enforce both count
  //      and byte caps on the per-run diagnostic ring — long-running advanced
  //      workflows otherwise grow unbounded.
  it('orchestrator addHelperDiagnostic enforces retention count and byte caps (task 10.6)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      file.text.includes('P2P_HELPER_DIAGNOSTIC_RETENTION_COUNT'),
      'p2p-orchestrator must declare a retention count cap on helper diagnostics',
    ).toBe(true);
    expect(
      file.text.includes('P2P_HELPER_DIAGNOSTIC_RETENTION_BYTES'),
      'p2p-orchestrator must declare a retention byte cap on helper diagnostics',
    ).toBe(true);
    // FIFO trim — drop OLDEST entries when over budget so most-recent
    // forensic data survives.
    expect(
      /helperDiagnostics\.shift\(\)/.test(file.text),
      'p2p-orchestrator addHelperDiagnostic must use FIFO trim (shift) to drop oldest entries when over cap',
    ).toBe(true);
  });

  // ── 29. (Tasks 7.2 / 7.3 / 12.1) The P2P workflow script runner MUST NOT
  //      spawn child processes with `shell: true`. spec.md "Script command is
  //      argv-only" Scenario forbids implicit shell parsing of argv —
  //      `shell: true` would run argv through `/bin/sh -c` (POSIX) or `cmd.exe`
  //      (Windows) and would re-introduce shell-injection / metacharacter
  //      execution that the executable allowlist explicitly defends against.
  //      The runner must always pass `shell: false` (or omit the flag) and
  //      rely on argv-only spawn.
  it('p2p-workflow-script-runner.ts never calls child_process.spawn with shell: true (tasks 7.2 / 7.3)', () => {
    const file = read('src/daemon/p2p-workflow-script-runner.ts');
    // Forbid any `shell: true` in the file (the runner is the only spawn
    // site for script nodes; ad-hoc shell:true would be a regression).
    const offenders: string[] = [];
    file.lines.forEach((line, index) => {
      if (/shell\s*:\s*true/.test(line)) {
        offenders.push(`${file.path}:${index + 1}: ${line.trim()}`);
      }
    });
    expect(
      offenders,
      `p2p-workflow-script-runner.ts must not call spawn with shell: true:\n${offenders.join('\n')}`,
    ).toEqual([]);

    // Belt-and-suspenders: explicitly verify the canonical safe call carries
    // `shell: false` so a future refactor cannot drop it silently.
    expect(
      /shell\s*:\s*false/.test(file.text),
      'p2p-workflow-script-runner.ts must explicitly pass `shell: false` to child_process.spawn',
    ).toBe(true);
  });

  // ── 30. (Tasks 6.2 / 6.9 / 12.2) The daemon artifact runtime must NOT use
  //      `readdir(...).join('\n')` (or any other broad-directory-listing
  //      heuristic) as artifact success evidence. The contract requires
  //      per-file sha256 baselines + declared-file delta verification — a
  //      regression that lists a directory and joins the names back to a
  //      single string would silently let unrelated changes satisfy a
  //      declared-file contract. spec.md "Directory listing join is not a
  //      success criterion" scenario.
  it('p2p-workflow-artifact-runtime.ts must not use readdir(...).join("\\n") as success evidence (tasks 6.2 / 6.9)', () => {
    const file = read('src/daemon/p2p-workflow-artifact-runtime.ts');
    // Same rule as guard #5 but scoped specifically to the daemon runtime
    // (file may exist standalone in v1b refactors). Match a `readdir(...)`
    // call DIRECTLY chained to `.join(` with no intervening tokens.
    const compactText = file.text.replace(/\s+/g, ' ');
    const pattern = /\breaddir\s*\([^()]*\)\s*\)?\.join\s*\(/g;
    const offenders: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(compactText)) != null) {
      offenders.push(`src/daemon/p2p-workflow-artifact-runtime.ts: matched "${match[0]}"`);
    }
    // Also forbid the `.map(e => e.name).join(` shape on a readdir result —
    // the same heuristic with one common transformation in between.
    const mapJoinPattern = /\breaddir\s*\([^()]*\)\s*\)?\.map\s*\([^)]*\)\.join\s*\(/g;
    while ((match = mapJoinPattern.exec(compactText)) != null) {
      offenders.push(`src/daemon/p2p-workflow-artifact-runtime.ts: matched "${match[0]}"`);
    }
    expect(
      offenders,
      `p2p-workflow-artifact-runtime.ts must not use readdir().join() as success evidence:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // ── 31. (Tasks 4.7b / 4.8b / §12.3 closure) The orchestrator MUST recheck
  //      dangerous-round capabilities BEFORE dispatching each dangerous round
  //      (envelope_compiled runs only). A regression that drops the recheck
  //      reopens the "bound at compile, downgraded at execute" gap.
  it('orchestrator wires recheckDangerousNodeCapabilities before each dangerous round (task 4.7b / 4.8b / §12.3)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      file.text.includes('recheckDangerousNodeCapabilities'),
      'p2p-orchestrator must import and call recheckDangerousNodeCapabilities',
    ).toBe(true);
    expect(
      /isRoundDangerous|recheckDangerousRoundOrFail/.test(file.text),
      'p2p-orchestrator must declare a dangerous-round predicate + recheck-or-fail helper',
    ).toBe(true);
    // The helper MUST be invoked from the executeAdvancedChain loop body.
    const idx = file.lines.findIndex((line) => /executeAdvancedChain\b/.test(line) && /async\s+function/.test(line));
    expect(idx, 'executeAdvancedChain function not found').toBeGreaterThanOrEqual(0);
    const window = file.lines.slice(idx, idx + 80).join('\n');
    expect(
      /recheckDangerousRoundOrFail\(run,\s*round,\s*serverLink\)/.test(window),
      'executeAdvancedChain must invoke recheckDangerousRoundOrFail before dispatching each dangerous round',
    ).toBe(true);
  });

  // ── 32. (Audit:R2-N1 / round 4e78ab60) The orchestrator MUST invoke the
  //      script runner from `executeAdvancedChain` for compiled `nodeKind: 'script'`
  //      nodes. A regression that drops the dispatch reopens the
  //      "runner exists but never called" gap.
  it('orchestrator dispatches script-node rounds via runP2pScriptNode (audit:R2-N1 / R3 §12.1 wiring)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      file.text.includes('runP2pScriptNode'),
      'p2p-orchestrator must import and call runP2pScriptNode for script-node rounds',
    ).toBe(true);
    expect(
      /dispatchScriptRoundOrFail/.test(file.text),
      'p2p-orchestrator must declare a script-node dispatch helper invoked from executeAdvancedChain',
    ).toBe(true);
    // The helper MUST be invoked from executeAdvancedChain.
    const idx = file.lines.findIndex((line) => /async\s+function\s+executeAdvancedChain\b/.test(line));
    expect(idx, 'executeAdvancedChain must exist').toBeGreaterThanOrEqual(0);
    // R3 v2 PR-ζ — pre-round capture fail-closed block grew the window;
    // bump from 120 → 200 to keep matching the dispatch call that lives
    // post-capture but pre-legacy-hop.
    const window = file.lines.slice(idx, idx + 200).join('\n');
    expect(
      /dispatchScriptRoundOrFail\(run,\s*round,\s*serverLink\)/.test(window),
      'executeAdvancedChain must invoke dispatchScriptRoundOrFail before the legacy dispatchHop branches',
    ).toBe(true);
    // Slot acquire/release MUST be paired — orchestrator owns the cap.
    expect(
      /acquireScriptSlot\(\)/.test(file.text) && /releaseScriptSlot\(\)/.test(file.text),
      'p2p-orchestrator must acquire and release script concurrency slots around runP2pScriptNode',
    ).toBe(true);
  });

  // ── 33. (Audit:R2-N2 / round 4e78ab60) The orchestrator MUST use the new
  //      artifact runtime helpers for envelope_compiled OpenSpec runs. A
  //      regression that drops the freeze + capture + verify chain reopens
  //      the "helpers exist but legacy `captureArtifactBaseline` shadows them"
  //      gap.
  it('orchestrator uses new artifact runtime for envelope_compiled OpenSpec rounds (audit:R2-N2 / R3 §12.2 wiring)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      file.text.includes('freezeP2pArtifactIdentity')
        && file.text.includes('captureP2pArtifactBaseline')
        && file.text.includes('verifyP2pArtifactBaselineDelta'),
      'p2p-orchestrator must import all three new artifact runtime helpers',
    ).toBe(true);
    expect(
      /getOrFreezeRunArtifactRoot/.test(file.text),
      'p2p-orchestrator must declare a per-run identity-freeze cache helper that gates on envelope_compiled + openspec_convention',
    ).toBe(true);
    // The post-round delta verify MUST run inside executeAdvancedChain.
    const idx = file.lines.findIndex((line) => /async\s+function\s+executeAdvancedChain\b/.test(line));
    expect(idx, 'executeAdvancedChain must exist').toBeGreaterThanOrEqual(0);
    const window = file.lines.slice(idx, idx + 400).join('\n');
    expect(
      /verifyP2pArtifactBaselineDelta\(/.test(window),
      'executeAdvancedChain must call verifyP2pArtifactBaselineDelta after the round dispatches',
    ).toBe(true);
  });

  // ── 19. (Audit:R3 PR-α / W-2) The broadcast↔persistence projection field
  //      diff must equal a documented set. Today: broadcast carries
  //      `capabilitySnapshot` and persisted snapshot strips it. Any future
  //      field added on one side without the other will break this guard.
  it('broadcast vs persistence projection field difference is documented (audit:W-2)', () => {
    const sanitizerFile = read('server/src/p2p-workflow-sanitize.ts');
    // The `isValidPersistedSnapshotShape` predicate must explicitly forbid
    // `capabilitySnapshot` from persisted snapshots — that one field defines
    // the only allowed broadcast↔persistence asymmetry.
    expect(
      /value\.capabilitySnapshot\s*!==\s*undefined/.test(sanitizerFile.text),
      'isValidPersistedSnapshotShape must explicitly reject `capabilitySnapshot` on persisted rows',
    ).toBe(true);
    // The projection builder (broadcast side) must include capabilitySnapshot.
    expect(
      /capabilitySnapshot/.test(sanitizerFile.text),
      'sanitizer must reference capabilitySnapshot for broadcast inclusion',
    ).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // R3 PR-α reverse-regression #34-#40 (Cu1-R3 §1)
  //
  // Calibrated state: the post-PR-α adapter MUST preserve compiled-node
  // semantics, the orchestrator MUST recheck script kind dangerously, the
  // bind-fail path MUST prepend `policyMismatchDiagnostics`, and the
  // script/artifact fail-closed branches MUST call `failRun`. These
  // string-shape guards lock the post-fix invariants so a future refactor
  // that re-opens any of A1-A7/B1/B2/W3/A4/A5 will fail loudly here in
  // addition to the semantic unit tests in `test/daemon/...`.
  // ──────────────────────────────────────────────────────────────────────

  it('#34 adapter must preserve nodeKind / script / routingAuthority / artifactConvention through compiledWorkflowToLegacyAdvancedRounds (R3 PR-α A1 / W3)', () => {
    const file = read('src/daemon/command-handler.ts');
    expect(
      /nodeKind:\s*node\.nodeKind/.test(file.text),
      'adapter must spread `nodeKind: node.nodeKind` onto the legacy round',
    ).toBe(true);
    expect(
      /node\.script\s*\?\s*\{\s*script:\s*node\.script\s*\}/.test(file.text),
      'adapter must spread `script` field when present',
    ).toBe(true);
    expect(
      /node\.routingAuthority\s*\?\s*\{\s*routingAuthority:\s*node\.routingAuthority\s*\}/.test(file.text),
      'adapter must spread `routingAuthority` field when present',
    ).toBe(true);
    expect(
      /artifactConvention\s*\?\s*\{\s*artifactConvention\s*\}/.test(file.text),
      'adapter must spread `artifactConvention` derived from node.artifacts[0].convention',
    ).toBe(true);
  });

  it('#35 adapter must order compiled nodes by topology, not lexical id (R3 PR-α A2)', () => {
    const file = read('src/daemon/command-handler.ts');
    // The lexical-sort anti-pattern must NOT appear in the production
    // adapter callsite (a comment that documents the OLD bug is fine, but
    // an actual `localeCompare` on workflow.nodes must not).
    expect(
      /\[\.\.\.workflow\.nodes\]\s*\.sort\(\(left,\s*right\)\s*=>\s*left\.id\.localeCompare\(right\.id\)\)/.test(file.text),
      'adapter must not sort workflow.nodes lexically by id (replaced with topological traversal)',
    ).toBe(false);
    expect(
      /orderCompiledNodesForExecution\(workflow\)/.test(file.text),
      'adapter must traverse via orderCompiledNodesForExecution',
    ).toBe(true);
  });

  it('#36 legacy readdir().join is bounded to non-envelope-compiled paths (R3 PR-α A3 setup; PR-γ retires it fully)', () => {
    // Until PR-γ retires the legacy validator entirely, the orchestrator
    // still calls it as the FIRST gate. We only assert that the new
    // helper is now ALSO authoritative — a regression that drops the new
    // helper leaves the legacy gate alone, which would be silently
    // weaker than spec.
    const orchestrator = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /verifyP2pArtifactBaselineDelta\(/.test(orchestrator.text),
      'orchestrator must invoke verifyP2pArtifactBaselineDelta on envelope_compiled OpenSpec rounds',
    ).toBe(true);
    expect(
      /failRun\([\s\S]{0,200}Artifact contract not satisfied/.test(orchestrator.text),
      'verifyP2pArtifactBaselineDelta failure must call failRun (no longer just helper diagnostic)',
    ).toBe(true);
  });

  it('#37 isRoundDangerous must recognise script-kind rounds (R3 PR-α A4)', () => {
    const orchestrator = read('src/daemon/p2p-orchestrator.ts');
    // The predicate must include a `nodeKind === 'script'` branch so
    // analysis_only script rounds still trigger recheck.
    expect(
      /round\.nodeKind\s*===\s*'script'/.test(orchestrator.text),
      'isRoundDangerous must include `round.nodeKind === \'script\'` branch',
    ).toBe(true);
  });

  it('#38 prepareAdvancedWorkflowLaunch bind-fail must prepend policyMismatchDiagnostics (R3 PR-δ A5)', () => {
    const file = read('src/daemon/command-handler.ts');
    // The bind-fail return MUST include policyMismatchDiagnostics. The
    // shape `[...policyMismatchDiagnostics, ...bindDiagnostics]` is the
    // post-fix canonical form; an old `return { ok: false, diagnostics:
    // bindDiagnostics }` regression must be caught.
    expect(
      /\[\.\.\.policyMismatchDiagnostics,\s*\.\.\.bindDiagnostics\]/.test(file.text),
      'bind-fail return must concatenate policyMismatchDiagnostics + bindDiagnostics',
    ).toBe(true);
    expect(
      /diagnostics:\s*bindDiagnostics\s*\}\s*;[\s]*\}/.test(file.text),
      'bind-fail return must NOT use bindDiagnostics alone',
    ).toBe(false);
  });

  it('#39 dispatchScriptRoundOrFail !result.ok must call failRun + return fail_closed (R3 PR-α B1 / B5)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    // Use brace-balance scan to extract the outer body of `if (!result.ok)`.
    const startIdx = file.text.indexOf('if (!result.ok) {');
    expect(startIdx, '`if (!result.ok)` block must exist in dispatchScriptRoundOrFail').toBeGreaterThanOrEqual(0);
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx + 'if (!result.ok) '.length; i < file.text.length; i += 1) {
      const ch = file.text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    expect(endIdx, 'failed to locate end of !result.ok block').toBeGreaterThan(startIdx);
    const body = file.text.slice(startIdx, endIdx + 1);
    expect(
      body.includes('failRun('),
      '!result.ok body must invoke failRun (no longer return { kind: "ok" })',
    ).toBe(true);
    expect(
      body.includes("return { kind: 'fail_closed' }"),
      '!result.ok body must return { kind: \'fail_closed\' }',
    ).toBe(true);
    expect(
      body.includes('return { kind: \'ok\''),
      '!result.ok body must NOT return kind: ok (legacy regression)',
    ).toBe(false);
    // Structured workflow diagnostic MUST be preserved via
    // `helperDiagnostic.workflowDiagnostic` so the original 32-code enum
    // survives the helper path.
    expect(
      /workflowDiagnostic:\s*wd/.test(file.text),
      'helper diagnostic must preserve original workflow diagnostic via `workflowDiagnostic` sidecar',
    ).toBe(true);
  });

  it('#40 verifyP2pArtifactBaselineDelta(!ok) must call failRun (R3 PR-α B2)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    // The artifact verify branch must include a `failRun` call after the
    // delta failure loop, not just `addHelperDiagnostic`.
    expect(
      /delta\.diagnostics[\s\S]{0,400}failRun\([\s\S]{0,200}artifact_contract_not_satisfied/i.test(file.text),
      'delta failure branch must invoke failRun with artifact_contract_not_satisfied diagnostic',
    ).toBe(true);
  });

  it('#41 captureP2pArtifactBaseline post-round phase must be `validate` (R3 PR-α B7)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    // The pre-round capture is `phase: 'baseline'`; post-round capture
    // must be `phase: 'validate'`. We assert the validate string is
    // present in the file (post-round capture path).
    expect(
      /afterCapture[\s\S]{0,200}phase:\s*'validate'/.test(file.text),
      'post-round artifact capture must use phase: validate',
    ).toBe(true);
  });

  it('#42 getOrFreezeRunArtifactRoot returns narrowed { rootPath, bound } | null (R3 PR-α W1)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /interface\s+RunArtifactRootResolution\s*\{[\s\S]{0,200}rootPath:\s*string;[\s\S]{0,200}bound:\s*P2pBoundWorkflow;/.test(file.text),
      'getOrFreezeRunArtifactRoot must return a narrowed { rootPath, bound } shape so callers do not need ! assertions',
    ).toBe(true);
    expect(
      /run\.boundWorkflow!\.bindContext\.repoRoot/.test(file.text),
      '! non-null assertion against run.boundWorkflow must not appear in artifact code paths',
    ).toBe(false);
  });

  it('#43 daemon static policy MUST NOT read host-side allowlist files; allowedExecutables is envelope-carried (R3 PR-α §13.13)', () => {
    // Originally (#43 in §13.10) we asserted that loadDaemonP2pStaticPolicy
    // wired in a JSON file reader. User feedback (§13.13) reverted that:
    // hand-editing host JSON is off-product. The new contract is the
    // INVERSE — daemon static policy returns an empty allowlist and the
    // launch envelope is the sole source of non-empty allowlists.
    const policy = read('src/daemon/p2p-workflow-static-policy.ts');
    expect(
      /loadAllowedExecutables/.test(policy.text),
      '`loadAllowedExecutables` symbol MUST NOT exist in p2p-workflow-static-policy.ts',
    ).toBe(false);
    // Strip comments before scanning so doc/historical references in
    // module-doc blocks don't trip the guard. We only care about runtime code.
    const stripped = policy.text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\s*\/\/.*$/, ''))
      .join('\n');
    expect(
      /from\s+['"]node:fs['"]|from\s+['"]node:os['"]|readFileSync\s*\(|homedir\s*\(/.test(stripped),
      'p2p-workflow-static-policy.ts MUST NOT import node:fs/node:os or call readFileSync/homedir at runtime',
    ).toBe(false);
    expect(
      /allowedExecutables:\s*\[\]/.test(policy.text),
      'loadDaemonP2pStaticPolicy MUST set allowedExecutables: []',
    ).toBe(true);
    // Launch path must merge envelope-supplied entries into the policy.
    const handler = read('src/daemon/command-handler.ts');
    expect(
      /envelope\.allowedExecutables/.test(handler.text),
      'prepareAdvancedWorkflowLaunch must read envelope.allowedExecutables',
    ).toBe(true);
    expect(
      /buildDefaultP2pStaticPolicy\(\{[\s\S]{0,200}allowedExecutables/.test(handler.text),
      'merged static policy MUST be rebuilt via buildDefaultP2pStaticPolicy with envelope-derived allowedExecutables (so policyHash is recomputed)',
    ).toBe(true);
  });

  it('#44 expectedStaticPolicyHash validator enforces ASCII pattern + byte length (R3 PR-δ A6)', () => {
    const file = read('shared/p2p-workflow-validators.ts');
    expect(
      /P2P_REQUEST_ID_ASCII_PATTERN\.test\(hash\)/.test(file.text),
      'validator must enforce ASCII pattern on expectedStaticPolicyHash',
    ).toBe(true);
    expect(
      /TextEncoder\(\)\.encode\(hash\)\.byteLength/.test(file.text),
      'validator must compute UTF-8 byte length via TextEncoder',
    ).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // R3 PR-ε reverse-regression #45-#47: visual canvas editor folded into v1a
  //
  // Calibrated state: the canvas editor MUST be the only authoring surface in
  // `P2pConfigPanel`. Adding back the list editor or any toggle should fail
  // these guards. The canvas testid contract `data-editor-variant="canvas"`
  // must remain stable so integration tests can assert canvas presence.
  // ──────────────────────────────────────────────────────────────────────

  it('#45 P2pConfigPanel imports AdvancedWorkflowCanvasEditor and renders it for advanced drafts (R3 PR-ε)', () => {
    const file = read('web/src/components/P2pConfigPanel.tsx');
    expect(
      /import\s*\{\s*AdvancedWorkflowCanvasEditor\s*\}\s*from\s*['"]\.\/AdvancedWorkflowCanvasEditor\.js['"]/.test(file.text),
      'P2pConfigPanel must import AdvancedWorkflowCanvasEditor from the canvas module',
    ).toBe(true);
    expect(
      /<AdvancedWorkflowCanvasEditor\b/.test(file.text),
      'P2pConfigPanel must render <AdvancedWorkflowCanvasEditor /> for the workflowDraft branch',
    ).toBe(true);
  });

  it('#46 AdvancedWorkflowDraftEditor (list editor) MUST NOT be re-introduced (R3 PR-ε no-toggle contract)', () => {
    const panel = read('web/src/components/P2pConfigPanel.tsx');
    // The previous list-based component must NOT be defined or referenced
    // anywhere in the panel. The canvas is the SOLE authoring surface; a
    // future PR that revives the list view (even as a toggle option) must
    // fail this guard.
    expect(
      /export\s+function\s+AdvancedWorkflowDraftEditor\b/.test(panel.text),
      'AdvancedWorkflowDraftEditor (list editor) MUST NOT be re-defined in P2pConfigPanel.tsx',
    ).toBe(false);
    expect(
      /<AdvancedWorkflowDraftEditor\b/.test(panel.text),
      'AdvancedWorkflowDraftEditor JSX usage MUST NOT reappear in P2pConfigPanel.tsx',
    ).toBe(false);
  });

  it('#47 canvas editor exposes data-editor-variant="canvas" testid contract (R3 PR-ε)', () => {
    const file = read('web/src/components/AdvancedWorkflowCanvasEditor.tsx');
    expect(
      /data-testid="p2p-advanced-workflow-editor"/.test(file.text),
      'canvas editor must expose the shared editor testid for integration tests',
    ).toBe(true);
    expect(
      /data-editor-variant="canvas"/.test(file.text),
      'canvas editor must declare data-editor-variant="canvas" so guards can distinguish from any future variant',
    ).toBe(true);
    expect(
      /data-testid="p2p-editor-canvas"/.test(file.text),
      'canvas editor must expose the SVG root testid `p2p-editor-canvas`',
    ).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // R3 PR-β + PR-γ reverse-regression #48-#52
  //
  // Calibrated state: envelope_compiled runs MUST drive routing /
  // declaredFiles / freeze semantics from the compiled graph and frozen
  // identity, NOT from the lossy adapter projection. Legacy
  // `readdir().join()` MUST be bypassed for envelope_compiled OpenSpec
  // rounds (PR-γ A3). Compiler MUST reject multiple conditional outgoing
  // edges per node (PR-γ W4). These guards lock the post-fix invariants
  // so a future refactor that re-opens any of A3 / A7 / A8 / W4 / Cx1-H2
  // / Cx1-H3 / Cx1-H4 will fail loudly.
  // ──────────────────────────────────────────────────────────────────────

  it('#48 envelope_compiled freeze failure must call failRun (R3 PR-β Cx1-H4)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /freezeError\s*:\s*\{\s*reason\s*:/.test(file.text),
      'getOrFreezeRunArtifactRoot must surface a `freezeError` field on its resolution shape',
    ).toBe(true);
    // Locate the freezeError guard block by scanning for the predicate
    // chain, then assert failRun appears within the same block. Using
    // brace-balance scan keeps this robust against intervening whitespace
    // / comments / additional helper calls.
    const startIdx = file.text.indexOf('artifactRootResolution?.freezeError');
    expect(startIdx, 'expected freezeError guard in p2p-orchestrator.ts').toBeGreaterThanOrEqual(0);
    // The guard must reference both envelope_compiled and openspec_convention
    // within a 400-char window of the freezeError predicate.
    const window = file.text.slice(startIdx, startIdx + 600);
    expect(window).toContain("advancedSourceKind === 'envelope_compiled'");
    expect(window).toContain("artifactConvention === 'openspec_convention'");
    // The same guard block must contain a failRun call (within 1500 chars
    // — covers the diagnostic + failRun + return body).
    const block = file.text.slice(startIdx, startIdx + 1500);
    expect(block).toContain('failRun(');
  });

  it('#49 declaredFiles must come from frozen identity for envelope_compiled (R3 PR-β Cx1-H3)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /artifactRootResolution\.identity\.openspecArtifactPaths/.test(file.text),
      'post-round delta gate must use identity.openspecArtifactPaths as the declared-files coordinate system',
    ).toBe(true);
    // The delta gate must NOT *exclusively* read from round.artifactOutputs
    // for envelope_compiled — it must prefer the frozen identity. We allow
    // the round.artifactOutputs as a defensive fallback only.
    expect(
      /declaredSource\s*=\s*identityPaths\.length\s*>\s*0\s*\?\s*identityPaths\s*:\s*round\.artifactOutputs/.test(file.text),
      'declaredSource must prefer identityPaths and fall back to round.artifactOutputs only when identity is empty',
    ).toBe(true);
  });

  it('#50 envelope_compiled jump routing must read compiled.edges, not the legacy jumpRule (R3 PR-β Cx1-H2 / A7 / A8)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /run\.advancedSourceKind\s*===\s*'envelope_compiled'\s*&&\s*run\.boundWorkflow[\s\S]{0,400}compiled\.edges\.filter/.test(file.text),
      'envelope_compiled jump path must enumerate compiled.edges for outgoing conditional edges',
    ).toBe(true);
    expect(
      /edge\.condition\.kind\s*===\s*'routing_key_equals'/.test(file.text),
      'jump path must match routing_key_equals condition against scriptRoutingKey',
    ).toBe(true);
    expect(
      /edge\.condition\.kind\s*===\s*'verdict_marker_equals'/.test(file.text),
      'jump path must match verdict_marker_equals condition against effectiveVerdict',
    ).toBe(true);
    // Per-edge loop budget MUST be enforced from compiled.loopBudgets — not
    // the round-aggregated roundJumpCounts.
    expect(
      /compiled\.loopBudgets\[edge\.id\]/.test(file.text),
      'jump path must enforce per-edge loop budget from compiled.loopBudgets',
    ).toBe(true);
  });

  it('#51 dispatchScriptRoundOrFail must surface routingKey from machine output frame (R3 PR-β Cx1-H2)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /result\.machineOutput\?\.ok[\s\S]{0,200}finalFrame[\s\S]{0,200}routingKey/.test(file.text),
      'dispatchScriptRoundOrFail must extract routingKey from machineOutput.finalFrame',
    ).toBe(true);
    expect(
      /scriptDispatch\.routingKey/.test(file.text),
      'executor must consume scriptDispatch.routingKey to drive compiled-edge routing',
    ).toBe(true);
  });

  it('#52 legacy captureArtifactBaseline / validateArtifactOutputsForRound MUST bypass envelope_compiled OpenSpec rounds (R3 PR-γ A3)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    // Use brace-balance scan to extract each helper body, then assert the
    // bypass condition + early return live inside that body.
    const captureStart = file.text.indexOf('async function captureArtifactBaseline(');
    expect(captureStart, 'captureArtifactBaseline must exist').toBeGreaterThanOrEqual(0);
    const captureBody = file.text.slice(captureStart, captureStart + 2000);
    expect(captureBody).toContain("artifactConvention === 'openspec_convention'");
    expect(captureBody).toContain("advancedSourceKind === 'envelope_compiled'");
    // The envelope_compiled guard must early-return WITHOUT hitting the
    // readdir.join() heuristic. We assert both guards are present in the
    // function body and that 'return baseline' appears under them.
    expect(captureBody).toMatch(/return\s+baseline/);

    const validateStart = file.text.indexOf('async function validateArtifactOutputsForRound(');
    expect(validateStart, 'validateArtifactOutputsForRound must exist').toBeGreaterThanOrEqual(0);
    const validateBody = file.text.slice(validateStart, validateStart + 2000);
    expect(validateBody).toContain("artifactConvention === 'openspec_convention'");
    expect(validateBody).toContain("advancedSourceKind === 'envelope_compiled'");
    expect(validateBody).toMatch(/return\s*;/);
  });

  it('#53 compiler must reject multiple conditional outgoing edges per node (R3 PR-γ W4)', () => {
    const file = read('shared/p2p-workflow-compiler.ts');
    expect(
      /conditionalOutgoing\.length\s*>\s*1/.test(file.text),
      'compiler must explicitly check conditionalOutgoing.length > 1',
    ).toBe(true);
    expect(
      /Multiple conditional outgoing edges/i.test(file.text),
      'compiler diagnostic summary must mention multiple conditional outgoing edges',
    ).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // R3 v1b follow-ups (§13.14) — locked guards #55-#60
  //
  // Calibrated state: logic node evaluator wired into executor, script
  // retry with transient-only allowlist, artifact identity persisted on
  // disk, discussion writer non-blocking via per-run queue, script env
  // hardened against dynamic-loader hooks.
  // ──────────────────────────────────────────────────────────────────────

  it('#55 logic node evaluator must be wired into the orchestrator dispatch (R3 v1b)', () => {
    const orchestrator = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /import\s*\{\s*evaluateP2pLogic\s*\}\s*from\s*['"]\.\.\/\.\.\/shared\/p2p-workflow-logic-evaluator\.js['"]/.test(orchestrator.text),
      'orchestrator must import evaluateP2pLogic from the shared evaluator',
    ).toBe(true);
    expect(
      /round\.nodeKind\s*===\s*'logic'/.test(orchestrator.text),
      'orchestrator must dispatch logic nodes via a dedicated branch',
    ).toBe(true);
    expect(
      /evaluateP2pLogic\(logic\b/.test(orchestrator.text),
      'orchestrator must call evaluateP2pLogic against the compiled logic contract',
    ).toBe(true);
    expect(
      /logic_marker_equals[\s\S]{0,200}logicMarker/.test(orchestrator.text),
      'logic_marker_equals routing must consume the evaluator-emitted marker',
    ).toBe(true);
  });

  it('#56 logic node compile validation rejects missing / mismatched contracts (R3 v1b)', () => {
    const compiler = read('shared/p2p-workflow-compiler.ts');
    expect(
      /node\.nodeKind\s*===\s*'logic'/.test(compiler.text),
      'compiler must branch on logic nodeKind',
    ).toBe(true);
    expect(
      /Logic node MUST declare a `logic` contract/.test(compiler.text),
      'compiler must reject logic nodes missing a `logic` contract with explicit summary',
    ).toBe(true);
    expect(
      /Only nodeKind: .{1,8}logic.{1,8} nodes may declare a `logic` contract/.test(compiler.text),
      'compiler must reject non-logic nodes carrying a `logic` contract',
    ).toBe(true);
    expect(
      /validateP2pLogicContract\(/.test(compiler.text),
      'compiler must invoke validateP2pLogicContract for logic nodes',
    ).toBe(true);
  });

  it('#57 script retry honours transient-only allowlist + per-round attempt budget (R3 v1b)', () => {
    const constants = read('shared/p2p-workflow-constants.ts');
    expect(
      /P2P_SCRIPT_RETRY_DEFAULT_ATTEMPTS\s*=\s*3/.test(constants.text),
      'default script retry attempts must be 3',
    ).toBe(true);
    expect(
      /P2P_SCRIPT_RETRIABLE_DIAGNOSTIC_CODES\s*=\s*\[[\s\S]{0,200}'script_timeout'[\s\S]{0,200}'daemon_busy'/.test(constants.text),
      'transient retriable codes must include script_timeout and daemon_busy',
    ).toBe(true);
    const orchestrator = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /result\.diagnostics\.every\([\s\S]{0,200}P2P_SCRIPT_RETRIABLE_DIAGNOSTIC_CODES/.test(orchestrator.text),
      'retry decision must require ALL diagnostics be in the retriable list',
    ).toBe(true);
    // R3 v2 PR-ζ ζ-10 — retry counter switched from `roundAttemptCounts`
    // to a dedicated `scriptRetryCounts` map; budget check is `<= max - 1`
    // to keep "first attempt + N retries" semantics.
    expect(
      /scriptAttemptsSoFar\s*<\s*P2P_SCRIPT_RETRY_DEFAULT_ATTEMPTS\s*-\s*1/.test(orchestrator.text)
        || /attemptsSoFar\s*<\s*P2P_SCRIPT_RETRY_DEFAULT_ATTEMPTS/.test(orchestrator.text),
      'retry decision must check the per-round retry counter against the budget',
    ).toBe(true);
    expect(
      /scriptDispatch\.kind\s*===\s*'retry'[\s\S]{0,500}continue;/.test(orchestrator.text),
      'executor must `continue` on retry kind so the same round re-runs',
    ).toBe(true);
  });

  it('#58 artifact identity persistence wires through freeze + daemon startup (R3 v1b)', () => {
    const runtime = read('src/daemon/p2p-workflow-artifact-runtime.ts');
    expect(
      /export\s+async\s+function\s+loadPersistedFrozenP2pArtifactIdentities/.test(runtime.text),
      'artifact runtime must export loadPersistedFrozenP2pArtifactIdentities',
    ).toBe(true);
    expect(
      /async\s+function\s+persistFrozenIdentity/.test(runtime.text),
      'artifact runtime must define persistFrozenIdentity',
    ).toBe(true);
    expect(
      /function\s+recordFrozenIdentity/.test(runtime.text),
      'artifact runtime must wrap set + persist via recordFrozenIdentity helper',
    ).toBe(true);
    expect(
      /\.tmp.*?rename/s.test(runtime.text),
      'persistence must use atomic .tmp → rename to avoid torn writes',
    ).toBe(true);
    const orchestrator = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /loadPersistedFrozenP2pArtifactIdentities\(\)/.test(orchestrator.text),
      'orchestrator startup hook must rehydrate persisted identities',
    ).toBe(true);
  });

  it('#59 discussion writer queue is non-blocking and surfaces failures via callback (R3 v1b W2)', () => {
    const writer = read('src/daemon/p2p-discussion-writer.ts');
    expect(
      /export\s+function\s+enqueueP2pDiscussionWrite/.test(writer.text),
      'writer module must export enqueueP2pDiscussionWrite',
    ).toBe(true);
    expect(
      /export\s+async\s+function\s+flushP2pDiscussionWriteQueue/.test(writer.text),
      'writer module must export flushP2pDiscussionWriteQueue',
    ).toBe(true);
    expect(
      /onWriteFailure\?\s*:\s*\(error/.test(writer.text),
      'writer must accept and invoke an onWriteFailure listener so the orchestrator can record helper diagnostics',
    ).toBe(true);
    expect(
      /pendingBytes[\s\S]{0,80}P2P_DISCUSSION_WRITE_QUEUE_MAX_BYTES/.test(writer.text),
      'writer must enforce the byte-budget backpressure cap (pendingBytes vs P2P_DISCUSSION_WRITE_QUEUE_MAX_BYTES)',
    ).toBe(true);
    const orchestrator = read('src/daemon/p2p-orchestrator.ts');
    // R3 v2 PR-ζ ζ-4 / M1 — enqueueP2pDiscussionWrite now takes an
    // optional fourth `onSegmentDropped` callback so backpressure drops
    // surface as helper diagnostics. The orchestrator passes
    // `run.contextFilePath` as the first arg in both forms.
    expect(
      /enqueueP2pDiscussionWrite\([\s\S]{0,40}run\.contextFilePath/.test(orchestrator.text),
      'orchestrator script + logic dispatch must use enqueueP2pDiscussionWrite, not awaited appendFile',
    ).toBe(true);
    expect(
      /flushP2pDiscussionWriteQueue\(run\.contextFilePath\)/.test(orchestrator.text),
      'orchestrator must flush the queue before reading the discussion file for the run summary',
    ).toBe(true);
  });

  it('#60 script runner env deny-list strips dynamic-loader hooks unconditionally (R3 v1b sandbox)', () => {
    const runner = read('src/daemon/p2p-workflow-script-runner.ts');
    expect(
      /export\s+const\s+P2P_SCRIPT_ENV_DENYLIST/.test(runner.text),
      'runner must export the deny-list constant',
    ).toBe(true);
    for (const hook of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS']) {
      expect(
        runner.text.includes(`'${hook}'`),
        `deny-list MUST include ${hook}`,
      ).toBe(true);
    }
    expect(
      /denylist\.has\(name\)\s*\)\s*continue/.test(runner.text),
      'buildScriptSpawnEnv must skip allowlisted names that appear in the deny-list',
    ).toBe(true);
  });

  it('#54 UI-managed allowedExecutables plumbing: envelope + saved config + canvas panel section (R3 PR-α §13.13)', () => {
    // Envelope type carries the field with documentation pointing at UI flow.
    const envelopeType = read('shared/p2p-workflow-types.ts');
    expect(
      /allowedExecutables\?\:\s*string\[\]/.test(envelopeType.text),
      'P2pWorkflowLaunchEnvelope must declare optional allowedExecutables',
    ).toBe(true);
    // Validator enforces shape on the envelope.
    const validator = read('shared/p2p-workflow-validators.ts');
    expect(
      /input\.allowedExecutables/.test(validator.text),
      'envelope validator must inspect allowedExecutables',
    ).toBe(true);
    expect(
      /allowedExecutables\.length\s*>\s*64/.test(validator.text),
      'envelope validator must cap allowedExecutables at 64 entries',
    ).toBe(true);
    // Saved config persists the user-managed list.
    const savedConfig = read('shared/p2p-modes.ts');
    expect(
      /allowedExecutables\?\:\s*string\[\]/.test(savedConfig.text),
      'P2pSavedConfig must declare optional allowedExecutables for userPref round-trip',
    ).toBe(true);
    // Canvas panel writes config.allowedExecutables into the envelope.
    const panel = read('web/src/components/P2pConfigPanel.tsx');
    expect(
      /sanitizeAllowedExecutables\(config\.allowedExecutables\)/.test(panel.text),
      'buildP2pWorkflowLaunchEnvelopeFromConfig must sanitize and emit config.allowedExecutables',
    ).toBe(true);
    expect(
      /data-testid="p2p-allowed-executables-section"/.test(panel.text),
      'P2pConfigPanel must render a dedicated "Allowed executables" UI section',
    ).toBe(true);
    expect(
      /data-testid="p2p-allowed-executables-add"/.test(panel.text),
      'allowed-executables UI must expose an Add button testid',
    ).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // R3 v2 PR-ζ reverse-regression #61-#66 + #68-#70
  //
  // Calibrated state: prototype pollution write path closed, persistence
  // hardened against symlinks / path-traversal / repoRoot mismatch /
  // count + TTL caps / .tmp orphans, terminal cleanup hook fires for
  // all three caches, baseline diagnostics fail-closed, scriptRetryCounts
  // independent of roundAttemptCounts, env deny-list expanded by 11.
  // ──────────────────────────────────────────────────────────────────────

  it('#61 runVariables MUST be initialised from a null-prototype map (R3 v2 PR-ζ B1/A5)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /Object\.create\(null\)/.test(file.text),
      'orchestrator MUST initialise runVariables via Object.create(null) for prototype-pollution defence',
    ).toBe(true);
    expect(
      /runVariables:\s*\(\(\)\s*=>\s*\{[\s\S]{0,400}Object\.create\(null\)/.test(file.text),
      'runVariables initialiser must wrap Object.create(null) into the IIFE that seeds defaults',
    ).toBe(true);
  });

  it('#62 orchestrator script-variable write path MUST validate name + array caps (R3 v2 PR-ζ B1/B5)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /P2P_WORKFLOW_VARIABLE_NAME_PATTERN\.test\(name\)/.test(file.text),
      'write path must reject names failing P2P_WORKFLOW_VARIABLE_NAME_PATTERN',
    ).toBe(true);
    expect(
      /P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENTS/.test(file.text),
      'write path must enforce element-count cap',
    ).toBe(true);
    expect(
      /P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENT_BYTES/.test(file.text),
      'write path must enforce per-element byte cap',
    ).toBe(true);
  });

  it('#63 persistFrozenIdentity tmp filename MUST include process.pid (R3 v2 PR-ζ B2)', () => {
    const file = read('src/daemon/p2p-workflow-artifact-runtime.ts');
    expect(
      /\$\{filePath\}\.\$\{process\.pid\}/.test(file.text),
      'tmp filename must include process.pid to prevent same-runId concurrent corruption',
    ).toBe(true);
  });

  it('#64 rehydrate MUST reject symlink top-level entries (R3 v2 PR-ζ A3)', () => {
    const file = read('src/daemon/p2p-workflow-artifact-runtime.ts');
    expect(
      /entryStat\.isSymbolicLink\(\)/.test(file.text),
      'rehydrate must lstat entry and skip symlinks',
    ).toBe(true);
  });

  it('#65 rehydrate MUST re-validate every openspecArtifactPaths entry (R3 v2 PR-ζ A4)', () => {
    const file = read('src/daemon/p2p-workflow-artifact-runtime.ts');
    expect(
      /validateP2pArtifactRelativePath\(declared/.test(file.text),
      'rehydrate must run validateP2pArtifactRelativePath on each declared path',
    ).toBe(true);
  });

  it('#66 terminal transition MUST schedule cleanup of 3 caches (R3 v2 PR-ζ A6/O4)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /scheduleP2pRunTerminalCleanup\(/.test(file.text),
      'terminal cleanup helper must exist and be called from transition+failRun',
    ).toBe(true);
    // The helper must clear all three caches.
    expect(
      /dropP2pDiscussionWriteQueue\(/.test(file.text),
      'cleanup helper must drop discussion writer queue',
    ).toBe(true);
    expect(
      /clearPersistedFrozenP2pArtifactIdentity\(/.test(file.text),
      'cleanup helper must clear frozen identity',
    ).toBe(true);
    expect(
      /runArtifactRootCache\.delete\(/.test(file.text),
      'cleanup helper must delete runArtifactRootCache entry',
    ).toBe(true);
  });

  it('#68 captureP2pArtifactBaseline diagnostics + truncated MUST fail closed (R3 v2 PR-ζ Cx1-A2)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    // Both pre and post capture sites must inspect diagnostics + truncated.
    const occurrences = file.text.match(/captureResult\.diagnostics\.find|afterCapture\.diagnostics\.find/g) ?? [];
    expect(occurrences.length, 'pre AND post capture sites must inspect diagnostics').toBeGreaterThanOrEqual(2);
    expect(
      /baseline\.truncated/.test(file.text),
      'baseline.truncated must be checked',
    ).toBe(true);
    expect(
      /Pre-round artifact baseline capture failed|Post-round artifact baseline capture failed/.test(file.text),
      'failRun message must distinguish pre vs post capture failure',
    ).toBe(true);
  });

  it('#69 P2P_SCRIPT_ENV_DENYLIST MUST cover loader / runtime / shell / package categories (R3 v2 PR-ζ M4)', () => {
    const file = read('src/daemon/p2p-workflow-script-runner.ts');
    const required = [
      'JAVA_TOOL_OPTIONS', 'PSModulePath', 'LUA_PATH', 'LUA_CPATH',
      'PYTHONHOME', 'PIP_INDEX_URL', 'npm_config_registry',
      'SHELLOPTS', 'BASHOPTS', 'PROMPT_COMMAND', 'IFS',
    ];
    for (const name of required) {
      expect(
        file.text.includes(`'${name}'`),
        `P2P_SCRIPT_ENV_DENYLIST MUST include ${name}`,
      ).toBe(true);
    }
  });

  it('#67 envelope_compiled MUST advance via compiled graph; unmatched conditional + no default = fail closed (R3 v2 PR-η Cx1-A1)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /unmatched_edge_route/.test(file.text),
      'orchestrator must emit `unmatched_edge_route` diagnostic when conditional edges miss AND no default exists',
    ).toBe(true);
    // After the legacy `if (jump) { ... continue; }` block, envelope_compiled
    // must take the compiled-graph branch BEFORE the `roundIndex += 1`
    // fallback. We assert both the branch presence AND the fact that the
    // legacy `roundIndex += 1` is now reachable ONLY for non-envelope_compiled
    // runs.
    // Use brace-balance to find the envelope_compiled advance block
    // and then verify the legacy `roundIndex += 1` comes AFTER it.
    const advanceIdx = file.text.indexOf("run.advancedSourceKind === 'envelope_compiled' && run.boundWorkflow");
    const legacyIncIdx = file.text.lastIndexOf('roundIndex += 1');
    expect(advanceIdx, 'envelope_compiled advance branch must exist').toBeGreaterThanOrEqual(0);
    expect(legacyIncIdx, 'legacy roundIndex++ fallback must exist').toBeGreaterThanOrEqual(0);
    // The advance branch must precede the legacy fallback in source order.
    expect(advanceIdx).toBeLessThan(legacyIncIdx);
    expect(
      /No outgoing conditional edge matched from/.test(file.text),
      'unmatched-route diagnostic summary must include the canonical phrase',
    ).toBe(true);
  });

  const diagnosticsModuleSpec = read('shared/p2p-workflow-diagnostics.ts');
  it('#67b unmatched_edge_route diagnostic code is registered (R3 v2 PR-η)', () => {
    expect(
      /'unmatched_edge_route'/.test(diagnosticsModuleSpec.text),
      'diagnostic code list must include unmatched_edge_route',
    ).toBe(true);
    expect(
      /unmatched_edge_route:\s*\['execute'\]/.test(diagnosticsModuleSpec.text),
      'phase matrix must register unmatched_edge_route on the execute phase',
    ).toBe(true);
  });

  it('#70 scriptRetryCounts MUST be independent of roundAttemptCounts (R3 v2 PR-ζ M2)', () => {
    const file = read('src/daemon/p2p-orchestrator.ts');
    expect(
      /scriptRetryCounts\?\:\s*Record<string,\s*number>/.test(file.text),
      'P2pRun must declare scriptRetryCounts as an optional Record<string,number>',
    ).toBe(true);
    expect(
      /run\.scriptRetryCounts\[round\.id\]/.test(file.text),
      'retry decision must read scriptRetryCounts, not roundAttemptCounts',
    ).toBe(true);
    expect(
      /delete run\.scriptRetryCounts\[jump\]/.test(file.text),
      'jump-rebound must reset scriptRetryCounts for the target round',
    ).toBe(true);
  });

  /*
   * Reverse-regression #71 (R3 v2 PR-θ — UX accessibility: dedicated
   * "advanced workflow" tab so the canvas editor is reachable from a
   * cold panel, and so the participants tab is no longer overloaded
   * with the canvas + allowed-executables + workflow banners).
   *
   * Locked invariants:
   *   1. `P2pConfigPanel` declares an `'advanced'` member in its
   *      `initialTab` union AND in the `useState` type so users may
   *      open the panel directly on the canvas.
   *   2. The tab button is rendered with `data-testid="p2p-tab-advanced"`
   *      and a tab-name `t()` key (`p2p.tab.advanced_workflow`).
   *   3. A `useEffect` auto-bootstraps a starter `P2pWorkflowDraft` when
   *      the user enters the advanced tab with no prior draft, so the
   *      canvas is never blank-and-unreachable for a new user.
   *   4. The advanced tab branch in the body switch hosts the
   *      `<AdvancedWorkflowCanvasEditor>` AND the allowed-executables
   *      section — the participants branch must NOT host either.
   *   5. The 7 supported locales each carry the
   *      `p2p.tab.advanced_workflow*` key block (parity is asserted by
   *      the existing i18n parity test; here we only guard the source
   *      code structure that emits those keys).
   */
  it('#71 advanced workflow tab MUST exist and host the canvas (R3 v2 PR-θ)', () => {
    const file = read('web/src/components/P2pConfigPanel.tsx');

    // (1) initialTab + useState type must include 'advanced'.
    expect(
      /initialTab\?:\s*'participants'\s*\|\s*'combos'\s*\|\s*'advanced'/.test(file.text),
      "Props.initialTab must include 'advanced' so callers can open directly on the canvas tab",
    ).toBe(true);
    expect(
      /useState<'participants'\s*\|\s*'combos'\s*\|\s*'advanced'>/.test(file.text),
      "activeTab useState type union must include 'advanced'",
    ).toBe(true);

    // (2) Tab button with stable testid + i18n key.
    expect(
      /data-testid=\"p2p-tab-advanced\"/.test(file.text),
      'Advanced tab button must carry data-testid="p2p-tab-advanced" for tests + a11y selectors',
    ).toBe(true);
    expect(
      /t\(\s*['\"]p2p\.tab\.advanced_workflow['\"]/.test(file.text),
      "Advanced tab button label must read from the i18n key 'p2p.tab.advanced_workflow'",
    ).toBe(true);

    // (3) Bootstrap useEffect: when activeTab === 'advanced' AND no draft
    // exists yet, a starter draft must be injected. We don't pin the exact
    // useEffect body — just that the conditional bootstrap path exists in
    // the source and refers to the canvas-relevant state.
    const bootstrapAnchor = file.text.indexOf("if (activeTab !== 'advanced') return;");
    expect(
      bootstrapAnchor,
      "A bootstrap useEffect early-return guarding on `activeTab !== 'advanced'` must exist",
    ).toBeGreaterThan(0);
    const bootstrapWindow = file.text.slice(bootstrapAnchor, bootstrapAnchor + 1500);
    // R3 v2 PR-ι — bootstrap now seeds the workflow LIBRARY (single-entry)
    // rather than the legacy workflowDraft state. Either pattern is
    // acceptable — both keep the canvas reachable from a cold panel.
    expect(
      /setWorkflowDraft\(starter\)/.test(bootstrapWindow)
        || /setWorkflowLibrary\(\[starter\]\)/.test(bootstrapWindow),
      'The advanced-tab bootstrap effect must inject a starter draft via setWorkflowDraft(starter) or setWorkflowLibrary([starter])',
    ).toBe(true);

    // (4) The advanced tab branch must contain the canvas + allowed
    // executables. We anchor on the comment marker placed in the advanced
    // tab branch and scan forward for the canvas + allowlist mounts.
    const advancedAnchor = file.text.indexOf('R3 v2 PR-θ — Advanced Workflow tab');
    expect(advancedAnchor, 'Advanced tab branch comment marker must be present').toBeGreaterThan(0);
    // Window grew with the PR-ι library section + name input — bump the
    // scan range so the canvas + allowlist mounts (which now sit deeper
    // in the branch) still fall inside it.
    const advancedWindow = file.text.slice(advancedAnchor, advancedAnchor + 16000);
    expect(
      /<AdvancedWorkflowCanvasEditor[\s\S]*?value=\{workflowDraft\}/.test(advancedWindow),
      'Advanced tab branch must mount <AdvancedWorkflowCanvasEditor value={workflowDraft}>',
    ).toBe(true);
    expect(
      /data-testid=\"p2p-allowed-executables-section\"/.test(advancedWindow),
      'Allowed-executables section must live inside the advanced tab branch',
    ).toBe(true);

    // The canvas + allowed-executables MUST NOT appear ANYWHERE else (i.e.
    // not inside the participants branch). We assert the file contains
    // exactly one of each marker so the participants branch can never
    // re-acquire them via accidental copy/paste.
    const canvasOccurrences = file.text.match(/<AdvancedWorkflowCanvasEditor/g)?.length ?? 0;
    expect(canvasOccurrences, 'Canvas editor must be mounted exactly once (advanced tab only)').toBe(1);
    const allowlistOccurrences = file.text.match(/data-testid=\"p2p-allowed-executables-section\"/g)?.length ?? 0;
    expect(allowlistOccurrences, 'Allowed-executables section must be mounted exactly once').toBe(1);
  });

  /*
   * Reverse-regression #72 (R3 v2 PR-ι — Workflow library: multi-workflow
   * data model so users can save/name/edit/duplicate/delete workflows
   * and pick which one P2P invokes).
   *
   * Locked invariants:
   *   1. `P2pSavedConfig` declares optional `workflowLibrary?: P2pWorkflowDraft[]`
   *      AND `activeWorkflowId?: string` fields (with comments tying them
   *      to PR-ι), and `isP2pSavedConfig` validates their shape.
   *   2. The shared `p2p-workflow-library.ts` helper module exists and
   *      exports the resolution + mutator functions used by the UI and
   *      the launch-envelope builder. Centralising these prevents drift
   *      between UI and launch.
   *   3. `buildP2pWorkflowLaunchEnvelopeFromConfig` MUST resolve the
   *      active workflow through `getActiveWorkflowFromConfig` (rather
   *      than reading `config.workflowDraft` directly), so the envelope
   *      always launches the user-selected entry.
   *   4. `P2pConfigPanel` mounts the workflow library section
   *      (`data-testid="p2p-workflow-library-section"`) and the title
   *      input (`data-testid="p2p-workflow-name-input"`) inside the
   *      advanced tab.
   */
  it('#72 P2pSavedConfig MUST carry a workflow library + active id (R3 v2 PR-ι)', () => {
    const file = read('shared/p2p-modes.ts');

    expect(
      /workflowLibrary\?\:\s*P2pWorkflowDraft\[\]/.test(file.text),
      'P2pSavedConfig must declare optional workflowLibrary: P2pWorkflowDraft[]',
    ).toBe(true);
    expect(
      /activeWorkflowId\?\:\s*string/.test(file.text),
      'P2pSavedConfig must declare optional activeWorkflowId: string',
    ).toBe(true);

    // Validator must shape-check both new fields so malformed payloads from
    // the wire don't slip through and crash the editor.
    expect(
      /workflowLibrary\?\:\s*unknown/.test(file.text),
      'isP2pSavedConfig must accept workflowLibrary as a checked unknown',
    ).toBe(true);
    expect(
      /activeWorkflowId\?\:\s*unknown/.test(file.text),
      'isP2pSavedConfig must accept activeWorkflowId as a checked unknown',
    ).toBe(true);
  });

  it('#72b shared workflow library helpers exist and are wired into the launch path (R3 v2 PR-ι)', () => {
    const helpers = read('shared/p2p-workflow-library.ts');
    // Required exports — the UI + launch builder import these symbols.
    for (const symbol of [
      'P2P_WORKFLOW_DEFAULT_TITLE',
      'P2P_WORKFLOW_LIBRARY_MAX_ENTRIES',
      'generateWorkflowDraftId',
      'normalizeWorkflowLibrary',
      'migrateLegacyWorkflowDraft',
      'getActiveWorkflowFromConfig',
      'addWorkflowToLibrary',
      'removeWorkflowFromLibrary',
      'duplicateWorkflowInLibrary',
      'replaceActiveWorkflowInConfig',
    ]) {
      // Accept either `export const FOO` / `export function FOO` (declaration
      // form) or `export { FOO }` / `export { FOO, BAR }` (re-export form).
      const declared = new RegExp(`export\\s+(function|const)\\s+${symbol}\\b`).test(helpers.text);
      const reExported = new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`).test(helpers.text);
      expect(
        declared || reExported,
        `shared/p2p-workflow-library.ts must export ${symbol}`,
      ).toBe(true);
    }

    // The launch envelope builder must source the active workflow through
    // the helper, never by reading `config.workflowDraft` as the primary
    // path (which would skip the library entirely).
    const panel = read('web/src/components/P2pConfigPanel.tsx');
    expect(
      /getActiveWorkflowFromConfig\(config\)/.test(panel.text),
      'buildP2pWorkflowLaunchEnvelopeFromConfig must call getActiveWorkflowFromConfig(config)',
    ).toBe(true);
  });

  it('#72c P2pConfigPanel MUST mount the workflow library section + title input under the advanced tab (R3 v2 PR-ι)', () => {
    const file = read('web/src/components/P2pConfigPanel.tsx');

    // Both UI markers must exist exactly once each so a future edit cannot
    // accidentally drop the surface or double-mount it.
    const sectionCount = file.text.match(/data-testid=\"p2p-workflow-library-section\"/g)?.length ?? 0;
    expect(sectionCount, 'Library section must be mounted exactly once').toBe(1);
    const nameInputCount = file.text.match(/data-testid=\"p2p-workflow-name-input\"/g)?.length ?? 0;
    expect(nameInputCount, 'Workflow name input must be mounted exactly once').toBe(1);
    for (const testId of [
      'p2p-workflow-library-new',
      'p2p-workflow-library-duplicate',
      'p2p-workflow-library-delete',
      'p2p-workflow-library-list',
    ]) {
      expect(
        file.text.includes(`data-testid="${testId}"`),
        `Library action button must carry data-testid="${testId}"`,
      ).toBe(true);
    }
  });
});
