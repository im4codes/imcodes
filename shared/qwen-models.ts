export interface QwenModelOption {
  id: string;
  description: string;
}

export const QWEN_MODEL_OPTIONS: QwenModelOption[] = [
  { id: 'qwen3-coder-plus', description: 'Optimized for coding tasks' },
  { id: 'qwen3.5-plus', description: 'Advanced model with thinking enabled' },
  { id: 'qwen3-coder-next', description: 'Next-generation coding model' },
  { id: 'qwen3-max', description: 'High-capability max model' },
  { id: 'glm-4.7', description: 'Available in Coding Plan model picker' },
  { id: 'kimi-k2.5', description: 'Available in Coding Plan model picker' },
] as const;

export const QWEN_MODEL_IDS = QWEN_MODEL_OPTIONS.map((model) => model.id);
