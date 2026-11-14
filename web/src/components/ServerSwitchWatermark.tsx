/**
 * Centered translucent floating HUD watermark shown briefly after switching
 * servers via keyboard shortcuts (`serverPrev` / `serverNext`).
 */
import { useEffect, useState } from 'preact/hooks';

export const SERVER_SWITCH_WATERMARK_HOLD_MS = 1000;
export const SERVER_SWITCH_WATERMARK_EXIT_MS = 200;

export type ServerSwitchWatermarkKind = 'server' | 'session';

export interface ServerSwitchWatermarkProps {
  visible: boolean;
  triggerKey: number;
  serverName: string;
  sessionName: string | null;
  switchKind?: ServerSwitchWatermarkKind;
  fallbackLabel?: string | null;
  shortcutKeycaps?: readonly string[];
  onDismiss: () => void;
  holdMs?: number;
  exitMs?: number;
}

export function ServerSwitchWatermark({
  visible,
  triggerKey,
  serverName,
  sessionName,
  switchKind = 'server',
  fallbackLabel = null,
  shortcutKeycaps = [],
  onDismiss,
  holdMs = SERVER_SWITCH_WATERMARK_HOLD_MS,
  exitMs = SERVER_SWITCH_WATERMARK_EXIT_MS,
}: ServerSwitchWatermarkProps) {
  const [exiting, setExiting] = useState(false);
  const [trackedTriggerKey, setTrackedTriggerKey] = useState(triggerKey);
  if (trackedTriggerKey !== triggerKey) {
    setTrackedTriggerKey(triggerKey);
    if (exiting) setExiting(false);
  }

  useEffect(() => {
    if (!visible) {
      setExiting(false);
      return;
    }
    setExiting(false);
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    const holdTimer = setTimeout(() => {
      setExiting(true);
      exitTimer = setTimeout(() => {
        onDismiss();
      }, exitMs);
    }, holdMs);

    return () => {
      clearTimeout(holdTimer);
      if (exitTimer !== null) clearTimeout(exitTimer);
    };
  }, [visible, triggerKey, holdMs, exitMs, onDismiss]);

  if (!visible) return null;

  const secondaryText = sessionName || fallbackLabel || null;
  const isFallback = !sessionName && Boolean(fallbackLabel);

  return (
    <div
      class={`server-switch-watermark is-${switchKind}${exiting ? ' is-exiting' : ''}`}
      data-testid="server-switch-watermark"
      data-state={exiting ? 'exiting' : 'visible'}
      data-switch-kind={switchKind}
      aria-hidden="true"
    >
      <div class={`server-switch-watermark-card is-${switchKind}`}>
        <div class="server-switch-watermark-server">
          <span class="server-switch-watermark-server-name" data-testid="server-switch-watermark-server">
            {serverName}
          </span>
        </div>
        {secondaryText && (
          <div class={`server-switch-watermark-session${isFallback ? ' is-muted' : ''}`}>
            <span class="server-switch-watermark-session-name" data-testid="server-switch-watermark-session">
              {secondaryText}
            </span>
          </div>
        )}
        {shortcutKeycaps.length > 0 && (
          <div class="server-switch-watermark-shortcut" data-testid="server-switch-watermark-shortcut">
            {shortcutKeycaps.map((cap, index) => (
              <kbd class="server-switch-watermark-kbd" key={`${index}:${cap}`}>
                {cap}
              </kbd>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
