/**
 * Register all built-in pinned panel types.
 * Import this file once at app startup to populate the registry.
 */
import { registerPanelType, getPanelType } from './PinnedPanelRegistry.js';
import { ChatView } from './ChatView.js';
import { TerminalView } from './TerminalView.js';
import { FileBrowser } from './FileBrowser.js';
import { RepoPage } from '../pages/RepoPage.js';
import { useTimeline } from '../hooks/useTimeline.js';
import { useTranslation } from 'react-i18next';
import type { PinnedPanel } from '../app.js';
import type { PanelRenderContext } from './PinnedPanelRegistry.js';

// ── Sub-session panel ────────────────────────────────────────────────────

function SubSessionContent({ panel, ctx }: { panel: PinnedPanel; ctx: PanelRenderContext }) {
  const sessionName = panel.props?.sessionName as string;
  const pinnedViewMode = panel.props?.viewMode as 'terminal' | 'chat' | undefined;
  const { t } = useTranslation();
  const { events, refreshing } = useTimeline(sessionName, ctx.ws);
  const liveSub = ctx.subSessions.find(s => s.sessionName === sessionName);

  if (!liveSub) {
    return <div class="sidebar-pinned-unavailable">{t('sidebar.session_unavailable')}</div>;
  }

  const isShell = liveSub.type === 'shell' || liveSub.type === 'script';
  const mode = pinnedViewMode ?? (isShell ? 'terminal' : 'chat');

  if (mode === 'terminal') {
    return <TerminalView sessionName={sessionName} ws={ctx.ws} connected={ctx.connected} />;
  }

  return (
    <ChatView
      events={events}
      loading={false}
      refreshing={refreshing}
      sessionId={sessionName}
      sessionState={liveSub.state}
      ws={ctx.connected ? ctx.ws : null}
      workdir={liveSub.cwd ?? null}
      serverId={ctx.serverId}
    />
  );
}

registerPanelType('subsession', {
  title: (panel) => {
    const name = (panel.props?.sessionName as string) ?? '';
    return (panel.props?.label as string) ?? name.replace(/^deck_sub_/, '');
  },
  render: (panel, ctx) => <SubSessionContent panel={panel} ctx={ctx} />,
});

// ── File browser panel ───────────────────────────────────────────────────

registerPanelType('filebrowser', {
  title: () => '📁 Files',
  render: (panel, ctx) => {
    // Follow active tab's project dir; fall back to captured dir at pin time
    const projectDir = ctx.activeProjectDir ?? panel.props?.projectDir as string | undefined;
    if (!ctx.ws || !projectDir) return <div class="sidebar-pinned-unavailable">No project dir</div>;
    const activeSession = ctx.activeSession ?? panel.props?.sessionName as string | undefined;
    return (
      <FileBrowser
        ws={ctx.ws}
        mode="file-multi"
        layout="panel"
        initialPath={projectDir}
        changesRootPath={projectDir}
        hideFooter={false}
        onPreviewFile={ctx.onPreviewFile}
        onConfirm={(paths) => {
          const inputEl = activeSession && ctx.inputRefsMap?.current
            ? ctx.inputRefsMap.current.get(activeSession)
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
  },
});

// ── Legacy 'repo' type — alias for filebrowser ───────────────────────────

registerPanelType('repo', {
  title: () => '📁 Files',
  render: (panel, ctx) => {
    const reg = getPanelType('filebrowser');
    return reg ? reg.render(panel, ctx) : null;
  },
});

// ── Repository page panel ────────────────────────────────────────────────

registerPanelType('repopage', {
  title: () => 'Repository',
  render: (panel, ctx) => {
    // Follow active tab's project dir
    const projectDir = ctx.activeProjectDir ?? panel.props?.projectDir as string | undefined;
    if (!ctx.ws || !projectDir) return <div class="sidebar-pinned-unavailable">No project dir</div>;
    return (
      <RepoPage
        ws={ctx.ws}
        projectDir={projectDir}
        onBack={() => {}}
        onCiEvent={ctx.onCiEvent ?? (() => {})}
      />
    );
  },
});
