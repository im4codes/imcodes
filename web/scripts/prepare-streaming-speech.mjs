#!/usr/bin/env node
// Build-time only: one checksum-pinned INT8 model shared by Android and iOS.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODEL_REVISION = '8e40c43232a1c5c66c82111efc5820d3accca11b';
const modelBase = `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/${MODEL_REVISION}`;
export const SPEECH_ASSETS = [
  ['models/encoder.int8.onnx', `${modelBase}/encoder.int8.onnx`, '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a', 165462184],
  ['models/decoder.int8.onnx', `${modelBase}/decoder.int8.onnx`, 'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f', 71664561],
  ['models/tokens.txt', `${modelBase}/tokens.txt`, '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6', 75756],
  ['android/libs/sherpa-onnx-2.0.1.aar', 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-2.0.1.aar', 'a8d09d1d32f3eb8520482c6d3d43fae674681c5b050385967c70a3c2c9bf0ee7', 49441341],
];
export async function matchesAsset(file, hash, size) {
  try {
    if ((await stat(file)).size !== size) return false;
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    return digest.digest('hex') === hash;
  } catch { return false; }
}
export async function prepareSpeechAssets(root, download = fetch, assets = SPEECH_ASSETS) {
  for (const [relative, url, hash, size] of assets) {
    const file = new URL(relative, root);
    if (await matchesAsset(file, hash, size)) continue;
    await mkdir(new URL('.', file), { recursive: true });
    // Per-process staging allows parallel CI platforms; only verified bytes publish.
    const pending = new URL(`${relative}.${process.pid}.part`, root);
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await download(url, { signal: AbortSignal.timeout(300_000) });
        if (!response.ok || !response.body) throw new Error(`Speech asset HTTP ${response.status}: ${relative}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(pending, { flags: 'w' }));
        if (!await matchesAsset(pending, hash, size)) throw new Error(`Speech asset checksum/size mismatch: ${relative}`);
        await rename(pending, file);
        break;
      } catch (error) {
        await rm(pending, { force: true });
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  await prepareSpeechAssets(new URL('../plugins/streaming-speech/', import.meta.url));
}
