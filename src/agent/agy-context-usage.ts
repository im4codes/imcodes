import { countTokensFallback } from '../context/tokenizer.js';
import type { ProviderUsageUpdate } from './transport-provider.js';

type Usage = NonNullable<ProviderUsageUpdate['usage']>;
const nonnegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Native occupancy wins. Otherwise expose an explicitly estimated count of
 * the text actually submitted/observed, never a synthetic billing token count.
 * Stores numbers only; no transcript copy or per-chunk history rescanning. */
export class AgyContextUsage {
  private tokens = 0;
  private nativeWindow?: number;
  private nativeUsed?: number;
  private nativeInput = 0;
  private nativeCache = 0;
  private nativeCreated = 0;
  private hasNative = false;

  get hasNativeOccupancy(): boolean {
    return this.hasNative;
  }

  resetToSummary(tokens: number): void {
    this.tokens = Math.max(0, tokens);
    this.nativeUsed = undefined;
    this.nativeInput = 0;
    this.nativeCache = 0;
    this.nativeCreated = 0;
    this.hasNative = false;
  }

  beginPrompt(text: string): void {
    this.nativeUsed = undefined;
    this.addText(text);
  }

  addText(text: string): void {
    this.tokens += countTokensFallback(text);
  }

  normalize(raw: Record<string, unknown> = {}): Usage {
    const input = nonnegative(raw.input_tokens) ?? nonnegative(raw.inputTokens);
    const output = nonnegative(raw.output_tokens) ?? nonnegative(raw.outputTokens);
    const cache = nonnegative(raw.cache_read_input_tokens) ?? nonnegative(raw.cache_read_tokens) ?? nonnegative(raw.cachedReadTokens);
    const created = nonnegative(raw.cache_creation_input_tokens) ?? nonnegative(raw.cachedWriteTokens);
    const used = nonnegative(raw.used);
    const window = nonnegative(raw.model_context_window) ?? nonnegative(raw.size);
    if (window && window > 0) this.nativeWindow = window;
    if (used && used > 0) {
      this.nativeUsed = used;
      this.nativeInput = Math.ceil(used);
      this.nativeCache = 0;
      this.nativeCreated = 0;
      this.hasNative = true;
    }
    const isEstimatedInput = raw.context_usage_estimated === true;
    const rawOccupancy = isEstimatedInput ? 0 : (input ?? 0) + (cache ?? 0) + (created ?? 0);
    if (!this.nativeUsed && rawOccupancy > 0) {
      this.nativeInput = input ?? 0;
      this.nativeCache = cache ?? 0;
      this.nativeCreated = created ?? 0;
      this.hasNative = true;
    }
    const occupancy = this.nativeUsed;
    const native = occupancy ?? rawOccupancy;
    if (native > 0) this.tokens = Math.ceil(native);
    const preserveNativeSplit = !occupancy && rawOccupancy <= 0 && this.hasNative;
    const estimated = native <= 0 && !preserveNativeSplit && this.tokens > 0;
    return {
      ...(occupancy && occupancy > 0 ? { input_tokens: Math.ceil(occupancy), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        : preserveNativeSplit ? {
            input_tokens: Math.max(this.nativeInput, Math.ceil(this.tokens - this.nativeCache - this.nativeCreated)),
            cache_read_input_tokens: this.nativeCache,
            cache_creation_input_tokens: this.nativeCreated,
          }
          : estimated ? { input_tokens: Math.ceil(this.tokens), cache_read_input_tokens: 0, cache_creation_input_tokens: 0, context_usage_estimated: true }
            : { ...(input !== undefined ? { input_tokens: input } : {}), ...(cache !== undefined ? { cache_read_input_tokens: cache } : {}), ...(created !== undefined ? { cache_creation_input_tokens: created } : {}) }),
      ...(output !== undefined ? { output_tokens: output } : {}),
      ...(this.nativeWindow ? { model_context_window: this.nativeWindow } : {}),
    };
  }
}
