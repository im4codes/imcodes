#!/usr/bin/env node
/**
 * Every aiDesk application icon, rendered from the ONE official IM.codes brand logo (`web/public/imcodes-brand-logo.png`).
 * Nothing else is committed per platform: the macOS .icns iconset, the Windows .ico, the Linux hicolor PNGs, the panel page's
 * inline favicon, and the Remote Desktop PWA icons are all produced here, at build time or by the generator.
 *
 *   node scripts/aidesk-icon.mjs ico OUT.ico
 *   node scripts/aidesk-icon.mjs iconset DIR            (then: iconutil -c icns DIR -o AppIcon.icns)
 *   node scripts/aidesk-icon.mjs hicolor DIR            (DIR/<n>x<n>/apps/aidesk.png)
 *   node scripts/aidesk-icon.mjs favicon-ts [OUT.ts]    (shared/aidesk-favicon-generated.ts, committed; the test binds it to the source hash)
 *   node scripts/aidesk-icon.mjs icon-ts [OUT.ts]       (shared/aidesk-icon-generated.ts: the Linux hicolor PNGs + Windows .ico, embedded in the node bundle)
 *   node scripts/aidesk-icon.mjs pwa-icons [DIR]        (web/public/remote-desktop-app: the installable remote desktop web app's icons + SOURCE.sha256)
 *
 * Rendered inside the official dark-navy rounded tile with cyan glow and hairline border (matching apps/pc-app/scripts/generate-icons.mjs).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
// The names, sizes and purposes of the installable web app's icons: written once, in the JSON shared/remote-desktop-app.ts also reads.
import appAssets from '../shared/remote-desktop-app.json' with { type: 'json' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The official IM.codes brand logo. */
export const AIDESK_LOGO_SOURCE = join(root, 'web', 'public', 'imcodes-brand-logo.png');
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

/** Apple's icon template: the artwork fills 824 of 1024 px, with a corner radius of 22.37 % of that. */
const MACOS_CONTENT_RATIO = 824 / 1024;
const CORNER_RADIUS_RATIO = 0.2237;
const MASKABLE_CANVAS_RGB = Object.freeze({ r: 2, g: 5, b: 11 });
/** Scaled so all HUD corner brackets and wordmark pixels stay strictly inside the W3C 80% safe-zone circle. */
const PWA_MASKABLE_ROBOT_RATIO = 0.62;

export function logoSha256(source = AIDESK_LOGO_SOURCE) {
  return createHash('sha256').update(readFileSync(source)).digest('hex');
}

/**
 * One icon: the full-bleed brand artwork clipped to a rounded squircle with a cyan hairline border, on a transparent canvas of `size` x `size`.
 * `contentRatio` < 1 leaves transparent margin (macOS); 1 fills the canvas (Windows, Linux, favicon).
 */
export async function renderAideskIcon(size, { contentRatio = 1, source = AIDESK_LOGO_SOURCE } = {}) {
  const inner = Math.max(1, Math.round(size * contentRatio));
  const offset = Math.floor((size - inner) / 2);
  const radius = inner * CORNER_RADIUS_RATIO;
  const stroke = Math.max(1, inner * 0.015);
  const halfStroke = stroke / 2;

  const maskSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${inner}" viewBox="0 0 ${inner} ${inner}">
      <rect x="0" y="0" width="${inner}" height="${inner}" rx="${radius}" ry="${radius}" fill="#ffffff" />
    </svg>`,
  );

  const borderSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${inner}" viewBox="0 0 ${inner} ${inner}">
      <rect x="${halfStroke}" y="${halfStroke}" width="${Math.max(0, inner - stroke)}" height="${Math.max(0, inner - stroke)}" rx="${Math.max(0, radius - halfStroke)}" ry="${Math.max(0, radius - halfStroke)}" fill="none" stroke="#67e8f9" stroke-opacity="0.34" stroke-width="${stroke}" />
    </svg>`,
  );

  const clippedPng = await sharp(source)
    .resize(inner, inner, { fit: 'cover', kernel: 'lanczos3' })
    .ensureAlpha()
    .composite([{ input: maskSvg, blend: 'dest-in' }])
    .png()
    .toBuffer();

  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: clippedPng, left: offset, top: offset },
      { input: borderSvg, left: offset, top: offset },
    ])
    .png({ compressionLevel: 9, palette: true, quality: 80, dither: 0.2, effort: 10 })
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

/**
 * The installable web app's icons. `any` is the same rounded tile every other platform uses. `maskable` is opaque and full-bleed (the
 * platform supplies the shape) with the robot scaled so the entire artwork sits inside the W3C safe zone (80% diameter circle).
 */
export async function renderPwaIcon(size, purpose, source = AIDESK_LOGO_SOURCE) {
  if (purpose !== 'maskable') return renderAideskIcon(size, { source });
  const robotSize = Math.max(1, Math.round(size * PWA_MASKABLE_ROBOT_RATIO));
  const offset = Math.floor((size - robotSize) / 2);
  const robotPng = await sharp(source)
    .resize(robotSize, robotSize, {
      fit: 'cover',
      kernel: 'lanczos3',
    })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: MASKABLE_CANVAS_RGB } })
    .composite([{ input: robotPng, left: offset, top: offset }])
    .png({ compressionLevel: 9, palette: true, quality: 80, dither: 0.2, effort: 10 })
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
// Produced by \`node scripts/aidesk-icon.mjs favicon-ts\` from the official IM.codes robot logo. Re-run it after the logo
// changes; test/spec/aidesk-panel-host-windows.test.ts fails if the recorded hash and the logo ever disagree.
//
// source: web/public/imcodes-brand-logo.png
// sha256: ${logoSha256()}

/** The panel page's favicon (${AIDESK_FAVICON_SIZE}x${AIDESK_FAVICON_SIZE} PNG as a data: URI): inline, so the page makes no request for it. */
export const AIDESK_FAVICON_DATA_URI = '${await faviconDataUri()}';
export const AIDESK_FAVICON_SOURCE_SHA256 = '${logoSha256()}';
`;
}

/** The text of shared/aidesk-icon-generated.ts: the Linux desktop icon PNGs and Windows .ico (base64), bound to the logo they were made from. */
export async function iconModule() {
  const entries = [];
  for (const size of AIDESK_EMBEDDED_ICON_SIZES) entries.push(`  ${size}: '${(await renderAideskIcon(size)).toString('base64')}',`);
  const icoBase64 = (await buildIco()).toString('base64');
  return `// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Produced by \`node scripts/aidesk-icon.mjs icon-ts\` from the official IM.codes robot logo. The Linux desktop entry icons and Windows
// shortcut .ico travel inside the node bundle (nothing to ship or roll back separately). Re-run after the logo changes;
// test/node/aidesk-desktop-entry.test.ts fails if the recorded hash and the logo disagree.
//
// source: web/public/imcodes-brand-logo.png
// sha256: ${logoSha256()}

/** Pixel size -> PNG (base64). */
export const AIDESK_HICOLOR_ICONS_BASE64: Readonly<Record<number, string>> = Object.freeze({
${entries.join('\n')}
});
/** Windows multi-size ICO (base64). */
export const AIDESK_ICO_BASE64 = '${icoBase64}';
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
