/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskQuestionDialog, resolveAskQuestionSource, type PendingQuestion } from '../../src/components/AskQuestionDialog.js';

const translations: Record<string, string> = {
  'askQuestion.waiting': '正在等待你的回答，模型会在 {{seconds}} 秒后自行继续。',
  'askQuestion.fromTab': '来自标签页',
  'askQuestion.fromSubSession': '来自子会话',
  'askQuestion.goToSession': '查看对话',
  'askQuestion.retained': '模型已经继续运行；你仍可在 {{seconds}} 秒内用这个回答打断它。',
  'askQuestion.customPlaceholder': '自定义/补充（可选）',
  'askQuestion.answerPlaceholder': '输入你的回答',
  'askQuestion.dismiss': '关闭',
  'askQuestion.answer': '回答',
  'askQuestion.interrupt': '用此回答打断',
  'openspec.auto.ask.header': 'OpenSpec 自动交付',
  'openspec.auto.ask.needs_human_question': '自动交付需要人工处理：{{reason}} 这个会话接下来要怎么做？',
  'openspec.auto.ask.review_continue': '查看失败原因并手动继续',
  'openspec.auto.ask.review_continue_desc': '发送指令，让代理检查已停止的自动交付、修复问题并回报结果。',
  'openspec.auto.ask.stop_summarize': '停在这里并总结当前状态',
  'openspec.auto.ask.stop_summarize_desc': '让代理停止当前工作，并给出简短交接说明。',
  'openspec.auto.reason.out_of_band_target_session_input': 'Auto Deliver 运行期间执行会话收到了人工输入。',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = translations[key] ?? String(opts?.defaultValue ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(opts?.[name] ?? ''));
    },
  }),
}));

function makePending(): PendingQuestion {
  return {
    sessionName: 'deck_sub_1',
    toolUseId: 'run-1:needs-human:1',
    waitMs: 300_000,
    questions: [{
      header: 'OpenSpec Auto Deliver',
      question: 'Auto Deliver stopped with reason "out_of_band_target_session_input". What should happen next in this session?',
      options: [
        {
          label: 'Review the failure and continue manually',
          description: 'Send an instruction to inspect the stopped run, fix the issue, and report back.',
        },
        {
          label: 'Stop here and summarize the current state',
          description: 'Ask the agent to stop active work and provide a concise handoff.',
        },
      ],
    }],
  };
}

describe('AskQuestionDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('localizes Auto Deliver handoff questions and hides machine reason codes', () => {
    render(<AskQuestionDialog pending={makePending()} onDismiss={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByText('OpenSpec 自动交付')).toBeTruthy();
    expect(screen.getByText(/自动交付需要人工处理/)).toBeTruthy();
    expect(screen.getByText(/执行会话收到了人工输入/)).toBeTruthy();
    expect(screen.getByText('查看失败原因并手动继续')).toBeTruthy();
    expect(screen.getByText('停在这里并总结当前状态')).toBeTruthy();
    expect(screen.getByPlaceholderText('自定义/补充（可选）')).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '回答' })).toBeTruthy();
    expect(screen.queryByText(/out_of_band_target_session_input/)).toBeNull();
    expect(screen.queryByText(/Review the failure/)).toBeNull();
  });

  it('does not submit while an IME is composing, but submits on a normal Enter afterward', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionDialog pending={makePending()} onDismiss={vi.fn()} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText('自定义/补充（可选）');

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false });
    expect(onSubmit).toHaveBeenCalledWith('[OpenSpec 自动交付] skip');
  });

  it('submits the localized option text shown to the user', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionDialog pending={makePending()} onDismiss={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByLabelText(/查看失败原因并手动继续/));
    fireEvent.click(screen.getByRole('button', { name: '回答' }));

    expect(onSubmit).toHaveBeenCalledWith('[OpenSpec 自动交付] 查看失败原因并手动继续');
  });

  it('displays main tab source label and handles Go to chat without dismissing', () => {
    const onJumpToSession = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AskQuestionDialog
        pending={{ ...makePending(), sessionName: 'deck_beta_brain' }}
        sourceLabel="Beta Repo"
        sourceKind="tab"
        onJumpToSession={onJumpToSession}
        onDismiss={onDismiss}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('来自标签页')).toBeTruthy();
    expect(screen.getByText('Beta Repo')).toBeTruthy();
    const jumpBtn = screen.getByRole('button', { name: '查看对话' });
    fireEvent.click(jumpBtn);
    expect(onJumpToSession).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('displays parent › sub-session source label and handles missing parent cleanly', () => {
    const { rerender } = render(
      <AskQuestionDialog
        pending={makePending()}
        sourceLabel="Worker Alpha"
        sourceParentLabel="Main Tab"
        sourceKind="subsession"
        onDismiss={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('来自子会话')).toBeTruthy();
    expect(screen.getByText('Main Tab › Worker Alpha')).toBeTruthy();

    rerender(
      <AskQuestionDialog
        pending={makePending()}
        sourceLabel="Worker Alpha"
        sourceKind="subsession"
        onDismiss={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText('Worker Alpha')).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('resolveAskQuestionSource prefers readable labels/projects and falls back gracefully without undefined', () => {
    const sessions = [
      { name: 'deck_alpha_brain', label: 'Alpha Tab', project: 'alpha-repo' },
      { name: 'deck_beta_brain', label: null, project: 'beta-repo' },
      { name: 'deck_raw_brain', label: null, project: null },
    ];
    const subSessions = [
      { sessionName: 'deck_sub_1', label: 'Reviewer', parentSession: 'deck_alpha_brain' },
      { sessionName: 'deck_sub_2', label: null, parentSession: 'deck_missing_brain' },
    ];

    expect(resolveAskQuestionSource('deck_alpha_brain', sessions, subSessions)).toEqual({
      kind: 'tab',
      label: 'Alpha Tab',
    });
    expect(resolveAskQuestionSource('deck_beta_brain', sessions, subSessions)).toEqual({
      kind: 'tab',
      label: 'beta-repo',
    });
    expect(resolveAskQuestionSource('deck_raw_brain', sessions, subSessions)).toEqual({
      kind: 'tab',
      label: 'Brain',
    });
    expect(resolveAskQuestionSource('deck_sub_1', sessions, subSessions)).toEqual({
      kind: 'subsession',
      label: 'Reviewer',
      parentLabel: 'Alpha Tab',
    });
    expect(resolveAskQuestionSource('deck_sub_2', sessions, subSessions)).toEqual({
      kind: 'subsession',
      label: 'Worker',
    });
  });

  it('renders indicator + stacked content wrapper and updates selected visual class on label/description click', () => {
    const onSubmit = vi.fn();
    const pending: PendingQuestion = {
      sessionName: 'deck_sub_1',
      toolUseId: 'tu-dialog-multi',
      waitMs: 300_000,
      questions: [
        {
          header: 'Single',
          question: 'Pick one',
          options: [
            { label: 'One', description: 'First detail' },
            { label: 'Two', description: 'Second detail' },
          ],
        },
        {
          header: 'Multi',
          question: 'Pick many',
          multiSelect: true,
          options: [
            { label: 'Red', description: 'Warm' },
            { label: 'Blue', description: 'Cool' },
          ],
        },
      ],
    };

    const { container } = render(<AskQuestionDialog pending={pending} onDismiss={vi.fn()} onSubmit={onSubmit} />);
    const options = Array.from(container.querySelectorAll('label.ask-option'));
    expect(options.length).toBe(4);
    expect(options[0]!.querySelector('.ask-option-indicator.is-radio')).not.toBeNull();
    expect(options[2]!.querySelector('.ask-option-indicator.is-checkbox')).not.toBeNull();
    expect(options[0]!.querySelector('.ask-option-content .ask-option-label')).not.toBeNull();
    expect(options[0]!.querySelector('.ask-option-content .ask-option-desc')).not.toBeNull();

    fireEvent.click(screen.getByText('Second detail'));
    expect(options[1]!.classList.contains('ask-option-selected')).toBe(true);
    expect(options[0]!.classList.contains('ask-option-selected')).toBe(false);

    fireEvent.click(screen.getByText('Red'));
    fireEvent.click(screen.getByText('Blue'));
    expect(options[2]!.classList.contains('ask-option-selected')).toBe(true);
    expect(options[3]!.classList.contains('ask-option-selected')).toBe(true);

    fireEvent.click(screen.getByText('Red'));
    expect(options[2]!.classList.contains('ask-option-selected')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    expect(onSubmit).toHaveBeenCalledWith('[Single] Two\n[Multi] Blue');
  });
});
