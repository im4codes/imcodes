#!/usr/bin/env node
/**
 * Generate desktop app icons for `apps/pc-app` from the official IM.codes
 * brand logo (`web/public/imcodes-brand-logo.png`).
 *
 * Produces:
 *   - `apps/pc-app/build/icon.icns` (macOS iconset via `iconutil -c icns`)
 *   - `apps/pc-app/build/icon.ico`  (Windows multi-size PNG-in-ICO)
 *   - `apps/pc-app/build/icon.png`  (512x512 runtime window/Linux PNG)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PC_APP_DIR = resolve(SCRIPT_DIR, '..');
export const REPO_ROOT = resolve(PC_APP_DIR, '..', '..');
export const BRAND_LOGO_SOURCE = join(REPO_ROOT, 'web', 'public', 'imcodes-brand-logo.png');
export const ROBOT_LOGO_SOURCE = BRAND_LOGO_SOURCE;
export const PC_APP_BUILD_DIR = join(PC_APP_DIR, 'build');

export const ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
export const ICONSET_ENTRIES = Object.freeze([
  ['icon_16x16', 16],
  ['icon_16x16@2x', 32],
  ['icon_32x32', 32],
  ['icon_32x32@2x', 64],
  ['icon_128x128', 128],
  ['icon_128x128@2x', 256],
  ['icon_256x256', 256],
  ['icon_256x256@2x', 512],
  ['icon_512x512', 512],
  ['icon_512x512@2x', 1024],
]);

/** Apple macOS Big Sur+ icon template proportions. */
const MACOS_CONTENT_RATIO = 824 / 1024;
const CORNER_RADIUS_RATIO = 0.2237;

export async function renderPcAppIconPng(size, { contentRatio = 1, source = BRAND_LOGO_SOURCE } = {}) {
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

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: clippedPng, left: offset, top: offset },
      { input: borderSvg, left: offset, top: offset },
    ])
    .png({ compressionLevel: 9, palette: true, quality: 85, dither: 0.2, effort: 10 })
    .toBuffer();
}

export function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2);
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

export async function generatePcAppIcons(outDir = PC_APP_BUILD_DIR, source = BRAND_LOGO_SOURCE) {
  mkdirSync(outDir, { recursive: true });

  // 1. Runtime PNG (512x512 full rounded tile)
  const pngOut = join(outDir, 'icon.png');
  writeFileSync(pngOut, await renderPcAppIconPng(512, { contentRatio: 1, source }));

  // 2. Windows multi-size ICO
  const icoImages = [];
  for (const size of ICO_SIZES) {
    icoImages.push({ size, png: await renderPcAppIconPng(size, { contentRatio: 1, source }) });
  }
  const icoOut = join(outDir, 'icon.ico');
  writeFileSync(icoOut, packIco(icoImages));

  // 3. macOS .icns via iconutil (Apple HIG content ratio inside 1024 canvas)
  const icnsOut = join(outDir, 'icon.icns');
  const tmpRoot = mkdtempSync(join(tmpdir(), 'pc-app-iconset-'));
  try {
    const iconsetDir = join(tmpRoot, 'AppIcon.iconset');
    mkdirSync(iconsetDir, { recursive: true });
    for (const [name, size] of ICONSET_ENTRIES) {
      writeFileSync(
        join(iconsetDir, `${name}.png`),
        await renderPcAppIconPng(size, { contentRatio: MACOS_CONTENT_RATIO, source }),
      );
    }
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsOut], { stdio: 'inherit' });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  return { pngOut, icoOut, icnsOut };
}

if (process.argv[1] && process.argv[1].endsWith('generate-icons.mjs')) {
  const result = await generatePcAppIcons();
  process.stdout.write(`Generated PC App icons:\n- ${result.pngOut}\n- ${result.icoOut}\n- ${result.icnsOut}\n`);
}
