import { describe, expect, it } from 'vitest';
import {
  getDefaultSharedContextModelForBackend,
  normalizeSharedContextRuntimeConfig,
} from '../shared/shared-context-runtime-config.js';

describe('shared-context-runtime-config', () => {
  it('uses backend-specific defaults when model is missing', () => {
    expect(normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
    })).toEqual({
      primaryContextBackend: 'qwen',
      primaryContextModel: getDefaultSharedContextModelForBackend('qwen'),
      backupContextBackend: undefined,
      backupContextModel: undefined,
    });
  });

  it('replaces incompatible saved models with the backend default', () => {
    expect(normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'qwen',
      primaryContextModel: 'sonnet',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'haiku',
    })).toEqual({
      primaryContextBackend: 'qwen',
      primaryContextModel: getDefaultSharedContextModelForBackend('qwen'),
      backupContextBackend: 'codex-sdk',
      backupContextModel: getDefaultSharedContextModelForBackend('codex-sdk'),
    });
  });
});
