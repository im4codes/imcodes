import { describe, expect, it } from 'vitest';
import {
  isTemplatePrompt,
  isTemplateOriginSummary,
  listKnownSlashCommands,
} from '../../shared/template-prompt-patterns.js';

describe('isTemplatePrompt', () => {
  // ── OpenSpec references ──────────────────────────────────────────────
  it('flags @openspec/changes/<slug> references', () => {
    expect(isTemplatePrompt('Drive @openspec/changes/my-feature to completion')).toBe(true);
  });

  it('flags bare openspec/changes/<slug> paths', () => {
    expect(isTemplatePrompt('See openspec/changes/shared-agent-context/proposal.md')).toBe(true);
  });

  it('flags openspec/changes references embedded in longer text', () => {
    expect(
      isTemplatePrompt(`Please drive the implementation of openspec/changes/x.
Many sub-tasks ahead.`),
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
  it('flags summaries that reference openspec/changes/', () => {
    expect(
      isTemplateOriginSummary('User orchestrated openspec/changes/feature-x via subagents.'),
    ).toBe(true);
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
