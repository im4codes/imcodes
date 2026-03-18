/**
 * useSwipeBack — iOS-style left-edge swipe with a wave/bubble pull effect.
 * A curved wave stretches from the left edge following the finger.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';

const EDGE_THRESHOLD = 30;
const SWIPE_MIN_DISTANCE = 80;

export function useSwipeBack(onBack: (() => void) | null | undefined): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onBack) return;
    if (!(globalThis as any).Capacitor?.isNativePlatform?.()) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    function createOverlay(y: number) {
      // SVG wave
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('width', '80');
      s.setAttribute('height', String(window.innerHeight));
      Object.assign(s.style, {
        position: 'fixed', left: '0', top: '0',
        zIndex: '99999', pointerEvents: 'none',
        overflow: 'visible',
      });
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'rgba(99, 102, 241, 0.25)');
      path.setAttribute('d', buildWavePath(0, y));
      s.appendChild(path);

      // Arrow chevron
      const a = document.createElement('div');
      Object.assign(a.style, {
        position: 'fixed',
        left: '-20px',
        top: `${y - 14}px`,
        fontSize: '22px',
        fontWeight: '700',
        color: 'rgba(99, 102, 241, 0.9)',
        zIndex: '100000',
        pointerEvents: 'none',
        transition: 'opacity 0.1s',
        opacity: '0',
        lineHeight: '1',
        fontFamily: '-apple-system, system-ui, sans-serif',
      });
      a.textContent = '‹';

      document.body.appendChild(s);
      document.body.appendChild(a);
      return { svg: s, path, arrow: a };
    }

    function buildWavePath(dx: number, cy: number): string {
      const h = window.innerHeight;
      // Wave bulge width = dx, centered at touch Y
      // The wave curves out from the left edge
      const bulge = Math.min(dx * 0.9, 120);
      const spread = Math.min(80 + dx * 1.5, 220); // vertical spread of the wave
      const top = Math.max(cy - spread, 0);
      const bot = Math.min(cy + spread, h);
      // Cubic bezier wave from left edge
      return [
        `M 0 0`,
        `L 0 ${top}`,
        `C 0 ${cy - spread * 0.3}, ${bulge} ${cy - spread * 0.15}, ${bulge} ${cy}`,
        `C ${bulge} ${cy + spread * 0.15}, 0 ${cy + spread * 0.3}, 0 ${bot}`,
        `L 0 ${h}`,
        `L 0 0 Z`,
      ].join(' ');
    }

    let parts: { svg: SVGSVGElement; path: SVGPathElement; arrow: HTMLDivElement } | null = null;

    function update(dx: number, cy: number) {
      if (!parts) return;
      const progress = Math.min(dx / SWIPE_MIN_DISTANCE, 1);
      const bulge = Math.min(dx * 0.9, 120);

      parts.path.setAttribute('d', buildWavePath(dx, cy));

      // Color intensifies as you pull further
      const triggered = progress >= 1;
      parts.path.setAttribute('fill',
        triggered ? 'rgba(52, 211, 153, 0.3)' : `rgba(99, 102, 241, ${0.15 + progress * 0.2})`);

      // Arrow follows the wave tip
      const arrowX = Math.max(bulge - 18, -20);
      parts.arrow.style.left = `${arrowX}px`;
      parts.arrow.style.top = `${cy - 14}px`;
      parts.arrow.style.opacity = String(Math.min(progress * 2, 1));
      parts.arrow.style.color = triggered ? 'rgba(52, 211, 153, 1)' : 'rgba(99, 102, 241, 0.9)';
      parts.arrow.style.fontSize = `${22 + progress * 6}px`;
    }

    function cleanup(triggered: boolean) {
      if (!parts) return;
      const { svg: s, arrow: a } = parts;
      parts = null;

      if (triggered) {
        // Quick flash and out
        s.style.transition = 'opacity 0.2s';
        a.style.transition = 'opacity 0.2s, transform 0.2s';
        a.style.transform = 'translateX(30px)';
        s.style.opacity = '0';
        a.style.opacity = '0';
      } else {
        // Snap back
        s.style.transition = 'opacity 0.25s';
        a.style.transition = 'opacity 0.15s';
        s.style.opacity = '0';
        a.style.opacity = '0';
      }
      setTimeout(() => { s.remove(); a.remove(); }, 300);
    }

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch.clientX <= EDGE_THRESHOLD) {
        startX = touch.clientX;
        startY = touch.clientY;
        tracking = true;
        parts = createOverlay(touch.clientY);
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      if (dy > dx * 1.2 && dx < 30) {
        tracking = false;
        cleanup(false);
        return;
      }
      update(Math.max(0, dx), touch.clientY);
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      const triggered = dx >= SWIPE_MIN_DISTANCE && dx > dy * 1.5;
      cleanup(triggered);
      if (triggered) onBack();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      if (parts) { parts.svg.remove(); parts.arrow.remove(); parts = null; }
    };
  }, [onBack]);

  return ref;
}
