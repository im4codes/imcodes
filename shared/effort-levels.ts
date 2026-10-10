export const TRANSPORT_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'adaptive'] as const;

export type TransportEffortLevel = typeof TRANSPORT_EFFORT_LEVELS[number];

export const DEFAULT_TRANSPORT_EFFORT: TransportEffortLevel = 'high';

export const CLAUDE_SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const satisfies readonly TransportEffortLevel[];
/** Fallback until the Codex app-server's model/list metadata is available. */
export const CODEX_SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly TransportEffortLevel[];
export const COPILOT_SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const satisfies readonly TransportEffortLevel[];
export const QWEN_EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const satisfies readonly TransportEffortLevel[];
export const PI_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly TransportEffortLevel[];
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
  ultra:    'Ultra',
  adaptive: 'Adaptive',
};

/** Validate and preserve provider-supplied effort ordering. */
export function normalizeSupportedEffortLevels(value: unknown): TransportEffortLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value.filter((entry): entry is TransportEffortLevel => isTransportEffortLevel(entry));
  return levels.length > 0 ? [...new Set(levels)] : undefined;
}

/** Clamp an effort to the nearest supported level using the shared ordering. */
export function clampTransportEffort(
  requested: TransportEffortLevel | undefined,
  supported: readonly TransportEffortLevel[],
): TransportEffortLevel | undefined {
  if (supported.length === 0) return undefined;
  if (requested && supported.includes(requested)) return requested;
  const requestedIndex = requested ? TRANSPORT_EFFORT_LEVELS.indexOf(requested) : -1;
  return [...supported].sort((a, b) => {
    const aDistance = requestedIndex < 0 ? 0 : Math.abs(TRANSPORT_EFFORT_LEVELS.indexOf(a) - requestedIndex);
    const bDistance = requestedIndex < 0 ? 0 : Math.abs(TRANSPORT_EFFORT_LEVELS.indexOf(b) - requestedIndex);
    return aDistance - bDistance || TRANSPORT_EFFORT_LEVELS.indexOf(a) - TRANSPORT_EFFORT_LEVELS.indexOf(b);
  })[0];
}

/** Human-readable label for a TransportEffortLevel value. */
export function formatEffortLevel(level: TransportEffortLevel): string {
  return EFFORT_DISPLAY_LABELS[level] ?? level;
}
