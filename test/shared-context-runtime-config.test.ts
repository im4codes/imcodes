import { describe, expect, it } from 'vitest';
import {
  getDefaultSharedContextModelForBackend,
  normalizeSharedContextRuntimeConfig,
} from '../shared/shared-context-runtime-config.js';

describe('shared-context-runtime-config', () => {
  it('uses backend-specific defaults when model is missing', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
    });
    expect(result.primaryContextBackend).toBe('qwen');
    expect(result.primaryContextModel).toBe(getDefaultSharedContextModelForBackend('qwen'));
    expect(result.backupContextBackend).toBeUndefined();
    expect(result.backupContextModel).toBeUndefined();
    expect(result.enablePersonalMemorySync).toBe(false);
  });

  it('replaces incompatible saved models with the backend default', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'haiku',
    });
    expect(result.primaryContextBackend).toBe('qwen');
    expect(result.primaryContextModel).toBe(getDefaultSharedContextModelForBackend('qwen'));
    expect(result.backupContextBackend).toBe('codex-sdk');
    expect(result.backupContextModel).toBe(getDefaultSharedContextModelForBackend('codex-sdk'));
  });

  it('keeps a configured backup backend by filling its default model when the model is omitted', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'qwen',
    });
    expect(result.primaryContextBackend).toBe('claude-code-sdk');
    expect(result.primaryContextModel).toBe('sonnet');
    expect(result.backupContextBackend).toBe('qwen');
    expect(result.backupContextModel).toBe(getDefaultSharedContextModelForBackend('qwen'));
  });

  it('passes through primaryContextSdk and backupContextSdk when provided', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      primaryContextSdk: 'anthropic-sdk',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-4.1-mini',
      backupContextSdk: 'openai-sdk',
    });
    expect(result.primaryContextSdk).toBe('anthropic-sdk');
    expect(result.backupContextSdk).toBe('openai-sdk');
  });

  it('omits sdk fields when not provided', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
    });
    expect(result.primaryContextSdk).toBeUndefined();
    expect(result.backupContextSdk).toBeUndefined();
  });

  it('passes through materializationMinIntervalMs when positive', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      materializationMinIntervalMs: 15000,
    });
    expect(result.materializationMinIntervalMs).toBe(15000);
  });

  it('omits materializationMinIntervalMs when zero or negative', () => {
    expect(normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      materializationMinIntervalMs: 0,
    }).materializationMinIntervalMs).toBeUndefined();

    expect(normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      materializationMinIntervalMs: -1,
    }).materializationMinIntervalMs).toBeUndefined();
  });

  it('preserves enablePersonalMemorySync when true', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      enablePersonalMemorySync: true,
    });
    expect(result.enablePersonalMemorySync).toBe(true);
  });

  it('defaults enablePersonalMemorySync to false when undefined', () => {
    const result = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
    });
    expect(result.enablePersonalMemorySync).toBe(false);
  });
});
