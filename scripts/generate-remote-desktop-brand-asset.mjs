#!/usr/bin/env node
/**
 * Derive the Windows worker's compiled brand bitmap from the ONE canonical
 * logo, `web/public/imcodes-robot-avatar.png`.
 *
 * The worker cannot read a PNG off disk: it runs as SYSTEM on the interactive
 * desktop, often before any user profile is loaded, and the indicator must be
 * visible for the entire session with no I/O dependency and no network. So the
 * pixels are compiled in. To keep that from becoming a second logo that drifts
 * from the web one, this generator is the only writer of the header and
 * `--check` re-derives it byte-for-byte in CI: editing either the canonical PNG
 * or the generated header without regenerating fails the build-manifest test.
 *
 * Output is premultiplied BGRA at fixed pixel sizes so the indicator can
 * AlphaBlend it directly -- no WIC/GDI+ decode, no COM apartment, nothing that
 * can fail at paint time inside a session-0/secure-desktop transition.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CANONICAL_LOGO = resolve(ROOT, 'web', 'public', 'imcodes-robot-avatar.png');
export const GENERATED_HEADER = resolve(
  ROOT, 'native', 'windows-remote-desktop', 'brand_logo_generated.h',
);
/**
 * 20 logical px at 100/150/200/300% DPI. The indicator picks the nearest size
 * at or above what the monitor needs, so every common scale gets exact pixels
 * instead of a resample.
 */
export const LOGO_SIZES = [20, 30, 40, 60];

function hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Minimal PNG reader for exactly the shape the canonical logo has: 8-bit
 * RGBA, non-interlaced. Deliberately dependency-free -- an image library
 * would put its own resampler version between the canonical logo and the
 * compiled bytes, so a routine dependency bump could silently change the
 * binary. Node's zlib plus IEEE754 arithmetic is reproducible everywhere.
 */
function decodePng(png) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG has no IHDR');
  if (header.bitDepth !== 8 || header.colorType !== 6 || header.interlace !== 0) {
    throw new Error(`unsupported PNG: depth=${header.bitDepth} color=${header.colorType} interlace=${header.interlace}`);
  }
  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      out[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, rgba: out };
}

/**
 * Box downscale with exact fractional edge coverage, averaging PREMULTIPLIED
 * channels so transparent pixels cannot bleed their colour into the halo.
 */
function downscaleToPremultipliedBgra(image, size) {
  const { width, height, rgba } = image;
  const bgra = Buffer.alloc(size * size * 4);
  const scaleX = width / size;
  const scaleY = height / size;
  for (let ty = 0; ty < size; ty += 1) {
    const y0 = ty * scaleY; const y1 = y0 + scaleY;
    for (let tx = 0; tx < size; tx += 1) {
      const x0 = tx * scaleX; const x1 = x0 + scaleX;
      let sb = 0; let sg = 0; let sr = 0; let sa = 0; let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * width + sx) * 4;
          const a = rgba[i + 3] / 255;
          sr += rgba[i] * a * w;
          sg += rgba[i + 1] * a * w;
          sb += rgba[i + 2] * a * w;
          sa += rgba[i + 3] * w;
          weight += w;
        }
      }
      const o = (ty * size + tx) * 4;
      bgra[o] = Math.min(255, Math.round(sb / weight));
      bgra[o + 1] = Math.min(255, Math.round(sg / weight));
      bgra[o + 2] = Math.min(255, Math.round(sr / weight));
      bgra[o + 3] = Math.min(255, Math.round(sa / weight));
    }
  }
  return bgra;
}

function emitArray(name, bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(`    ${[...bytes.subarray(i, i + 16)].map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')},`);
  }
  return `inline constexpr unsigned char ${name}[] = {\n${lines.join('\n')}\n};\n`;
}

export async function renderHeader() {
  const png = await readFile(CANONICAL_LOGO);
  const digest = hex(png);
  const image = decodePng(png);
  const parts = [];
  const table = [];
  for (const size of LOGO_SIZES) {
    const bgra = downscaleToPremultipliedBgra(image, size);
    parts.push(emitArray(`kLogoBgra${size}`, bgra));
    table.push(`    {${size}, kLogoBgra${size}},`);
  }
  return `// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Produced by scripts/generate-remote-desktop-brand-asset.mjs from the single
// canonical logo web/public/imcodes-robot-avatar.png. Re-run that script after
// changing the logo; test/spec/windows-remote-desktop-build-manifests.test.ts
// fails if this file and the canonical PNG ever disagree.
//
// source: web/public/imcodes-robot-avatar.png
// sha256: ${digest}

#ifndef IMCODES_REMOTE_DESKTOP_BRAND_LOGO_GENERATED_H_
#define IMCODES_REMOTE_DESKTOP_BRAND_LOGO_GENERATED_H_

namespace imcodes::rd::brand {

// sha256 of the canonical PNG these bitmaps were derived from.
inline constexpr char kCanonicalLogoSha256[] = "${digest}";

// Premultiplied BGRA, top-down, no padding: size * size * 4 bytes each.
${parts.join('\n')}
struct LogoBitmap {
  int size;
  const unsigned char* premultiplied_bgra;
};

inline constexpr LogoBitmap kLogoBitmaps[] = {
${table.join('\n')}
};

inline constexpr int kLogoBitmapCount =
    static_cast<int>(sizeof(kLogoBitmaps) / sizeof(kLogoBitmaps[0]));

}  // namespace imcodes::rd::brand

#endif  // IMCODES_REMOTE_DESKTOP_BRAND_LOGO_GENERATED_H_
`;
}

const isCheck = process.argv.includes('--check');
if (import.meta.url === `file://${process.argv[1]}`) {
  const rendered = await renderHeader();
  if (isCheck) {
    const current = await readFile(GENERATED_HEADER, 'utf8').catch(() => '');
    if (current !== rendered) {
      console.error('brand_logo_generated.h is stale; run: node scripts/generate-remote-desktop-brand-asset.mjs');
      process.exit(1);
    }
    console.log('brand_logo_generated.h matches the canonical logo');
  } else {
    await writeFile(GENERATED_HEADER, rendered);
    console.log(`wrote ${GENERATED_HEADER}`);
  }
}
