import { describe, expect, it } from 'vitest';
import { countTokens, countMessagesTokens } from '../../src/context/tokenizer.js';

describe('context tokenizer', () => {
  it('counts CJK, code, and message arrays without network access', () => {
    expect(countTokens('记忆系统升级')).toBeGreaterThan(0);
    expect(countTokens('function x(){ return 42; }')).toBeGreaterThan(0);
    expect(countMessagesTokens([{ role: 'user', content: 'hello' }])).toBeGreaterThan(countTokens('hello'));
  });
});
