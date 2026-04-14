/**
 * Register all built-in pinned panel types.
 * Import this file once at app startup to populate the registry.
 */
import { registerPanelType, getPanelType } from './PinnedPanelRegistry.js';
import { ChatView } from './ChatView.js';
import { TerminalView } from './TerminalView.js';
import { FileBrowser } from './FileBrowser.js';
import { RepoPage } from '../pages/RepoPage.js';
import { CronManager } from '../pages/CronManager.js';
import { LocalWebPreviewPanel } from './LocalWebPreviewPanel.js';
import { useTimeline } from '../hooks/useTimeline.js';
import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { UsageFooter } from './UsageFooter.js';
import { extractLatestUsage } from '../usage-data.js';
import { getActiveThinkingTs, getActiveStatusText, getTailSessionState, hasActiveToolCall } from '../thinking-utils.js';
import { useNowTicker } from '../hooks/useNowTicker.js';
import type { PinnedPanel } from '../app.js';
import type { PanelRenderContext } from './PinnedPanelRegistry.js';
import { SharedContextManagementPanel } from './SharedContextManagementPanel.js';
import { ContextDiagnosticsPanel } from './ContextDiagnosticsPanel.js';

export const LOCAL_WEB_PREVIEW_PANEL_TYPE = 'localwebpreview';
export const SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE = 'sharedcontext-management';
export const SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE = 'sharedcontext-diagnostics';

// ── Sub-session panel ────────────────────────────────────────────────────

// SubSessionContent — compact pinned session view.
// Intentionally includes: content (chat/terminal), model label, plan/quota badges, thinking indicator.
// Intentionally excludes: full input composer, shortcut row, cost display, session menus.
// For full session chrome, see SubSessionWindow.tsx and SessionPane.tsx.
function SubSessionContent({ panel, ctx }: { panel: PinnedPanel; ctx: PanelRenderContext }) {
  const sessionName = panel.props?.sessionName as string;
  const pinnedViewMode = panel.props?.viewMode as 'terminal' | 'chat' | undefined;
  const { t } = useTranslation();
  const { events, refreshing } = useTimeline(sessionName, ctx.ws, ctx.serverId);
  const liveSub = ctx.subSessions.find(s => s.sessionName === sessionName);

  // Derive usage/thinking state from timeline events (same as SubSessionWindow)
  const lastUsage = useMemo(() => extractLatestUsage(events), [events]);
  const activeThinkingTs = useMemo(() => getActiveThinkingTs(events), [events]);
  const statusText = useMemo(() => getActiveStatusText(events), [events]);
  const activeToolCall = useMemo(() => hasActiveToolCall(events), [events]);
  const liveSessionState = useMemo(
    () => getTailSessionState(events) ?? liveSub?.state ?? null,
    [events, liveSub?.state],
  );
  const thinkingNow = useNowTicker(!!activeThinkingTs);

  if (!liveSub) {
    return <div class="sidebar-pinned-unavailable">{t('sidebar.session_unavailable')}</div>;
  }

  const isShell = liveSub.type === 'shell' || liveSub.type === 'script';
  const mode = pinnedViewMode ?? (isShell ? 'terminal' : 'chat');
  const modelDisplay = liveSub.modelDisplay ?? (liveSub.type === 'qwen' ? liveSub.qwenModel : undefined);
  const compactQuotaText = liveSub.type === 'codex' || liveSub.type === 'codex-sdk'
    ? ''
    : [liveSub.quotaLabel, liveSub.quotaUsageLabel].filter(Boolean).join(' · ');

  return (
    <>
      {mode === 'terminal' ? (
        <TerminalView sessionName={sessionName} ws={ctx.ws} connected={ctx.connected} mobileInput={isShell} />
      ) : (
        <ChatView
          events={events}
          loading={false}
          refreshing={refreshing}
          sessionId={sessionName}
          sessionState={liveSessionState ?? undefined}
          ws={ctx.ws}
          workdir={liveSub.cwd ?? null}
          serverId={ctx.serverId}
          onQuote={ctx.onQuote}
        />
      )}
      {(lastUsage || activeThinkingTs || activeToolCall || statusText || liveSessionState === 'running' || liveSessionState === 'idle' || liveSub.planLabel || liveSub.quotaLabel || liveSub.quotaUsageLabel || liveSub.quotaMeta) && (
        <UsageFooter
          usage={lastUsage ?? { inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
          sessionName={sessionName}
          sessionState={liveSessionState}
          agentType={liveSub.type}
          modelOverride={modelDisplay ?? undefined}
          planLabel={liveSub.planLabel}
          quotaLabel={liveSub.quotaLabel}
          quotaUsageLabel={(liveSub.type === 'codex' || liveSub.type === 'codex-sdk') ? undefined : liveSub.quotaUsageLabel}
          quotaMeta={liveSub.quotaMeta}
          showCost={false}
          activeThinkingTs={activeThinkingTs}
          statusText={statusText}
          activeToolCall={activeToolCall}
          now={thinkingNow}
        />
      )}
      {(compactQuotaText || liveSub.planLabel) && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 8px', flexShrink: 0 }}>
          {compactQuotaText && (
            <span class="session-usage-quota-inline">{compactQuotaText}</span>
          )}
          {liveSub.planLabel && (
            <span class="session-usage-quota-inline" style={{ color: '#93c5fd' }}>{liveSub.planLabel}</span>
          )}
        </div>
      )}
    </>
  );
}

registerPanelType('subsession', {
  title: (panel, ctx) => {
    const sessionName = (panel.props?.sessionName as string) ?? '';
    const liveSub = ctx?.subSessions.find(s => s.sessionName === sessionName);
    const label = liveSub?.label ?? (panel.props?.label as string) ?? sessionName.replace(/^deck_sub_/, '');
    const agentType = liveSub?.type;
    return agentType ? `${label} · ${agentType}` : label;
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
        key={`${ctx.serverId}:${projectDir}`}
        ws={ctx.ws}
        serverId={ctx.serverId}
        mode="file-multi"
        layout="panel"
        defaultTab="changes"
        initialPath={projectDir}
        changesRootPath={projectDir}
        hideFooter={false}
        onPreviewStateChange={ctx.onPreviewStateChange}
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
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
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
    // Follow active tab's project dir — keep mounted during WS reconnect to preserve state
    const projectDir = ctx.activeProjectDir ?? panel.props?.projectDir as string | undefined;
    if (!ctx.ws || !projectDir) return <div class="sidebar-pinned-unavailable">No project dir</div>;
    return (
      <RepoPage
        key={`${ctx.serverId}:${projectDir}`}
        ws={ctx.ws}
        projectDir={projectDir}
        onBack={() => {}}
        onCiEvent={ctx.onCiEvent ?? (() => {})}
      />
    );
  },
});

// ── Cron manager panel ──────────────────────────────────────────────────

registerPanelType('cronmanager', {
  title: () => 'Scheduled Tasks',
  render: (panel, ctx) => {
    // Derive project from active session, fall back to pinned prop
    const projectName = (ctx.sessions?.find(s => s.name === ctx.activeSession)?.project
      ?? panel.props?.projectName as string | undefined);
    if (!projectName) return <div class="sidebar-pinned-unavailable">No project</div>;
    const subSessionsSlim = ctx.subSessions.map(s => ({
      sessionName: s.sessionName, type: s.type, label: s.label, state: s.state, parentSession: s.parentSession,
    }));
    return (
      <CronManager
        key={`${ctx.serverId}:${projectName}`}
        serverId={ctx.serverId}
        projectName={projectName}
        sessions={(ctx.sessions ?? []) as any}
        subSessions={subSessionsSlim}
        activeSession={ctx.activeSession}
        onBack={() => {}}
        onNavigateSession={(sessionName, quote) => {
          window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { session: sessionName, quote } }));
        }}
        onViewDiscussion={(fileId) => {
          window.dispatchEvent(new CustomEvent('deck:view-discussion', { detail: { fileId } }));
        }}
        servers={ctx.servers}
      />
    );
  },
});

// ── Local web preview panel ──────────────────────────────────────────────

registerPanelType(LOCAL_WEB_PREVIEW_PANEL_TYPE, {
  title: (panel, ctx) => {
    const port = panel.props?.port as string | number | undefined;
    const path = (panel.props?.path as string | undefined)?.trim() || '/';
    const suffix = path && path !== '/' ? `${port ? `:${port}` : ''}${path}` : (port ? `:${port}` : '');
    const label = ctx?.t('localWebPreview.title') ?? 'Local Web Preview';
    return `🌐 ${label}${suffix}`;
  },
  render: (panel, ctx) => {
    const serverId = (panel.props?.serverId as string | undefined) ?? ctx.serverId;
    if (!serverId) return <div class="sidebar-pinned-unavailable">No server selected</div>;
    return (
      <LocalWebPreviewPanel
        serverId={serverId}
        port={panel.props?.port as string | number | undefined}
        path={panel.props?.path as string | undefined}
        onDraftChange={({ port, path }) => {
          ctx.updatePanelProps?.(panel.id, {
            ...panel.props,
            serverId,
            port,
            path,
          });
        }}
      />
    );
  },
});

registerPanelType(SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE, {
  title: (_panel, ctx) => ctx?.t('sharedContext.management.title') ?? 'Shared Context',
  render: (panel, ctx) => (
    <SharedContextManagementPanel
      enterpriseId={typeof panel.props?.enterpriseId === 'string' ? panel.props.enterpriseId : undefined}
      onEnterpriseChange={(enterpriseId) => ctx.updatePanelProps?.(panel.id, { ...panel.props, enterpriseId })}
    />
  ),
});

registerPanelType(SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE, {
  title: (_panel, ctx) => ctx?.t('sharedContext.diagnostics.title') ?? 'Context Diagnostics',
  render: (panel, ctx) => (
    <ContextDiagnosticsPanel
      enterpriseId={typeof panel.props?.enterpriseId === 'string' ? panel.props.enterpriseId : undefined}
      canonicalRepoId={typeof panel.props?.canonicalRepoId === 'string' ? panel.props.canonicalRepoId : undefined}
      workspaceId={typeof panel.props?.workspaceId === 'string' ? panel.props.workspaceId : undefined}
      enrollmentId={typeof panel.props?.enrollmentId === 'string' ? panel.props.enrollmentId : undefined}
      language={typeof panel.props?.language === 'string' ? panel.props.language : undefined}
      filePath={typeof panel.props?.filePath === 'string' ? panel.props.filePath : undefined}
      persistedSnapshot={panel.props?.persistedSnapshot as Parameters<typeof ContextDiagnosticsPanel>[0]['persistedSnapshot']}
      onStateChange={(next) => ctx.updatePanelProps?.(panel.id, { ...panel.props, ...next })}
    />
  ),
});
