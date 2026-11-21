import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PC_APP_SPEECH_MODEL_CHOICES = ['system', 'qwen3-0.6b', 'qwen3-1.7b'] as const;
export type PcAppSpeechModelChoice = (typeof PC_APP_SPEECH_MODEL_CHOICES)[number];
export type PcAppSpeechVariant = '0.6b' | '1.7b';
export type PcAppSpeechModelState = 'idle' | 'downloading' | 'ready' | 'failed' | 'unsupported';

export interface PcAppSpeechModelAssetSpec {
  filename: string;
  expectedSize: number;
  expectedSha256: string;
}

export interface PcAppSpeechModelManifest {
  choice: Exclude<PcAppSpeechModelChoice, 'system'>;
  variant: PcAppSpeechVariant;
  repoId: string;
  revision: string;
  files: readonly PcAppSpeechModelAssetSpec[];
}

export interface PcAppSpeechVariantStatus {
  state: PcAppSpeechModelState;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
  modelDir: string;
}

export interface PcAppSpeechModelStatus {
  selectedModel: PcAppSpeechModelChoice;
  activeBackend: PcAppSpeechModelChoice;
  state: PcAppSpeechModelState;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  mlxSupported: boolean;
  error?: string;
  modelDir?: string;
  downloadingModel?: Exclude<PcAppSpeechModelChoice, 'system'> | null;
  models?: Record<Exclude<PcAppSpeechModelChoice, 'system'>, PcAppSpeechVariantStatus>;
}

export const CHINA_MIRROR_ORIGINS = ['https://hf-mirror.com', 'https://huggingface.co'] as const;
export const GLOBAL_MIRROR_ORIGINS = ['https://huggingface.co', 'https://hf-mirror.com'] as const;

const CHINA_TIMEZONE_IDENTIFIERS = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Urumqi',
  'Asia/Kashgar',
]);

export const SPEECH_MODEL_MANIFESTS: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
  '0.6b': {
    choice: 'qwen3-0.6b',
    variant: '0.6b',
    repoId: 'aufklarer/Qwen3-ASR-0.6B-MLX-4bit',
    revision: 'bc441bd1e4295c1f42d9879f056049a925b6e013',
    files: [
      {
        filename: 'config.json',
        expectedSize: 7187,
        expectedSha256: '923618cf5ca452fda0253a6be5c1a17f94a2e4851d3b98beb45848565587bd72',
      },
      {
        filename: 'merges.txt',
        expectedSize: 1_671_853,
        expectedSha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5',
      },
      {
        filename: 'model.safetensors',
        expectedSize: 708_236_945,
        expectedSha256: '70c7e67e588062adce4f10796e47ad42ead51c6671eda61a0987eae38ca95ddf',
      },
      {
        filename: 'model.safetensors.index.json',
        expectedSize: 71814,
        expectedSha256: 'e3bb80ef0fd42a5be07b04e90c97d60460bbde8af3531e0bfe9100a61404d81a',
      },
      {
        filename: 'tokenizer_config.json',
        expectedSize: 12487,
        expectedSha256: '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c',
      },
      {
        filename: 'vocab.json',
        expectedSize: 2_776_833,
        expectedSha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
      },
    ],
  },
  '1.7b': {
    choice: 'qwen3-1.7b',
    variant: '1.7b',
    repoId: 'aufklarer/Qwen3-ASR-1.7B-MLX-4bit',
    revision: 'd4f9fa3bb45489219f0fcbec671c92d9c1a68fb6',
    files: [
      {
        filename: 'config.json',
        expectedSize: 560,
        expectedSha256: '1928d5e62e90f1c0b085c655fce43ef74ace6731ebf79ec2229729c99a1cf732',
      },
      {
        filename: 'merges.txt',
        expectedSize: 1_671_853,
        expectedSha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5',
      },
      {
        filename: 'model.safetensors',
        expectedSize: 2_225_411_512,
        expectedSha256: '6d3ded9f339df22308f57f3287b32940a7297c4ffc597debcfbeff41ca0ff8bd',
      },
      {
        filename: 'tokenizer_config.json',
        expectedSize: 12487,
        expectedSha256: '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c',
      },
      {
        filename: 'vocab.json',
        expectedSize: 2_776_833,
        expectedSha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
      },
    ],
  },
};

export function choiceToSpeechVariant(choice: PcAppSpeechModelChoice): PcAppSpeechVariant | null {
  if (choice === 'qwen3-0.6b') return '0.6b';
  if (choice === 'qwen3-1.7b') return '1.7b';
  return null;
}

export function isValidSpeechModelChoice(value: unknown): value is PcAppSpeechModelChoice {
  return value === 'system' || value === 'qwen3-0.6b' || value === 'qwen3-1.7b';
}

export function defaultMacosSpeechModelsDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'imcodes-pc-app', 'speech-models');
}

export function verifiedMarkerFilename(revision: string): string {
  return `.verified-${revision}`;
}

export function normalizeMirrorOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/u, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function parseCustomMirrorList(raw: unknown): string[] {
  const entries = typeof raw === 'string'
    ? raw.split(/[\s,;]+/u)
    : Array.isArray(raw)
      ? raw
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const normalized = normalizeMirrorOrigin(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractLocaleRegionSubtag(locale?: string | null): string | null {
  if (typeof locale !== 'string') return null;
  const parts = locale.trim().replace(/_/gu, '-').split('-').filter(Boolean);
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (/^[a-z]{2}$/iu.test(part)) {
      return part.toUpperCase();
    }
  }
  return null;
}

export function isChinaLocaleOrTimeZone(opts: {
  locale?: string | null;
  timeZone?: string | null;
} = {}): boolean {
  const locale = opts.locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (extractLocaleRegionSubtag(locale) === 'CN') {
    return true;
  }
  if (typeof timeZone === 'string' && CHINA_TIMEZONE_IDENTIFIERS.has(timeZone.trim())) {
    return true;
  }
  return false;
}

export function resolvedDefaultMirrorOrigins(opts: {
  locale?: string | null;
  timeZone?: string | null;
} = {}): string[] {
  return isChinaLocaleOrTimeZone(opts)
    ? [...CHINA_MIRROR_ORIGINS]
    : [...GLOBAL_MIRROR_ORIGINS];
}

export function resolvedMirrorOrigins(opts: {
  explicitOrigins?: readonly string[] | null;
  env?: Record<string, string | undefined>;
  customMirrors?: readonly string[] | string | null;
  locale?: string | null;
  timeZone?: string | null;
} = {}): string[] {
  if (opts.explicitOrigins && opts.explicitOrigins.length > 0) {
    const explicit = parseCustomMirrorList([...opts.explicitOrigins]);
    if (explicit.length > 0) {
      return explicit;
    }
  }
  const envRaw = (opts.env ?? process.env).IMCODES_SPEECH_MODEL_MIRRORS;
  const custom = [
    ...parseCustomMirrorList(envRaw),
    ...parseCustomMirrorList(opts.customMirrors),
  ];
  const defaults = resolvedDefaultMirrorOrigins({
    locale: opts.locale,
    timeZone: opts.timeZone,
  });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const origin of [...custom, ...defaults]) {
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

export function buildSpeechModelAssetUrl(
  origin: string,
  manifest: PcAppSpeechModelManifest,
  filename: string,
): string {
  const cleanOrigin = origin.replace(/\/+$/u, '');
  return `${cleanOrigin}/${manifest.repoId}/resolve/${manifest.revision}/${filename}`;
}

/**
 * Atomic file-backed persistence for the PC App's selected speech recognition model.
 * Fails soft to `'system'` on missing, corrupt, or unwritable storage.
 */
export class PcAppSpeechModelStore {
  private readonly filePath: string;

  constructor(userDataDir: string, fileName = 'speech-model.json') {
    this.filePath = path.join(userDataDir, fileName);
  }

  load(): PcAppSpeechModelChoice {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown; model?: unknown } | null;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
        return 'system';
      }
      return isValidSpeechModelChoice(parsed.model) ? parsed.model : 'system';
    } catch {
      return 'system';
    }
  }

  save(model: PcAppSpeechModelChoice): void {
    const dir = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        tmpPath,
        JSON.stringify({ version: 1, model }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      );
      renameSync(tmpPath, this.filePath);
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Fail soft when userDataDir is unwritable.
      }
    }
  }
}

async function computeFileSha256(filePath: string): Promise<{ size: number; sha256: string }> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      hash.update(buf);
    });
    stream.on('end', () => resolveHash({ size, sha256: hash.digest('hex') }));
    stream.on('error', rejectHash);
  });
}

function removeStalePartFiles(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.includes('.part.') || entry.endsWith('.part')) {
        rmSync(path.join(dir, entry), { force: true });
      }
    }
  } catch {
    // Ignore cleanup errors on unreadable dir
  }
}

export interface SpeechModelDownloaderDeps {
  modelsBaseDir: string;
  manifests?: Record<PcAppSpeechVariant, PcAppSpeechModelManifest>;
  explicitMirrors?: readonly string[] | null;
  customMirrors?: readonly string[] | string | null;
  env?: Record<string, string | undefined>;
  locale?: string | null;
  timeZone?: string | null;
  fetchFn?: typeof fetch;
  onProgress?: (event: {
    variant: PcAppSpeechVariant;
    state: 'downloading' | 'ready' | 'failed';
    progress: number;
    downloadedBytes: number;
    totalBytes: number;
    error?: string;
  }) => void;
}

export class PcAppSpeechModelDownloader {
  private readonly modelsBaseDir: string;
  private readonly manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest>;
  private readonly fetchFn: typeof fetch;
  private readonly onProgress?: SpeechModelDownloaderDeps['onProgress'];
  private mirrorOrder: string[];
  private activeDownload: {
    variant: PcAppSpeechVariant;
    controller: AbortController;
    promise: Promise<boolean>;
  } | null = null;

  constructor(deps: SpeechModelDownloaderDeps) {
    this.modelsBaseDir = deps.modelsBaseDir;
    this.manifests = deps.manifests ?? SPEECH_MODEL_MANIFESTS;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.onProgress = deps.onProgress;
    this.mirrorOrder = resolvedMirrorOrigins({
      explicitOrigins: deps.explicitMirrors,
      customMirrors: deps.customMirrors,
      env: deps.env,
      locale: deps.locale,
      timeZone: deps.timeZone,
    });
  }

  getMirrorOrder(): string[] {
    return [...this.mirrorOrder];
  }

  getModelDirectory(variant: PcAppSpeechVariant): string {
    return path.join(this.modelsBaseDir, variant);
  }

  getManifest(variant: PcAppSpeechVariant): PcAppSpeechModelManifest {
    return this.manifests[variant];
  }

  /** Fast check: requires marker `.verified-<rev>` + all manifest files with exact sizes (never `.part.*`). */
  isModelReadySync(variant: PcAppSpeechVariant): boolean {
    const manifest = this.manifests[variant];
    const dir = this.getModelDirectory(variant);
    if (!existsSync(path.join(dir, verifiedMarkerFilename(manifest.revision)))) {
      return false;
    }
    for (const file of manifest.files) {
      const target = path.join(dir, file.filename);
      try {
        const st = statSync(target);
        if (!st.isFile() || st.size !== file.expectedSize) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Full async SHA-256 verification of all manifest files on disk. Removes `.verified-*` if tampered. */
  async verifyModelFilesOnDisk(variant: PcAppSpeechVariant): Promise<boolean> {
    const manifest = this.manifests[variant];
    const dir = this.getModelDirectory(variant);
    const markerPath = path.join(dir, verifiedMarkerFilename(manifest.revision));
    if (!existsSync(dir)) return false;

    for (const file of manifest.files) {
      const target = path.join(dir, file.filename);
      try {
        const st = statSync(target);
        if (!st.isFile() || st.size !== file.expectedSize) {
          rmSync(markerPath, { force: true });
          return false;
        }
        const { size, sha256 } = await computeFileSha256(target);
        if (size !== file.expectedSize || sha256.toLowerCase() !== file.expectedSha256.toLowerCase()) {
          rmSync(markerPath, { force: true });
          return false;
        }
      } catch {
        rmSync(markerPath, { force: true });
        return false;
      }
    }
    return true;
  }

  cancelActive(): void {
    if (this.activeDownload) {
      this.activeDownload.controller.abort();
      this.activeDownload = null;
    }
  }

  getActiveVariant(): PcAppSpeechVariant | null {
    return this.activeDownload?.variant ?? null;
  }

  ensureDownloaded(variant: PcAppSpeechVariant): Promise<boolean> {
    if (this.activeDownload && this.activeDownload.variant === variant) {
      return this.activeDownload.promise;
    }
    if (this.activeDownload && this.activeDownload.variant !== variant) {
      this.activeDownload.controller.abort();
      this.activeDownload = null;
    }

    const controller = new AbortController();
    const runPromise = this.runDownload(variant, controller.signal).finally(() => {
      if (this.activeDownload?.controller === controller) {
        this.activeDownload = null;
      }
    });
    this.activeDownload = { variant, controller, promise: runPromise };
    return runPromise;
  }

  private promoteMirror(winner: string, failed: string[]): void {
    const failedSet = new Set(failed);
    const rest = this.mirrorOrder.filter((m) => m !== winner && !failedSet.has(m));
    const demoted = failed.filter((m) => m !== winner);
    const next: string[] = [winner, ...rest, ...demoted];
    this.mirrorOrder = next;
  }

  private async runDownload(variant: PcAppSpeechVariant, signal: AbortSignal): Promise<boolean> {
    const manifest = this.manifests[variant];
    const dir = this.getModelDirectory(variant);
    const markerPath = path.join(dir, verifiedMarkerFilename(manifest.revision));
    const totalBytes = manifest.files.reduce((sum, f) => sum + f.expectedSize, 0);

    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      removeStalePartFiles(dir);

      let completedBytes = 0;
      const missing: PcAppSpeechModelAssetSpec[] = [];

      for (const spec of manifest.files) {
        if (signal.aborted) return false;
        const destPath = path.join(dir, spec.filename);
        let valid = false;
        try {
          const st = statSync(destPath);
          if (st.isFile() && st.size === spec.expectedSize) {
            const { size, sha256 } = await computeFileSha256(destPath);
            valid = size === spec.expectedSize && sha256.toLowerCase() === spec.expectedSha256.toLowerCase();
          }
        } catch {
          valid = false;
        }
        if (valid) {
          completedBytes += spec.expectedSize;
        } else {
          rmSync(destPath, { force: true });
          rmSync(markerPath, { force: true });
          missing.push(spec);
        }
      }

      if (signal.aborted) return false;

      if (missing.length === 0) {
        this.ensureHotwordsFile(dir);
        writeFileSync(markerPath, manifest.revision, 'utf8');
        this.onProgress?.({
          variant,
          state: 'ready',
          progress: 1,
          downloadedBytes: totalBytes,
          totalBytes,
        });
        return true;
      }

      this.onProgress?.({
        variant,
        state: 'downloading',
        progress: totalBytes > 0 ? completedBytes / totalBytes : 0,
        downloadedBytes: completedBytes,
        totalBytes,
      });

      for (const spec of missing) {
        if (signal.aborted) return false;
        await this.downloadAssetWithMirrorFallback(spec, manifest, dir, signal, (fileBytes) => {
          const current = completedBytes + Math.min(spec.expectedSize, fileBytes);
          const progress = totalBytes > 0 ? Math.min(1, current / totalBytes) : 0;
          this.onProgress?.({
            variant,
            state: 'downloading',
            progress,
            downloadedBytes: current,
            totalBytes,
          });
        });
        completedBytes += spec.expectedSize;
      }

      if (signal.aborted) return false;

      this.ensureHotwordsFile(dir);
      writeFileSync(markerPath, manifest.revision, 'utf8');
      this.onProgress?.({
        variant,
        state: 'ready',
        progress: 1,
        downloadedBytes: totalBytes,
        totalBytes,
      });
      return true;
    } catch (err) {
      removeStalePartFiles(dir);
      if (signal.aborted) {
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.onProgress?.({
        variant,
        state: 'failed',
        progress: 0,
        downloadedBytes: 0,
        totalBytes,
        error: message,
      });
      return false;
    }
  }

  private ensureHotwordsFile(dir: string): void {
    const hotwordsPath = path.join(dir, 'hotwords.txt');
    if (!existsSync(hotwordsPath)) {
      writeFileSync(hotwordsPath, '', 'utf8');
    }
  }

  private async downloadAssetWithMirrorFallback(
    spec: PcAppSpeechModelAssetSpec,
    manifest: PcAppSpeechModelManifest,
    dir: string,
    signal: AbortSignal,
    onFileProgress: (bytes: number) => void,
  ): Promise<void> {
    const candidates = [...this.mirrorOrder];
    const failed: string[] = [];
    let lastError: Error = new Error(`No mirrors available for ${spec.filename}`);

    for (const origin of candidates) {
      if (signal.aborted) {
        throw new Error('Download aborted');
      }
      const url = buildSpeechModelAssetUrl(origin, manifest, spec.filename);
      const partPath = path.join(dir, `${spec.filename}.part.${randomUUID()}`);
      const destPath = path.join(dir, spec.filename);
      try {
        await this.downloadSingleAsset(url, spec, partPath, destPath, signal, onFileProgress);
        this.promoteMirror(origin, failed);
        return;
      } catch (err) {
        rmSync(partPath, { force: true });
        if (signal.aborted) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        failed.push(origin);
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError;
  }

  private async downloadSingleAsset(
    url: string,
    spec: PcAppSpeechModelAssetSpec,
    partPath: string,
    destPath: string,
    signal: AbortSignal,
    onFileProgress: (bytes: number) => void,
  ): Promise<void> {
    const res = await this.fetchFn(url, { signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${spec.filename}`);
    }
    if (!res.body) {
      throw new Error(`Empty response body for ${spec.filename}`);
    }

    const hash = createHash('sha256');
    let receivedBytes = 0;
    const out = createWriteStream(partPath, { flags: 'w', mode: 0o644 });
    const reader = res.body.getReader();

    try {
      while (true) {
        if (signal.aborted) {
          throw new Error('Download aborted');
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        receivedBytes += buf.length;
        hash.update(buf);
        await new Promise<void>((resolveWrite, rejectWrite) => {
          out.write(buf, (writeErr) => (writeErr ? rejectWrite(writeErr) : resolveWrite()));
        });
        onFileProgress(receivedBytes);
      }

      await new Promise<void>((resolveEnd, rejectEnd) => {
        out.end((endErr?: Error | null) => (endErr ? rejectEnd(endErr) : resolveEnd()));
      });
    } catch (err) {
      out.destroy();
      try { await reader.cancel(); } catch { /* ignore */ }
      throw err;
    }

    if (signal.aborted) {
      throw new Error('Download aborted');
    }

    const actualSha = hash.digest('hex').toLowerCase();
    if (receivedBytes !== spec.expectedSize || actualSha !== spec.expectedSha256.toLowerCase()) {
      throw new Error(`Checksum or size mismatch for ${spec.filename}`);
    }

    rmSync(destPath, { force: true });
    renameSync(partPath, destPath);
  }
}
