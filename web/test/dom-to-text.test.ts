import { describe, it, expect } from 'vitest';
import { domNodeToPlainText } from '../src/util/dom-to-text.js';

/**
 * dom-to-text walks a DOM tree and returns plain text that preserves
 * paragraph/list/code-block boundaries. These tests pin down the contract
 * that ChatView depends on for copying assistant messages with their
 * structure intact.
 */

function makeEl(html: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  return wrapper;
}

describe('domNodeToPlainText', () => {
  it('separates consecutive paragraphs with a blank line', () => {
    const el = makeEl('<p>foo</p><p>bar</p>');
    expect(domNodeToPlainText(el)).toBe('foo\n\nbar');
  });

  it('expands <br> into newlines', () => {
    const el = makeEl('<p>line one<br>line two</p>');
    expect(domNodeToPlainText(el)).toBe('line one\nline two');
  });

  it('preserves embedded \\n in text nodes (white-space: pre-wrap content)', () => {
    // marked emits paragraph text with raw \n when `breaks: true` would
    // otherwise wrap them in <br>; the chat view relies on the visible
    // newlines coming through copy verbatim.
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('hello\nworld'));
    expect(domNodeToPlainText(p)).toBe('hello\nworld');
  });

  it('renders unordered lists with "- " bullets', () => {
    const el = makeEl('<ul><li>a</li><li>b</li></ul>');
    expect(domNodeToPlainText(el)).toBe('- a\n- b');
  });

  it('renders ordered lists with "N. " markers', () => {
    const el = makeEl('<ol><li>a</li><li>b</li><li>c</li></ol>');
    expect(domNodeToPlainText(el)).toBe('1. a\n2. b\n3. c');
  });

  it('preserves <pre> content verbatim (no whitespace collapsing)', () => {
    const el = makeEl('<pre><code>line 1\n  indented\nline 3</code></pre>');
    expect(domNodeToPlainText(el)).toBe('line 1\n  indented\nline 3');
  });

  it('prefixes every blockquote line with "> "', () => {
    const el = makeEl('<blockquote><p>quoted</p><p>twice</p></blockquote>');
    expect(domNodeToPlainText(el)).toBe('> quoted\n>\n> twice');
  });

  it('separates table cells with TAB and rows with newline', () => {
    const el = makeEl(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>',
    );
    expect(domNodeToPlainText(el)).toBe('a\tb\n1\t2\n3\t4');
  });

  it('omits chat-bubble-time, copy buttons, and download buttons', () => {
    const el = makeEl(
      '<div class="chat-event chat-assistant">' +
        '<p>hello</p>' +
        '<button class="chat-code-copy-btn">copy</button>' +
        '<button class="chat-dl-btn">⬇</button>' +
        '<div class="chat-bubble-time">12:34</div>' +
      '</div>',
    );
    expect(domNodeToPlainText(el)).toBe('hello');
  });

  it('handles headings as block-level boundaries', () => {
    const el = makeEl('<h1>Title</h1><p>body</p>');
    expect(domNodeToPlainText(el)).toBe('Title\n\nbody');
  });

  it('collapses runs of blank lines to at most one', () => {
    const el = makeEl('<p>a</p><p></p><p></p><p>b</p>');
    expect(domNodeToPlainText(el)).toBe('a\n\nb');
  });

  it('keeps inline link text adjacent to surrounding text (no extra newlines)', () => {
    const el = makeEl('<p>see <a href="#">this link</a> please</p>');
    expect(domNodeToPlainText(el)).toBe('see this link please');
  });

  it('round-trips a marked-style multi-paragraph assistant message', () => {
    // Shape mirrors what ChatMarkdown renders for:
    //   First paragraph.
    //
    //   Second paragraph with `code` and **bold**.
    //
    //   - bullet one
    //   - bullet two
    //
    //   ```
    //   block
    //   content
    //   ```
    const el = makeEl(
      '<div class="chat-rich-text">' +
        '<p>First paragraph.</p>' +
        '<p>Second paragraph with <code class="chat-inline-code">code</code> and <strong>bold</strong>.</p>' +
        '<ul class="chat-list"><li>bullet one</li><li>bullet two</li></ul>' +
        '<div class="chat-code-block">' +
          '<div class="chat-code-header"><div class="chat-code-titlebar">' +
            '<span class="chat-code-lang">text</span>' +
            '<button class="chat-code-copy-btn">copy</button>' +
          '</div></div>' +
          '<pre><code>block\ncontent</code></pre>' +
        '</div>' +
      '</div>',
    );
    expect(domNodeToPlainText(el)).toBe(
      'First paragraph.\n\n' +
      'Second paragraph with code and bold.\n\n' +
      '- bullet one\n' +
      '- bullet two\n\n' +
      'block\ncontent',
    );
  });
});
