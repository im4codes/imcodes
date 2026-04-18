import { describe, expect, it } from 'vitest';
import {
  isTemplatePrompt,
  isTemplateOriginSummary,
  isImperativeCommand,
  listKnownSlashCommands,
} from '../../shared/template-prompt-patterns.js';

describe('isTemplatePrompt', () => {
  // ── OpenSpec path references in prose ────────────────────────────────
  // Bare AND @-prefixed openspec/changes/... references are NOT enough to
  // flag a prompt as template. Users reference their own specs naturally
  // while debugging. Only workflow phrases + command tags + slash commands
  // + namespaced skills trigger the filter. Tests below guard against
  // regressions into over-aggressive path matching.

  it('does NOT flag bare openspec/changes/<slug> mentions', () => {
    expect(isTemplatePrompt('openspec/changes/shared-agent-context has a bug in the spec')).toBe(false);
  });

  it('does NOT flag @openspec/changes/<slug> mentions (user debugging style)', () => {
    // Real user pattern: reference a spec with @, then ask a real question.
    expect(
      isTemplatePrompt('@openspec/changes/chatview-unified-file-change-diff 我也会这样发消息, 这样也会过滤吗!?'),
    ).toBe(false);
  });

  it('does NOT flag inline mentions of openspec paths in debugging prose', () => {
    expect(
      isTemplatePrompt(
        'openspec/changes/cursor-copilot-transport-providers — copilot and cursor SDKs still show "Terminal stream unavailable". Can you investigate?',
      ),
    ).toBe(false);
  });

  it('does NOT flag inline "see openspec/changes/..." references in prose', () => {
    expect(isTemplatePrompt('See openspec/changes/shared-agent-context/proposal.md for details, any issues with rollout?')).toBe(false);
  });

  it('still flags openspec references when combined with a workflow verb', () => {
    // The workflow-phrase marker catches this, not any path regex
    expect(
      isTemplatePrompt('Drive the implementation of @openspec/changes/x aggressively.'),
    ).toBe(true);
  });

  // ── Workflow imperatives ─────────────────────────────────────────────
  it('flags "Drive the implementation of" workflow preamble', () => {
    expect(isTemplatePrompt('Drive the implementation of my-change aggressively.')).toBe(true);
  });

  it('flags "Archive a completed change" workflow preamble', () => {
    expect(isTemplatePrompt('Archive a completed change in the experimental workflow.')).toBe(true);
  });

  it('flags "Propose a new change" workflow preamble', () => {
    expect(isTemplatePrompt('Propose a new change for the memory filter.')).toBe(true);
  });

  it('flags "Implement tasks from an OpenSpec change" workflow preamble', () => {
    expect(isTemplatePrompt('Implement tasks from an OpenSpec change.')).toBe(true);
  });

  it('flags "Enter explore mode" workflow preamble', () => {
    expect(isTemplatePrompt('Enter explore mode - think through ideas')).toBe(true);
  });

  // ── Harness command tags ─────────────────────────────────────────────
  it('flags <command-name> tags', () => {
    expect(isTemplatePrompt('Some text with <command-name>foo</command-name> embedded')).toBe(true);
  });

  it('flags <command-args> tags', () => {
    expect(isTemplatePrompt('<command-args>bar</command-args>')).toBe(true);
  });

  it('flags <command-message> tags', () => {
    expect(isTemplatePrompt('<command-message>test</command-message>')).toBe(true);
  });

  // ── Slash commands ───────────────────────────────────────────────────
  it('flags /loop as a slash command', () => {
    expect(isTemplatePrompt('/loop 5m /foo')).toBe(true);
  });

  it('flags /schedule as a slash command', () => {
    expect(isTemplatePrompt('/schedule list')).toBe(true);
  });

  it('flags /review as a slash command', () => {
    expect(isTemplatePrompt('/review')).toBe(true);
  });

  it('flags /init as a slash command', () => {
    expect(isTemplatePrompt('/init')).toBe(true);
  });

  it('flags case-insensitive slash commands', () => {
    expect(isTemplatePrompt('/Review extra args')).toBe(true);
  });

  // ── Multilingual built-in quick-action templates ────────────────────
  // These are sent verbatim by the web UI (see `web/src/i18n/locales/*.json`
  // keys `openspec.*_prompt` and `p2p.*_prompt`). Every locale must be
  // caught or the filter leaks in non-English contexts.

  describe('openspec.implement_prompt across 7 locales', () => {
    it('en', () => {
      expect(isTemplatePrompt('Drive the implementation of my-change aggressively.')).toBe(true);
    });
    it('zh-CN', () => {
      expect(
        isTemplatePrompt('强力推进 openspec/changes/foo 的实施。把工作拆成明确子任务。'),
      ).toBe(true);
    });
    it('zh-TW', () => {
      expect(
        isTemplatePrompt('強力推進 openspec/changes/foo 的實作。把工作拆成明確子任務。'),
      ).toBe(true);
    });
    it('es', () => {
      expect(
        isTemplatePrompt('Impulsa con firmeza la implementación de la propuesta.'),
      ).toBe(true);
    });
    it('ru', () => {
      expect(isTemplatePrompt('Жестко доведи реализацию изменения до конца.')).toBe(true);
    });
    it('ja', () => {
      expect(isTemplatePrompt('この変更の実装を強力に前進させてください。')).toBe(true);
    });
    it('ko', () => {
      expect(isTemplatePrompt('이 변경의 구현을 강하게 밀어붙이세요.')).toBe(true);
    });
  });

  describe('openspec.audit_implementation_prompt across 7 locales', () => {
    it('en', () => {
      expect(isTemplatePrompt('Perform a strict implementation audit for x.')).toBe(true);
    });
    it('zh-CN', () => {
      expect(isTemplatePrompt('对 x 执行严格的实现审计，逐项对照。')).toBe(true);
    });
    it('zh-TW', () => {
      expect(isTemplatePrompt('對 x 執行嚴格的實作審計，逐項對照。')).toBe(true);
    });
    it('es', () => {
      expect(isTemplatePrompt('Realiza una auditoría estricta de la implementación.')).toBe(true);
    });
    it('ru', () => {
      expect(isTemplatePrompt('Проведи строгий аудит реализации.')).toBe(true);
    });
    it('ja', () => {
      expect(isTemplatePrompt('厳格な実装監査を実施してください。')).toBe(true);
    });
    it('ko', () => {
      expect(isTemplatePrompt('엄격한 구현 감사를 수행하세요.')).toBe(true);
    });
  });

  describe('openspec.audit_spec_prompt across 7 locales', () => {
    it('en', () => {
      expect(isTemplatePrompt('Perform a strict specification audit for y.')).toBe(true);
    });
    it('zh-CN', () => {
      expect(isTemplatePrompt('对 y 执行严格的规范审计。')).toBe(true);
    });
    it('zh-TW', () => {
      expect(isTemplatePrompt('對 y 執行嚴格的規格審計。')).toBe(true);
    });
    it('es', () => {
      expect(isTemplatePrompt('Realiza una auditoría estricta de la especificación.')).toBe(true);
    });
    it('ru', () => {
      expect(isTemplatePrompt('Проведи строгий аудит спецификации.')).toBe(true);
    });
    it('ja', () => {
      expect(isTemplatePrompt('厳格な仕様監査を実施してください。')).toBe(true);
    });
    it('ko', () => {
      expect(isTemplatePrompt('엄격한 명세 감사를 수행하세요.')).toBe(true);
    });
  });

  describe('openspec.propose_from_discussion_prompt across 7 locales', () => {
    it('en', () => {
      expect(isTemplatePrompt('Generate an OpenSpec change from the recent discussion.')).toBe(
        true,
      );
    });
    it('zh-CN', () => {
      expect(isTemplatePrompt('根据最近的讨论生成一个 OpenSpec 变更。')).toBe(true);
    });
    it('zh-TW', () => {
      expect(isTemplatePrompt('根據最近的討論生成一個 OpenSpec 變更。')).toBe(true);
    });
    it('es', () => {
      expect(isTemplatePrompt('Genera un cambio de OpenSpec a partir de la discusión reciente.')).toBe(
        true,
      );
    });
    it('ru', () => {
      expect(
        isTemplatePrompt('Сгенерируй изменение OpenSpec на основе недавнего обсуждения.'),
      ).toBe(true);
    });
    it('ja', () => {
      expect(isTemplatePrompt('直近の議論から OpenSpec 変更を生成してください。')).toBe(true);
    });
    it('ko', () => {
      expect(isTemplatePrompt('최근 논의를 바탕으로 OpenSpec 변경을 생성하세요.')).toBe(true);
    });
  });

  describe('openspec.achieve_prompt across 7 locales', () => {
    it('en', () => {
      expect(
        isTemplatePrompt('Take my-change to done using the full OpenSpec workflow.'),
      ).toBe(true);
    });
    it('zh-CN', () => {
      expect(isTemplatePrompt('按完整 OpenSpec 工作流把变更推到完成。')).toBe(true);
    });
    it('zh-TW', () => {
      expect(isTemplatePrompt('依照完整 OpenSpec 工作流程把變更推到完成。')).toBe(true);
    });
    it('es', () => {
      expect(isTemplatePrompt('Lleva el cambio hasta completarlo usando el flujo completo de OpenSpec.')).toBe(
        true,
      );
    });
    it('ru', () => {
      expect(isTemplatePrompt('Доведи изменение до состояния done по полному процессу OpenSpec.')).toBe(
        true,
      );
    });
    it('ja', () => {
      expect(isTemplatePrompt('完全な OpenSpec ワークフローで変更を done まで持っていってください。')).toBe(true);
    });
    it('ko', () => {
      expect(isTemplatePrompt('전체 OpenSpec 워크플로로 변경을 완료 상태까지 밀어붙이세요.')).toBe(true);
    });
  });

  describe('p2p.post_summary_execute_prompt across 7 locales', () => {
    it('en', () => {
      expect(isTemplatePrompt('The P2P discussion is complete. Use the discussion file.')).toBe(
        true,
      );
    });
    it('zh-CN', () => {
      expect(isTemplatePrompt('P2P 讨论已经完成。请把讨论文件作为上下文。')).toBe(true);
    });
    it('zh-TW', () => {
      expect(isTemplatePrompt('P2P 討論已完成。請把討論檔案作為上下文。')).toBe(true);
    });
    it('es', () => {
      expect(isTemplatePrompt('La discusión P2P ha terminado.')).toBe(true);
    });
    it('ru', () => {
      expect(isTemplatePrompt('P2P-обсуждение завершено.')).toBe(true);
    });
    it('ja', () => {
      expect(isTemplatePrompt('P2P議論は完了しました。')).toBe(true);
    });
    it('ko', () => {
      expect(isTemplatePrompt('P2P 토론이 완료되었습니다.')).toBe(true);
    });
  });

  describe('p2p.final_original_request_reminder across 7 locales', () => {
    it('en', () => {
      expect(
        isTemplatePrompt(
          "After synthesizing the discussion, directly address the user's original request.",
        ),
      ).toBe(true);
    });
    it('zh-CN', () => {
      expect(isTemplatePrompt('在完成讨论综合后，务必直接落实。')).toBe(true);
    });
    it('zh-TW', () => {
      expect(isTemplatePrompt('在完成討論綜合後，務必直接落實。')).toBe(true);
    });
    it('es', () => {
      expect(isTemplatePrompt('No te quedes solo en el resumen de la discusión.')).toBe(true);
    });
    it('ru', () => {
      expect(isTemplatePrompt('Не ограничивайся только сводкой обсуждения.')).toBe(true);
    });
    it('ja', () => {
      expect(isTemplatePrompt('議論の要約だけで終わらせず、実行してください。')).toBe(true);
    });
    it('ko', () => {
      expect(isTemplatePrompt('토론 요약으로 끝내지 말고 실행하세요.')).toBe(true);
    });
  });

  describe('P2P baseline prompt + round headers', () => {
    it('flags the shared P2P baseline prompt', () => {
      expect(
        isTemplatePrompt(
          'You are a staff-level engineer participating in a multi-agent technical discussion.',
        ),
      ).toBe(true);
    });
    it('flags [Round N/M — Phase — Initial Analysis] headers', () => {
      expect(
        isTemplatePrompt(
          '[Round 1/3 — Audit Phase — Initial Analysis]\nProvide your initial analysis based on the original request.',
        ),
      ).toBe(true);
    });
    it('flags [Round N/M — Deepening] round headers', () => {
      expect(isTemplatePrompt("[Round 2/3 — Deepening]\nReview ALL previous rounds' findings above.")).toBe(
        true,
      );
    });
  });

  // ── Plugin-namespaced skills ────────────────────────────────────────
  it('flags claude-mem:do', () => {
    expect(isTemplatePrompt('claude-mem:do run the plan')).toBe(true);
  });

  it('flags opsx:apply', () => {
    expect(isTemplatePrompt('opsx:apply the change')).toBe(true);
  });

  it('flags openspec-archive-change', () => {
    expect(isTemplatePrompt('openspec-archive-change:run')).toBe(true);
  });

  // ── Negative cases ───────────────────────────────────────────────────
  it('accepts normal natural-language questions', () => {
    expect(isTemplatePrompt('How do I fix the download bug?')).toBe(false);
  });

  it('accepts Chinese natural-language questions', () => {
    expect(isTemplatePrompt('帮我修一下下载的 bug 好不好')).toBe(false);
  });

  it('accepts prose that mentions "change" without the workflow phrase', () => {
    expect(isTemplatePrompt('I want to change the color of this button.')).toBe(false);
  });

  it('accepts prose that mentions "implement" without the workflow phrase', () => {
    expect(isTemplatePrompt('Please implement the sorting algorithm we discussed.')).toBe(false);
  });

  it('accepts prose with /path/like/slashes that are not slash commands', () => {
    expect(isTemplatePrompt('look at /src/agent/detect.ts for the answer')).toBe(false);
  });

  it('accepts empty / null / undefined without throwing', () => {
    expect(isTemplatePrompt('')).toBe(false);
    expect(isTemplatePrompt(null)).toBe(false);
    expect(isTemplatePrompt(undefined)).toBe(false);
    expect(isTemplatePrompt('   \n   \t  ')).toBe(false);
  });

  it('accepts prose that references a repo path containing "changes"', () => {
    expect(isTemplatePrompt('look at changes/not-openspec/foo.ts')).toBe(false);
  });
});

describe('isTemplateOriginSummary', () => {
  it('does NOT flag summaries that mention openspec paths in prose', () => {
    // Real debugging summaries may legitimately reference spec paths while
    // discussing unrelated code/bugs — they should still be recallable.
    // Both bare and @-prefixed mentions are treated as debugging references.
    expect(
      isTemplateOriginSummary(
        '## Project\n- User problem: copilot SDK fails with "Terminal stream unavailable"\n- Resolution: referenced openspec/changes/cursor-copilot-transport-providers during debugging; fixed by restarting pane.',
      ),
    ).toBe(false);
    expect(
      isTemplateOriginSummary('User debugging @openspec/changes/feature-x behavior with a question.'),
    ).toBe(false);
  });

  it('flags summaries with "Drive the implementation of"', () => {
    expect(isTemplateOriginSummary('## Summary\n- Drive the implementation of change X')).toBe(
      true,
    );
  });

  it('flags summaries with "Archived a completed change"', () => {
    expect(isTemplateOriginSummary('Archived the completed change.')).toBe(true);
  });

  it('flags summaries with residual <command-name> fragments', () => {
    expect(isTemplateOriginSummary('Resolved <command-name>loop</command-name> request.')).toBe(
      true,
    );
  });

  it('accepts normal problem→solution summaries', () => {
    expect(
      isTemplateOriginSummary(
        '## codedeck\n- User problem: download cancel dropped connection.\n- Resolution: added AbortController pass-through.',
      ),
    ).toBe(false);
  });

  it('accepts empty / null / undefined without throwing', () => {
    expect(isTemplateOriginSummary('')).toBe(false);
    expect(isTemplateOriginSummary(null)).toBe(false);
    expect(isTemplateOriginSummary(undefined)).toBe(false);
  });
});

describe('listKnownSlashCommands', () => {
  it('exposes a non-empty list for auditing', () => {
    const list = listKnownSlashCommands();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list).toContain('/loop');
    expect(list).toContain('/schedule');
  });
});

describe('isImperativeCommand', () => {
  // The real user bug: "commit&push" got through the <10-char + template
  // filter and triggered a full semantic recall, polluting results with the
  // current task's own logs.
  it('flags "commit&push" as an imperative command', () => {
    expect(isImperativeCommand('commit&push')).toBe(true);
  });

  it('flags compound slash/ampersand/plus verb pairs', () => {
    expect(isImperativeCommand('commit+push')).toBe(true);
    expect(isImperativeCommand('commit&push&deploy')).toBe(true);
    expect(isImperativeCommand('push/restart')).toBe(true);
  });

  it('flags single-verb imperatives that are unambiguous ops verbs', () => {
    expect(isImperativeCommand('commit')).toBe(true);
    expect(isImperativeCommand('deploy')).toBe(true);
    expect(isImperativeCommand('redeploy')).toBe(true);
    expect(isImperativeCommand('continue')).toBe(true);
    expect(isImperativeCommand('proceed')).toBe(true);
    expect(isImperativeCommand('restart')).toBe(true);
    expect(isImperativeCommand('ok')).toBe(true);
    expect(isImperativeCommand('yes')).toBe(true);
  });

  it('flags short multi-token imperatives up to MAX_TOKENS when every non-connector token is a verb', () => {
    expect(isImperativeCommand('ok continue')).toBe(true);
    expect(isImperativeCommand('yes proceed')).toBe(true);
    expect(isImperativeCommand('please commit')).toBe(true);
    expect(isImperativeCommand('commit and push')).toBe(true);
    expect(isImperativeCommand('commit then push')).toBe(true);
  });

  it('trims trailing punctuation from tokens', () => {
    expect(isImperativeCommand('commit!')).toBe(true);
    expect(isImperativeCommand('ok.')).toBe(true);
    expect(isImperativeCommand('yes, proceed.')).toBe(true);
  });

  // ── The critical regression: natural-language queries that CONTAIN a
  //    verb token must NOT be classified as imperative commands. These were
  //    getting skipped because the old "any token is a verb" rule matched
  //    the lone verb even in prose.
  it('does NOT flag natural-language queries with a verb + noun', () => {
    expect(isImperativeCommand('retry behavior')).toBe(false);
    expect(isImperativeCommand('memory test')).toBe(false);
    expect(isImperativeCommand('commit hash')).toBe(false);
    expect(isImperativeCommand('push notification')).toBe(false);
    expect(isImperativeCommand('deploy script')).toBe(false);
    expect(isImperativeCommand('restart loop')).toBe(false);
  });

  it('does NOT flag the generic placeholder query "test"', () => {
    // `test` is too ambiguous (noun vs verb) to treat as a control command.
    // The server test suite uses it as a generic probe query — we must not
    // skip recall on it.
    expect(isImperativeCommand('test')).toBe(false);
    expect(isImperativeCommand('test harness')).toBe(false);
    expect(isImperativeCommand('run the tests')).toBe(false);
  });

  it('does NOT flag natural prose whose first word happens to be a verb', () => {
    expect(isImperativeCommand('fix garbled download filename')).toBe(false);
    expect(isImperativeCommand('update the docs')).toBe(false);
    expect(isImperativeCommand('review pending PRs')).toBe(false);
    expect(isImperativeCommand('build failures on Windows')).toBe(false);
  });

  it('does NOT flag longer prose messages', () => {
    expect(
      isImperativeCommand('I just committed and pushed, anything else broken in the release pipeline?'),
    ).toBe(false); // > MAX_TOKENS
    expect(
      isImperativeCommand('Should I commit this or wait for review?'),
    ).toBe(false);
  });

  it('does NOT flag messages with non-ASCII letters (CJK / accented prose)', () => {
    // User writes in Chinese even when asking about commits — that's a real
    // semantic query and should go through recall normally.
    expect(isImperativeCommand('commit 一下')).toBe(false);
    expect(isImperativeCommand('请帮我 commit')).toBe(false);
    expect(isImperativeCommand('¿deploy a producción?')).toBe(false);
  });

  it('does NOT flag multi-line text', () => {
    expect(isImperativeCommand('commit\npush\ndeploy')).toBe(false);
  });

  it('does NOT flag unrelated short ASCII phrases', () => {
    expect(isImperativeCommand('hello world')).toBe(false);
    expect(isImperativeCommand('what is this')).toBe(false);
    expect(isImperativeCommand('foo bar baz')).toBe(false);
    expect(isImperativeCommand('websocket bug')).toBe(false);
    expect(isImperativeCommand('nonexistent topic')).toBe(false);
  });

  it('handles empty / null / undefined without throwing', () => {
    expect(isImperativeCommand('')).toBe(false);
    expect(isImperativeCommand('   ')).toBe(false);
    expect(isImperativeCommand(null)).toBe(false);
    expect(isImperativeCommand(undefined)).toBe(false);
  });
});
