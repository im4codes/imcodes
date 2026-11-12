#!/usr/bin/env node
// Build-time only: one checksum-pinned Qwen3-ASR-0.6B INT4 model shared by Android and iOS.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODEL_REVISION = '9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e';
const modelBase = `https://huggingface.co/goodpixelltd/qwen3-asr-0.6b-int4-sherpa-onnx/resolve/${MODEL_REVISION}`;
export const SPEECH_ASSETS = [
  ['models/conv_frontend.onnx', `${modelBase}/conv_frontend.onnx`, 'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e', 44148281],
  ['models/encoder.int4.onnx', `${modelBase}/encoder.int4.onnx`, '774e997d23a2f06c3f544666625c93a3b824fdd83d04c6acd88ee25f4e3b6e2e', 5622024],
  ['models/encoder.int4.weights', `${modelBase}/encoder.int4.weights`, 'dc66975d9be10fbd31f89c76d33dd0bf4a8059ef14da4abf545bbf9895a5293d', 110308864],
  ['models/decoder.int4.onnx', `${modelBase}/decoder.int4.onnx`, 'c588d2a89460315f51ca8c65dbe85a0619891500fc853e5b673e3c914c25b2d3', 891837],
  ['models/decoder.int4.weights', `${modelBase}/decoder.int4.weights`, '126c8e16074cc87250dacbf07602315e3bc5239c93ea414773b6e3a6fd4bf466', 469962752],
  ['models/tokenizer/vocab.json', `${modelBase}/tokenizer/vocab.json`, 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910', 2776833],
  ['models/tokenizer/merges.txt', `${modelBase}/tokenizer/merges.txt`, '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5', 1671853],
  ['models/tokenizer/tokenizer_config.json', `${modelBase}/tokenizer/tokenizer_config.json`, '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c', 12487],
  ['models/hotwords.txt', null, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 0],
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
  // Retire only known obsolete assets, and only after the new model verifies.
  if (assets.some(([relative]) => relative === 'models/conv_frontend.onnx')) {
    for (const name of ['encoder.int8.onnx', 'decoder.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'punct.int8.onnx', 'tokens.txt', 'bpe.vocab']) {
      await rm(new URL(`models/${name}`, root), { force: true });
    }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  await prepareSpeechAssets(new URL('../plugins/streaming-speech/', import.meta.url));
}
