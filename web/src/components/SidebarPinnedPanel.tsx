/**
 * SidebarPinnedPanel — a panel pinned to the sidebar.
 * Supports two panel types:
 *   - 'subsession': renders a ChatView for the sub-session (chat only, no terminal)
 *   - 'repo': renders FileBrowser in compact panel mode
 *
 * Includes a resize handle at the bottom and an unpin (×) button in the header.
 *
 * Task 4.2 + 4.3: Generic container with header + content + resize handle.
 * Task 4.6: Shows placeholder if session is not live locally.
 */

import { useRef, useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { ChatView } from './ChatView.js';
import { FileBrowser } from './FileBrowser.js';
import { useTimeline } from '../hooks/useTimeline.js';
import { useTranslation } from 'react-i18next';
import type { WsClient } from '../ws-client.js';
import type { SessionInfo } from '../types.js';
import type { PinnedPanel } from '../app.js';
import type { SubSession } from '../hooks/useSubSessions.js';

const MIN_HEIGHT = 100;

interface SidebarPinnedPanelProps {
  panel: PinnedPanel;
  height: number;
  onUnpin: () => void;
  onResize: (height: number) => void;
  ws: WsClient | null;
  connected: boolean;
  sessions: SessionInfo[];
  subSessions: Array<{ sessionName: string; type: string; label?: string | null; state: string; parentSession?: string | null }>;
  serverId: string;
  /** For repo panels: the project directory to browse */
  projectDir?: string;
  /** For repo panels: input element map for inserting file paths */
  inputRefsMap?: RefObject<Map<string, HTMLDivElement>>;
  /** For repo panels: the currently active main session */
  activeSession?: string | null;
  /** For sub-session panels: the live sub-session object (null = stale/unavailable) */
  liveSubSession?: SubSession;
}

// Small component for a sub-session chat panel
function SubSessionChatPanel({
  sessionName,
  ws,
  connected,
  serverId,
  liveSubSession,
}: {
  sessionName: string;
  ws: WsClient | null;
  connected: boolean;
  serverId: string;
  liveSubSession?: SubSession;
}) {
  const { t } = useTranslation();
  const { events, refreshing } = useTimeline(sessionName, ws);

  if (!liveSubSession) {
    // Task 4.6: stale panel — session not live on this device
    return (
      <div class="sidebar-pinned-unavailable">
        {t('sidebar.session_unavailable')}
      </div>
    );
  }

  return (
    <ChatView
      events={events}
      loading={false}
      refreshing={refreshing}
      sessionId={sessionName}
      sessionState={liveSubSession.state}
      ws={connected ? ws : null}
      workdir={liveSubSession.cwd ?? null}
      serverId={serverId}
    />
  );
}

export function SidebarPinnedPanel({
  panel,
  height,
  onUnpin,
  onResize,
  ws,
  connected,
  serverId,
  projectDir,
  inputRefsMap,
  activeSession,
  liveSubSession,
}: SidebarPinnedPanelProps) {
  const { t } = useTranslation();

  // ── Resize handle (bottom drag) ──────────────────────────────────────────
  const isDraggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const [localHeight, setLocalHeight] = useState(height);

  // Keep local height in sync with prop (on initial mount and external changes)
  useEffect(() => {
    setLocalHeight(height);
  }, [height]);

  const handleResizeMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = localHeight;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = ev.clientY - startYRef.current;
      const newH = Math.max(MIN_HEIGHT, startHeightRef.current + delta);
      setLocalHeight(newH);
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      const delta = ev.clientY - startYRef.current;
      const finalH = Math.max(MIN_HEIGHT, startHeightRef.current + delta);
      setLocalHeight(finalH);
      onResize(finalH); // persist to localStorage via app.tsx
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [localHeight, onResize]);

  // ── Title ────────────────────────────────────────────────────────────────
  const title = useMemo(() => {
    if (panel.type === 'repo') return t('sidebar.pinned_repo');
    if (liveSubSession) return liveSubSession.label ?? liveSubSession.type;
    return panel.sessionName.replace(/^deck_sub_/, '');
  }, [panel, liveSubSession, t]);

  // ── Content ──────────────────────────────────────────────────────────────
  const renderContent = () => {
    if (panel.type === 'repo') {
      if (!ws || !projectDir) {
        return (
          <div class="sidebar-pinned-unavailable">
            {t('sidebar.session_unavailable')}
          </div>
        );
      }
      return (
        <FileBrowser
          ws={ws}
          mode="file-multi"
          layout="panel"
          initialPath={projectDir}
          changesRootPath={projectDir}
          hideFooter={false}
          onConfirm={(paths) => {
            const inputEl = activeSession && inputRefsMap?.current
              ? inputRefsMap.current.get(activeSession)
              : null;
            if (inputEl) {
              const rel = projectDir
                ? paths.map((p) => '@' + (p.startsWith(projectDir + '/') ? p.slice(projectDir.length + 1) : p) + ' ')
                : paths.map((p) => '@' + p + ' ');
              inputEl.textContent = (inputEl.textContent || '') + rel.join('');
              inputEl.focus();
            }
          }}
        />
      );
    }

    // subsession chat panel
    return (
      <SubSessionChatPanel
        sessionName={panel.sessionName}
        ws={ws}
        connected={connected}
        serverId={serverId}
        liveSubSession={liveSubSession}
      />
    );
  };

  return (
    <div class="sidebar-pinned-panel" style={{ height: localHeight, flexShrink: 0 }}>
      {/* Header */}
      <div class="sidebar-pinned-header">
        <span class="sidebar-pinned-title">{title}</span>
        <button
          class="sidebar-pinned-unpin"
          onClick={onUnpin}
          title={t('sidebar.unpin')}
          aria-label={t('sidebar.unpin')}
        >
          ×
        </button>
      </div>

      {/* Content area */}
      <div class="sidebar-pinned-content">
        {renderContent()}
      </div>

      {/* Resize handle at bottom */}
      <div
        class="sidebar-pinned-resize-handle"
        onMouseDown={handleResizeMouseDown}
        aria-hidden="true"
      />
    </div>
  );
}
