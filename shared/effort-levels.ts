export const TRANSPORT_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'adaptive'] as const;

export type TransportEffortLevel = typeof TRANSPORT_EFFORT_LEVELS[number];

export const DEFAULT_TRANSPORT_EFFORT: TransportEffortLevel = 'high';

export const CLAUDE_SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const satisfies readonly TransportEffortLevel[];
export const CODEX_SDK_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly TransportEffortLevel[];
export const COPILOT_SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const satisfies readonly TransportEffortLevel[];
export const QWEN_EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const satisfies readonly TransportEffortLevel[];
export const OPENCLAW_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'adaptive'] as const satisfies readonly TransportEffortLevel[];

export function isTransportEffortLevel(value: unknown): value is TransportEffortLevel {
  return typeof value === 'string' && (TRANSPORT_EFFORT_LEVELS as readonly string[]).includes(value);
}

const EFFORT_DISPLAY_LABELS: Record<TransportEffortLevel, string> = {
  off:      'Off',
  minimal:  'Minimal',
  low:      'Low',
  medium:   'Medium',
  high:     'High',
  xhigh:    'Extra High',
  max:      'Max',
  adaptive: 'Adaptive',
};

/** Human-readable label for a TransportEffortLevel value. */
export function formatEffortLevel(level: TransportEffortLevel): string {
  return EFFORT_DISPLAY_LABELS[level] ?? level;
}
