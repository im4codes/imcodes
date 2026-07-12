import { describe, it, expect } from 'vitest';
import { stripLeakedThink } from './strip-leaked-think.js';

describe('stripLeakedThink', () => {
  it('removes a complete <think>…</think> block', () => {
    expect(stripLeakedThink('<think>reasoning here</think>PONG')).toBe('PONG');
    expect(stripLeakedThink('<think>a</think> answer <think>b</think>!')).toBe(' answer !');
  });

  it('is case-insensitive and spans newlines', () => {
    expect(stripLeakedThink('<THINK>multi\nline\nreason</THINK>ok')).toBe('ok');
  });

  it('suppresses an unclosed block still mid-stream (drops from the open tag on)', () => {
    expect(stripLeakedThink('<think>partial reasoning so far')).toBe('');
    expect(stripLeakedThink('answer done<think>new reasoning')).toBe('answer done');
  });

  it('hides a trailing forming open tag split across frames', () => {
    expect(stripLeakedThink('hi <t')).toBe('hi ');
    expect(stripLeakedThink('hi <th')).toBe('hi ');
    expect(stripLeakedThink('hi <thi')).toBe('hi ');
    expect(stripLeakedThink('hi <think')).toBe('hi ');
  });

  it('is correct frame-by-frame on cumulative streaming text', () => {
    const full = '<think>the user wants PONG</think>PONG';
    const frames = [
      '<', '<t', '<th', '<think', '<think>', '<think>the user', '<think>the user wants PONG</think>',
      '<think>the user wants PONG</think>P', '<think>the user wants PONG</think>PONG',
    ];
    const cleaned = frames.map(stripLeakedThink);
    // Never leaks any reasoning text
    for (const c of cleaned) expect(c.includes('user') || c.includes('wants')).toBe(false);
    // The final frames reveal only the real answer
    expect(cleaned.at(-1)).toBe('PONG');
    expect(cleaned.at(-2)).toBe('P');
    // A lone leading '<' shows for one frame (we don't hide bare '<'), then the
    // forming/'<think>' tag suppresses everything until '</think>' arrives.
    expect(cleaned[0]).toBe('<');
    expect(cleaned.slice(1, 7).every((c) => c === '')).toBe(true);
    expect(stripLeakedThink(full)).toBe('PONG');
  });

  it('preserves legitimate content, including a lone trailing "<"', () => {
    expect(stripLeakedThink('hello world')).toBe('hello world');
    expect(stripLeakedThink('a < b and c > d')).toBe('a < b and c > d');
    expect(stripLeakedThink('trailing lt a <')).toBe('trailing lt a <');
    expect(stripLeakedThink('use the <b>bold</b> tag')).toBe('use the <b>bold</b> tag');
    expect(stripLeakedThink('<thanks for the help')).toBe('<thanks for the help');
  });

  it('fast-paths text with no angle bracket and handles empties', () => {
    expect(stripLeakedThink('just plain text')).toBe('just plain text');
    expect(stripLeakedThink('')).toBe('');
  });
});
