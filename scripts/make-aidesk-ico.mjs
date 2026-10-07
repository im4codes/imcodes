#!/usr/bin/env node
/**
 * Builds the Windows application icon from the ONE canonical brand logo (web/public/imcodes-robot-avatar.png), so the panel window
 * host's icon is the same mark every other aiDesk surface shows and no second copy of it is kept in the tree.
 *
 *   node scripts/make-aidesk-ico.mjs OUT.ico
 *
 * An .ico is a directory of images; each entry here is a PNG (supported since Windows Vista) at one standard size.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AIDESK_ICO_SOURCE = join(root, 'web', 'public', 'imcodes-robot-avatar.png');
export const AIDESK_ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);

/** The bytes of an .ico holding one PNG image per size (width/height byte 0 means 256). */
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

export async function buildAideskIco(source = AIDESK_ICO_SOURCE, sizes = AIDESK_ICO_SIZES) {
  const images = [];
  for (const size of sizes) {
    images.push({ size, png: await sharp(source).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer() });
  }
  return packIco(images);
}

if (process.argv[1] && process.argv[1].endsWith('make-aidesk-ico.mjs')) {
  const out = process.argv[2];
  if (!out) { process.stderr.write('usage: make-aidesk-ico.mjs OUT.ico\n'); process.exit(2); }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), await buildAideskIco());
}
