import io, subprocess, os, sys, tempfile
H='src/agent/priority-preserving-context-cap.ts'; Q='src/agent/providers/qwen.ts'; C='src/agent/providers/codex-sdk.ts'
S='shared/session-identity.ts'; M='shared/memory-mcp-contracts.ts'
DT=["test/agent/priority-preserving-context-cap.test.ts","test/agent/qwen-provider.test.ts","test/agent/codex-sdk-provider.test.ts","test/agent/provider-context-routing.test.ts","test/agent/transport-runtime-assembly.test.ts",
    "test/shared/session-identity.test.ts","test/daemon/session-identity-mcp.test.ts","test/daemon/memory-mcp-tools-schema-firewall.test.ts",
    "test/daemon/send-tool.test.ts","test/daemon/command-handler-transport-queue.test.ts","test/store/session-store.test.ts"]
MUT = [
 ("U1 UI counter uses raw code points", "web/src/components/SessionIdentityTabs.tsx", "count: sessionIdentityContentLength(draft.content), limit", "count: Array.from(draft.content).length + 0 * Number(typeof sessionIdentityContentLength === 'function'), limit", "web", ["web/test/components/SessionIdentityTabs.limit.test.tsx"]),
 ("U2 UI counter skips NFC", "web/src/components/SessionIdentityTabs.tsx", "count: sessionIdentityContentLength(draft.content), limit", "count: Array.from(draft.content.trim()).length + 0 * Number(typeof sessionIdentityContentLength === 'function'), limit", "web", ["web/test/components/SessionIdentityTabs.limit.test.tsx"]),
 ("U3 UI counter skips trim", "web/src/components/SessionIdentityTabs.tsx", "count: sessionIdentityContentLength(draft.content), limit", "count: Array.from(draft.content.normalize('NFC')).length + 0 * Number(typeof sessionIdentityContentLength === 'function'), limit", "web", ["web/test/components/SessionIdentityTabs.limit.test.tsx"]),
 ("U4 shared length skips normalization", S, "  return Array.from(normalizeSessionIdentityContent(value)).length;", "  return Array.from(value).length;", "daemon", ["test/shared/session-identity.test.ts"]),
 ("U5 shared length skips normalization (UI view)", S, "  return Array.from(normalizeSessionIdentityContent(value)).length;", "  return Array.from(value).length;", "web", ["web/test/components/SessionIdentityTabs.limit.test.tsx"]),
 ("R4-1 cap rediscovers the identity by searching text (lastIndexOf close / indexOf open)", H, "  const span = verifyIdentitySpan(input.text, input.identity);\n", "  const openAt = input.text.indexOf(SESSION_IDENTITY_BLOCK_OPEN_TAG);\n  const closeAt = input.text.lastIndexOf(SESSION_IDENTITY_BLOCK_CLOSE_TAG);\n  const span = input.identity && openAt >= 0 && closeAt > openAt ? { start: openAt + SESSION_IDENTITY_BLOCK_OPEN_TAG.length, end: closeAt, sha256: '' } : undefined;\n", "daemon", DT),
 ("R4-2 span sha256 verification skipped", H, "  if (typeof sha256 !== 'string' || sha256Hex(text.slice(start, end)) !== sha256) return undefined;\n", "", "daemon", DT),
 ("R4-3 span bounds check skipped", H, "  if (start < 0 || end < start || end > text.length) return undefined;\n", "", "daemon", DT),
 ("R4-4 assembly drops the identity span", "src/agent/transport-runtime-assembly.ts", "identitySegment ? { text: identitySegment, identity: identitySpanForSegment(identitySegment) } : undefined", "identitySegment", "daemon", DT),
 ("R4-5 joinSpanned does not re-base span offsets", H, "offsetIdentitySpan(spanned.identity, text.length)", "offsetIdentitySpan(spanned.identity, 0)", "daemon", DT),
 ("R4-6 routing ignores leading-trim offset", "src/agent/provider-context-routing.ts", "offsetIdentitySpan(payload.context.sessionSystemTextIdentity, -leadingTrim)", "offsetIdentitySpan(payload.context.sessionSystemTextIdentity, 0)", "daemon", DT),
 ("R4-7 identity frame ignored (tags become shrinkable)", H, "  const start = framed ? SESSION_IDENTITY_BLOCK_OPEN_TAG.length : 0;\n  const end = framed ? segment.length - SESSION_IDENTITY_BLOCK_CLOSE_TAG.length : segment.length;", "  const start = framed ? 0 : 0;\n  const end = framed ? segment.length : segment.length;", "daemon", DT),
 ("R4-8 Codex turn context capped without its span", C, "  const cappedContextText = capCodexSdkContextInjection(contextText);", "  const cappedContextText = capCodexSdkContextInjection(contextText.text);", "daemon", DT),
 ("R4-9 Codex baseInstructions tail capped without its span", C, "${capCodexSdkContextInjection(tail)}", "${capCodexSdkContextInjection(tail.text)}", "daemon", DT),
 ("R4-10 Qwen prompt capped without its span", Q, "capQwenAppendSystemPrompt(effectivePrompt));", "capQwenAppendSystemPrompt(typeof effectivePrompt === 'string' ? effectivePrompt : effectivePrompt.text));", "daemon", DT),
 ("R4-11 Codex stable update drops the session span", C, "buildCodexTurnInput(payload, shouldInjectStableUpdate ? getProviderSessionSystemTextSpanned(payload) : undefined)", "buildCodexTurnInput(payload, shouldInjectStableUpdate ? joinSpanned([getProviderSessionSystemTextSpanned(payload)?.text], '') : undefined)", "daemon", DT),
 ("Q1 qwen cap call removed (raw argv prompt)", Q, "args.push('--append-system-prompt', capQwenAppendSystemPrompt(effectivePrompt));", "args.push('--append-system-prompt', typeof effectivePrompt === 'string' ? effectivePrompt : effectivePrompt.text);", "daemon", DT),
 ("Q2 identity-first shrink disabled (all providers)", H, "  if (identityShrunk !== undefined) return identityShrunk;\n", "", "daemon", DT),
 ("Q3 utf8 cut may split a code point", H, "  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;\n", "", "daemon", DT),
 ("Q4 qwen byte budget raised past MAX_ARG_STRLEN", Q, "export const QWEN_APPEND_SYSTEM_PROMPT_MAX_BYTES = 120_000;", "export const QWEN_APPEND_SYSTEM_PROMPT_MAX_BYTES = 200_000;", "daemon", DT),
 ("Q5 qwen budget measured in UTF-16 units instead of bytes", Q, "QWEN_APPEND_SYSTEM_PROMPT_MAX_BYTES, 'utf8', QWEN_SYSTEM_PROMPT_CAP_MARKERS", "QWEN_APPEND_SYSTEM_PROMPT_MAX_BYTES, 'utf16', QWEN_SYSTEM_PROMPT_CAP_MARKERS", "daemon", DT),
 ("Q7 utf16 surrogate guard removed", H, "    return text.slice(0, lastKept >= 0xd800 && lastKept <= 0xdbff ? budget - 1 : budget);", "    return text.slice(0, lastKept >= 0 ? budget : budget);", "daemon", DT),
 ("Q8 shrink ignores marker size (overflows budget)", H, "    - measureContext(marker, measure);\n  if (keep < 0) return undefined;", ";\n  if (keep < 0) return undefined;", "daemon", DT),
 ("Q9 shrink drops the kept identity head", H, "  return `${before}${prefixWithinBudget(body, keep, measure).trimEnd()}${marker}${after}`;", "  return `${before}${marker}${after}`;", "daemon", DT),
 ("C5 Codex ceiling reverted to 180k", C, "export const MAX_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS = 250_000;", "export const MAX_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS = 180_000;", "daemon", DT),
 ("C7 Codex measured in bytes instead of UTF-16", C, "capContextPreservingPriority(text, maxChars, 'utf16', CODEX_CONTEXT_CAP_MARKERS)", "capContextPreservingPriority(text, maxChars, 'utf8', CODEX_CONTEXT_CAP_MARKERS)", "daemon", DT),
 ("S1 user limit reverted to 20k", S, "export const SESSION_IDENTITY_USER_MAX_CHARS = 50_000;", "export const SESSION_IDENTITY_USER_MAX_CHARS = 20_000;", "daemon", DT),
 ("S2 project limit reverted to 60k", S, "export const SESSION_IDENTITY_PROJECT_MAX_CHARS = 100_000;", "export const SESSION_IDENTITY_PROJECT_MAX_CHARS = 60_000;", "daemon", DT),
 ("S3 session limit reverted to 100k", S, "export const SESSION_IDENTITY_SESSION_MAX_CHARS = 200_000;", "export const SESSION_IDENTITY_SESSION_MAX_CHARS = 100_000;", "daemon", DT),
 ("S4 validator counts UTF-16 units", S, "  return Array.from(normalizeSessionIdentityContent(value)).length;", "  return normalizeSessionIdentityContent(value).length;", "daemon", DT),
 ("M1 MCP description back to stale literals", M, "`Inline identity contract: user scope up to ${SESSION_IDENTITY_USER_MAX_CHARS.toLocaleString('en-US')} characters, project up to ${SESSION_IDENTITY_PROJECT_MAX_CHARS.toLocaleString('en-US')}, session up to ${SESSION_IDENTITY_SESSION_MAX_CHARS.toLocaleString('en-US')} characters. Limits are counted as Unicode code points, independent of UTF-8 or JSON transport size.`", "'Inline identity contract: user scope up to 20,000 characters, project up to 40,000, session up to 80,000 characters. Limits are counted as Unicode code points, independent of UTF-8 or JSON transport size.'", "daemon", DT),
 ("G1 server route content gate removed", "server/src/routes/session-identity-http.ts", "  if (contentReason) return c.json({ error: contentReason }, 400);", "  if (false && contentReason) return c.json({ error: contentReason }, 400);", "server", ["server/test/session-identities-routes.test.ts"]),
 ("G2 MCP set content gate removed", "src/daemon/memory-mcp-tools.ts", "      if (contentReason) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, contentReason);\n", "", "daemon", DT),
 ("G3 MCP send identity ingress gate removed", "src/daemon/memory-mcp-tools.ts", "  if (sessionIdentityContentError(content, SESSION_IDENTITY_SCOPES.SESSION)) return 'invalid';\n", "", "daemon", DT),
 ("G4 send-tool identity gate removed", "src/daemon/send-tool.ts", "    if (identityError) {\n      return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, error: identityError };\n    }\n", "", "daemon", DT),
 ("G5 command-handler identity gate removed", "src/daemon/command-handler.ts", "    || sessionIdentityContentError(rawIdentityPrompt) !== null\n", "", "daemon", DT),
 ("G6 web panel validation gate removed", "web/src/components/SessionIdentityTabs.tsx", "  const validationError = draft.content.trim() ? sessionIdentityContentError(draft.content, activeScope) : null;", "  const validationError = null as string | null;", "web", ["web/test/components/SessionIdentityTabs.limit.test.tsx"]),
]
ONLY = sys.argv[1:]
if ONLY: MUT = [m for m in MUT if m[0].split(' ')[0] in ONLY]
killed = 0
for label, path, old, new, project, tests in MUT:
    o = io.open(path, encoding='utf8').read()
    if o.count(old) != 1:
        print(f"{'ANCHOR-MISS('+str(o.count(old))+')':20} {label}", flush=True); continue
    io.open(path, 'w', encoding='utf8').write(o.replace(old, new, 1))
    tsc = {"daemon": (["npx","tsc","--noEmit"], None), "server": (["npx","tsc","-p","server/tsconfig.json","--noEmit"], None), "web": (["npx","tsc","--noEmit"], "web")}[project]
    if subprocess.run(tsc[0], cwd=tsc[1], capture_output=True, text=True).returncode:
        io.open(path, 'w', encoding='utf8').write(o); print(f"{'NOT-COMPILE-CLEAN':20} {label}", flush=True); continue
    env = dict(os.environ, HOME=tempfile.mkdtemp(), IMCODES_HOME=tempfile.mkdtemp())
    try:
        r = subprocess.run(["npx","vitest","run","--project",project,*tests], capture_output=True, text=True, env=env, timeout=2400)
        k = r.returncode != 0
        fails = sorted({l.split('> ')[-1][:100] for l in (r.stdout + r.stderr).splitlines() if 'FAIL ' in l})
    except subprocess.TimeoutExpired:
        k, fails = True, ["<timeout>"]
    io.open(path, 'w', encoding='utf8').write(o)
    killed += k
    print(f"{'KILLED' if k else 'SURVIVED':20} {label}" + (f"  <- {fails[:1]}" if k else ""), flush=True)
print(f"\nKILLED {killed}/{len(MUT)}")
