import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

export interface ModelComboboxProps {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  style?: Record<string, string | number>;
}

/**
 * Model picker used by launch dialogs.  Unlike a native datalist, opening the
 * picker does not treat the pre-filled model as a filter.  Filtering starts
 * only after the user edits the field; custom model ids remain valid.
 */
export function ModelCombobox({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  id,
  className,
  style,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const filteredOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.toLowerCase().includes(needle));
  }, [options, query]);

  return (
    <div ref={rootRef} class="model-combobox" style={{ position: 'relative' }}>
      <input
        class={className}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={id ? `${id}-options` : undefined}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onFocus={() => { setQuery(''); setOpen(true); }}
        onInput={(event) => {
          const next = (event.target as HTMLInputElement).value;
          setQuery(next);
          onChange(next);
          setOpen(true);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 0)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellcheck={false}
        style={style}
      />
      {open && options.length > 0 && (
        <div
          id={id ? `${id}-options` : undefined}
          role="listbox"
          class="model-combobox-options"
          style={{
            position: 'absolute',
            zIndex: 20,
            left: 0,
            right: 0,
            top: 'calc(100% + 2px)',
            maxHeight: 240,
            overflowY: 'auto',
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,.35)',
          }}
        >
          {filteredOptions.map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === value}
              class={`model-combobox-option${option === value ? ' is-selected' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { onChange(option); setQuery(''); setOpen(false); }}
              style={{
                display: 'block',
                width: '100%',
                padding: '7px 10px',
                border: 0,
                background: option === value ? '#1e3a5f' : 'transparent',
                color: '#e2e8f0',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
