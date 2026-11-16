import { useTranslation } from 'react-i18next';
import {
  COMPACT_HIJACK_HANDOFF_LIMIT_BOUNDS,
  COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS,
  isValidHandoffLimitValue,
  type CompactHijackHandoffLimitField,
  type CompactHijackHandoffLimitPatch,
  type SessionHandoffLimits,
} from '@shared/compact-hijack.js';

export type HandoffLimitDrafts = Record<CompactHijackHandoffLimitField, string>;

const FIELD_LABEL_KEYS: Record<CompactHijackHandoffLimitField, string> = {
  handoffTextLimit: 'settings.compact_hijack_handoff_text_limit',
  handoffSummaryLimit: 'settings.compact_hijack_handoff_summary_limit',
  handoffMaxChars: 'settings.compact_hijack_handoff_max_chars',
};

export function formatHandoffLimitDrafts(
  limits: SessionHandoffLimits | null | undefined,
  fallbackWithDefaults: boolean,
): HandoffLimitDrafts {
  return {
    handoffTextLimit: limits?.handoffTextLimit !== undefined
      ? String(limits.handoffTextLimit)
      : (fallbackWithDefaults ? String(COMPACT_HIJACK_HANDOFF_LIMIT_BOUNDS.handoffTextLimit.defaultValue) : ''),
    handoffSummaryLimit: limits?.handoffSummaryLimit !== undefined
      ? String(limits.handoffSummaryLimit)
      : (fallbackWithDefaults ? String(COMPACT_HIJACK_HANDOFF_LIMIT_BOUNDS.handoffSummaryLimit.defaultValue) : ''),
    handoffMaxChars: limits?.handoffMaxChars !== undefined
      ? String(limits.handoffMaxChars)
      : (fallbackWithDefaults ? String(COMPACT_HIJACK_HANDOFF_LIMIT_BOUNDS.handoffMaxChars.defaultValue) : ''),
  };
}

export function parseHandoffLimitDrafts(
  drafts: HandoffLimitDrafts,
  options: { allowBlank: boolean },
): { valid: boolean; values: CompactHijackHandoffLimitPatch } {
  const values: CompactHijackHandoffLimitPatch = {};
  for (const field of COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS) {
    const raw = drafts[field].trim();
    if (raw === '') {
      if (!options.allowBlank) return { valid: false, values: {} };
      values[field] = null;
      continue;
    }
    if (!/^\d+$/.test(raw)) return { valid: false, values: {} };
    const parsed = Number(raw);
    if (!isValidHandoffLimitValue(field, parsed)) return { valid: false, values: {} };
    values[field] = parsed;
  }
  return { valid: true, values };
}

interface HandoffLimitsFieldsProps {
  idPrefix: string;
  drafts: HandoffLimitDrafts;
  placeholders?: Partial<Record<CompactHijackHandoffLimitField, number>>;
  disabled?: boolean;
  compact?: boolean;
  onChange: (field: CompactHijackHandoffLimitField, value: string) => void;
}

export function HandoffLimitsFields({
  idPrefix,
  drafts,
  placeholders,
  disabled = false,
  compact = false,
  onChange,
}: HandoffLimitsFieldsProps) {
  const { t } = useTranslation();

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: '8px',
        marginTop: compact ? '6px' : '10px',
      }}
    >
      {COMPACT_HIJACK_HANDOFF_LIMIT_FIELDS.map((field) => {
        const bounds = COMPACT_HIJACK_HANDOFF_LIMIT_BOUNDS[field];
        const label = t(FIELD_LABEL_KEYS[field]);
        const inputId = `${idPrefix}-${field}`;
        const placeholder = placeholders?.[field] !== undefined ? String(placeholders[field]) : undefined;
        return (
          <label
            key={field}
            for={inputId}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              fontSize: '12px',
              color: '#94a3b8',
            }}
          >
            <span>{label}</span>
            <input
              id={inputId}
              class="input"
              type="number"
              inputMode="numeric"
              min={bounds.min}
              max={bounds.max}
              step={1}
              aria-label={label}
              value={drafts[field]}
              placeholder={placeholder}
              disabled={disabled}
              onInput={(e) => onChange(field, (e.target as HTMLInputElement).value)}
              onChange={(e) => onChange(field, (e.target as HTMLInputElement).value)}
              style={{ width: '100%', padding: compact ? '4px 8px' : '6px 8px', fontSize: '12px' }}
            />
          </label>
        );
      })}
    </div>
  );
}
