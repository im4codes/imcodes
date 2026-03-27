interface StatsBarProps {
  total: number;
  active: number;
  completed: number;
  failed: number;
  avgDurationMs?: number;
}

interface StatBoxProps {
  label: string;
  value: string | number;
  valueColor?: string;
}

function StatBox({ label, value, valueColor }: StatBoxProps) {
  return (
    <div
      class="stats-bar__box"
      style={{
        background: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '6px',
        padding: '10px 16px',
        flex: 1,
        minWidth: '80px',
        textAlign: 'center',
      }}
    >
      <div
        class="stats-bar__value"
        style={{ fontSize: '22px', fontWeight: 700, color: valueColor ?? '#e2e8f0', lineHeight: 1.2 }}
      >
        {value}
      </div>
      <div
        class="stats-bar__label"
        style={{ fontSize: '11px', color: '#64748b', marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}
      >
        {label}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

export function StatsBar({ total, active, completed, failed, avgDurationMs }: StatsBarProps) {
  const successRate = completed > 0 ? Math.round(((completed - failed) / completed) * 100) : 0;
  const successRateColor = successRate >= 80 ? '#4ade80' : '#f87171';

  return (
    <div
      class="stats-bar"
      style={{ display: 'flex', gap: '8px', padding: '8px 0', flexWrap: 'wrap' }}
    >
      <StatBox label="Total" value={total} />
      <StatBox label="Active" value={active} valueColor="#60a5fa" />
      <StatBox label="Completed" value={completed} valueColor="#4ade80" />
      <StatBox label="Failed" value={failed} valueColor={failed > 0 ? '#f87171' : '#e2e8f0'} />
      <StatBox
        label="Success Rate"
        value={`${successRate}%`}
        valueColor={successRateColor}
      />
      {avgDurationMs !== undefined && (
        <StatBox
          label="Avg Duration"
          value={formatDuration(avgDurationMs)}
          valueColor="#a78bfa"
        />
      )}
    </div>
  );
}
