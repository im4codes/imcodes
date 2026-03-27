import type { JSX } from 'preact';

interface FindingEntry {
  round: number;
  type: 'finding' | 'response';
  agent: string;
  content: string;
  timestamp: number;
}

interface AuditFindingsProps {
  findings: FindingEntry[];
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Minimal markdown-ish renderer: bolds **text**, renders bullet lists */
function renderContent(content: string): JSX.Element {
  const lines = content.split('\n');
  const elements: JSX.Element[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBullet = /^[-*]\s/.test(line);
    const text = isBullet ? line.replace(/^[-*]\s/, '') : line;

    // Split on **bold** markers
    const parts = text.split(/(\*\*[^*]+\*\*)/g).map((part, j) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={j}>{part.slice(2, -2)}</strong>;
      }
      return <span key={j}>{part}</span>;
    });

    if (isBullet) {
      elements.push(<li key={i} class="audit-findings__bullet">{parts}</li>);
    } else if (line.trim() === '') {
      elements.push(<br key={i} />);
    } else {
      elements.push(<p key={i} class="audit-findings__para">{parts}</p>);
    }
  }

  // Wrap consecutive <li> elements in a <ul>
  const wrapped: JSX.Element[] = [];
  let listBuf: JSX.Element[] = [];

  function flushList() {
    if (listBuf.length > 0) {
      wrapped.push(<ul class="audit-findings__list">{listBuf}</ul>);
      listBuf = [];
    }
  }

  for (const el of elements) {
    if (el.type === 'li') {
      listBuf.push(el);
    } else {
      flushList();
      wrapped.push(el);
    }
  }
  flushList();

  return <div class="audit-findings__content">{wrapped}</div>;
}

export function AuditFindings({ findings }: AuditFindingsProps) {
  if (findings.length === 0) {
    return (
      <div class="audit-findings audit-findings--empty">
        <span>No findings yet.</span>
      </div>
    );
  }

  // Group by round for display
  const rounds = Array.from(new Set(findings.map((f) => f.round))).sort((a, b) => a - b);

  return (
    <div class="audit-findings">
      {rounds.map((round) => {
        const entries = findings.filter((f) => f.round === round);
        return (
          <div key={round} class="audit-findings__round">
            <div class="audit-findings__round-label">Round {round}</div>
            {entries.map((entry, idx) => {
              const isFinding = entry.type === 'finding';
              return (
                <div
                  key={idx}
                  class={`audit-card audit-card--${entry.type}`}
                  style={{
                    borderLeft: `3px solid ${isFinding ? '#ef4444' : '#3b82f6'}`,
                    background: isFinding ? '#1a0a0a' : '#0a0f1a',
                    borderRadius: '4px',
                    padding: '10px 14px',
                    marginBottom: '8px',
                  }}
                >
                  <div class="audit-card__header">
                    <span
                      class="audit-card__agent"
                      style={{ color: isFinding ? '#f87171' : '#60a5fa', fontWeight: 700, fontSize: '12px' }}
                    >
                      {entry.agent}
                    </span>
                    <span class="audit-card__time" style={{ color: '#64748b', fontSize: '11px', marginLeft: '8px' }}>
                      {formatTime(entry.timestamp)}
                    </span>
                    <span
                      class={`audit-card__type-badge badge`}
                      style={{
                        marginLeft: '8px',
                        background: isFinding ? '#450a0a' : '#1e3a5f',
                        color: isFinding ? '#f87171' : '#93c5fd',
                        fontSize: '10px',
                      }}
                    >
                      {isFinding ? 'FINDING' : 'RESPONSE'}
                    </span>
                  </div>
                  <div class="audit-card__body" style={{ marginTop: '6px' }}>
                    {renderContent(entry.content)}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
