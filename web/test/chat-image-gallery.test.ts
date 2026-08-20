/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_IMAGE_PATH_ATTR,
  collectChatImagePaths,
  resolveGalleryPosition,
  stepGallery,
} from '../src/chat-image-gallery.js';

function mountChat(id: string, paths: string[]): HTMLElement {
  const chat = document.createElement('div');
  chat.className = 'chat-view';
  chat.id = id;
  for (const p of paths) {
    const img = document.createElement('img');
    img.setAttribute(CHAT_IMAGE_PATH_ATTR, p);
    chat.appendChild(img);
  }
  document.body.appendChild(chat);
  return chat;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collectChatImagePaths', () => {
  it('returns the chat images in document order', () => {
    const chat = mountChat('a', ['/x/1.png', '/x/2.png', '/x/3.png']);
    const origin = chat.querySelector('img')!;
    expect(collectChatImagePaths(origin)).toEqual(['/x/1.png', '/x/2.png', '/x/3.png']);
  });

  // A main session and any number of sub-session windows can be mounted at
  // once. An unscoped query would page across conversations.
  it('does not reach into another chat view', () => {
    mountChat('a', ['/a/1.png', '/a/2.png']);
    const other = mountChat('b', ['/b/1.png']);
    const origin = other.querySelector('img')!;
    expect(collectChatImagePaths(origin)).toEqual(['/b/1.png']);
  });

  it('collapses a repeated path to its first appearance', () => {
    const chat = mountChat('a', ['/x/1.png', '/x/2.png', '/x/1.png']);
    expect(collectChatImagePaths(chat.querySelector('img')!)).toEqual(['/x/1.png', '/x/2.png']);
  });

  it('returns empty for a null origin', () => {
    expect(collectChatImagePaths(null)).toEqual([]);
  });
});

describe('resolveGalleryPosition', () => {
  const paths = ['/x/1.png', '/x/2.png', '/x/3.png'];

  it('reports both directions in the middle', () => {
    expect(resolveGalleryPosition(paths, '/x/2.png')).toEqual({ index: 1, canPrev: true, canNext: true });
  });

  it('clamps at the ends', () => {
    expect(resolveGalleryPosition(paths, '/x/1.png').canPrev).toBe(false);
    expect(resolveGalleryPosition(paths, '/x/3.png').canNext).toBe(false);
  });

  // A thumbnail can scroll out of the render window while its lightbox is open;
  // losing the gallery must not break the image that is already showing.
  it('degrades to a single-entry gallery for an unknown path', () => {
    expect(resolveGalleryPosition(paths, '/gone.png')).toEqual({ index: 0, canPrev: false, canNext: false });
  });
});

describe('stepGallery', () => {
  const paths = ['/x/1.png', '/x/2.png', '/x/3.png'];

  it('steps in both directions', () => {
    expect(stepGallery(paths, '/x/2.png', -1)).toBe('/x/1.png');
    expect(stepGallery(paths, '/x/2.png', 1)).toBe('/x/3.png');
  });

  it('never wraps', () => {
    expect(stepGallery(paths, '/x/1.png', -1)).toBeNull();
    expect(stepGallery(paths, '/x/3.png', 1)).toBeNull();
  });

  it('returns null for an unknown path', () => {
    expect(stepGallery(paths, '/gone.png', 1)).toBeNull();
  });
});
