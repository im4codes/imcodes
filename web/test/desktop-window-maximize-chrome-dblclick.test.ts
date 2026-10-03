/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { isWindowChromeDoubleClickTarget } from '../src/desktop-window-maximize.js';

function tree(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('isWindowChromeDoubleClickTarget', () => {
  it('accepts bare chrome and rejects interactive descendants', () => {
    const host = tree(`
      <div id="bar"><span id="title">t</span>
        <button id="b"><span id="bi">x</span></button>
        <a id="a" href="#">l</a>
        <input id="i" /><select id="s"><option>o</option></select><textarea id="t"></textarea>
        <label id="l">lab</label><div role="button" id="rb">r</div>
        <div contenteditable="true" id="ce">e</div><div contenteditable="false" id="cf">f</div>
      </div>`);
    const q = (id: string) => host.querySelector(`#${id}`);
    expect(isWindowChromeDoubleClickTarget(q('bar'))).toBe(true);
    expect(isWindowChromeDoubleClickTarget(q('title'))).toBe(true);
    expect(isWindowChromeDoubleClickTarget(q('cf'))).toBe(true);
    for (const id of ['b', 'bi', 'a', 'i', 's', 't', 'l', 'rb', 'ce']) {
      expect(isWindowChromeDoubleClickTarget(q(id)), id).toBe(false);
    }
    expect(isWindowChromeDoubleClickTarget(null)).toBe(false);
    expect(isWindowChromeDoubleClickTarget(document as unknown as EventTarget)).toBe(false);
    host.remove();
  });
});
