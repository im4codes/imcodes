/**
 * Ordered set of the images a chat view is currently showing, used to page
 * between them from the lightbox.
 *
 * The list is read from the rendered thumbnails at open time rather than
 * derived from the timeline events. Two reasons:
 *
 *   1. No drift. Path detection is spread across several markdown token
 *      branches plus the plain-text scanner; re-deriving it here would mean a
 *      second implementation that can silently disagree with what was actually
 *      drawn. Reading the DOM asks the renderer what it produced.
 *   2. It matches what the user can see. `ChatView` renders only a tail window
 *      of the loaded history, so images in older, unrendered events are not on
 *      screen at all — leaving them out of the gallery is the consistent
 *      behaviour, not a gap.
 *
 * Scoping to one chat container is required, not cosmetic: a main session and
 * any number of sub-session windows can be mounted at once, and an unscoped
 * query would page across conversations.
 */

/** Marks a thumbnail as a gallery member and carries the path it resolves to. */
export const CHAT_IMAGE_PATH_ATTR = 'data-chat-image-path';

/** Container the gallery is limited to. */
const CHAT_CONTAINER_SELECTOR = '.chat-view';

/**
 * Collect the image paths of one chat view in document order, starting from any
 * element inside it. Duplicate paths collapse to their first appearance so
 * paging does not stall on an image repeated in the transcript.
 */
export function collectChatImagePaths(origin: Element | null): string[] {
  if (!origin) return [];
  const scope = origin.closest(CHAT_CONTAINER_SELECTOR) ?? origin.ownerDocument;
  if (!scope) return [];
  const nodes = scope.querySelectorAll(`[${CHAT_IMAGE_PATH_ATTR}]`);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const node of Array.from(nodes)) {
    const path = node.getAttribute(CHAT_IMAGE_PATH_ATTR);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Where paging can go from `path`.
 *
 * A path missing from `paths` yields a single-entry gallery rather than an
 * error: a thumbnail can be scrolled out of the render window while its
 * lightbox is open, and losing the gallery should not break the open image.
 */
export function resolveGalleryPosition(paths: string[], path: string): {
  index: number;
  canPrev: boolean;
  canNext: boolean;
} {
  const index = paths.indexOf(path);
  if (index < 0) return { index: 0, canPrev: false, canNext: false };
  return { index, canPrev: index > 0, canNext: index < paths.length - 1 };
}

/** Next path in `direction`, or null at the ends. Never wraps. */
export function stepGallery(paths: string[], path: string, direction: -1 | 1): string | null {
  const index = paths.indexOf(path);
  if (index < 0) return null;
  const target = index + direction;
  if (target < 0 || target >= paths.length) return null;
  return paths[target] ?? null;
}
