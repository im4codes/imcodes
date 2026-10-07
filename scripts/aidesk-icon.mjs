#!/usr/bin/env node
/**
 * Every aiDesk application icon, rendered from the ONE official IM.codes logo: the app icon the iOS app ships (an "IM / .codes"
 * wordmark on black; landing/im.png is the same pixels). Nothing else is committed per platform: the macOS .icns iconset, the Windows
 * .ico, the Linux hicolor PNGs and the panel page's inline favicon are all produced here, at build time or by the generator.
 *
 *   node scripts/aidesk-icon.mjs ico OUT.ico
 *   node scripts/aidesk-icon.mjs iconset DIR            (then: iconutil -c icns DIR -o AppIcon.icns)
 *   node scripts/aidesk-icon.mjs hicolor DIR            (DIR/<n>x<n>/apps/aidesk.png)
 *   node scripts/aidesk-icon.mjs favicon-ts [OUT.ts]    (shared/aidesk-favicon-generated.ts, committed; the test binds it to the source hash)
 *   node scripts/aidesk-icon.mjs icon-ts [OUT.ts]       (shared/aidesk-icon-generated.ts: the Linux hicolor PNGs, embedded in the node bundle)
 *   node scripts/aidesk-icon.mjs pwa-icons [DIR]        (web/public/remote-desktop-app: the installable remote desktop web app's icons + SOURCE.sha256)
 *
 * The logo is black, so on a dark Dock or taskbar its edge would vanish: the artwork is shaped as a rounded tile with a hairline light
 * border, and at 64 px and below it is cropped to the wordmark so "IM.codes" stays legible.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
// The names, sizes and purposes of the installable web app's icons: written once, in the JSON shared/remote-desktop-app.ts also reads.
import appAssets from '../shared/remote-desktop-app.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The official logo: the iOS app icon (1024x1024, opaque). Same pixels as landing/im.png; there is no vector source in the repository. */
export const AIDESK_LOGO_SOURCE = join(root, 'web', 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png');
export const AIDESK_FAVICON_TS = join(root, 'shared', 'aidesk-favicon-generated.ts');

export const AIDESK_ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
export const AIDESK_HICOLOR_SIZES = Object.freeze([16, 22, 24, 32, 48, 64, 128, 256, 512]);
/** The images an macOS .iconset needs, as [file name, pixel size]. */
export const AIDESK_ICONSET_ENTRIES = Object.freeze([
  ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
  ['icon_512x512', 512], ['icon_512x512@2x', 1024],
]);
export const AIDESK_FAVICON_SIZE = 64;
export const AIDESK_ICON_TS = join(root, 'shared', 'aidesk-icon-generated.ts');
/** The hicolor sizes the node writes for the Linux desktop entry (the shell scales between them): small enough to embed in the bundle. */
export const AIDESK_EMBEDDED_ICON_SIZES = Object.freeze([48, 256]);

/** The wordmark's bounding box inside the 1024 px artwork, padded: what small sizes are cropped to. */
const WORDMARK_CROP = Object.freeze({ left: 188, top: 120, width: 704, height: 704 });
const SMALL_SIZE_LIMIT = 64;
/** Apple's icon template: the artwork fills 824 of 1024 px, with a corner radius of 22.37 % of that. */
const MACOS_CONTENT_RATIO = 824 / 1024;
const CORNER_RADIUS_RATIO = 0.2237;

export function logoSha256(source = AIDESK_LOGO_SOURCE) {
  return createHash('sha256').update(readFileSync(source)).digest('hex');
}

/**
 * One icon: the logo shaped as a rounded tile, a hairline light border, on a transparent canvas of `size` x `size`.
 * `contentRatio` < 1 leaves transparent margin (macOS); 1 fills the canvas (Windows, Linux, favicon).
 */
export async function renderAideskIcon(size, { contentRatio = 1, source = AIDESK_LOGO_SOURCE } = {}) {
  const inner = Math.max(1, Math.round(size * contentRatio));
  const offset = Math.floor((size - inner) / 2);
  const radius = inner * CORNER_RADIUS_RATIO;
  const art = sharp(source).removeAlpha();
  const cropped = size <= SMALL_SIZE_LIMIT ? art.extract(WORDMARK_CROP) : art;
  const tile = await cropped.resize(inner, inner, { kernel: 'lanczos3' }).ensureAlpha().png().toBuffer();
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${inner}"><rect width="${inner}" height="${inner}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`);
  const rounded = await sharp(tile).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const stroke = Math.max(1, inner * 0.012);
  const border = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${inner}"><rect x="${stroke / 2}" y="${stroke / 2}" width="${inner - stroke}" height="${inner - stroke}" rx="${radius - stroke / 2}" ry="${radius - stroke / 2}" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="${stroke}"/></svg>`);
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: rounded, left: offset, top: offset }, { input: border, left: offset, top: offset }])
    .png()
    .toBuffer();
}

/** The bytes of an .ico holding one PNG image per entry (width/height byte 0 means 256). */
export function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // no palette
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

export async function buildIco(sizes = AIDESK_ICO_SIZES) {
  const images = [];
  for (const size of sizes) images.push({ size, png: await renderAideskIcon(size) });
  return packIco(images);
}

export async function writeIconset(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [name, size] of AIDESK_ICONSET_ENTRIES) {
    writeFileSync(join(dir, `${name}.png`), await renderAideskIcon(size, { contentRatio: MACOS_CONTENT_RATIO }));
  }
}

export async function writeHicolor(dir) {
  for (const size of AIDESK_HICOLOR_SIZES) {
    const target = join(dir, `${size}x${size}`, 'apps');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'aidesk.png'), await renderAideskIcon(size));
  }
}

export async function faviconDataUri() {
  return `data:image/png;base64,${(await renderAideskIcon(AIDESK_FAVICON_SIZE)).toString('base64')}`;
}

/** Where the installable web app's icons are committed (the test binds them to the logo's hash). */
export const PWA_ICON_DIR = join(root, appAssets.iconSourceDir);
/** A maskable icon is masked by the platform (a circle, a squircle, ...): the artwork is scaled down to leave the safe zone clear. */
const PWA_MASKABLE_CONTENT_RATIO = 0.9;
/** The logo artwork is 1024 px; its outer frame (<= 16 px) is not part of the wordmark; a pixel well inside it gives the canvas colour. */
const ART_SIZE = 1024;
const PWA_MASKABLE_FRAME_CROP = 16;
const PWA_MASKABLE_BACKGROUND_PROBE = 100;

/**
 * The installable web app's icons. `any` is the same rounded tile every other platform uses. `maskable` is opaque and full-bleed (the
 * platform supplies the shape) with the artwork scaled so the whole wordmark sits inside the W3C safe zone (a circle of 80 % of the
 * width) -- at full size the wordmark's corners reach 41 % of the width from the centre and would be cut.
 */
export async function renderPwaIcon(size, purpose, source = AIDESK_LOGO_SOURCE) {
  if (purpose !== 'maskable') return renderAideskIcon(size, { source });
  // The artwork is near-black edge to edge, with a faint greenish hairline frame in its outer few pixels. Cropping the frame away and
  // painting the canvas in the interior colour leaves no visible seam once the artwork is scaled down inside the safe zone.
  const { data } = await sharp(source).removeAlpha().extract({ left: PWA_MASKABLE_BACKGROUND_PROBE, top: PWA_MASKABLE_BACKGROUND_PROBE, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  const inner = Math.round(size * PWA_MASKABLE_CONTENT_RATIO);
  const offset = Math.floor((size - inner) / 2);
  const art = await sharp(source).removeAlpha()
    .extract({ left: PWA_MASKABLE_FRAME_CROP, top: PWA_MASKABLE_FRAME_CROP, width: ART_SIZE - 2 * PWA_MASKABLE_FRAME_CROP, height: ART_SIZE - 2 * PWA_MASKABLE_FRAME_CROP })
    .resize(inner, inner, { kernel: 'lanczos3' }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: data[0], g: data[1], b: data[2] } } })
    .composite([{ input: art, left: offset, top: offset }])
    .png()
    .toBuffer();
}

export async function writePwaIcons(dir = PWA_ICON_DIR) {
  mkdirSync(dir, { recursive: true });
  for (const { file, size, purpose } of appAssets.icons) writeFileSync(join(dir, file), await renderPwaIcon(size, purpose));
  writeFileSync(join(dir, appAssets.iconSourceHashFile), `${logoSha256()}\n`);
}

/** The text of shared/aidesk-favicon-generated.ts: the inline favicon of the panel page, bound to the logo it was made from. */
export async function faviconModule() {
  return `// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Produced by \`node scripts/aidesk-icon.mjs favicon-ts\` from the official IM.codes logo (the iOS app icon). Re-run it after the logo
// changes; test/spec/aidesk-panel-host-windows.test.ts fails if the recorded hash and the logo ever disagree.
//
// source: web/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
// sha256: ${logoSha256()}

/** The panel page's favicon (${AIDESK_FAVICON_SIZE}x${AIDESK_FAVICON_SIZE} PNG as a data: URI): inline, so the page makes no request for it. */
export const AIDESK_FAVICON_DATA_URI = '${await faviconDataUri()}';
export const AIDESK_FAVICON_SOURCE_SHA256 = '${logoSha256()}';
`;
}

/** The text of shared/aidesk-icon-generated.ts: the Linux desktop icon PNGs (base64), bound to the logo they were made from. */
export async function iconModule() {
  const entries = [];
  for (const size of AIDESK_EMBEDDED_ICON_SIZES) entries.push(`  ${size}: '${(await renderAideskIcon(size)).toString('base64')}',`);
  return `// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Produced by \`node scripts/aidesk-icon.mjs icon-ts\` from the official IM.codes logo (the iOS app icon). The Linux desktop entry's icon
// travels inside the node bundle (nothing to ship or roll back separately): the node writes these PNGs to the desktop user's hicolor
// icon directories. Re-run after the logo changes; test/node/aidesk-desktop-entry.test.ts fails if the recorded hash and the logo disagree.
//
// source: web/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
// sha256: ${logoSha256()}

/** Pixel size -> PNG (base64). */
export const AIDESK_HICOLOR_ICONS_BASE64: Readonly<Record<number, string>> = Object.freeze({
${entries.join('\n')}
});
export const AIDESK_ICON_SOURCE_SHA256 = '${logoSha256()}';
`;
}

if (process.argv[1] && process.argv[1].endsWith('aidesk-icon.mjs')) {
  const [mode, target] = process.argv.slice(2);
  const need = () => { if (!target) { process.stderr.write('usage: aidesk-icon.mjs ico OUT.ico | iconset DIR | hicolor DIR | favicon-ts [OUT.ts] | icon-ts [OUT.ts]\n'); process.exit(2); } return resolve(target); };
  if (mode === 'ico') { const out = need(); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, await buildIco()); }
  else if (mode === 'iconset') await writeIconset(need());
  else if (mode === 'hicolor') await writeHicolor(need());
  else if (mode === 'pwa-icons') await writePwaIcons(target ? resolve(target) : PWA_ICON_DIR);
  else if (mode === 'icon-ts') writeFileSync(target ? resolve(target) : AIDESK_ICON_TS, await iconModule());
  else if (mode === 'favicon-ts') writeFileSync(target ? resolve(target) : AIDESK_FAVICON_TS, await faviconModule());
  else { process.stderr.write('usage: aidesk-icon.mjs ico OUT.ico | iconset DIR | hicolor DIR | favicon-ts [OUT.ts] | icon-ts [OUT.ts] | pwa-icons [DIR]\n'); process.exit(2); }
}
