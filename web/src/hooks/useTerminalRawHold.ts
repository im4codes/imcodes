import { useEffect } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';

/**
 * Keep a shell/script session's raw PTY stream subscribed for as long as the
 * calling surface is mounted — INDEPENDENT of focus.
 *
 * Shell/script sessions are deliberately excluded from the passive "always-on"
 * terminal subscription set (see terminal-subscribe-mode.ts) and have no chat
 * timeline to replay, so their live PTY output IS their status. Without a
 * focus-independent hold, an open-but-unfocused shell window/card/pinned panel
 * (e.g. one the user keeps at the side to observe) stops receiving output and
 * freezes.
 *
 * Uses the ref-counted `ws.holdTerminalRaw` so multiple surfaces for the same
 * session coexist and the server is only told to stop streaming when the LAST
 * holder unmounts. Falls back to a plain raw subscribe/unsubscribe when the
 * hold API is unavailable (older ws-client).
 *
 * @param enabled pass `isShell` (or any condition) — the hold only arms when true.
 */
export function useTerminalRawHold(
  ws: WsClient | null | undefined,
  connected: boolean,
  enabled: boolean,
  sessionName: string,
): void {
  useEffect(() => {
    if (!enabled || !ws || !connected) return;
    if (typeof ws.holdTerminalRaw === 'function') {
      return ws.holdTerminalRaw(sessionName);
    }
    try { ws.subscribeTerminal(sessionName, true); } catch { /* ignore */ }
    return () => { try { ws.unsubscribeTerminal(sessionName); } catch { /* ignore */ } };
  }, [ws, connected, enabled, sessionName]);
}
