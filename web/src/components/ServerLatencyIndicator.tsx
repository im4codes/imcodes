export interface ServerLatencyIndicatorProps {
  connected?: boolean;
  latencyMs?: number | null;
  className?: string;
}

export function ServerLatencyIndicator({ connected, latencyMs, className }: ServerLatencyIndicatorProps) {
  const latencyColor = !connected ? '#ef4444' : latencyMs == null ? '#4ade80' : latencyMs < 150 ? '#4ade80' : latencyMs < 400 ? '#f59e0b' : '#ef4444';
  const latencyTitle = connected ? (latencyMs != null ? `${latencyMs}ms` : 'Connected') : 'Disconnected';
  const valClass = className ? `${className}-val` : 'server-latency-val';

  return (
    <span
      class={className}
      style={{ color: latencyColor }}
      title={latencyTitle}
    >
      ●{connected && latencyMs != null && <span class={valClass}> {latencyMs}ms</span>}
    </span>
  );
}
