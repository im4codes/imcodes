import { describe, it } from 'vitest';
import { marked } from 'marked';

describe('Debug Marked', () => {
  it('shows tokens', () => {
    const text = "Visit https://example.com/some/path";
    const tokens = marked.lexer(text);
    console.log('TOKENS:', JSON.stringify(tokens, null, 2));
  });
});
