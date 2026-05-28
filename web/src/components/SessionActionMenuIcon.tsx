export type SessionActionIconKind = 'pin' | 'unpin' | 'restart' | 'new' | 'rename' | 'settings' | 'clone' | 'stop';

export function SessionActionMenuIcon({ kind }: { kind: SessionActionIconKind }) {
  const common = {
    width: '16',
    height: '16',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '2',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  } as const;

  return (
    <span class={`session-action-menu-icon session-action-menu-icon-${kind}`} aria-hidden="true">
      {kind === 'pin' && (
        <svg {...common}>
          <path d="M12 17v5" />
          <path d="M5 17h14" />
          <path d="m16 3 5 5" />
          <path d="M8 3h8l-2 7 3 3v4H7v-4l3-3L8 3Z" />
        </svg>
      )}
      {kind === 'unpin' && (
        <svg {...common}>
          <path d="m3 3 18 18" />
          <path d="M12 17v5" />
          <path d="M5 17h12" />
          <path d="M8 3h8l-1.2 4.3" />
          <path d="M10 10 7 13v4h7" />
          <path d="m16 3 5 5" />
        </svg>
      )}
      {kind === 'restart' && (
        <svg {...common}>
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      )}
      {kind === 'new' && (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      )}
      {kind === 'rename' && (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      )}
      {kind === 'settings' && (
        <svg {...common}>
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6l-.09.09a2 2 0 1 1-3.82 0L10 20a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1l-.09-.09a2 2 0 1 1 0-3.82L4 10a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6l.09-.09a2 2 0 1 1 3.82 0L14 4a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.25.32.46.66.6 1l.09.09a2 2 0 1 1 0 3.82L20 14a1.7 1.7 0 0 0-.6 1Z" />
        </svg>
      )}
      {kind === 'clone' && (
        <svg {...common}>
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
      {kind === 'stop' && (
        <svg {...common}>
          <rect width="14" height="14" x="5" y="5" rx="2" />
        </svg>
      )}
    </span>
  );
}
