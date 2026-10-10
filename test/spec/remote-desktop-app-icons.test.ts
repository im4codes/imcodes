import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PWA_ICON_DIR, logoSha256, renderPwaIcon } from '../../scripts/aidesk-icon.mjs';
import {
  REMOTE_DESKTOP_APP_ICON_FILES,
  REMOTE_DESKTOP_APP_ICON_SOURCE_DIR,
  REMOTE_DESKTOP_APP_ICON_SOURCE_HASH_FILE,
  REMOTE_DESKTOP_APP_MASKABLE_SAFE_ZONE_RATIO,
  buildRemoteDesktopAppManifest,
} from '../../shared/remote-desktop-app.js';
import { readSource } from '../helpers/read-source.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const iconDir = join(root, REMOTE_DESKTOP_APP_ICON_SOURCE_DIR);
/** What counts as artwork (the wordmark), as opposed to the near-black canvas it sits on. */
const INK_LUMINANCE = 40;
/** The three icons together stay small: they ship in every web build. */
const ICON_BUDGET_BYTES = 150 * 1024;

async function raw(file: string) {
  const { data, info } = await sharp(join(iconDir, file)).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

describe('the installable remote desktop app: icons', () => {
  it('are the committed files the generator writes, and nothing else is in the directory', () => {
    expect(PWA_ICON_DIR).toBe(iconDir);
    const expected = [...REMOTE_DESKTOP_APP_ICON_FILES.map((icon) => icon.file), REMOTE_DESKTOP_APP_ICON_SOURCE_HASH_FILE].sort();
    expect(readdirSync(iconDir).sort()).toEqual(expected);
  });

  it('are bound to the official logo: the recorded hash is the hash of the logo they were rendered from', () => {
    expect(readSource(join(iconDir, REMOTE_DESKTOP_APP_ICON_SOURCE_HASH_FILE)).trim()).toBe(logoSha256());
  });

  it.each(REMOTE_DESKTOP_APP_ICON_FILES.map((icon) => [icon.file, icon.size] as const))('%s is a square PNG of exactly %i px', async (file, size) => {
    const meta = await sharp(join(iconDir, file)).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(size);
    expect(meta.height).toBe(size);
  });

  it('declare in the manifest exactly the sizes the files have', async () => {
    for (const icon of buildRemoteDesktopAppManifest().icons) {
      const file = REMOTE_DESKTOP_APP_ICON_FILES.find((candidate) => candidate.path === icon.src)!;
      const meta = await sharp(join(iconDir, file.file)).metadata();
      expect(icon.sizes).toBe(`${meta.width}x${meta.height}`);
    }
  });

  it('stay within the size budget', () => {
    const total = REMOTE_DESKTOP_APP_ICON_FILES.reduce((sum, icon) => sum + statSync(join(iconDir, icon.file)).size, 0);
    expect(total).toBeLessThan(ICON_BUDGET_BYTES);
  });

  it('"any" icons are the rounded tile: transparent corners, opaque centre (not a bare square that looks wrong on a dark Dock)', async () => {
    for (const icon of REMOTE_DESKTOP_APP_ICON_FILES.filter((candidate) => candidate.purpose === 'any')) {
      const { data, width, channels } = await raw(icon.file);
      expect(channels).toBe(4);
      const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3]!;
      expect(alphaAt(0, 0), icon.file).toBe(0);
      expect(alphaAt(width - 1, width - 1), icon.file).toBe(0);
      expect(alphaAt(Math.floor(width / 2), Math.floor(width / 2)), icon.file).toBe(255);
    }
  });

  it('the maskable icon is fully opaque, and all of the wordmark sits inside the safe zone the platform never crops', async () => {
    const { data, width, height, channels } = await raw('icon-maskable-512.png');
    const cx = width / 2;
    const cy = height / 2;
    const safeRadius = (REMOTE_DESKTOP_APP_MASKABLE_SAFE_ZONE_RATIO * width) / 2;
    let inkPixels = 0;
    let farthest = 0;
    let minAlpha = 255;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * channels;
        if (channels === 4) minAlpha = Math.min(minAlpha, data[i + 3]!);
        if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) > INK_LUMINANCE) {
          inkPixels += 1;
          farthest = Math.max(farthest, Math.hypot(x - cx, y - cy));
        }
      }
    }
    expect(minAlpha).toBe(255);
    expect(inkPixels).toBeGreaterThan(1_000); // the wordmark is there
    expect(farthest).toBeLessThanOrEqual(safeRadius);
  });

  it('the safe-zone check really bites: the unscaled full-bleed logo would be cropped (it reaches past the safe zone)', async () => {
    // The same measurement on the logo scaled to fill the canvas: the wordmark's corners are beyond 40 % of the width from the centre.
    const size = 512;
    const { data, info } = await sharp(join(root, 'web/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')).removeAlpha().resize(size, size).raw().toBuffer({ resolveWithObject: true });
    let farthest = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * info.channels;
        if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) > INK_LUMINANCE) farthest = Math.max(farthest, Math.hypot(x - size / 2, y - size / 2));
      }
    }
    expect(farthest).toBeGreaterThan((REMOTE_DESKTOP_APP_MASKABLE_SAFE_ZONE_RATIO * size) / 2);
  });

  it('the generator renders what it promises at any size: an opaque maskable icon, a translucent-cornered "any" icon', async () => {
    const maskable = await renderPwaIcon(256, 'maskable');
    expect(await sharp(maskable).metadata()).toMatchObject({ width: 256, height: 256 });
    expect((await sharp(maskable).stats()).isOpaque).toBe(true);
    const any = await renderPwaIcon(256, 'any');
    expect(await sharp(any).metadata()).toMatchObject({ width: 256, height: 256 });
    expect((await sharp(any).stats()).isOpaque).toBe(false);
  });

  it('exist where the build copies them from (web/public is the Vite public directory)', () => {
    expect(REMOTE_DESKTOP_APP_ICON_SOURCE_DIR.startsWith('web/public/')).toBe(true);
    for (const icon of REMOTE_DESKTOP_APP_ICON_FILES) expect(existsSync(join(iconDir, icon.file)), icon.file).toBe(true);
  });
});
