export const TRANSPORT_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max', 'adaptive'] as const;

export type TransportEffortLevel = typeof TRANSPORT_EFFORT_LEVELS[number];

export const DEFAULT_TRANSPORT_EFFORT: TransportEffortLevel = 'high';

export const CLAUDE_SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const satisfies readonly TransportEffortLevel[];
export const CODEX_SDK_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high'] as const satisfies readonly TransportEffortLevel[];
export const COPILOT_SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const satisfies readonly TransportEffortLevel[];
export const QWEN_EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const satisfies readonly TransportEffortLevel[];
export const OPENCLAW_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'adaptive'] as const satisfies readonly TransportEffortLevel[];

export function isTransportEffortLevel(value: unknown): value is TransportEffortLevel {
  return typeof value === 'string' && (TRANSPORT_EFFORT_LEVELS as readonly string[]).includes(value);
}
