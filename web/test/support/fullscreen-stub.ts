/**
 * A fullscreen API for jsdom, which has none.
 *
 * Shared by everything that tests a fullscreen control, so that they all agree
 * on how the browser behaves: `requestFullscreen` moves `fullscreenElement`
 * and fires `fullscreenchange`, `exitFullscreen` clears it and fires again,
 * and `setElement` stands in for the browser changing it on its own -- which
 * is what Esc does.
 */
export interface FullscreenStub {
  /** Move fullscreen to this element (or out of it) the way the browser would. */
  setElement(element: Element | null): void;
  /** Every element `requestFullscreen()` was called on, in order. */
  requests: Element[];
}

export function installFullscreenStub(
  options: { enabled?: boolean; reject?: boolean } = {},
): FullscreenStub {
  const state: { element: Element | null } = { element: null };
  const requests: Element[] = [];

  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => state.element,
  });
  Object.defineProperty(document, 'fullscreenEnabled', {
    configurable: true,
    get: () => options.enabled !== false,
  });

  const setElement = (element: Element | null): void => {
    state.element = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  };

  Element.prototype.requestFullscreen = function requestFullscreen(this: Element) {
    requests.push(this);
    if (options.reject) return Promise.reject(new Error('permissions check failed'));
    setElement(this);
    return Promise.resolve();
  };
  document.exitFullscreen = () => {
    setElement(null);
    return Promise.resolve();
  };

  return { setElement, requests };
}

/** Put jsdom back the way it was: no fullscreen API at all. */
export function removeFullscreenStub(): void {
  Reflect.deleteProperty(document, 'fullscreenElement');
  Reflect.deleteProperty(document, 'fullscreenEnabled');
  Reflect.deleteProperty(Element.prototype, 'requestFullscreen');
  Reflect.deleteProperty(document, 'exitFullscreen');
}
