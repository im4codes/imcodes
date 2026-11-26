import { describe, expect, it } from 'vitest';
import {
  canonicalAskQuestionToolName,
  extractAskQuestionsFromToolCallPayload,
  extractAskQuestionsFromToolName,
  isAskQuestionToolName,
  normalizeAskQuestionsPayload,
  parseAskQuestionAnswers,
} from '../shared/ask-question-normalize.js';

describe('shared ask-question normalization', () => {
  it('canonicalizes exact and Antigravity ACP AskUserQuestion / ask_question tool names', () => {
    expect(canonicalAskQuestionToolName('AskUserQuestion')).toBe('AskUserQuestion');
    expect(canonicalAskQuestionToolName('ask_question')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('Run ask_question')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('run ask_question')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('Run AskUserQuestion')).toBe('AskUserQuestion');
    expect(canonicalAskQuestionToolName('default_api:ask_question')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('Run default_api:ask_question')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('DEFAULT_API:ask_question')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('Run ask_question {"question":"Proceed?"}')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('Run ask_question{"is_multi_select":false,"options":["A","B"],"question":"Pick?"}')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('Run default_api:ask_question {"questions":[{"question":"Q"}]}')).toBe('ask_question');

    expect(isAskQuestionToolName('Run ask_question')).toBe(true);
    expect(isAskQuestionToolName('default_api:ask_question')).toBe(true);
    expect(isAskQuestionToolName('Run ask_question {"question":"Q"}')).toBe(true);
  });

  it('rejects shell commands, substrings, suffixed names, and non-strings', () => {
    for (const candidate of [
      'Run echo ask_question',
      'Run cat ask_question.json',
      'Bash',
      'Read ask_question.ts',
      'ask_question_v2',
      'ask_question_helper',
      '{"question":"Bare json"}',
      '',
      '   ',
      null,
      undefined,
      123,
    ]) {
      expect(canonicalAskQuestionToolName(candidate)).toBeNull();
      expect(isAskQuestionToolName(candidate)).toBe(false);
    }
  });

  it('extracts inline JSON questions from ACP tool title only when structured input yields none', () => {
    const inlineTool = 'Run ask_question {"is_multi_select":false,"options":["Alpha","Beta"],"question":"Pick env?"}';
    expect(extractAskQuestionsFromToolName(inlineTool)).toEqual([{
      question: 'Pick env?',
      multiSelect: false,
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
    }]);

    expect(extractAskQuestionsFromToolCallPayload({ tool: inlineTool })).toEqual([{
      question: 'Pick env?',
      multiSelect: false,
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
    }]);

    // Structured input takes precedence over inline JSON
    expect(extractAskQuestionsFromToolCallPayload({
      tool: inlineTool,
      input: { question: 'Structured wins?', options: ['Yes'] },
    })).toEqual([{
      question: 'Structured wins?',
      options: [{ label: 'Yes' }],
    }]);

    // Non-ask_question tool never extracts inline JSON
    expect(extractAskQuestionsFromToolName('Run echo {"question":"fake"}')).toEqual([]);
    expect(extractAskQuestionsFromToolCallPayload({ tool: 'Run echo {"question":"fake"}' })).toEqual([]);
  });

  it('canonicalizes ask_user, ask_user_question, and request_user_input while rejecting lookalikes', () => {
    expect(canonicalAskQuestionToolName('ask_user')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('ask_user_question')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('request_user_input')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('Run ask_user')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('default_api:request_user_input')).toBe('ask_question');
    expect(canonicalAskQuestionToolName('Run ask_user {"question":"Proceed?"}')).toBe('ask_question');

    for (const candidate of [
      'Run echo ask_user',
      'ask_user_helper',
      'request_user_input_v2',
      'ask_user_question_tool',
    ]) {
      expect(canonicalAskQuestionToolName(candidate)).toBeNull();
      expect(isAskQuestionToolName(candidate)).toBe(false);
    }
  });

  it('normalizes OpenCode multiple + Copilot choices and parses ordered answers', () => {
    expect(normalizeAskQuestionsPayload([
      {
        question: 'Select modules',
        header: 'Modules',
        multiple: true,
        options: [{ label: 'Web', description: 'UI' }, { label: 'Daemon', description: 'Core' }],
      },
      {
        question: 'Choose runtime',
        choices: ['Local', 'Cloud'],
      },
    ])).toEqual([
      {
        question: 'Select modules',
        header: 'Modules',
        multiSelect: true,
        options: [{ label: 'Web', description: 'UI' }, { label: 'Daemon', description: 'Core' }],
      },
      {
        question: 'Choose runtime',
        options: [{ label: 'Local' }, { label: 'Cloud' }],
      },
    ]);

    expect(parseAskQuestionAnswers(
      [
        { header: 'Modules', multiSelect: true },
        { header: 'Env', multiSelect: false },
        { header: 'Optional' },
      ],
      '[Modules] Web, Daemon\n[Env] Prod, US-East\n[Optional] skip',
    )).toEqual([
      ['Web', 'Daemon'],
      ['Prod, US-East'],
      [],
    ]);
  });
});
