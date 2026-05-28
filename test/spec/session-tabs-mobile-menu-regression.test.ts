import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('SessionTabs mobile context menu regression', () => {
  it('keeps desktop right-click and adds touch long-press access to the tab menu', () => {
    const source = read('web/src/components/SessionTabs.tsx');

    expect(source).toContain('TAB_LONG_PRESS_MS');
    expect(source).toContain('TAB_LONG_PRESS_MOVE_CANCEL_PX');
    expect(source).toContain('suppressNextClickRef');
    expect(source).toContain('openCtxAt');
    expect(source).toContain('onTabPointerDown');
    expect(source).toContain('onPointerDown={(e) => onTabPointerDown(e as PointerEvent, s)}');
    expect(source).toContain('onPointerMove={(e) => onTabPointerMove(e as PointerEvent)}');
    expect(source).toContain('onPointerCancel={(e) => onTabPointerCancel(e as PointerEvent)}');
    expect(source).toContain('onPointerLeave={(e) => onTabPointerCancel(e as PointerEvent)}');
    expect(source).toContain('onContextMenu={(e) => openCtx(e, s)}');
    expect(source).toContain('togglePin(ctx.session.name)');
  });

  it('prevents the mobile long-press menu from being swallowed by native callouts', () => {
    const css = read('web/src/styles.css');

    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.tab\s*\{[^}]*-webkit-touch-callout:\s*none/);
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.tab\s*\{[^}]*touch-action:\s*pan-x/);
  });
});
