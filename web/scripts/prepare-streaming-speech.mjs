#!/usr/bin/env node
// Build-time only: one checksum-pinned INT8 model shared by Android and iOS.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODEL_REVISION = '98590b7ed6443e77b714204da2757d75e1a642f4';
export const PUNCT_MODEL_REVISION = '5cccf43af83e4fc50d1d55b8410312e87709be70';
const modelBase = `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/${MODEL_REVISION}`;
const punctModelBase = `https://huggingface.co/ranger810/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/resolve/${PUNCT_MODEL_REVISION}`;
export const SPEECH_ASSETS = [
  ['models/encoder.int8.onnx', `${modelBase}/encoder-epoch-99-avg-1.int8.onnx`, '8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b', 181895032],
  ['models/decoder.onnx', `${modelBase}/decoder-epoch-99-avg-1.onnx`, '2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d', 13876452],
  ['models/joiner.int8.onnx', `${modelBase}/joiner-epoch-99-avg-1.int8.onnx`, '1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0', 3228404],
  ['models/tokens.txt', `${modelBase}/tokens.txt`, 'a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3', 56317],
  ['models/bpe.vocab', `${modelBase}/bpe.vocab`, 'd0b642f3a2eacd5fadefdeff9e0e1358cab729647cbb7fe58cf738e1f7407029', 12564],
  ['models/hotwords.txt', null, '26feefe92ea440b2cd286ace1b4d386db86990bd6f6a95e921cdbe0c1af79b49', 53],
  ['models/punct.int8.onnx', `${punctModelBase}/model.int8.onnx`, '65a3fb9f5ad7bfb96bf69e0dc4481df97f6ee60513c1d94ce981ba6effd524b1', 75519198],
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
    if (!url) throw new Error(`Bundled speech asset missing/corrupt: ${relative}`);
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
  // A cached old decoder would otherwise be copied into both app packages.
  if (assets.some(([relative]) => relative === 'models/decoder.onnx')) {
    await rm(new URL('models/decoder.int8.onnx', root), { force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  await prepareSpeechAssets(new URL('../plugins/streaming-speech/', import.meta.url));
}
