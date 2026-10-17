import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

/** Fill the visible space below the trigger, including after keyboard/rotation changes. */
export function MobileServerMenu({ children }: { children: ComponentChildren }) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const viewport = window.visualViewport;
    const updateHeight = () => {
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      menu.style.setProperty('--mobile-server-menu-available-height', `${Math.max(0, bottom - menu.getBoundingClientRect().top)}px`);
    };
    updateHeight();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateHeight);
    if (menu.parentElement) observer?.observe(menu.parentElement);
    window.addEventListener('resize', updateHeight);
    viewport?.addEventListener('resize', updateHeight);
    viewport?.addEventListener('scroll', updateHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateHeight);
      viewport?.removeEventListener('resize', updateHeight);
      viewport?.removeEventListener('scroll', updateHeight);
    };
  }, []);
  return <div class="mobile-server-menu" ref={menuRef}>{children}</div>;
}
