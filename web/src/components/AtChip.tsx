/**
 * AtChip — inline styled chip for @-mention tokens in the input.
 * Shows agent or file reference as a small pill with a delete button.
 */

interface AtChipProps {
  type: 'agent' | 'file';
  label: string;
  onDelete: () => void;
}

const agentStyle: Record<string, string | number> = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '1px 6px',
  borderRadius: 9999,
  fontSize: 12,
  lineHeight: '20px',
  background: 'rgba(37, 99, 235, 0.2)',
  border: '1px solid rgba(59, 130, 246, 0.4)',
  color: '#93c5fd',
  verticalAlign: 'middle',
  maxWidth: 200,
  whiteSpace: 'nowrap' as any,
};

const fileStyle: Record<string, string | number> = {
  ...agentStyle,
  background: 'rgba(22, 163, 74, 0.2)',
  border: '1px solid rgba(34, 197, 94, 0.4)',
  color: '#86efac',
};

const deleteBtnStyle: Record<string, string | number> = {
  background: 'none',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  padding: 0,
  fontSize: 11,
  lineHeight: 1,
  opacity: 0.6,
  marginLeft: 2,
};

export function AtChip({ type, label, onDelete }: AtChipProps) {
  const style = type === 'agent' ? agentStyle : fileStyle;

  return (
    <span style={style}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <button
        type="button"
        style={deleteBtnStyle}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Remove"
      >
        &times;
      </button>
    </span>
  );
}
