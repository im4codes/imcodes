/**
 * Template-prompt detection shared across daemon and server.
 *
 * IM.codes' shared-context memory system stages and materializes chat events
 * into `recent_summary` / `durable_memory_candidate` projections that later
 * feed back into `prependLocalMemory` (process agents), the transport recall
 * step (Phase K), `selectStartupMemoryItems`, and the server
 * `memory/recall` endpoint.
 *
 * That pipeline produces noise for built-in / templated prompts:
 *   - OpenSpec workflow invocations (`Drive the implementation of
 *     @openspec/changes/...`, archive/propose/apply/explore skills)
 *   - Slash-command / skill preambles (`/loop`, `/schedule`, `/review`,
 *     `claude-mem:*`, `opsx:*`, `openspec-*`, `update-config`, ...)
 *   - Harness-injected `<command-name>` templates
 *
 * Memories derived from those prompts are irrelevant to later user work:
 * cross-project OpenSpec references pollute recall hits for unrelated
 * projects. This module is the single source of truth for detecting them
 * at every ingestion and recall site.
 *
 * Design goals:
 *   - Cheap: pure string/regex, no allocation beyond trimming
 *   - Conservative: a pattern must be a high-signal marker, not merely a
 *     keyword that could appear in normal prose
 *   - Shared: daemon (`src/context/*`, `src/daemon/*`, `src/agent/*`) and
 *     server (`server/src/routes/shared-context.ts`) import the same
 *     predicate so query-side and result-side filtering stay consistent
 */

/**
 * Raw user prompt or staged-event `content`.
 *
 * True when the text is obviously a templated workflow invocation — the kind
 * of prompt whose resulting assistant turn should not become recallable
 * memory, and whose text should not be used as a recall query.
 */
export function isTemplatePrompt(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // OpenSpec change references — any `@openspec/changes/<slug>` or bare
  // `openspec/changes/<slug>` path is a strong marker. The workflow skills
  // (propose/apply/archive/explore) all emit these references.
  if (/(^|[\s@/`"'])openspec\/changes\/[a-z0-9][\w./-]*/i.test(trimmed)) {
    return true;
  }

  // Harness-injected command invocation tags (Claude Code slash commands
  // render as `<command-name>foo</command-name>` in the transcript).
  if (/<command-name>[^<]+<\/command-name>/i.test(trimmed)) {
    return true;
  }
  if (/<command-message>[^<]*<\/command-message>/i.test(trimmed)) {
    return true;
  }
  if (/<command-args>[^<]*<\/command-args>/i.test(trimmed)) {
    return true;
  }

  // OpenSpec + P2P workflow imperative phrases emitted by built-in skill
  // preambles and quick-actions. Each is a high-signal anchor per language —
  // see `web/src/i18n/locales/*.json` keys `openspec.*_prompt` and
  // `p2p.*_prompt`, plus `shared/p2p-modes.ts` (`P2P_BASELINE_PROMPT`,
  // `roundPrompt`). These MUST stay in sync with those templates across all
  // 7 locales (en, zh-CN, zh-TW, es, ru, ja, ko).
  for (const marker of MULTILINGUAL_TEMPLATE_MARKERS) {
    if (marker.test(trimmed)) return true;
  }

  // Leading slash-command dispatch for well-known built-in skills. We only
  // match the first token to avoid swallowing legitimate prose that happens
  // to contain a slash path.
  const firstToken = trimmed.split(/\s/, 1)[0] ?? '';
  if (SLASH_COMMAND_NAMES.has(firstToken.toLowerCase())) return true;

  // Plugin-namespaced skill invocations like `claude-mem:do`, `opsx:apply`.
  if (/^(?:claude-mem|claude-hud|claude-api|opsx|openspec-[a-z-]+|update-config|less-permission-prompts|keybindings-help|simplify|statusline-setup|init|review|security-review|loop|schedule):/i.test(firstToken)) {
    return true;
  }

  return false;
}

/**
 * Processed projection `summary` text.
 *
 * True when a stored memory summary clearly originated from a templated
 * prompt — e.g. summaries that mention orchestrating subagents for an
 * OpenSpec change, archiving a change, or running a skill. This catches
 * legacy projections written before ingestion-side filtering existed, and
 * guards against any content that slipped through because the templated
 * prompt leaked into the assistant's final message verbatim.
 */
export function isTemplateOriginSummary(summary: string | null | undefined): boolean {
  if (!summary || typeof summary !== 'string') return false;
  const trimmed = summary.trim();
  if (trimmed.length === 0) return false;

  // The OpenSpec change path is the most common and highest-signal leak.
  if (/openspec\/changes\//i.test(trimmed)) return true;

  // Reuse the multilingual workflow anchors so legacy summaries written
  // before ingestion-side filtering existed are also filtered at recall.
  for (const marker of MULTILINGUAL_TEMPLATE_MARKERS) {
    if (marker.test(trimmed)) return true;
  }

  // Harness `<command-name>` tag fragments sometimes survive into summary
  // compression output.
  if (/<command-name>|<command-args>|<command-message>/i.test(trimmed)) return true;

  return false;
}

/**
 * Multilingual anchor regexes for every built-in prompt template IM.codes
 * auto-sends on behalf of the user. Each marker is a short, distinctive
 * substring chosen to not collide with ordinary prose in its language.
 *
 * Grouped by template for auditability; when a template is added or its
 * wording changes in `web/src/i18n/locales/*.json`, update the matching
 * group here. Add a test case in
 * `test/shared/template-prompt-patterns.test.ts` for each new language.
 */
const MULTILINGUAL_TEMPLATE_MARKERS: readonly RegExp[] = [
  // ── openspec.implement_prompt ─────────────────────────────────────────
  /\bDrive the implementation of\b/i, // en
  /强力推进/, // zh-CN
  /強力推進/, // zh-TW
  /\bImpulsa con firmeza la implementación\b/i, // es
  /Жестко доведи реализацию/i, // ru
  /の実装を強力に前進させてください/, // ja
  /구현을 강하게 밀어붙이세요/, // ko

  // ── openspec.audit_implementation_prompt ──────────────────────────────
  /\bPerform a strict implementation audit\b/i, // en
  /执行严格的实现审计/, // zh-CN
  /執行嚴格的實作審計/, // zh-TW
  /\bRealiza una auditoría estricta de la implementación\b/i, // es
  /Проведи строгий аудит реализации/i, // ru
  /厳格な実装監査を実施してください/, // ja
  /엄격한 구현 감사를 수행하세요/, // ko

  // ── openspec.audit_spec_prompt ────────────────────────────────────────
  /\bPerform a strict specification audit\b/i, // en
  /执行严格的规范审计/, // zh-CN
  /執行嚴格的規格審計/, // zh-TW
  /\bRealiza una auditoría estricta de la especificación\b/i, // es
  /Проведи строгий аудит спецификации/i, // ru
  /厳格な仕様監査を実施してください/, // ja
  /엄격한 명세 감사를 수행하세요/, // ko

  // ── openspec.propose_from_discussion_prompt ───────────────────────────
  /\bGenerate an OpenSpec change from the recent discussion\b/i, // en
  /根据最近的讨论生成一个 OpenSpec 变更/, // zh-CN
  /根據最近的討論生成一個 OpenSpec 變更/, // zh-TW
  /\bGenera un cambio de OpenSpec a partir de la discusión\b/i, // es
  /Сгенерируй изменение OpenSpec на основе недавнего обсуждения/i, // ru
  /直近の議論から OpenSpec 変更を生成してください/, // ja
  /최근 논의를 바탕으로 OpenSpec 변경을 생성하세요/, // ko

  // ── openspec.propose_from_description_prompt ──────────────────────────
  /\bGenerate an OpenSpec change from the description\b/i, // en
  /根据下面的描述生成一个 OpenSpec 变更/, // zh-CN
  /根據下面的描述生成一個 OpenSpec 變更/, // zh-TW
  /\bGenera un cambio de OpenSpec a partir de la descripción\b/i, // es
  /Сгенерируй изменение OpenSpec на основе описания/i, // ru
  /OpenSpec 変更を生成してください/, // ja
  /설명을 바탕으로 OpenSpec 변경을 생성하세요/, // ko

  // ── openspec.achieve_prompt ───────────────────────────────────────────
  /\busing the full OpenSpec workflow\b/i, // en
  /按完整 OpenSpec 工作流/, // zh-CN
  /依照完整 OpenSpec 工作流程/, // zh-TW
  /\busando el flujo completo de OpenSpec\b/i, // es
  /по полному процессу OpenSpec/i, // ru
  /完全な OpenSpec ワークフロー/, // ja
  /전체 OpenSpec 워크플로/, // ko

  // ── p2p.post_summary_execute_prompt ───────────────────────────────────
  /\bThe P2P discussion is complete\b/i, // en
  /P2P 讨论已经完成/, // zh-CN
  /P2P 討論已完成/, // zh-TW
  /\bLa discusión P2P ha terminado\b/i, // es
  /P2P-обсуждение завершено/i, // ru
  /P2P議論は完了しました/, // ja
  /P2P 토론이 완료되었습니다/, // ko

  // ── p2p.final_original_request_reminder ───────────────────────────────
  /\bAfter synthesizing the discussion\b/i, // en
  /在完成讨论综合后/, // zh-CN
  /在完成討論綜合後/, // zh-TW
  /\bNo te quedes solo en el resumen de la discusión\b/i, // es
  /Не ограничивайся только сводкой обсуждения/i, // ru
  /議論の要約だけで終わらせず/, // ja
  /토론 요약으로 끝내지 말고/, // ko

  // ── shared/p2p-modes.ts — P2P_BASELINE_PROMPT ─────────────────────────
  /\bstaff-level engineer participating in a multi-agent\b/i,

  // ── shared/p2p-modes.ts — roundPrompt() output ────────────────────────
  /\[Round \d+\/\d+\b/, // round phase header
  /\bProvide your initial analysis based on the original request\b/i,
  /\bReview ALL previous rounds' findings above\b/i,

  // ── Generic explicit workflow phrases (non-locale-specific fallbacks) ─
  /\bArchive(?:s|d)? (?:a |the )?completed (?:OpenSpec )?change\b/i,
  /\bPropose a new (?:OpenSpec )?change\b/i,
  /\bImplement tasks from an? OpenSpec change\b/i,
  /\bEnter explore mode\b/i,
];

/**
 * First-token slash command names to treat as template invocations.
 * Kept as a `Set` for O(1) membership checks.
 */
const SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set([
  '/loop',
  '/schedule',
  '/review',
  '/security-review',
  '/init',
  '/doctor',
  '/clear',
  '/compact',
  '/config',
  '/model',
  '/help',
  '/status',
  '/exit',
  '/plan',
  '/hooks',
  '/mcp',
  '/agents',
  '/cost',
  '/memory',
  '/permissions',
  '/rewind',
  '/resume',
  '/export',
  '/statusline',
  '/ide',
  '/pr_comments',
  '/upgrade',
  '/output-style',
  '/compactify',
  '/bashes',
  '/add-dir',
  '/bug',
  '/feedback',
  '/release-notes',
  '/vim',
  '/migrate-installer',
  '/install-github-app',
]);

/**
 * Exposed for tests that want to extend or audit the slash-command allowlist.
 */
export function listKnownSlashCommands(): readonly string[] {
  return Array.from(SLASH_COMMAND_NAMES);
}
