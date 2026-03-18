interface ReviewEntry {
  round: number;
  approved: boolean;
  content: string;
  timestamp: number;
}

interface ReviewFlowProps {
  coderSession: string;
  auditorSession: string;
  reviews: ReviewEntry[];
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function TerminalPlaceholder({ sessionName }: { sessionName: string }) {
  return (
    <div
      class="review-flow__terminal"
      style={{
        background: '#0f0f13',
        borderRadius: '6px',
        border: '1px solid #334155',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: '200px',
      }}
    >
      <div
        class="review-flow__terminal-header"
        style={{
          padding: '6px 12px',
          background: '#1e293b',
          borderBottom: '1px solid #334155',
          fontSize: '11px',
          color: '#94a3b8',
          borderRadius: '6px 6px 0 0',
        }}
      >
        {sessionName}
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#334155',
          fontSize: '12px',
        }}
      >
        terminal
      </div>
    </div>
  );
}

export function ReviewFlow({ coderSession, auditorSession, reviews }: ReviewFlowProps) {
  return (
    <div
      class="review-flow"
      style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1fr', gap: '12px', height: '100%', minHeight: '300px' }}
    >
      {/* Left: Coder terminal */}
      <div class="review-flow__panel review-flow__panel--coder">
        <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Coder
        </div>
        <TerminalPlaceholder sessionName={coderSession} />
      </div>

      {/* Center: Review thread */}
      <div class="review-flow__panel review-flow__panel--thread">
        <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Review Thread
        </div>
        <div
          class="review-flow__thread"
          style={{
            overflowY: 'auto',
            maxHeight: '400px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {reviews.length === 0 && (
            <div style={{ color: '#64748b', fontSize: '12px', padding: '16px 0', textAlign: 'center' }}>
              No reviews yet.
            </div>
          )}
          {reviews.map((review, idx) => {
            const isApproved = review.approved;
            return (
              <div
                key={idx}
                class={`review-card review-card--${isApproved ? 'approved' : 'rejected'}`}
                style={{
                  borderLeft: `3px solid ${isApproved ? '#22c55e' : '#ef4444'}`,
                  background: isApproved ? '#0a1a0f' : '#1a0a0a',
                  borderRadius: '4px',
                  padding: '8px 12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span style={{ color: '#64748b', fontSize: '11px' }}>Round {review.round}</span>
                  <span
                    class="badge"
                    style={{
                      background: isApproved ? '#14532d' : '#450a0a',
                      color: isApproved ? '#4ade80' : '#f87171',
                      fontSize: '10px',
                    }}
                  >
                    {isApproved ? 'APPROVED' : 'REJECTED'}
                  </span>
                  <span style={{ color: '#475569', fontSize: '10px', marginLeft: 'auto' }}>
                    {formatTime(review.timestamp)}
                  </span>
                </div>
                <div style={{ color: '#cbd5e1', fontSize: '12px', lineHeight: 1.5 }}>
                  {review.content}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Auditor terminal */}
      <div class="review-flow__panel review-flow__panel--auditor">
        <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Auditor
        </div>
        <TerminalPlaceholder sessionName={auditorSession} />
      </div>
    </div>
  );
}
