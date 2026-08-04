/**
 * SubSessionBar — bottom panel showing sub-session preview cards.
 * Cards show live chat/terminal previews. Single or double row layout.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks';
import type { JSX } from 'preact';
import { useTranslation } from 'react-i18next';
import { SubSessionCard } from './SubSessionCard.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';
import { isVisuallyBusy } from '../thinking-utils.js';
import { reorderSubSessions } from '../api.js';
import { formatLabel } from '../format-label.js';
import { getAgentBadgeLabel } from '../agent-display.js';
import { resolveContextWindow } from '../model-context.js';
import { bestModelLabel } from '../model-label.js';
import { P2pProgressCard } from './P2pProgressCard.js';
import type { P2pProgressDiscussion } from './P2pProgressCard.js';
import { IdleFlashLayer } from './IdleFlashLayer.js';
import { useIdleFlashPlayback } from '../hooks/useIdleFlashPlayback.js';
import { useNowTicker } from '../hooks/useNowTicker.js';
import { EmbeddingStatusIcon } from './EmbeddingStatusIcon.js';
import { SharedStateIndicator } from './SharedStateIndicator.js';
import type { SharedStateSummary } from '../tab-sharing-ui.js';
import type { EmbeddingStatus } from '@shared/embedding-status.js';
import type { DiskUsage } from '@shared/disk-usage.js';
import type { MemoryShortRefHealth } from '@shared/memory-short-ref-health.js';
import { formatDaemonVersionMobile, formatDaemonVersionShort } from '../util/format-version.js';
import { isAuthoritativeUsageContextWindowSource, type UsageContextWindowSource } from '@shared/usage-context-window.js';
import { resolveQuickAgentDelegationModel } from '../quick-agent-delegation-model.js';
import {
  createSubSessionEntryGestureController,
  type SubSessionEntryGestureController,
} from '../subsession-entry-gesture.js';
import {
  DEFAULT_SUBSESSION_ACCENT_COLOR,
  getSubSessionAccentColorMap,
} from '../subsession-accent-colors.js';
import { OpenSpecAutoDeliverRunBar } from './OpenSpecAutoDeliver.js';
import type { OpenSpecAutoDeliverProjection } from '../openspec-auto-deliver.js';
import {
  DIRECT_CONNECTIVITY_ENDPOINT_KIND,
  DIRECT_CONNECTIVITY_PROBE_STAGE,
  DIRECT_CONNECTIVITY_ROUTE,
  DIRECT_CONNECTIVITY_RUNTIME_STATE,
  DIRECT_FILE_TRANSFER_CAPABILITY,
  DIRECT_FILE_TRANSFER_ERROR,
  inferDirectConnectivityEndpointKind,
  inferDirectConnectivityEndpointKindFromTypes,
  type DirectConnectivityCandidateInfo,
  type DirectConnectivityCandidateType,
  type DirectConnectivityEndpointKind,
  type DirectConnectivityProbeDiagnostics,
  type DirectConnectivityProbeResult,
  type DirectConnectivityProbeStage,
  type DirectConnectivityRuntimeStatus,
} from '@shared/direct-file-transfer.js';
import { DirectFileTransferFailure, probeDirectConnectivity } from '../direct-file-transfer.js';

interface DaemonStats {
  daemonVersion?: string | null;
  cpu: number;
  memUsed: number;
  memTotal: number;
  load1: number;
  load5: number;
  load15: number;
  uptime: number;
  embedding?: EmbeddingStatus | null;
  disks?: DiskUsage[] | null;
  shortRefHealth?: MemoryShortRefHealth | null;
  directConnectivity?: DirectConnectivityRuntimeStatus | null;
}

type DiscussionSummary = P2pProgressDiscussion & {
  currentSpeaker?: string;
  filePath?: string;
  fileId?: string;
};

interface CollapsedSubSessionButtonProps {
  sub: SubSession;
  accentColor: string;
  isOpen: boolean;
  isFocused: boolean;
  idleFlashToken: number;
  usage?: { inputTokens: number; cacheTokens: number; contextWindow: number; contextWindowSource?: UsageContextWindowSource; model?: string };
  detectedModel?: string;
  sharedState?: SharedStateSummary | null;
  inP2p: boolean;
  draggable?: boolean;
  onEntryPointerDown: (id: string, event: JSX.TargetedPointerEvent<HTMLButtonElement>) => void;
  onEntryTouchStart: (id: string) => void;
  onEntryClick: (id: string, event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
  onEntryDoubleClick: (id: string, event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
  onEntryDragStart: (id: string, event: JSX.TargetedDragEvent<HTMLButtonElement>) => void;
  onEntryDragOver: (id: string, event: JSX.TargetedDragEvent<HTMLButtonElement>) => void;
  onEntryDragEnd: (id: string, event: JSX.TargetedDragEvent<HTMLButtonElement>) => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

interface Props {
  subSessions: SubSession[];
  openIds: Set<string>;
  maximizedIds?: ReadonlySet<string>;
  desktopLayoutCapable?: boolean;
  idleFlashTokens?: Map<string, number>;
  sharedSubSessionStates?: ReadonlyMap<string, SharedStateSummary>;
  onOpen: (id: string) => void;
  onFocus?: (id: string) => void;
  onClose: (id: string) => void;
  onCloseAllOpen?: () => void;
  onRestoreQuickClosed?: (ids: string[]) => void;
  onOpenMaximized?: (id: string) => void;
  onMaximize?: (id: string) => void;
  onRestore?: (id: string) => void;
  onRestoreThenClose?: (id: string) => void;
  onRestart: (id: string) => void;
  onNew?: () => void;
  onViewAutoDeliver?: () => void;
  onViewDiscussions?: () => void;
  onViewDiscussion?: (fileId: string) => void;
  onViewRepo?: () => void;
  onViewCron?: () => void;
  openSpecAutoProjection?: OpenSpecAutoDeliverProjection | null;
  openSpecAutoStopPending?: boolean;
  openSpecAutoCompact?: boolean;
  onOpenSpecAutoView?: () => void;
  onOpenSpecAutoStop?: () => void;
  onOpenSpecAutoToggleCompact?: () => void;
  onOpenSpecAutoHide?: () => void;

  discussions?: DiscussionSummary[];
  /**
   * Total number of in-progress P2P discussions across the whole
   * daemon (NOT scoped to the active session). The scoped
   * `discussions` array shows only those relevant to the current
   * session view; this number is rendered as a badge on the
   * "View Discussions" (👥) button so the user can see at a glance
   * that more runs exist elsewhere even when this session has none.
   */
  totalRunningDiscussions?: number;
  onStopDiscussion?: (id: string) => void;
  ws: WsClient | null;
  connected: boolean;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
  serverId?: string;
  /** Per-sub-session usage data (ctx tokens, model) collected from timeline events. */
  subUsages?: Map<string, { inputTokens: number; cacheTokens: number; contextWindow: number; contextWindowSource?: UsageContextWindowSource; model?: string }>;
  /** Last model detected from timeline/terminal events, keyed by sessionName. */
  detectedModels?: Map<string, string>;
  /** ID of the currently focused (topmost) sub-session window. */
  focusedSubId?: string | null;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onVisualOrderChange?: (ids: string[]) => void;
  /** Quick data for compact SessionControls in cards. */
  quickData?: import('./QuickInputPanel.js').UseQuickDataResult;
  /** All sessions — for @ picker. */
  sessions?: import('../types.js').SessionInfo[];
  /** All sub-sessions slim — for @ picker. */
  allSubSessions?: Array<{ sessionName: string; type: string; label?: string | null; state: string; parentSession?: string | null }>;
  /** Set of sub-session labels participating in active P2P discussions. */
  p2pSessionLabels?: Set<string>;
  onSubTransportConfigSaved?: (subId: string, transportConfig: Record<string, unknown> | null) => void;
}

type Layout = 'single' | 'double';

interface CardSize { w: number; h: number }

const DEFAULT_SIZE: CardSize = { w: 350, h: 250 };
export const SUBSESSION_BAR_COLLAPSED_STORAGE_KEY = 'rcc_subcard_collapsed';
const P2P_MOBILE_COMPACT_STORAGE_KEY = 'rcc_subcard_p2p_hidden';
const P2P_DESKTOP_COMPACT_STORAGE_KEY = 'rcc_subcard_p2p_desktop_compact';
const EXPANDED_PREVIEW_INITIAL_COUNT = 2;
const EXPANDED_PREVIEW_BATCH_SIZE = 4;
const EXPANDED_PREVIEW_BATCH_DELAY_MS = 32;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v) return JSON.parse(v) as T;
  } catch { /* ignore */ }
  return fallback;
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

function formatMemoryPair(usedBytes: number, totalBytes: number): string {
  const totalGb = totalBytes / (1024 ** 3);
  if (totalGb >= 1) {
    return `${(usedBytes / (1024 ** 3)).toFixed(1)} / ${totalGb.toFixed(1)} GB`;
  }
  return `${(usedBytes / (1024 ** 2)).toFixed(0)} / ${(totalBytes / (1024 ** 2)).toFixed(0)} MB`;
}

/** Format a used/total byte pair in a shared GB or TB unit — never smaller
 *  units, so disk sizes always read as e.g. "440/460GB" or "1.2/2.0TB". */
function formatDiskPair(usedBytes: number, totalBytes: number): string {
  const useTb = totalBytes >= 1024 ** 4;
  const div = useTb ? 1024 ** 4 : 1024 ** 3;
  const unit = useTb ? 'TB' : 'GB';
  const fmt = (b: number) => {
    const v = b / div;
    return v >= 100 ? v.toFixed(0) : v.toFixed(1);
  };
  return `${fmt(usedBytes)}/${fmt(totalBytes)}${unit}`;
}

function shortMountLabel(mount: string): string {
  if (mount === '/') return '/';
  const seg = mount.replace(/[\\/]+$/, '').split(/[/\\]/).filter(Boolean).pop();
  return seg || mount;
}

function diskUsageColor(usedPercent: number): string | undefined {
  return usedPercent >= 90 ? '#f87171' : usedPercent >= 75 ? '#fbbf24' : undefined;
}

/**
 * Desktop-only disk-capacity readout for the daemon stats strip. Shows up to two
 * partitions inline; with more than two, only the fullest shows inline (plus a
 * "+N" hint) and every partition is listed in the hover tooltip. Mobile clients
 * receive no disk data, so this renders nothing there.
 */
/**
 * Memory handles stopped persisting. The daemon can only report this over the
 * socket — its counter is process-local and its log shares the disk that is
 * usually what failed — so this marker is the one place an operator sees it.
 */
function renderShortRefAlert(health: MemoryShortRefHealth | null | undefined, t: (k: string, v?: Record<string, unknown>) => string): JSX.Element | null {
  if (!health) return null;
  const when = new Date(health.lastFailureAt).toLocaleString();
  return (
    <span
      class="daemon-stat-shortref-alert"
      style={{ color: '#f87171' }}
      title={t('memory.short_ref_failure_detail', { stage: health.stage, failures: health.failures, when, error: health.lastError })}
    >
      <span style={{ fontSize: '0.65em', verticalAlign: 'middle' }}>⚠️</span>
      {t('memory.short_ref_failure_short')}
    </span>
  );
}

function renderDiskStats(disks: DiskUsage[] | null | undefined): JSX.Element | null {
  if (!disks || disks.length === 0) return null;
  const tooltip = disks
    .map((d) => `${shortMountLabel(d.mount)}  ${formatDiskPair(d.usedBytes, d.totalBytes)} (${d.usedPercent}%)`)
    .join('\n');
  const inline = disks.length <= 2 ? disks : disks.slice(0, 1);
  return (
    <span class="daemon-stat-disk" title={tooltip}>
      {inline.map((d, i) => (
        <span style={{ color: diskUsageColor(d.usedPercent) }}>
          {i > 0 ? ' ' : ''}
          <span style={{ fontSize: '0.65em', verticalAlign: 'middle' }}>💾</span>
          {formatDiskPair(d.usedBytes, d.totalBytes)}
        </span>
      ))}
      {disks.length > 2 && <span style={{ opacity: 0.7 }}>+{disks.length - 1}</span>}
    </span>
  );
}

function formatLocalDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderTechClockDigits(text: string, keyPrefix: string): JSX.Element {
  return (
    <>
      {Array.from(text).map((char, index) => (
        <span
          key={`${keyPrefix}-${index}-${char}`}
          class={/\d/.test(char) ? 'daemon-local-clock-digit' : 'daemon-local-clock-separator'}
        >
          {char}
        </span>
      ))}
    </>
  );
}

function renderTechClock(text: string): JSX.Element {
  const [dateText, timeText] = text.includes(' ') ? text.split(' ', 2) : ['', text];
  if (!dateText) {
    return <span class="daemon-local-clock-time">{renderTechClockDigits(timeText, 'time')}</span>;
  }
  return (
    <>
      <span class="daemon-local-clock-date">{renderTechClockDigits(dateText, 'date')}</span>
      <span class="daemon-local-clock-space" aria-hidden="true"> </span>
      <span class="daemon-local-clock-time">{renderTechClockDigits(timeText, 'time')}</span>
    </>
  );
}

function CollapsedSubSessionButton({ sub, accentColor, isOpen, isFocused, idleFlashToken, usage, sharedState, inP2p, draggable, onEntryPointerDown, onEntryTouchStart, onEntryClick, onEntryDoubleClick, onEntryDragStart, onEntryDragOver, onEntryDragEnd, t, detectedModel }: CollapsedSubSessionButtonProps) {
  const activeIdleFlashToken = useIdleFlashPlayback(idleFlashToken);
  const agentTag = sub.type === 'shell' ? (sub.shellBin?.split(/[/\\]/).pop() ?? 'shell') : sub.type;
  const label = sub.label ? `${formatLabel(sub.label)} · ${agentTag}` : agentTag;
  const abbr = getAgentBadgeLabel(sub.type);
  const effectiveModel = resolveQuickAgentDelegationModel(sub, detectedModel, usage?.model);
  const model = bestModelLabel(effectiveModel, usage?.model);
  let ctxPct = 0;
  if (usage) {
    const ctx = resolveContextWindow(
      usage.contextWindow,
      effectiveModel,
      1_000_000,
      { preferExplicit: isAuthoritativeUsageContextWindowSource(usage.contextWindowSource) },
    );
    ctxPct = Math.min(100, (usage.inputTokens + usage.cacheTokens) / ctx * 100);
  }

  return (
    <button
      key={sub.id}
      data-sub-id={sub.id}
      class={`subsession-card${isOpen ? ' open' : ''}${isFocused ? ' focused' : ''} mobile${isVisuallyBusy(sub.state, false) ? ' subcard-running-pulse' : ''}`}
      draggable={draggable}
      onPointerDown={(event) => onEntryPointerDown(sub.id, event)}
      onTouchStart={() => onEntryTouchStart(sub.id)}
      onClick={(event) => onEntryClick(sub.id, event)}
      onDblClick={(event) => onEntryDoubleClick(sub.id, event)}
      onDragStart={(event) => onEntryDragStart(sub.id, event)}
      onDragOver={(event) => onEntryDragOver(sub.id, event)}
      onDragEnd={(event) => onEntryDragEnd(sub.id, event)}
      title={label + (model ? ` · ${model}` : '') + (ctxPct > 0 ? ` · ctx ${ctxPct.toFixed(0)}%` : '')}
      style={{ '--subsession-accent-color': accentColor } as JSX.CSSProperties}
    >
      {activeIdleFlashToken ? <IdleFlashLayer key={`subbutton-idle-${activeIdleFlashToken}`} variant="frame" /> : null}
      <span class="subsession-card-icon">{abbr}</span>
      <span class="subsession-card-label">{sub.label ? formatLabel(sub.label).slice(0, 12) : agentTag.slice(0, 6)}</span>
      {inP2p && <span class="p2p-tag">{t('session.p2p_tag')}</span>}
      <SharedStateIndicator state={sharedState} iconOnly />
      {model && <span class="subsession-card-model">{model}</span>}
      {sub.ccPresetId && <span class="subsession-card-custom-api" title={`Custom API: ${sub.ccPresetId}`}>◉</span>}
      {sub.state === 'starting' && <span class="subsession-card-badge">…</span>}
      {ctxPct > 0 && (
        <span class="subsession-card-ctx" style={{ width: '100%' }}>
          <span class="subsession-card-ctx-fill" style={{ width: `${ctxPct}%` }} />
        </span>
      )}
    </button>
  );
}

function ExpandedSubSessionPlaceholder({ sub, accentColor, cardSize, sharedState, inP2p, t }: { sub: SubSession; accentColor: string; cardSize: CardSize; sharedState?: SharedStateSummary | null; inP2p: boolean; t: (key: string, vars?: Record<string, unknown>) => string }) {
  const agentTag = sub.type === 'shell' ? (sub.shellBin?.split(/[/\\]/).pop() ?? 'shell') : sub.type;
  const label = sub.label ? `${formatLabel(sub.label)} · ${agentTag}` : agentTag;
  const abbr = getAgentBadgeLabel(sub.type);
  return (
    <div
      class={`subcard subcard-preview-placeholder${isVisuallyBusy(sub.state, false) ? ' subcard-running-pulse' : ''}`}
      style={{
        width: cardSize.w,
        height: cardSize.h,
        minWidth: cardSize.w,
        position: 'relative',
        '--subsession-accent-color': accentColor,
      } as JSX.CSSProperties}
    >
      <div class="subcard-header">
        <span class="subcard-icon">{abbr}</span>
        <span class="subcard-label">{label}</span>
        {inP2p && <span class="p2p-tag">{t('session.p2p_tag')}</span>}
        <SharedStateIndicator state={sharedState} iconOnly />
      </div>
    </div>
  );
}

function DaemonStatsModal({
  stats,
  ws,
  localClockText,
  onClose,
  t,
}: {
  stats: DaemonStats;
  ws: WsClient | null;
  localClockText: string;
  onClose: () => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const PROBE_VIEW_STATE = {
    IDLE: 'idle',
    PROBING: 'probing',
    SUCCESS: 'success',
    FAILED: 'failed',
  } as const;
  const [probeState, setProbeState] = useState<typeof PROBE_VIEW_STATE[keyof typeof PROBE_VIEW_STATE]>(PROBE_VIEW_STATE.IDLE);
  const [probeResult, setProbeResult] = useState<DirectConnectivityProbeResult | null>(null);
  const [probeDiagnostics, setProbeDiagnostics] = useState<DirectConnectivityProbeDiagnostics | null>(null);
  const [probeErrorKey, setProbeErrorKey] = useState<string | null>(null);
  const autoProbeStarted = useRef(false);
  const embeddingKey = stats.embedding?.state
    ? `embedding.status_${stats.embedding.state}`
    : 'embedding.status_unknown';
  const shortRefHealth = stats.shortRefHealth;
  const capabilityReady = Boolean(ws?.getDaemonCapabilitySnapshot?.()?.capabilities.includes(DIRECT_FILE_TRANSFER_CAPABILITY));
  const runtimeUnavailable = stats.directConnectivity?.state === DIRECT_CONNECTIVITY_RUNTIME_STATE.RUNTIME_UNAVAILABLE;

  const runProbe = useCallback(async () => {
    if (!ws || runtimeUnavailable || !capabilityReady) return;
    setProbeState(PROBE_VIEW_STATE.PROBING);
    setProbeResult(null);
    setProbeDiagnostics({
      stage: DIRECT_CONNECTIVITY_PROBE_STAGE.AUTHORIZING,
      browserCandidateTypes: [],
      daemonCandidateTypes: [],
    });
    setProbeErrorKey(null);
    try {
      const result = await probeDirectConnectivity(ws, setProbeDiagnostics);
      setProbeResult(result);
      setProbeDiagnostics((current) => ({
        stage: DIRECT_CONNECTIVITY_PROBE_STAGE.COMPLETE,
        browserCandidateTypes: current?.browserCandidateTypes ?? [],
        daemonCandidateTypes: current?.daemonCandidateTypes ?? [],
      }));
      setProbeState(PROBE_VIEW_STATE.SUCCESS);
    } catch (error) {
      const code = error instanceof DirectFileTransferFailure ? error.code : DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED;
      const key = code === DIRECT_FILE_TRANSFER_ERROR.NEGOTIATION_TIMEOUT
        ? 'subsessionBar.daemon_details_direct_timeout'
        : code === DIRECT_FILE_TRANSFER_ERROR.DAEMON_OFFLINE
          ? 'subsessionBar.daemon_details_direct_signaling_failed'
          : code === DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE
            ? 'subsessionBar.daemon_details_direct_runtime_unavailable'
            : 'subsessionBar.daemon_details_direct_ice_failed';
      setProbeErrorKey(key);
      setProbeState(PROBE_VIEW_STATE.FAILED);
    }
  }, [capabilityReady, runtimeUnavailable, ws]);

  useEffect(() => {
    if (autoProbeStarted.current || !capabilityReady || runtimeUnavailable) return;
    autoProbeStarted.current = true;
    void runProbe();
  }, [capabilityReady, runProbe, runtimeUnavailable]);

  const routeKey = probeResult?.route === DIRECT_CONNECTIVITY_ROUTE.LAN_DIRECT
    ? 'subsessionBar.daemon_details_direct_lan'
    : probeResult?.route === DIRECT_CONNECTIVITY_ROUTE.RELAY
      ? 'subsessionBar.daemon_details_direct_relay'
      : 'subsessionBar.daemon_details_direct_ip';
  const probeStageKeys: Record<DirectConnectivityProbeStage, string> = {
    [DIRECT_CONNECTIVITY_PROBE_STAGE.AUTHORIZING]: 'subsessionBar.daemon_details_direct_stage_authorizing',
    [DIRECT_CONNECTIVITY_PROBE_STAGE.CREATING_OFFER]: 'subsessionBar.daemon_details_direct_stage_offer',
    [DIRECT_CONNECTIVITY_PROBE_STAGE.EXCHANGING_CANDIDATES]: 'subsessionBar.daemon_details_direct_stage_candidates',
    [DIRECT_CONNECTIVITY_PROBE_STAGE.CHECKING]: 'subsessionBar.daemon_details_direct_stage_checking',
    [DIRECT_CONNECTIVITY_PROBE_STAGE.DATA_CHANNEL_OPEN]: 'subsessionBar.daemon_details_direct_stage_channel',
    [DIRECT_CONNECTIVITY_PROBE_STAGE.VERIFYING]: 'subsessionBar.daemon_details_direct_stage_verifying',
    [DIRECT_CONNECTIVITY_PROBE_STAGE.COMPLETE]: 'subsessionBar.daemon_details_direct_stage_complete',
  };
  const endpointKindKeys: Record<DirectConnectivityEndpointKind, string> = {
    [DIRECT_CONNECTIVITY_ENDPOINT_KIND.PRIVATE_ROUTED]: 'subsessionBar.daemon_details_direct_endpoint_private',
    [DIRECT_CONNECTIVITY_ENDPOINT_KIND.PUBLIC_DIRECT]: 'subsessionBar.daemon_details_direct_endpoint_public',
    [DIRECT_CONNECTIVITY_ENDPOINT_KIND.NAT_MAPPED]: 'subsessionBar.daemon_details_direct_endpoint_nat',
    [DIRECT_CONNECTIVITY_ENDPOINT_KIND.PEER_REFLEXIVE]: 'subsessionBar.daemon_details_direct_endpoint_prflx',
    [DIRECT_CONNECTIVITY_ENDPOINT_KIND.TURN_RELAY]: 'subsessionBar.daemon_details_direct_endpoint_relay',
    [DIRECT_CONNECTIVITY_ENDPOINT_KIND.HOST_CANDIDATE]: 'subsessionBar.daemon_details_direct_endpoint_host',
    [DIRECT_CONNECTIVITY_ENDPOINT_KIND.UNKNOWN]: 'subsessionBar.daemon_details_direct_endpoint_unknown',
  };
  const resolveEndpointKind = (
    candidate: DirectConnectivityCandidateInfo | null,
    candidateTypes: readonly DirectConnectivityCandidateType[],
  ): DirectConnectivityEndpointKind => candidate
      ? inferDirectConnectivityEndpointKind(candidate)
      : inferDirectConnectivityEndpointKindFromTypes(candidateTypes);
  const formatEndpointSummary = (
    candidate: DirectConnectivityCandidateInfo | null,
    candidateTypes: readonly DirectConnectivityCandidateType[],
  ) => candidate || candidateTypes.length > 0
    ? t(endpointKindKeys[resolveEndpointKind(candidate, candidateTypes)])
    : t('subsessionBar.daemon_details_direct_no_candidates');
  const formatEndpointTechnicalDetail = (
    candidate: DirectConnectivityCandidateInfo | null,
    candidateTypes: readonly DirectConnectivityCandidateType[],
  ) => candidate
      ? `${candidate.type.toUpperCase()} · ${candidate.address.includes(':') ? `[${candidate.address}]` : candidate.address}:${candidate.port}`
      : candidateTypes.length > 0
        ? candidateTypes.map((type) => type.toUpperCase()).join(' / ')
        : t('subsessionBar.daemon_details_direct_no_candidates');
  const browserCandidateTypes = probeDiagnostics?.browserCandidateTypes ?? [];
  const daemonCandidateTypes = probeDiagnostics?.daemonCandidateTypes ?? [];
  const probeStages = Object.values(DIRECT_CONNECTIVITY_PROBE_STAGE);
  const probeStep = probeDiagnostics ? probeStages.indexOf(probeDiagnostics.stage) + 1 : 0;

  return (
    <div
      class="daemon-details-backdrop"
      data-testid="daemon-details-backdrop"
      onClick={onClose}
    >
      <section
        class="daemon-details-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="daemon-details-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="daemon-details-scanline" aria-hidden="true" />
        <header class="daemon-details-header">
          <div>
            <div class="daemon-details-kicker">{t('subsessionBar.daemon_details_kicker')}</div>
            <h2 id="daemon-details-title">{t('subsessionBar.daemon_details_title')}</h2>
          </div>
          <button
            type="button"
            class="daemon-details-close"
            onClick={onClose}
            aria-label={t('subsessionBar.daemon_details_close')}
          >
            ×
          </button>
        </header>

        <div class="daemon-details-version">
          <span>{t('subsessionBar.daemon_details_version')}</span>
          <code>{stats.daemonVersion ? `v${stats.daemonVersion}` : '—'}</code>
        </div>

        <div class="daemon-details-grid">
          <div class="daemon-details-card daemon-details-card-cpu">
            <span>{t('subsessionBar.daemon_details_cpu')}</span>
            <strong>{stats.cpu}%</strong>
          </div>
          <div class="daemon-details-card daemon-details-card-memory">
            <span>{t('subsessionBar.daemon_details_memory')}</span>
            <strong>{formatMemoryPair(stats.memUsed, stats.memTotal)}</strong>
          </div>
          <div class="daemon-details-card daemon-details-card-load">
            <span>{t('subsessionBar.daemon_details_load')}</span>
            <strong>{stats.load1} / {stats.load5} / {stats.load15}</strong>
          </div>
          <div class="daemon-details-card daemon-details-card-uptime">
            <span>{t('subsessionBar.daemon_details_uptime')}</span>
            <strong>{formatUptime(stats.uptime)}</strong>
          </div>
        </div>

        <div class="daemon-details-section">
          <div class="daemon-details-section-label">{t('subsessionBar.daemon_details_disks')}</div>
          {stats.disks && stats.disks.length > 0 ? (
            <div class="daemon-details-disks">
              {stats.disks.map((disk) => (
                <div class="daemon-details-disk" key={disk.mount}>
                  <div>
                    <strong>{shortMountLabel(disk.mount)}</strong>
                    <span>{formatDiskPair(disk.usedBytes, disk.totalBytes)}</span>
                  </div>
                  <div class="daemon-details-disk-track" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.max(0, Math.min(100, disk.usedPercent))}%`,
                        background: diskUsageColor(disk.usedPercent),
                      }}
                    />
                  </div>
                  <b style={{ color: diskUsageColor(disk.usedPercent) }}>{disk.usedPercent}%</b>
                </div>
              ))}
            </div>
          ) : (
            <div class="daemon-details-empty">{t('subsessionBar.daemon_details_no_data')}</div>
          )}
        </div>

        <div class="daemon-details-health">
          <div class="daemon-details-health-row daemon-details-direct-row">
            <span>{t('subsessionBar.daemon_details_direct_connectivity')}</span>
            <span class="daemon-details-direct-block">
              <span class="daemon-details-direct-result">
                {runtimeUnavailable || !capabilityReady ? (
                  <span class="is-danger">{t('subsessionBar.daemon_details_direct_runtime_unavailable')}</span>
                ) : probeState === PROBE_VIEW_STATE.PROBING ? (
                  <span class="is-probing">{t('subsessionBar.daemon_details_direct_probing')}</span>
                ) : probeState === PROBE_VIEW_STATE.SUCCESS && probeResult ? (
                  <span class={probeResult.route === DIRECT_CONNECTIVITY_ROUTE.RELAY ? 'is-warning' : 'is-direct'}>
                    {t(routeKey)} · {probeResult.rttMs.toFixed(1)} ms
                    <small title={`${probeResult.remoteCandidate.address}:${probeResult.remoteCandidate.port}`}>
                      {probeResult.localCandidate.type}/{probeResult.remoteCandidate.type} · {probeResult.localCandidate.transportType.toUpperCase()}
                    </small>
                  </span>
                ) : probeState === PROBE_VIEW_STATE.FAILED && probeErrorKey ? (
                  <span class="is-danger">{t(probeErrorKey)}</span>
                ) : (
                  <span>{t('subsessionBar.daemon_details_direct_not_tested')}</span>
                )}
                <button
                  type="button"
                  class="daemon-details-direct-refresh"
                  onClick={() => { void runProbe(); }}
                  disabled={!capabilityReady || runtimeUnavailable || probeState === PROBE_VIEW_STATE.PROBING}
                  aria-label={t('subsessionBar.daemon_details_direct_refresh')}
                  title={t('subsessionBar.daemon_details_direct_refresh')}
                >
                  ↻
                </button>
              </span>
              {probeDiagnostics && !runtimeUnavailable && capabilityReady && (
                <span class="daemon-details-direct-diagnostics" data-testid="direct-connectivity-diagnostics">
                  <span>
                    <b>{t('subsessionBar.daemon_details_direct_current_step')}</b>
                    <em><strong>{probeStep}/{probeStages.length}</strong> · {t(probeStageKeys[probeDiagnostics.stage])}</em>
                  </span>
                  <span>
                    <b>{t('subsessionBar.daemon_details_direct_browser_nat')}</b>
                    <em>{formatEndpointSummary(probeResult?.remoteCandidate ?? null, browserCandidateTypes)}</em>
                  </span>
                  <span>
                    <b>{t('subsessionBar.daemon_details_direct_daemon_nat')}</b>
                    <em>{formatEndpointSummary(probeResult?.localCandidate ?? null, daemonCandidateTypes)}</em>
                  </span>
                  <details>
                    <summary>{t('subsessionBar.daemon_details_direct_technical_details')}</summary>
                    <span>
                      <b>{t('subsessionBar.daemon_details_direct_browser_nat')}</b>
                      <code>{formatEndpointTechnicalDetail(probeResult?.remoteCandidate ?? null, browserCandidateTypes)}</code>
                    </span>
                    <span>
                      <b>{t('subsessionBar.daemon_details_direct_daemon_nat')}</b>
                      <code>{formatEndpointTechnicalDetail(probeResult?.localCandidate ?? null, daemonCandidateTypes)}</code>
                    </span>
                    <small>{t('subsessionBar.daemon_details_direct_nat_note')}</small>
                  </details>
                </span>
              )}
            </span>
          </div>
          <div class="daemon-details-health-row">
            <span>{t('subsessionBar.daemon_details_embedding')}</span>
            <span>
              <EmbeddingStatusIcon status={stats.embedding} />
              {t(embeddingKey)}
              {stats.embedding?.reason ? ` · ${stats.embedding.reason}` : ''}
            </span>
          </div>
          <div class={`daemon-details-health-row${shortRefHealth ? ' is-danger' : ''}`}>
            <span>{t('subsessionBar.daemon_details_memory_handles')}</span>
            <span>
              {shortRefHealth
                ? t('memory.short_ref_failure_detail', {
                  stage: shortRefHealth.stage,
                  failures: shortRefHealth.failures,
                  when: new Date(shortRefHealth.lastFailureAt).toLocaleString(),
                  error: shortRefHealth.lastError,
                })
                : t('subsessionBar.daemon_details_memory_handles_ok')}
            </span>
          </div>
          <div class="daemon-details-health-row">
            <span>{t('subsessionBar.daemon_details_local_time')}</span>
            <span class="daemon-details-clock">{localClockText}</span>
          </div>
        </div>
      </section>
    </div>
  );
}

export function SubSessionBar({ subSessions, openIds, maximizedIds, desktopLayoutCapable = true, idleFlashTokens, sharedSubSessionStates, onOpen, onFocus, onClose, onCloseAllOpen, onRestoreQuickClosed, onOpenMaximized, onMaximize, onRestore, onRestoreThenClose, onRestart, onNew, onViewAutoDeliver, onViewDiscussions, onViewDiscussion, onViewRepo, onViewCron, openSpecAutoProjection, openSpecAutoStopPending = false, openSpecAutoCompact = false, onOpenSpecAutoView, onOpenSpecAutoStop, onOpenSpecAutoToggleCompact, onOpenSpecAutoHide, discussions = [], totalRunningDiscussions = 0, onStopDiscussion, ws, connected, onDiff, onHistory, serverId, subUsages, detectedModels, focusedSubId, collapsed: controlledCollapsed, onCollapsedChange, onVisualOrderChange, quickData, sessions, allSubSessions, p2pSessionLabels, onSubTransportConfigSaved }: Props) {
  const { t } = useTranslation();
  const isMobile = !desktopLayoutCapable;
  const [layout, setLayout] = useState<Layout>(() => load('rcc_subcard_layout', 'single'));
  const [internalCollapsed, setInternalCollapsed] = useState(() => load(SUBSESSION_BAR_COLLAPSED_STORAGE_KEY, !desktopLayoutCapable));
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const [p2pHidden, setP2pHidden] = useState(() => load(P2P_MOBILE_COMPACT_STORAGE_KEY, false));
  const [p2pDesktopCompact, setP2pDesktopCompact] = useState(() => load(P2P_DESKTOP_COMPACT_STORAGE_KEY, false));
  const [showSizePanel, setShowSizePanel] = useState(false);
  const [cardSize, setCardSize] = useState<CardSize>(() => load('rcc_subcard_size', DEFAULT_SIZE));
  const [draftW, setDraftW] = useState(String(cardSize.w));
  const [draftH, setDraftH] = useState(String(cardSize.h));
  const [stats, setStats] = useState<DaemonStats | null>(null);
  const [showDaemonDetails, setShowDaemonDetails] = useState(false);
  const localClockNow = useNowTicker(!!stats && (desktopLayoutCapable || showDaemonDetails));
  const localClockText = useMemo(() => formatLocalDateTime(localClockNow), [localClockNow]);
  const [quickClosedIds, setQuickClosedIds] = useState<string[]>([]);
  // DB sort_order is the authority — subSessions arrive pre-sorted from server.
  // Local dragOrder only tracks in-session drag reorder (synced back to DB via reorderSubSessions).
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const reorderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Touch-drag state for collapsed bar (persists across re-renders)
  const touchDragRef = useRef<{
    id: string | null;
    active: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    startX: number;
    startY: number;
    moved: boolean;
  }>({ id: null, active: false, timer: null, startX: 0, startY: 0, moved: false });
  const expandedTouchRef = useRef<{ id: string | null; startX: number; startY: number; moved: boolean }>({
    id: null,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const entryGestureControllersRef = useRef<Map<string, SubSessionEntryGestureController>>(new Map());
  const suppressEntryClickRef = useRef(false);
  const openIdsRef = useRef(openIds);
  openIdsRef.current = openIds;
  const maximizedIdsRef = useRef(maximizedIds);
  maximizedIdsRef.current = maximizedIds;
  const desktopLayoutCapableRef = useRef(desktopLayoutCapable);
  desktopLayoutCapableRef.current = desktopLayoutCapable;
  const focusedSubIdRef = useRef(focusedSubId);
  focusedSubIdRef.current = focusedSubId;

  useEffect(() => {
    if (!showDaemonDetails) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowDaemonDetails(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [showDaemonDetails]);

  const gestureCallbacksRef = useRef({
    onOpen,
    onFocus,
    onOpenMaximized,
    onMaximize,
    onRestore,
    onRestoreThenClose,
  });
  gestureCallbacksRef.current = {
    onOpen,
    onFocus,
    onOpenMaximized,
    onMaximize,
    onRestore,
    onRestoreThenClose,
  };
  const collapsedBarRef = useRef<HTMLDivElement | null>(null);
  const expandedScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    for (const controller of entryGestureControllersRef.current.values()) controller.dispose();
    entryGestureControllersRef.current.clear();
  }, []);

  const isEntryGestureSuppressed = useCallback(() => {
    return suppressEntryClickRef.current || touchDragRef.current.active || !!dragIdRef.current;
  }, []);

  const getEntryGestureController = useCallback((id: string) => {
    const existing = entryGestureControllersRef.current.get(id);
    if (existing) return existing;

    const controller = createSubSessionEntryGestureController({
      getState: () => ({
        isOpen: openIdsRef.current.has(id),
        isMaximized: maximizedIdsRef.current?.has(id) ?? false,
        isFocused: !desktopLayoutCapableRef.current || focusedSubIdRef.current == null || focusedSubIdRef.current === id,
      }),
      actions: {
        openNormal: () => gestureCallbacksRef.current.onOpen(id),
        focus: () => gestureCallbacksRef.current.onFocus?.(id),
        closeNormal: () => gestureCallbacksRef.current.onOpen(id),
        restoreThenClose: () => {
          const callbacks = gestureCallbacksRef.current;
          if (callbacks.onRestoreThenClose) callbacks.onRestoreThenClose(id);
          else {
            callbacks.onRestore?.(id);
            callbacks.onOpen(id);
          }
        },
        openMaximized: () => {
          const callbacks = gestureCallbacksRef.current;
          if (callbacks.onOpenMaximized) callbacks.onOpenMaximized(id);
          else callbacks.onOpen(id);
        },
        maximize: () => gestureCallbacksRef.current.onMaximize?.(id),
        restore: () => gestureCallbacksRef.current.onRestore?.(id),
      },
      isGestureSuppressed: isEntryGestureSuppressed,
      isDesktopDoubleClickEnabled: () => desktopLayoutCapableRef.current,
    });
    entryGestureControllersRef.current.set(id, controller);
    return controller;
  }, [isEntryGestureSuppressed]);

  const handleEntryPointerDown = useCallback((id: string, event: JSX.TargetedPointerEvent<HTMLElement>) => {
    getEntryGestureController(id).handlePointerDown(event);
  }, [getEntryGestureController]);

  const handleEntryTouchStart = useCallback((id: string) => {
    getEntryGestureController(id).handlePointerDown({ pointerType: 'touch' });
  }, [getEntryGestureController]);

  const handleEntryClick = useCallback((id: string, event: JSX.TargetedMouseEvent<HTMLElement>) => {
    getEntryGestureController(id).handleClick(event, event.currentTarget as Element);
  }, [getEntryGestureController]);

  const handleEntryDoubleClick = useCallback((id: string, event: JSX.TargetedMouseEvent<HTMLElement>) => {
    getEntryGestureController(id).handleDoubleClick(event, event.currentTarget as Element);
  }, [getEntryGestureController]);

  const handleExpandedEntryTouchStart = useCallback((id: string, event: JSX.TargetedTouchEvent<HTMLElement>) => {
    handleEntryTouchStart(id);
    const touch = event.touches[0];
    expandedTouchRef.current = {
      id,
      startX: touch?.clientX ?? 0,
      startY: touch?.clientY ?? 0,
      moved: false,
    };
  }, [handleEntryTouchStart]);

  const handleExpandedEntryTouchMove = useCallback((id: string, event: JSX.TargetedTouchEvent<HTMLElement>) => {
    const state = expandedTouchRef.current;
    if (state.id !== id) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - state.startX;
    const dy = touch.clientY - state.startY;
    if (Math.hypot(dx, dy) > 8) state.moved = true;
  }, []);

  const handleExpandedEntryTouchEnd = useCallback((id: string, event: JSX.TargetedTouchEvent<HTMLElement>) => {
    const state = expandedTouchRef.current;
    const shouldActivate = state.id === id && !state.moved;
    expandedTouchRef.current = { id: null, startX: 0, startY: 0, moved: false };
    if (!shouldActivate) return;
    getEntryGestureController(id).handleTouchEndFallback(event, event.currentTarget as Element);
  }, [getEntryGestureController]);

  const handleExpandedEntryTouchCancel = useCallback((id: string) => {
    const state = expandedTouchRef.current;
    if (state.id !== id) return;
    expandedTouchRef.current = { id: null, startX: 0, startY: 0, moved: false };
    getEntryGestureController(id).cancelTouchSequence();
  }, [getEntryGestureController]);

  // Reset drag order only when session membership changes (add/remove),
  // NOT on state updates (idle/running) which just change the array reference.
  const sessionIdList = subSessions.map(s => s.id).join(',');
  useEffect(() => {
    setDragOrder(null);
    const activeIds = new Set(sessionIdList ? sessionIdList.split(',') : []);
    for (const [id, controller] of entryGestureControllersRef.current) {
      if (activeIds.has(id)) continue;
      controller.dispose();
      entryGestureControllersRef.current.delete(id);
    }
  }, [sessionIdList]);

  const syncOrderToServer = (ids: string[]) => {
    if (reorderTimerRef.current) clearTimeout(reorderTimerRef.current);
    reorderTimerRef.current = setTimeout(() => {
      if (serverId) reorderSubSessions(serverId, ids).catch(() => {});
    }, 150);
  };

  // Use drag order if active, otherwise DB order (subSessions is pre-sorted)
  const orderedSessions = useMemo(() => {
    if (!dragOrder) return subSessions;
    const sessionMap = new Map(subSessions.map((s) => [s.id, s]));
    return dragOrder.map((id) => sessionMap.get(id)).filter(Boolean) as SubSession[];
  }, [subSessions, dragOrder]);
  const accentColorsById = useMemo(() => getSubSessionAccentColorMap(orderedSessions), [orderedSessions]);
  const orderedSessionIds = useMemo(() => orderedSessions.map((sub) => sub.id), [orderedSessions]);
  const orderedSessionIdsKey = orderedSessionIds.join(',');
  const orderedSessionsRef = useRef(orderedSessions);
  orderedSessionsRef.current = orderedSessions;
  const dragOrderRef = useRef(dragOrder);
  dragOrderRef.current = dragOrder;
  const expandedPreviewKeyRef = useRef(orderedSessionIdsKey);
  const [expandedPreviewBudget, setExpandedPreviewBudget] = useState(EXPANDED_PREVIEW_INITIAL_COUNT);
  const currentExpandedPreviewBudget = expandedPreviewKeyRef.current === orderedSessionIdsKey
    ? expandedPreviewBudget
    : EXPANDED_PREVIEW_INITIAL_COUNT;
  const hydratedExpandedPreviewIds = useMemo(
    () => new Set(orderedSessions.slice(0, currentExpandedPreviewBudget).map((sub) => sub.id)),
    [currentExpandedPreviewBudget, orderedSessions],
  );
  const openSubWindowCount = useMemo(
    () => orderedSessions.filter((sub) => openIds.has(sub.id)).length,
    [openIds, orderedSessions],
  );
  const restorableQuickClosedIds = useMemo(() => {
    if (quickClosedIds.length === 0) return [];
    const knownIds = new Set(orderedSessionIds);
    return quickClosedIds.filter((id) => knownIds.has(id) && !openIds.has(id));
  }, [openIds, orderedSessionIds, quickClosedIds]);
  const canQuickCloseSubWindows = desktopLayoutCapable && openSubWindowCount > 0 && !!onCloseAllOpen;
  const canQuickRestoreSubWindows = desktopLayoutCapable
    && openSubWindowCount === 0
    && restorableQuickClosedIds.length > 0
    && !!onRestoreQuickClosed;
  const showQuickSubWindowControl = desktopLayoutCapable && !!onCloseAllOpen;
  const quickSubWindowIsRestore = !canQuickCloseSubWindows && canQuickRestoreSubWindows;
  const quickSubWindowDisabled = !canQuickCloseSubWindows && !canQuickRestoreSubWindows;
  const quickSubWindowLabel = canQuickCloseSubWindows
    ? t('subsessionBar.quick_close_open')
    : canQuickRestoreSubWindows
      ? t('subsessionBar.restore_quick_closed')
      : t('subsessionBar.quick_close_unavailable');

  const handleQuickSubWindowControl = useCallback((event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const openIdsSnapshot = openIdsRef.current;
    const closingIds = orderedSessionsRef.current
      .filter((sub) => openIdsSnapshot.has(sub.id))
      .map((sub) => sub.id);
    if (closingIds.length > 0 && onCloseAllOpen) {
      setQuickClosedIds(closingIds);
      onCloseAllOpen();
      return;
    }
    if (restorableQuickClosedIds.length > 0 && onRestoreQuickClosed) {
      const restoreIds = restorableQuickClosedIds;
      setQuickClosedIds([]);
      onRestoreQuickClosed(restoreIds);
    }
  }, [onCloseAllOpen, onRestoreQuickClosed, restorableQuickClosedIds]);

  const moveSubSessionInDragOrder = useCallback((draggedId: string, overId: string) => {
    if (draggedId === overId) return;
    setDragOrder((prev) => {
      const ids = prev ?? orderedSessionsRef.current.map((s) => s.id);
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(overId);
      if (from === -1 || to === -1) return prev;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, draggedId);
      return next;
    });
  }, []);

  const handleCollapsedEntryDragStart = useCallback((id: string, event: JSX.TargetedDragEvent<HTMLElement>) => {
    if (!desktopLayoutCapableRef.current) {
      event.preventDefault();
      return;
    }
    dragIdRef.current = id;
    suppressEntryClickRef.current = true;
    getEntryGestureController(id).cancelPendingSingleClick();
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', id); } catch { /* ignore */ }
    }
    (event.currentTarget as HTMLElement).style.opacity = '0.5';
    setDragOrder(orderedSessionsRef.current.map((s) => s.id));
  }, [getEntryGestureController]);

  const handleCollapsedEntryDragOver = useCallback((id: string, event: JSX.TargetedDragEvent<HTMLElement>) => {
    if (!desktopLayoutCapableRef.current) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const draggedId = dragIdRef.current;
    if (!draggedId) return;
    moveSubSessionInDragOrder(draggedId, id);
  }, [moveSubSessionInDragOrder]);

  const handleCollapsedEntryDragEnd = useCallback((id: string, event: JSX.TargetedDragEvent<HTMLElement>) => {
    getEntryGestureController(id).cancelPendingSingleClick();
    dragIdRef.current = null;
    setTimeout(() => { suppressEntryClickRef.current = false; }, 0);
    (event.currentTarget as HTMLElement).style.opacity = '';
    const ids = dragOrderRef.current;
    if (ids) syncOrderToServer(ids);
  }, [getEntryGestureController, syncOrderToServer]);

  useEffect(() => {
    onVisualOrderChange?.(orderedSessionIds);
  }, [onVisualOrderChange, orderedSessionIds]);

  useEffect(() => {
    expandedPreviewKeyRef.current = orderedSessionIdsKey;
    if (collapsed) {
      setExpandedPreviewBudget(0);
      return;
    }
    const total = orderedSessions.length;
    const initial = Math.min(total, EXPANDED_PREVIEW_INITIAL_COUNT);
    setExpandedPreviewBudget(initial);
    if (initial >= total) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let nextBudget = initial;
    const step = () => {
      if (cancelled) return;
      nextBudget = Math.min(total, nextBudget + EXPANDED_PREVIEW_BATCH_SIZE);
      setExpandedPreviewBudget(nextBudget);
      if (nextBudget < total) {
        timer = setTimeout(step, EXPANDED_PREVIEW_BATCH_DELAY_MS);
      }
    };
    timer = setTimeout(step, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [collapsed, orderedSessionIdsKey, orderedSessions.length]);

  useEffect(() => {
    save(SUBSESSION_BAR_COLLAPSED_STORAGE_KEY, collapsed);
  }, [collapsed]);

  const setCollapsed = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(collapsed) : next;
    if (controlledCollapsed === undefined) setInternalCollapsed(resolved);
    onCollapsedChange?.(resolved);
  }, [collapsed, controlledCollapsed, onCollapsedChange]);

  useEffect(() => {
    save(P2P_MOBILE_COMPACT_STORAGE_KEY, p2pHidden);
  }, [p2pHidden]);

  useEffect(() => {
    save(P2P_DESKTOP_COMPACT_STORAGE_KEY, p2pDesktopCompact);
  }, [p2pDesktopCompact]);

  // Touch-based reorder for collapsed bar — desktop collapsed buttons use HTML5 drag events below.
  // The touch path must use addEventListener({ passive: false }) so touchmove can preventDefault.
  useEffect(() => {
    const el = collapsedBarRef.current;
    if (!el) return;
    const td = touchDragRef.current;

    const findBtnId = (target: EventTarget | null): string | null => {
      let node = target as HTMLElement | null;
      while (node && node !== el) { if (node.dataset.subId) return node.dataset.subId; node = node.parentElement; }
      return null;
    };

    const onStart = (e: TouchEvent) => {
      const id = findBtnId(e.target);
      if (!id) return;
      const touch = e.touches[0];
      td.id = id;
      td.active = false;
      td.moved = false;
      td.startX = touch?.clientX ?? 0;
      td.startY = touch?.clientY ?? 0;
      td.timer = setTimeout(() => {
        if (td.id !== id || td.moved) return;
        td.id = id;
        td.active = true;
        setDragOrder(orderedSessionsRef.current.map((s) => s.id));
        const btn = el.querySelector(`[data-sub-id="${id}"]`) as HTMLElement | null;
        if (btn) { btn.style.transform = 'scale(1.18)'; btn.style.boxShadow = '0 0 10px rgba(251,191,36,0.6)'; btn.style.borderColor = '#f59e0b'; btn.style.zIndex = '2'; }
        el.style.overflowX = 'hidden';
        window.getSelection()?.removeAllRanges();
      }, 400);
    };

    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch) {
        const dx = touch.clientX - td.startX;
        const dy = touch.clientY - td.startY;
        if (Math.hypot(dx, dy) > 8) td.moved = true;
      }
      if (td.timer && !td.active && td.moved) { clearTimeout(td.timer); td.timer = null; return; }
      if (!td.active || !td.id) return;
      e.preventDefault(); // works because { passive: false }
      if (!touch) return;
      const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
      const overId = findBtnId(targetEl);
      if (overId && overId !== td.id) {
        moveSubSessionInDragOrder(td.id, overId);
      }
    };

    const resetTouchDrag = () => {
      td.id = null;
      td.active = false;
      td.moved = false;
      td.startX = 0;
      td.startY = 0;
    };

    const onEnd = (e: TouchEvent) => {
      const endedId = td.id ?? findBtnId(e.target);
      const wasActive = td.active;
      const moved = td.moved;
      if (td.timer) { clearTimeout(td.timer); td.timer = null; }
      if (wasActive && td.id) {
        suppressEntryClickRef.current = true;
        setTimeout(() => { suppressEntryClickRef.current = false; }, 0);
        const btn = el.querySelector(`[data-sub-id="${td.id}"]`) as HTMLElement | null;
        if (btn) { btn.style.transform = ''; btn.style.boxShadow = ''; btn.style.borderColor = ''; btn.style.zIndex = ''; }
        el.style.overflowX = '';
        if (dragOrderRef.current) syncOrderToServer(dragOrderRef.current);
      } else if (endedId && !moved) {
        const btn = el.querySelector(`[data-sub-id="${endedId}"]`) as HTMLElement | null;
        getEntryGestureController(endedId).handleTouchEndFallback(e, btn);
      }
      resetTouchDrag();
    };

    const onCancel = () => {
      if (td.timer) { clearTimeout(td.timer); td.timer = null; }
      if (td.active && td.id) {
        const btn = el.querySelector(`[data-sub-id="${td.id}"]`) as HTMLElement | null;
        if (btn) { btn.style.transform = ''; btn.style.boxShadow = ''; btn.style.borderColor = ''; btn.style.zIndex = ''; }
        el.style.overflowX = '';
      }
      if (td.id) getEntryGestureController(td.id).cancelTouchSequence();
      resetTouchDrag();
    };

    const onContext = (e: Event) => { if (td.active) e.preventDefault(); };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onCancel);
    el.addEventListener('contextmenu', onContext);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
      el.removeEventListener('contextmenu', onContext);
    };
  }, [collapsed, getEntryGestureController, moveSubSessionInDragOrder, syncOrderToServer]);

  useEffect(() => {
    const installHorizontalEdgeGuard = (el: HTMLDivElement | null) => {
      if (!el) return () => {};
      let startX = 0;
      let startY = 0;

      const onTouchStart = (e: TouchEvent) => {
        const touch = e.touches[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
      };

      const onTouchMove = (e: TouchEvent) => {
        const touch = e.touches[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(dy)) return;
        const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
        if (maxScrollLeft <= 0) {
          e.preventDefault();
          return;
        }
        const atStart = el.scrollLeft <= 0;
        const atEnd = el.scrollLeft >= maxScrollLeft - 1;
        if ((atStart && dx > 0) || (atEnd && dx < 0)) {
          e.preventDefault();
        }
      };

      el.addEventListener('touchstart', onTouchStart, { passive: true });
      el.addEventListener('touchmove', onTouchMove, { passive: false });
      return () => {
        el.removeEventListener('touchstart', onTouchStart);
        el.removeEventListener('touchmove', onTouchMove);
      };
    };

    const cleanupCollapsed = installHorizontalEdgeGuard(collapsedBarRef.current);
    const cleanupExpanded = installHorizontalEdgeGuard(expandedScrollRef.current);
    return () => {
      cleanupCollapsed();
      cleanupExpanded();
    };
  }, [collapsed, layout, orderedSessions.length]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      if (msg.type === 'daemon.stats') {
        setStats({
          daemonVersion: msg.daemonVersion,
          cpu: msg.cpu,
          memUsed: msg.memUsed,
          memTotal: msg.memTotal,
          load1: msg.load1,
          load5: msg.load5,
          load15: msg.load15,
          uptime: msg.uptime,
          // Older daemons don't ship `embedding`; preserve null so the
          // icon falls through to its "unknown" rendering instead of
          // showing a misleading "ready".
          embedding: msg.embedding ?? null,
          // Older daemons don't ship `disks`; null means "no data" so the
          // desktop strip simply hides the readout (and mobile never shows it).
          disks: msg.disks ?? null,
          shortRefHealth: msg.shortRefHealth ?? null,
          directConnectivity: msg.directConnectivity ?? null,
        });
      }
    });
  }, [ws]);

  const toggleLayout = () => {
    const next: Layout = layout === 'single' ? 'double' : 'single';
    setLayout(next);
    save('rcc_subcard_layout', next);
  };

  const applySize = () => {
    const w = Math.max(200, Math.min(800, parseInt(draftW) || DEFAULT_SIZE.w));
    const h = Math.max(150, Math.min(600, parseInt(draftH) || DEFAULT_SIZE.h));
    const next = { w, h };
    setCardSize(next);
    save('rcc_subcard_size', next);
    setDraftW(String(w));
    setDraftH(String(h));
    setShowSizePanel(false);
  };

  const resetSize = () => {
    setCardSize(DEFAULT_SIZE);
    save('rcc_subcard_size', DEFAULT_SIZE);
    setDraftW(String(DEFAULT_SIZE.w));
    setDraftH(String(DEFAULT_SIZE.h));
    setShowSizePanel(false);
  };

  const discussionButtonLabel = t('subsessionBar.p2p_discussions');
  const autoDeliverButtonLabel = t('subsessionBar.auto_deliver');
  const repoButtonLabel = t('repo.info_title', { defaultValue: t('subsessionBar.repository') });
  const cronButtonLabel = t('subsessionBar.scheduled_tasks');

  return (
    <div class="subcard-bar">
      {/* Toolbar */}
      <div class="subcard-toolbar">
        <button class="subcard-toolbar-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? t('subsessionBar.show') : t('subsessionBar.hide')}>
          {collapsed ? '▲' : '▼'}
        </button>
        {isMobile && discussions.length > 0 && (
          <button
            class={`subcard-toolbar-btn${p2pHidden ? ' subcard-toolbar-btn-active' : ''}`}
            data-testid="p2p-compact-toggle"
            onClick={() => setP2pHidden((hidden) => !hidden)}
            title={p2pHidden ? t('subsessionBar.p2p_compact_show') : t('subsessionBar.p2p_compact_hide')}
            aria-label={p2pHidden ? t('subsessionBar.p2p_compact_show') : t('subsessionBar.p2p_compact_hide')}
          >
            Team {p2pHidden ? '▾' : '▴'}
          </button>
        )}
        {!isMobile && discussions.length > 0 && (
          <button
            class={`subcard-toolbar-btn${p2pDesktopCompact ? ' subcard-toolbar-btn-active' : ''}`}
            data-testid="p2p-desktop-compact-toggle"
            onClick={() => setP2pDesktopCompact((compact) => !compact)}
            title={p2pDesktopCompact ? t('subsessionBar.p2p_compact_expand') : t('subsessionBar.p2p_compact_hide')}
            aria-label={p2pDesktopCompact ? t('subsessionBar.p2p_compact_expand') : t('subsessionBar.p2p_compact_hide')}
          >
            Team {p2pDesktopCompact ? '▾' : '▴'}
          </button>
        )}
        {!collapsed && (
          <>
            <button class="subcard-toolbar-btn" onClick={toggleLayout} title={layout === 'single' ? t('subsessionBar.layout_double') : t('subsessionBar.layout_single')}>
              {layout === 'single' ? '⊞' : '☰'}
            </button>
            <button
              class={`subcard-toolbar-btn${showSizePanel ? ' subcard-toolbar-btn-active' : ''}`}
              onClick={() => { setShowSizePanel(!showSizePanel); setDraftW(String(cardSize.w)); setDraftH(String(cardSize.h)); }}
              title={t('subsessionBar.card_size')}
            >
              ⚙
            </button>
            <span class="subcard-toolbar-label">{t('subsessionBar.subs_count', { count: subSessions.length })}</span>
            {/* Desktop: full stats in expanded toolbar */}
            {stats && (
              <button
                type="button"
                class="daemon-stats-inline daemon-stats-inline-tech daemon-stats-trigger"
                title={`${stats.daemonVersion ? `Daemon ${stats.daemonVersion} | ` : ''}Load: ${stats.load1} / ${stats.load5} / ${stats.load15} | Uptime: ${formatUptime(stats.uptime)}${desktopLayoutCapable ? ` | ${localClockText}` : ''}`}
                onClick={() => setShowDaemonDetails(true)}
                aria-haspopup="dialog"
                aria-label={t('subsessionBar.daemon_details_open')}
              >
                {stats.daemonVersion && (
                  <>
                    {/* Display the short form (strips trailing -dev.NNN counter); the
                        full version stays available in the title tooltip above. */}
                    {desktopLayoutCapable ? (
                      <span class="daemon-stat-version">v{formatDaemonVersionShort(stats.daemonVersion)}</span>
                    ) : (
                      <span class="daemon-stat-version daemon-stat-version-chip">
                        {formatDaemonVersionMobile(stats.daemonVersion)}
                      </span>
                    )}
                    <span class="daemon-stat-sep"> · </span>
                  </>
                )}
                <span class={`daemon-stat-cpu${stats.cpu > 80 ? ' danger' : stats.cpu > 50 ? ' warn' : ''}`}>
                  CPU {stats.cpu}%
                </span>
                <span class="daemon-stat-sep"> · </span>
                <span class="daemon-stat-mem">
                  Mem {(() => { const gb = stats.memUsed / (1024 ** 3); return gb >= 1 ? `${gb.toFixed(1)}G` : `${(stats.memUsed / (1024 ** 2)).toFixed(0)}M`; })()}
                </span>
                <span class="daemon-stat-sep"> · </span>
                <span class="daemon-stat-load">
                  Load {stats.load1}
                </span>
                {desktopLayoutCapable && stats.disks && stats.disks.length > 0 && (
                  <>
                    <span class="daemon-stat-sep"> · </span>
                    {renderDiskStats(stats.disks)}
                  </>
                )}
                {stats.shortRefHealth && (
                  <>
                    <span class="daemon-stat-sep"> · </span>
                    {renderShortRefAlert(stats.shortRefHealth, t)}
                  </>
                )}
                <span class="daemon-stat-sep"> · </span>
                <EmbeddingStatusIcon status={stats.embedding} />
                <span class="daemon-stat-sep"> · </span>
                <span class="daemon-stat-uptime">
                  {formatUptime(stats.uptime)}
                </span>
                {desktopLayoutCapable && (
                  <>
                    <span class="daemon-stat-sep"> · </span>
                    <span class="daemon-local-clock">{renderTechClock(localClockText)}</span>
                  </>
                )}
              </button>
            )}
          </>
        )}
        {/* Collapsed toolbar: compact stats strip. */}
        {collapsed && stats && (() => {
          const totalGb = stats.memTotal / (1024 ** 3);
          const useG = totalGb >= 1;
          const div = useG ? 1024 ** 3 : 1024 ** 2;
          const unit = useG ? 'G' : 'M';
          const memUsed = (stats.memUsed / div).toFixed(1);
          const memTotal = useG ? totalGb.toFixed(1) : (stats.memTotal / div).toFixed(0);
          const ei = { fontSize: '0.65em', verticalAlign: 'middle' } as const;
          return (
            <button
              type="button"
              class={`daemon-stats-inline daemon-stats-inline-tech daemon-stats-compact daemon-stats-trigger${desktopLayoutCapable ? '' : ' daemon-stats-mobile'}`}
              title={`${stats.daemonVersion ? `v${stats.daemonVersion} | ` : ''}CPU ${stats.cpu}% | Mem ${memUsed}/${memTotal}${unit} | Load: ${stats.load1} / ${stats.load5} / ${stats.load15} | Uptime: ${formatUptime(stats.uptime)}${desktopLayoutCapable ? ` | ${localClockText}` : ''}`}
              onClick={() => setShowDaemonDetails(true)}
              aria-haspopup="dialog"
              aria-label={t('subsessionBar.daemon_details_open')}
            >
              {/* Mobile-narrow stat strip — show short version; full string in title above. */}
              {stats.daemonVersion && (desktopLayoutCapable ? (
                <span class="daemon-stat-version">v{formatDaemonVersionShort(stats.daemonVersion)} </span>
              ) : (
                <span class="daemon-stat-version daemon-stat-version-chip">
                  {formatDaemonVersionMobile(stats.daemonVersion)}
                </span>
              ))}
              <span class={`daemon-stat-cpu${stats.cpu > 80 ? ' danger' : stats.cpu > 50 ? ' warn' : ''}`}><span style={ei}>⚙️</span>{stats.cpu}%</span>
              {' '}
              <span class="daemon-stat-mem"><span style={ei}>🧠</span>{memUsed}/{memTotal}{unit}</span>
              {' '}
              <span class="daemon-stat-load">≡{Number(stats.load1).toFixed(1)}</span>
              {' '}
              {desktopLayoutCapable && stats.disks && stats.disks.length > 0 && (
                <>{renderDiskStats(stats.disks)}{' '}</>
              )}
              {stats.shortRefHealth && (<>{renderShortRefAlert(stats.shortRefHealth, t)}{' '}</>)}
              <EmbeddingStatusIcon status={stats.embedding} compact />
              {desktopLayoutCapable && (
                <>
                  {' '}
                  <span class="daemon-local-clock">{renderTechClock(localClockText)}</span>
                </>
              )}
            </button>
          );
        })()}
        {onNew && (
          <button
            class={`subcard-toolbar-add${desktopLayoutCapable ? ' subcard-toolbar-add-desktop' : ''}`}
            data-onboarding="new-sub-session"
            onClick={onNew}
            title={t('subsessionBar.new_sub_session')}
          >
            {desktopLayoutCapable ? t('subsessionBar.add_sub_session_short') : '+'}
          </button>
        )}
        {onViewAutoDeliver && !isMobile && (
          <button
            class={`subcard-toolbar-btn subcard-toolbar-btn-auto${desktopLayoutCapable ? ' subcard-toolbar-btn-labeled' : ''}`}
            data-testid="subsession-auto-deliver-status"
            onClick={onViewAutoDeliver}
            title={autoDeliverButtonLabel}
            aria-label={autoDeliverButtonLabel}
          >
            <span aria-hidden="true">⟲</span>
            {desktopLayoutCapable && <span class="subcard-toolbar-btn-label">{autoDeliverButtonLabel}</span>}
          </button>
        )}
        {onViewDiscussions && (
          <button
            class={`subcard-toolbar-btn subcard-toolbar-btn-discussions${desktopLayoutCapable ? ' subcard-toolbar-btn-labeled' : ''}`}
            data-onboarding="discussion-history"
            data-running-discussions={totalRunningDiscussions}
            onClick={onViewDiscussions}
            // Tooltip: "View Team discussions" with running count when > 0,
            // so the user knows how many runs exist daemon-wide even
            // when this session's bar shows none (the scoped
            // discussions list filters to participants only).
            title={
              totalRunningDiscussions > 0
                ? t(
                    'subsessionBar.p2p_discussions_with_running',
                    {
                      count: totalRunningDiscussions,
                      defaultValue: '{{count}} running discussions — view all',
                    },
                  )
                : t('subsessionBar.p2p_discussions')
            }
          >
            <span aria-hidden="true">👥</span>
            {desktopLayoutCapable && <span class="subcard-toolbar-btn-label">{discussionButtonLabel}</span>}
            {totalRunningDiscussions > 0 && (
              <span
                data-testid="p2p-discussions-running-badge"
                aria-label={t(
                  'subsessionBar.p2p_running_count_aria',
                  {
                    count: totalRunningDiscussions,
                    defaultValue: '{{count}} Team discussions running',
                  },
                )}
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -4,
                  minWidth: 14,
                  height: 14,
                  padding: '0 3px',
                  borderRadius: 7,
                  background: '#3b82f6',
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: '14px',
                  textAlign: 'center',
                  pointerEvents: 'none',
                  boxSizing: 'border-box',
                }}
              >
                {totalRunningDiscussions > 99 ? '99+' : totalRunningDiscussions}
              </span>
            )}
          </button>
        )}
        {onViewRepo && (
          <button
            class={`subcard-toolbar-btn${desktopLayoutCapable ? ' subcard-toolbar-btn-labeled' : ''}`}
            data-onboarding="repo-page"
            onClick={() => onViewRepo()}
            title={repoButtonLabel}
            aria-label={repoButtonLabel}
            style={{
              marginLeft: 4,
              fontSize: 11,
            }}
          >
            <span aria-hidden="true">🗂️</span>
            {desktopLayoutCapable && <span class="subcard-toolbar-btn-label">{repoButtonLabel}</span>}
          </button>
        )}
        {onViewCron && (
          <button
            class={`subcard-toolbar-btn${desktopLayoutCapable ? ' subcard-toolbar-btn-labeled' : ''}`}
            data-onboarding="cron-manager"
            onClick={onViewCron}
            title={cronButtonLabel}
            aria-label={cronButtonLabel}
            style={{ marginLeft: 4, fontSize: 11 }}
          >
            <span aria-hidden="true">⏰</span>
            {desktopLayoutCapable && <span class="subcard-toolbar-btn-label">{cronButtonLabel}</span>}
          </button>
        )}
      </div>

      {/* Size settings panel */}
      {!collapsed && showSizePanel && (
        <div class="subcard-size-panel">
          <span class="subcard-size-label">{t('subsessionBar.card_size')}</span>
          <label class="subcard-size-field">
            {t('subsessionBar.width_short')}
            <input
              type="number"
              class="subcard-size-input"
              value={draftW}
              min={200} max={800}
              onInput={(e) => setDraftW((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && applySize()}
            />
          </label>
          <label class="subcard-size-field">
            {t('subsessionBar.height_short')}
            <input
              type="number"
              class="subcard-size-input"
              value={draftH}
              min={150} max={600}
              onInput={(e) => setDraftH((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && applySize()}
            />
          </label>
          <button class="subcard-toolbar-btn" onClick={applySize}>{t('subsessionBar.apply')}</button>
          <button class="subcard-toolbar-btn" onClick={resetSize}>{t('subsessionBar.reset')}</button>
        </div>
      )}

      {openSpecAutoProjection && openSpecAutoProjection.visibility !== 'conflict' && (
        <div class="openspec-auto-subsession-progress">
          <OpenSpecAutoDeliverRunBar
            projection={openSpecAutoProjection}
            stopPending={openSpecAutoStopPending}
            compact={openSpecAutoCompact}
            onView={onOpenSpecAutoView ?? onViewAutoDeliver ?? (() => {})}
            onStop={onOpenSpecAutoStop ?? (() => {})}
            onToggleCompact={onOpenSpecAutoToggleCompact}
            onHide={onOpenSpecAutoHide}
          />
        </div>
      )}

      {/* Empty state: no sub-sessions and expanded */}
      {!collapsed && subSessions.length === 0 && discussions.length === 0 && onNew && (
        <div class="subcard-empty-state">
          {t('subsessionBar.empty_prefix')} <strong>+</strong> {t('subsessionBar.empty_suffix')}
        </div>
      )}

      {/* Discussions panel — above sub-session buttons */}
      {discussions.length > 0 && (
        <div class={`discussion-panel${isMobile ? ' discussion-panel-mobile' : ''}${!isMobile && p2pDesktopCompact ? ' discussion-panel-desktop-compact' : ''}`}>
          {discussions.map((d) => (
            <P2pProgressCard
              key={d.id}
              discussion={d}
              compact={!isMobile && !p2pDesktopCompact}
              mobile={isMobile}
              ultraCompact={!isMobile && p2pDesktopCompact}
              hidden={isMobile && p2pHidden}
              onToggleHide={isMobile ? () => setP2pHidden((v) => !v) : undefined}
              onStopDiscussion={onStopDiscussion}
              onClick={d.fileId && onViewDiscussion ? () => onViewDiscussion(d.fileId!) : undefined}
            />
          ))}
        </div>
      )}

      {/* Collapsed: compact buttons (all platforms) — drag on desktop, long-press on touch */}
      {collapsed && subSessions.length > 0 && (
        <div class="subsession-row-with-close">
          {showQuickSubWindowControl && (
            <button
              type="button"
              class={`subsession-close-all-strip${quickSubWindowIsRestore ? ' subsession-close-all-strip-restore' : ''}`}
              title={quickSubWindowLabel}
              aria-label={quickSubWindowLabel}
              disabled={quickSubWindowDisabled}
              onClick={handleQuickSubWindowControl}
            >
              <span class="subsession-close-all-arrow" aria-hidden="true">{quickSubWindowIsRestore ? '↑' : '↓'}</span>
            </button>
          )}
          <div class="subsession-bar" style={{ borderTop: 'none' }} ref={collapsedBarRef}>
            {orderedSessions.map((sub) => (
              <CollapsedSubSessionButton
                key={sub.id}
                sub={sub}
                accentColor={accentColorsById.get(sub.id) ?? DEFAULT_SUBSESSION_ACCENT_COLOR}
                isOpen={openIds.has(sub.id)}
                // Desktop: focusedSubId marks the single active card. Mobile only
                // ever opens ONE sub-session, so that open card IS the active one
                // (focusedSubId is null on mobile) — treat open as active there so
                // it gets the SOLID bottom accent, not the dashed open-only one.
                isFocused={isMobile ? openIds.has(sub.id) : focusedSubId === sub.id}
                idleFlashToken={idleFlashTokens?.get(sub.sessionName) ?? 0}
                usage={subUsages?.get(`deck_sub_${sub.id}`)}
                detectedModel={detectedModels?.get(sub.sessionName)}
                sharedState={sharedSubSessionStates?.get(sub.id) ?? sharedSubSessionStates?.get(sub.sessionName)}
                inP2p={!!p2pSessionLabels?.has(sub.sessionName)}
                draggable={desktopLayoutCapable}
                onEntryPointerDown={handleEntryPointerDown}
                onEntryTouchStart={handleEntryTouchStart}
                onEntryClick={handleEntryClick}
                onEntryDoubleClick={handleEntryDoubleClick}
                onEntryDragStart={handleCollapsedEntryDragStart}
                onEntryDragOver={handleCollapsedEntryDragOver}
                onEntryDragEnd={handleCollapsedEntryDragEnd}
                t={t}
              />
            ))}
          </div>
        </div>
      )}

      {/* Expanded: preview cards (all platforms) */}
      {!collapsed && orderedSessions.length > 0 && (
        <div class="subsession-row-with-close">
          {showQuickSubWindowControl && (
            <button
              type="button"
              class={`subsession-close-all-strip${quickSubWindowIsRestore ? ' subsession-close-all-strip-restore' : ''}`}
              title={quickSubWindowLabel}
              aria-label={quickSubWindowLabel}
              disabled={quickSubWindowDisabled}
              onClick={handleQuickSubWindowControl}
            >
              <span class="subsession-close-all-arrow" aria-hidden="true">{quickSubWindowIsRestore ? '↑' : '↓'}</span>
            </button>
          )}
          <div
            ref={expandedScrollRef}
            class={`subcard-scroll ${layout === 'double' ? 'subcard-double' : 'subcard-single'}`}
            style={layout === 'double' ? { gridAutoColumns: 'max-content' } : undefined}
          >
            {orderedSessions.map((sub, index) => (
              <div
                key={sub.id}
                class="subcard-drag-wrap"
                draggable
                onPointerDown={(event) => handleEntryPointerDown(sub.id, event)}
                onTouchStart={(event) => handleExpandedEntryTouchStart(sub.id, event)}
                onTouchMove={(event) => handleExpandedEntryTouchMove(sub.id, event)}
                onTouchEnd={(event) => handleExpandedEntryTouchEnd(sub.id, event)}
                onTouchCancel={() => handleExpandedEntryTouchCancel(sub.id)}
                onClick={(event) => handleEntryClick(sub.id, event)}
                onDblClick={(event) => handleEntryDoubleClick(sub.id, event)}
                onDragStart={(e) => {
                  dragIdRef.current = sub.id;
                  suppressEntryClickRef.current = true;
                  e.dataTransfer!.effectAllowed = 'move';
                  (e.currentTarget as HTMLElement).style.opacity = '0.5';
                  // Initialize dragOrder from current displayed order
                  if (!dragOrder) setDragOrder(orderedSessions.map((s) => s.id));
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer!.dropEffect = 'move';
                  if (!dragIdRef.current || dragIdRef.current === sub.id) return;
                  setDragOrder((prev) => {
                    const ids = prev ?? orderedSessions.map((s) => s.id);
                    const from = ids.indexOf(dragIdRef.current!);
                    const to = ids.indexOf(sub.id);
                    if (from === -1 || to === -1) return prev;
                    const next = [...ids];
                    next.splice(from, 1);
                    next.splice(to, 0, dragIdRef.current!);
                    return next;
                  });
                }}
                onDragEnd={(e) => {
                  dragIdRef.current = null;
                  setTimeout(() => { suppressEntryClickRef.current = false; }, 0);
                  (e.currentTarget as HTMLElement).style.opacity = '';
                  if (dragOrder) syncOrderToServer(dragOrder);
                }}
              >
                {hydratedExpandedPreviewIds.has(sub.id) || openIds.has(sub.id) || focusedSubId === sub.id ? (
                  <SubSessionCard
                    sub={sub}
                    ws={ws}
                    connected={connected}
                    isOpen={openIds.has(sub.id)}
                    isFocused={focusedSubId === sub.id}
                    idleFlashToken={idleFlashTokens?.get(sub.sessionName) ?? 0}
                    onOpen={() => {}}
                    onClose={() => onClose(sub.id)}
                    onRestart={() => onRestart(sub.id)}
                    onDiff={onDiff}
                    onHistory={onHistory}
                    cardW={cardSize.w}
                    cardH={cardSize.h}
                    quickData={quickData}
                    sessions={sessions}
                    subSessions={allSubSessions}
                    serverId={serverId}
                    onTransportConfigSaved={onSubTransportConfigSaved}
                    sharedState={sharedSubSessionStates?.get(sub.id) ?? sharedSubSessionStates?.get(sub.sessionName)}
                    inP2p={!!p2pSessionLabels?.has(sub.sessionName)}
                    accentColor={accentColorsById.get(sub.id) ?? DEFAULT_SUBSESSION_ACCENT_COLOR}
                    previewHydrateDelayMs={Math.min(1200, 120 + index * 60)}
                  />
                ) : (
                  <ExpandedSubSessionPlaceholder
                    sub={sub}
                    accentColor={accentColorsById.get(sub.id) ?? DEFAULT_SUBSESSION_ACCENT_COLOR}
                    cardSize={cardSize}
                    sharedState={sharedSubSessionStates?.get(sub.id) ?? sharedSubSessionStates?.get(sub.sessionName)}
                    inP2p={!!p2pSessionLabels?.has(sub.sessionName)}
                    t={t}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {showDaemonDetails && stats && (
        <DaemonStatsModal
          stats={stats}
          ws={ws}
          localClockText={localClockText}
          onClose={() => setShowDaemonDetails(false)}
          t={t}
        />
      )}
    </div>
  );
}
