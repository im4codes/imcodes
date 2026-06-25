/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskQuestionDialog, type PendingQuestion } from '../../src/components/AskQuestionDialog.js';

const translations: Record<string, string> = {
  'askQuestion.waiting': '正在等待你的回答，模型会在 {{seconds}} 秒后自行继续。',
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

  it('submits the localized option text shown to the user', () => {
    const onSubmit = vi.fn();
    render(<AskQuestionDialog pending={makePending()} onDismiss={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByLabelText(/查看失败原因并手动继续/));
    fireEvent.click(screen.getByRole('button', { name: '回答' }));

    expect(onSubmit).toHaveBeenCalledWith('[OpenSpec 自动交付] 查看失败原因并手动继续');
  });
});
