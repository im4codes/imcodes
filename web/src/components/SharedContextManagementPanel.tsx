import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from '@shared/context-model-defaults.js';
import type { ContextMemoryProjectView, ContextMemoryView, SharedContextRuntimeBackend } from '@shared/context-types.js';
import { QWEN_MODEL_IDS } from '@shared/qwen-models.js';
import { MEMORY_WS } from '@shared/memory-ws.js';
import {
  type MemoryFeatureAdminRecord,
  type MemoryManagementErrorCode,
  type MemoryObservationAdminRecord,
  type MemoryPreferenceAdminRecord,
  type MemorySkillAdminRecord,
} from '@shared/memory-management.js';
import {
  deriveMemoryProjectCapabilities,
  type MemoryProjectOption,
  type MemoryProjectResolutionStatus,
} from '@shared/memory-project-options.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME, memoryFeatureFlagEnvKey, type MemoryFeatureFlag } from '@shared/feature-flags.js';
import { AUTHORED_CONTEXT_SCOPES, MEMORY_SCOPES, type AuthoredContextScope, type MemoryScope } from '@shared/memory-scope.js';
import { OBSERVATION_CLASSES, type ObservationClass } from '@shared/memory-observation.js';
import {
  DEFAULT_MEMORY_RECALL_MIN_SCORE,
  DEFAULT_MEMORY_SCORING_WEIGHTS,
  DEFAULT_PRIMARY_CONTEXT_BACKEND,
  doesSharedContextBackendSupportPresets,
  getDefaultSharedContextModelForBackend,
  isKnownSharedContextModelForBackend,
  MEMORY_RECALL_MIN_SCORE_MAX,
  MEMORY_RECALL_MIN_SCORE_MIN,
  MEMORY_RECALL_MIN_SCORE_STEP,
  MEMORY_SCORING_WEIGHT_INPUT_STEP,
  MEMORY_SCORING_WEIGHT_MAX,
  MEMORY_SCORING_WEIGHT_MIN,
  normalizeMemoryScoringWeights,
  normalizeMemoryRecallMinScore,
  SHARED_CONTEXT_RUNTIME_BACKENDS,
  type SharedContextRuntimeConfigSnapshot,
} from '@shared/shared-context-runtime-config.js';
import {
  ApiError,
  activateSharedDocumentVersion,
  getEnterpriseSharedMemory,
  getPersonalCloudMemory,
  createSharedDocument,
  createSharedDocumentBinding,
  createSharedDocumentVersion,
  createSharedWorkspace,
  createTeam,
  deleteEnterpriseSharedMemory,
  deletePersonalCloudMemory,
  createTeamInvite,
  enrollSharedProject,
  getSharedProjectPolicy,
  getTeam,
  joinTeamByToken,
  listSharedDocumentBindings,
  listSharedDocuments,
  listSharedProjects,
  listSharedWorkspaces,
  listTeams,
  markSharedProjectPendingRemoval,
  removeSharedProject,
  removeTeamMember,
  fetchSharedContextRuntimeConfig,
  type SharedDocument,
  type SharedDocumentBinding,
  type SharedProject,
  type SharedProjectPolicy,
  type SharedContextRuntimeConfigView,
  type SharedWorkspace,
  type TeamDetail,
  type TeamSummary,
  updateSharedProjectPolicy,
  updateSharedContextRuntimeConfig,
  updateTeamMemberRole,
} from '../api.js';
import { ChatMarkdown } from './ChatMarkdown.js';
import type { WsClient } from '../ws-client.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS } from '../../../src/shared/models/options.js';
import type { MemoryScoringWeights } from '@shared/memory-scoring.js';

// ── Mobile detection ────────────────────────────────────────────────────────
const SC_IS_MOBILE = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// ── Design tokens ────────────────────────────────────────────────────────────
// Unified palette and spacing system. All component styles below reference these.

const DT = {
  bg: {
    base: '#0a0e1a',          // deep canvas
    surface: '#111827',       // card background
    surfaceElev: '#162033',   // elevated card
    input: '#0d1423',         // input fields
    muted: 'rgba(148,163,184,0.06)', // subtle overlay
  },
  border: {
    subtle: 'rgba(51,65,85,0.55)',
    default: 'rgba(71,85,105,0.6)',
    strong: 'rgba(96,165,250,0.3)',
  },
  text: {
    primary: '#e6edf3',
    secondary: '#9ca3af',
    muted: '#6b7280',
    accent: '#60a5fa',
    success: '#34d399',
    warn: '#fbbf24',
    error: '#f87171',
  },
  radius: { sm: 6, md: 10, lg: 14, xl: 18, pill: 999 },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 },
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.3)',
    md: '0 4px 16px rgba(0,0,0,0.35)',
    accent: '0 8px 24px rgba(37,99,235,0.2)',
  },
} as const;

const shellStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  gap: SC_IS_MOBILE ? DT.space.md : DT.space.lg,
  padding: SC_IS_MOBILE ? DT.space.sm : DT.space.lg,
  color: DT.text.primary,
  overflowY: 'auto',
  overflowX: 'hidden',
  WebkitOverflowScrolling: 'touch',
  background: `radial-gradient(ellipse at top, rgba(37,99,235,0.08), transparent 40%), ${DT.bg.base}`,
  fontSize: SC_IS_MOBILE ? 12 : 13,
  lineHeight: 1.5,
} as const;

const sectionStyle = {
  border: `1px solid ${DT.border.subtle}`,
  borderRadius: SC_IS_MOBILE ? DT.radius.md : DT.radius.xl,
  padding: SC_IS_MOBILE ? `${DT.space.md}px ${DT.space.md}px` : `${DT.space.lg}px ${DT.space.xl}px`,
  display: 'flex',
  flexDirection: 'column',
  gap: DT.space.md,
  background: DT.bg.surface,
  boxShadow: DT.shadow.sm,
} as const;

const heroStyle = {
  ...sectionStyle,
  gap: DT.space.md,
  background: `linear-gradient(135deg, rgba(37,99,235,0.08) 0%, ${DT.bg.surface} 60%)`,
  border: `1px solid ${DT.border.strong}`,
  boxShadow: DT.shadow.accent,
  overflow: 'hidden',
} as const;

const rowStyle = {
  display: 'flex',
  gap: DT.space.sm,
  flexWrap: 'wrap',
  alignItems: 'center',
} as const;

const inputStyle = {
  flex: SC_IS_MOBILE ? '1 1 100%' : '1 1 180px',
  minWidth: 0,
  background: DT.bg.input,
  color: DT.text.primary,
  border: `1px solid ${DT.border.default}`,
  borderRadius: DT.radius.sm,
  padding: SC_IS_MOBILE ? '10px 12px' : '8px 12px',
  fontSize: SC_IS_MOBILE ? 14 : 13,
  transition: 'border-color 0.15s, box-shadow 0.15s',
  outline: 'none',
} as const;

// Compact style for numeric inputs like a recall threshold or scoring weight.
// The generic `inputStyle` uses `flex: 1 1 180px` which stretches to fill the
// whole section card — a single "0.4" was rendering in an input 600+px wide,
// which looks broken on both desktop and mobile. `maxWidth` keeps the field
// proportional to the content while `alignSelf` prevents the flex parent from
// re-expanding it.
const numberInputStyle = {
  ...inputStyle,
  flex: '0 0 auto',
  width: SC_IS_MOBILE ? 120 : 110,
  maxWidth: '100%',
  alignSelf: 'flex-start' as const,
  textAlign: 'right' as const,
  fontVariantNumeric: 'tabular-nums' as const,
} as const;

const buttonStyle = {
  background: '#2563eb',
  color: '#ffffff',
  border: 'none',
  borderRadius: DT.radius.sm,
  padding: SC_IS_MOBILE ? '10px 16px' : '8px 14px',
  cursor: 'pointer',
  fontSize: SC_IS_MOBILE ? 14 : 13,
  fontWeight: 500,
  transition: 'background 0.15s, transform 0.1s',
  ...(SC_IS_MOBILE ? { width: '100%' } : {}),
} as const;

const subtleButtonStyle = {
  ...buttonStyle,
  background: 'rgba(71,85,105,0.4)',
  color: DT.text.primary,
  border: `1px solid ${DT.border.subtle}`,
} as const;

const tabStyle = {
  background: 'transparent',
  color: DT.text.secondary,
  border: 'none',
  padding: SC_IS_MOBILE ? '10px 12px' : '8px 14px',
  fontSize: SC_IS_MOBILE ? 12 : 13,
  fontWeight: 500,
  borderRadius: DT.radius.md,
  cursor: 'pointer',
  transition: 'background 0.15s, color 0.15s',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  whiteSpace: SC_IS_MOBILE ? 'normal' : 'nowrap',
  textAlign: 'center',
  lineHeight: 1.2,
  minHeight: SC_IS_MOBILE ? 40 : undefined,
  minWidth: 0,
  width: SC_IS_MOBILE ? '100%' : undefined,
  flexShrink: 0,
} as const;

const tabActiveStyle = {
  ...tabStyle,
  background: 'rgba(37,99,235,0.15)',
  color: DT.text.primary,
  fontWeight: 600,
} as const;

const tabBarStyle = {
  display: SC_IS_MOBILE ? 'grid' : 'flex',
  gridTemplateColumns: SC_IS_MOBILE ? 'repeat(2, minmax(0, 1fr))' : undefined,
  gap: SC_IS_MOBILE ? 6 : DT.space.xs,
  flexWrap: SC_IS_MOBILE ? undefined : 'wrap' as const,
  alignItems: 'stretch',
  padding: SC_IS_MOBILE ? 6 : DT.space.xs,
  borderRadius: DT.radius.md,
  background: DT.bg.input,
  border: `1px solid ${DT.border.subtle}`,
  width: '100%',
  boxSizing: 'border-box',
  overflow: 'visible',
} as const;

const tabBadgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginLeft: DT.space.sm,
  padding: '2px 7px',
  borderRadius: DT.radius.pill,
  fontSize: 11,
  fontWeight: 600,
  background: 'rgba(96,165,250,0.18)',
  color: DT.text.accent,
  minWidth: 20,
} as const;

const pillStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: DT.space.xs,
  padding: '3px 10px',
  borderRadius: DT.radius.pill,
  background: DT.bg.input,
  border: `1px solid ${DT.border.subtle}`,
  color: DT.text.secondary,
  fontSize: 12,
  fontWeight: 500,
} as const;

const checkboxRowStyle = {
  ...rowStyle,
  alignItems: 'flex-start',
} as const;

const policyOptionStyle = {
  flex: SC_IS_MOBILE ? '1 1 100%' : '1 1 260px',
  minWidth: SC_IS_MOBILE ? 0 : 240,
  padding: DT.space.md,
  borderRadius: DT.radius.md,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.input,
  display: 'flex',
  flexDirection: 'column',
  gap: DT.space.xs,
} as const;

const fieldLabelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: DT.space.xs,
  color: DT.text.secondary,
  fontSize: 12,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
} as const;

const statGridStyle = {
  display: 'grid',
  gridTemplateColumns: SC_IS_MOBILE ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: SC_IS_MOBILE ? DT.space.xs : DT.space.sm,
} as const;

const statCardStyle = {
  borderRadius: DT.radius.md,
  padding: SC_IS_MOBILE ? `${DT.space.sm}px ${DT.space.md}px` : `${DT.space.md}px ${DT.space.lg}px`,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.input,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  transition: 'border-color 0.15s',
} as const;

const resourceListStyle = {
  display: 'grid',
  gap: DT.space.md,
} as const;

const resourceCardStyle = {
  borderRadius: SC_IS_MOBILE ? DT.radius.md : DT.radius.lg,
  padding: SC_IS_MOBILE ? DT.space.sm : DT.space.lg,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.surfaceElev,
  display: 'flex',
  flexDirection: 'column',
  gap: SC_IS_MOBILE ? DT.space.sm : DT.space.md,
  transition: 'border-color 0.15s, transform 0.1s',
  overflow: 'hidden',
  minWidth: 0,
} as const;

const memoryContentCollapsedStyle = {
  maxHeight: '4.8em',
  overflowY: 'hidden',
  overflowX: 'hidden',
  padding: SC_IS_MOBILE ? `${DT.space.sm}px ${DT.space.md}px` : `${DT.space.md}px ${DT.space.lg}px`,
  borderRadius: DT.radius.md,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.input,
  lineHeight: 1.6,
  fontSize: SC_IS_MOBILE ? 12 : 13,
  color: DT.text.primary,
  position: 'relative',
  wordBreak: 'break-word',
  maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
  WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
} as const;

const memoryContentExpandedStyle = {
  ...memoryContentCollapsedStyle,
  maxHeight: 'none',
  overflowY: 'visible',
  maskImage: 'none',
  WebkitMaskImage: 'none',
} as const;

const splitSectionStyle = {
  display: 'grid',
  gridTemplateColumns: SC_IS_MOBILE ? '1fr' : 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: DT.space.md,
  alignItems: 'start',
} as const;

const cardGridStyle = {
  display: 'grid',
  gridTemplateColumns: SC_IS_MOBILE ? '1fr' : 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: DT.space.md,
} as const;

const metaGridStyle = {
  display: 'grid',
  gridTemplateColumns: SC_IS_MOBILE ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: SC_IS_MOBILE ? DT.space.xs : DT.space.sm,
} as const;

const metaCardStyle = {
  borderRadius: DT.radius.sm,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.input,
  padding: SC_IS_MOBILE ? `${DT.space.xs}px ${DT.space.sm}px` : `${DT.space.sm}px ${DT.space.md}px`,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  overflow: 'hidden',
  minWidth: 0,
} as const;

const helperTextStyle = {
  color: DT.text.secondary,
  fontSize: 12,
  lineHeight: 1.5,
} as const;

const metaChipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  borderRadius: DT.radius.pill,
  background: DT.bg.muted,
  border: `1px solid ${DT.border.subtle}`,
  color: DT.text.secondary,
  fontSize: 10,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: SC_IS_MOBILE ? 120 : 180,
} as const;

const memoryProcessedNoteStyle = {
  ...helperTextStyle,
  padding: `${DT.space.sm}px ${DT.space.md}px`,
  borderRadius: DT.radius.sm,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.input,
  fontSize: 12,
} as const;

const processingGridStyle = {
  display: 'grid',
  gridTemplateColumns: SC_IS_MOBILE ? '1fr' : 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: DT.space.md,
  alignItems: 'start',
} as const;

const processingCardStyle = {
  border: `1px solid ${DT.border.subtle}`,
  borderRadius: SC_IS_MOBILE ? DT.radius.md : DT.radius.lg,
  padding: SC_IS_MOBILE ? DT.space.md : DT.space.lg,
  background: DT.bg.surface,
  display: 'flex',
  flexDirection: 'column',
  gap: DT.space.md,
} as const;

const backendChipRowStyle = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
} as const;

function processingChipStyle(active: boolean) {
  return active
    ? {
        ...buttonStyle,
        padding: '6px 10px',
        fontSize: 12,
        fontWeight: 700,
      }
    : {
        ...subtleButtonStyle,
        padding: '6px 10px',
        fontSize: 12,
        fontWeight: 600,
      };
}

function modelChipStyle(active: boolean) {
  return active
    ? {
        ...buttonStyle,
        padding: '3px 8px',
        fontSize: 11,
        fontWeight: 700,
        background: '#0f766e',
        lineHeight: 1.35,
      }
    : {
        ...subtleButtonStyle,
        padding: '3px 8px',
        fontSize: 11,
        fontWeight: 600,
        background: '#1e293b',
        lineHeight: 1.35,
      };
}

/** Preset chip: visually distinct from built-in model chips so users can see at
 *  a glance that a preset pulls in env/endpoint config, not just a model name. */
function presetChipStyle(active: boolean) {
  return active
    ? {
        ...buttonStyle,
        padding: '3px 8px',
        fontSize: 11,
        fontWeight: 700,
        background: '#7c3aed',
        border: '1px solid #a78bfa',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        lineHeight: 1.35,
      }
    : {
        ...subtleButtonStyle,
        padding: '3px 8px',
        fontSize: 11,
        fontWeight: 600,
        background: '#1e1b3a',
        border: '1px solid #4c1d95',
        color: '#c4b5fd',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        lineHeight: 1.35,
      };
}

/** Shared row for preset + built-in chips. Wraps on narrow widths but never
 *  grows vertically beyond what the content needs — no decorative container. */
const compactChipRowStyle = {
  display: 'flex',
  gap: 4,
  flexWrap: 'wrap',
  alignItems: 'center',
} as const;

/** Tiny inline "Preset:" / "Model:" label that sits on the same row as the
 *  chips. Smaller than the uppercase field label to keep the dimension
 *  separation visually obvious without adding another stacked heading. */
const inlineDimensionLabelStyle = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: DT.text.muted,
  marginRight: 6,
  minWidth: 44,
  flex: '0 0 auto',
} as const;

/** "(none)" / neutral chip used to clear the preset selection explicitly —
 *  visually distinct from both preset chips (purple) and model chips (teal)
 *  so users can see at a glance that it's the "no bundle" state. */
function neutralChipStyle(active: boolean) {
  return active
    ? {
        ...buttonStyle,
        padding: '3px 8px',
        fontSize: 11,
        fontWeight: 700,
        background: '#374151',
        border: '1px solid #6b7280',
        lineHeight: 1.35,
      }
    : {
        ...subtleButtonStyle,
        padding: '3px 8px',
        fontSize: 11,
        fontWeight: 600,
        background: '#1f2937',
        border: '1px solid #374151',
        color: '#9ca3af',
        lineHeight: 1.35,
      };
}

const defaultPolicyState: SharedProjectPolicy = {
  enrollmentId: '',
  enterpriseId: '',
  allowDegradedProviderSupport: true,
  allowLocalFallback: false,
  requireFullProviderSupport: false,
};

const PROCESSING_MODEL_OPTIONS_BY_BACKEND: Record<SharedContextRuntimeBackend, readonly string[]> = {
  'claude-code-sdk': CLAUDE_CODE_MODEL_IDS,
  'codex-sdk': CODEX_MODEL_IDS,
  qwen: QWEN_MODEL_IDS,
  openclaw: [],
};

function resolveProcessingModelForBackend(
  nextBackend: SharedContextRuntimeBackend,
  currentModel: string,
  previousBackend?: SharedContextRuntimeBackend,
): string {
  const trimmed = currentModel.trim();
  if (!trimmed) return getDefaultSharedContextModelForBackend(nextBackend);
  if (previousBackend && trimmed === getDefaultSharedContextModelForBackend(previousBackend)) {
    return getDefaultSharedContextModelForBackend(nextBackend);
  }
  if (!isKnownSharedContextModelForBackend(nextBackend, trimmed)) {
    return getDefaultSharedContextModelForBackend(nextBackend);
  }
  return trimmed;
}

function formatServerScopeValue(serverId: string | undefined, unboundLabel: string): string {
  if (!serverId) return unboundLabel;
  if (serverId.length <= 12) return serverId;
  return `${serverId.slice(0, 8)}…${serverId.slice(-4)}`;
}

function formatRelativeTime(ts: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('sharedContext.management.relativeLessThanOneMinute');
  if (diff < 3_600_000) return t('sharedContext.management.relativeMinutesAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('sharedContext.management.relativeHoursAgo', { count: Math.floor(diff / 3_600_000) });
  return t('sharedContext.management.relativeDaysAgo', { count: Math.floor(diff / 86_400_000) });
}

const archiveBadgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 7px',
  borderRadius: DT.radius.pill,
  background: 'rgba(251,191,36,0.12)',
  border: `1px solid rgba(251,191,36,0.3)`,
  color: DT.text.warn,
  fontSize: 10,
  fontWeight: 600,
  whiteSpace: 'nowrap',
} as const;

const recallChipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 7px',
  borderRadius: DT.radius.pill,
  background: 'rgba(239,68,68,0.10)',
  border: `1px solid rgba(239,68,68,0.25)`,
  color: DT.text.error,
  fontSize: 10,
  fontWeight: 600,
  whiteSpace: 'nowrap',
} as const;

const archiveRestoreButtonStyle = {
  background: 'transparent',
  color: DT.text.muted,
  border: `1px solid ${DT.border.subtle}`,
  borderRadius: DT.radius.sm,
  padding: '2px 8px',
  fontSize: 10,
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'color 0.15s, border-color 0.15s',
  whiteSpace: 'nowrap',
  flexShrink: 0,
} as const;


const deleteButtonStyle = {
  ...archiveRestoreButtonStyle,
  color: DT.text.error,
  border: `1px solid rgba(239,68,68,0.3)`,
} as const;

type KindOption = SharedDocument['kind'];
type ManagementTab = 'enterprise' | 'members' | 'projects' | 'knowledge' | 'processing' | 'memory';
type MemoryTopTab = 'personal' | 'enterprise-memory';
type MemoryPersonalSubTab = 'unprocessed' | 'processed' | 'cloud';
type MemoryEnterpriseSubTab = 'shared-memory' | 'authored-context';
type MemoryToolTab = 'status' | 'preferences' | 'skills' | 'md-ingest' | 'observations';
type MemoryObservationClassFilter = '' | ObservationClass;
type MemoryResponseStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'timeout' | 'error';
type TimeoutHandle = ReturnType<typeof setTimeout>;
const MD_INGEST_UI_SCOPES = ['personal', 'project_shared'] as const satisfies readonly MemoryScope[];
type MemoryAdminRequestSurface =
  | 'projectResolve'
  | 'features'
  | 'featureSet'
  | 'preferences'
  | 'skills'
  | 'observations'
  | 'prefCreate'
  | 'prefDelete'
  | 'skillRebuild'
  | 'skillRead'
  | 'skillDelete'
  | 'mdIngest'
  | 'observationPromote';

interface Props {
  enterpriseId?: string;
  serverId?: string;
  ws?: WsClient | null;
  onEnterpriseChange?: (enterpriseId: string) => void;
  memoryProjectCandidates?: MemoryProjectCandidate[];
  activeProjectDir?: string | null;
}

export interface MemoryProjectCandidate {
  projectDir?: string;
  canonicalRepoId?: string;
  displayName?: string;
  sessionName?: string;
  source?: MemoryProjectOption['source'];
  lastSeenAt?: number;
}

interface TabDef {
  id: ManagementTab;
  label: string;
}

type SharedScopeValue = AuthoredContextScope;

function InfoCard(props: { title: string; children: ComponentChildren }) {
  return (
    <div style={{ ...sectionStyle, background: DT.bg.surface }}>
      <strong style={{ fontSize: 14, fontWeight: 600, color: DT.text.primary }}>{props.title}</strong>
      <div style={{ display: 'flex', flexDirection: 'column', gap: DT.space.xs, color: DT.text.secondary, fontSize: 12, lineHeight: 1.5 }}>
        {props.children}
      </div>
    </div>
  );
}

function LabeledValue({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: DT.space.md, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <span style={{ color: DT.text.muted }}>{label}</span>
      <code style={{ color: DT.text.primary, fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace' }}>{value}</code>
    </div>
  );
}

function StatCard({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div style={statCardStyle}>
      <span style={{ color: DT.text.muted, fontSize: SC_IS_MOBILE ? 10 : 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>{label}</span>
      <strong style={{ fontSize: SC_IS_MOBILE ? 16 : 22, lineHeight: 1.1, color: DT.text.primary, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</strong>
      {detail ? <span style={{ color: DT.text.secondary, fontSize: SC_IS_MOBILE ? 10 : 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span> : null}
    </div>
  );
}

function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ComponentChildren }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: DT.space.md, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 auto', minWidth: SC_IS_MOBILE ? 0 : 200 }}>
        <strong style={{ fontSize: SC_IS_MOBILE ? 14 : 15, fontWeight: 600, color: DT.text.primary }}>{title}</strong>
        {description ? <span style={helperTextStyle}>{description}</span> : null}
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

function IOSToggle({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  const trackW = 44;
  const trackH = 24;
  const knobSize = 20;
  const knobOffset = checked ? trackW - knobSize - 2 : 2;
  return (
    <div
      role="switch"
      aria-checked={checked}
      style={{
        position: 'relative',
        width: trackW,
        height: trackH,
        borderRadius: trackH / 2,
        background: checked ? '#34c759' : 'rgba(120,120,128,0.32)',
        transition: 'background 0.25s ease',
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 2,
          left: knobOffset,
          width: knobSize,
          height: knobSize,
          borderRadius: '50%',
          background: '#ffffff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3), 0 1px 1px rgba(0,0,0,0.15)',
          transition: 'left 0.25s ease',
        }}
      />
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div style={{ ...metaCardStyle, overflow: 'hidden', minWidth: 0 }}>
      <span style={{ color: DT.text.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 500 }}>{label}</span>
      <span style={{ color: DT.text.primary, fontSize: SC_IS_MOBILE ? 11 : 12, lineHeight: 1.4, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

// ── Memory admin (post-1.1) visuals ──────────────────────────────────────────
// Tighter grid for the feature flag status row — each cell shows a colored
// status dot, the flag name, and an enabled/disabled/unknown label. Keeps the
// flag name visible (used as `MetaCard` label before) without the redundant
// uppercase header treatment.
const featureFlagGridStyle = {
  display: 'grid',
  gridTemplateColumns: SC_IS_MOBILE ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: SC_IS_MOBILE ? DT.space.xs : DT.space.sm,
} as const;

function featureFlagCardStyle(enabled: boolean | null, blocked = false) {
  let accentBorder: string = DT.border.subtle;
  let tintBg: string = DT.bg.input;
  if (blocked) {
    accentBorder = 'rgba(251,191,36,0.34)';
    tintBg = 'linear-gradient(180deg, rgba(251,191,36,0.06), rgba(251,191,36,0.02))';
  } else if (enabled === true) {
    accentBorder = 'rgba(52,211,153,0.32)';
    tintBg = 'linear-gradient(180deg, rgba(52,211,153,0.06), rgba(52,211,153,0.02))';
  } else if (enabled === false) {
    accentBorder = 'rgba(248,113,113,0.28)';
    tintBg = 'linear-gradient(180deg, rgba(248,113,113,0.05), rgba(248,113,113,0.015))';
  }
  return {
    borderRadius: DT.radius.md,
    border: `1px solid ${accentBorder}`,
    background: tintBg,
    padding: SC_IS_MOBILE ? `${DT.space.xs}px ${DT.space.sm}px` : `${DT.space.sm}px ${DT.space.md}px`,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    minWidth: 0,
    overflow: 'hidden' as const,
    transition: 'border-color 0.15s, background 0.15s',
  };
}

function featureFlagDotStyle(enabled: boolean | null, blocked = false) {
  const color = blocked
    ? DT.text.warn
    : enabled === true
      ? DT.text.success
      : enabled === false
        ? DT.text.error
        : DT.text.muted;
  return {
    width: 8,
    height: 8,
    borderRadius: '50%' as const,
    background: color,
    boxShadow: enabled === true ? `0 0 6px ${color}` : 'none',
    flexShrink: 0,
  };
}

function featureFlagStatusTextStyle(enabled: boolean | null, blocked = false) {
  const color = blocked
    ? DT.text.warn
    : enabled === true
      ? DT.text.success
      : enabled === false
        ? DT.text.error
        : DT.text.muted;
  return {
    color,
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  };
}

function FeatureFlagCard({
  flag,
  label,
  enabled,
  statusText,
  detail,
  blocked = false,
  actionLabel,
  actionPending = false,
  actionDisabled = false,
  onToggle,
}: {
  flag: string;
  label: string;
  enabled: boolean | null;
  statusText: string;
  detail?: string;
  blocked?: boolean;
  actionLabel?: string;
  actionPending?: boolean;
  actionDisabled?: boolean;
  onToggle?: () => void;
}) {
  const ariaLabel = `${label}: ${statusText}`;
  return (
    <div style={featureFlagCardStyle(enabled, blocked)} title={flag} role="group" aria-label={ariaLabel}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: DT.text.primary, fontSize: SC_IS_MOBILE ? 11 : 12, fontWeight: 600, overflow: 'hidden' }}>
        <span style={featureFlagDotStyle(enabled, blocked)} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </span>
      <span style={featureFlagStatusTextStyle(enabled, blocked)}>{statusText}</span>
      {detail ? <span style={{ ...helperTextStyle, fontSize: 10 }}>{detail}</span> : null}
      {onToggle && actionLabel ? (
        <button
          type="button"
          style={{ ...subtleButtonStyle, padding: '6px 10px', fontSize: 11, width: 'fit-content' }}
          disabled={actionDisabled || actionPending || enabled === null}
          onClick={onToggle}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

// Sub-card for each post-1.1 admin tool (preferences, skills, MD ingest,
// observations). When the feature is disabled the card gets a muted red
// accent on its left border so the user can spot the gated state at a glance,
// in addition to the existing helper-text notice. `enabled === null` means we
// haven't received a `features.query` response yet — keep the neutral look.
function adminSubCardStyle(enabled: boolean | null) {
  const leftAccent = enabled === false
    ? `3px solid rgba(248,113,113,0.45)`
    : enabled === true
      ? `3px solid rgba(52,211,153,0.4)`
      : `3px solid ${DT.border.subtle}`;
  return {
    ...resourceCardStyle,
    borderLeft: leftAccent,
    paddingLeft: SC_IS_MOBILE ? DT.space.md : DT.space.lg,
  };
}

// Small inline status pill for a sub-card heading. Mirrors `pillStyle` but
// colored by feature state.
function featurePillStyle(enabled: boolean | null) {
  if (enabled === true) {
    return {
      ...pillStyle,
      background: 'rgba(52,211,153,0.12)',
      border: `1px solid rgba(52,211,153,0.3)`,
      color: DT.text.success,
    };
  }
  if (enabled === false) {
    return {
      ...pillStyle,
      background: 'rgba(248,113,113,0.10)',
      border: `1px solid rgba(248,113,113,0.3)`,
      color: DT.text.error,
    };
  }
  return {
    ...pillStyle,
    color: DT.text.muted,
  };
}

// Form row for admin tools: same as `rowStyle` but a touch tighter and with
// inputs that don't sprawl on wide screens.
const adminFormRowStyle = {
  display: 'flex',
  gap: DT.space.sm,
  flexWrap: 'wrap' as const,
  alignItems: 'center',
  padding: SC_IS_MOBILE ? 0 : `${DT.space.xs}px 0`,
} as const;

interface ProcessingPresetEntry {
  name: string;
  env: Record<string, string>;
  contextWindow?: number;
  initMessage?: string;
}

/**
 * Unified model + preset selector.
 *
 * Replaces the older two-control design (a `<select>` for presets PLUS a chip
 * row for models) with a single flat set of chips grouped by kind. This
 * removes the dual-control confusion where selecting a preset left the model
 * chip stale (or vice versa), and where the `<select>` silently failed to
 * reflect saved state when the saved preset wasn't in the loaded list yet.
 *
 * Interaction:
 *   - Clicking a PRESET chip: selects that preset and, if the preset's env
 *     carries ANTHROPIC_MODEL, mirrors that model so downstream consumers
 *     don't need to resolve the preset separately.
 *   - Clicking a MODEL chip: selects the model and clears any active preset
 *     (presets carry additional env like base URL / API key — clearing keeps
 *     the two concepts from drifting).
 *   - Clicking the active chip again: deselects (clears both for safety).
 *
 * Active-state highlighting is decoupled per-chip so users can see both the
 * active preset AND the active model when a preset-derived model matches a
 * built-in. That's the read path of the state the save will persist.
 */
function ModelPresetChipSelector({
  backend,
  model,
  preset,
  presets,
  onChange,
  idPrefix,
}: {
  backend: SharedContextRuntimeBackend;
  model: string;
  preset: string;
  presets: ReadonlyArray<ProcessingPresetEntry>;
  onChange: (next: { model: string; preset: string }) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const modelOptions = PROCESSING_MODEL_OPTIONS_BY_BACKEND[backend] ?? [];
  const supportsPresets = doesSharedContextBackendSupportPresets(backend);
  const trimmedModel = model.trim();
  const trimmedPreset = preset.trim();
  if (modelOptions.length === 0 && (!supportsPresets || presets.length === 0)) return null;

  // Preset vs model are two DIFFERENT dimensions, not peers.
  //
  //   - A preset is an env bundle (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY +
  //     ANTHROPIC_MODEL). Picking a preset routes traffic to the endpoint
  //     that preset points at, and pins the model that endpoint serves.
  //   - A model is the identifier the endpoint resolves. Built-in qwen
  //     models run on the default qwen endpoint (OAuth / coding plan).
  //
  // Rendering them as one flat chip list invited users to read the preset
  // as a "model" alongside the others. Split them into two labeled rows so
  // the semantic distinction is visible in a glance, still compact:
  //
  //   Preset:  [ (none) ] [⚙ minimax] [⚙ team-b]
  //   Model:   [coder-model] [qwen3-coder-plus] …   (when no preset)
  //            [MiniMax-M2.5]                         (when preset pins one)
  const activePreset = supportsPresets
    ? presets.find((p) => p.name === trimmedPreset)
    : undefined;
  const presetPinnedModel = activePreset?.env?.ANTHROPIC_MODEL?.trim() || '';
  // When a preset is active, model selection collapses to what the preset
  // endpoint exposes — show ONLY the pinned model as a single read-ish chip.
  // User can still switch away by clicking a built-in chip, which clears
  // the preset (the `onChange({ model, preset: '' })` path handles that).
  return (
    <div style={chipGroupStyle}>
      {supportsPresets && presets.length > 0 ? (
        <div style={compactChipRowStyle}>
          <span style={inlineDimensionLabelStyle}>{t('sharedContext.management.processingPresetLabel')}</span>
          <button
            key={`${idPrefix}:preset:__none__`}
            type="button"
            aria-label={`${idPrefix}:preset:none`}
            aria-pressed={!trimmedPreset}
            title={t('sharedContext.management.processingPresetNoneTitle')}
            style={neutralChipStyle(!trimmedPreset)}
            onClick={() => onChange({ model: trimmedModel, preset: '' })}
          >
            {t('sharedContext.management.processingPresetNone')}
          </button>
          {presets.map((p) => {
            const active = trimmedPreset === p.name;
            const pinned = p.env?.ANTHROPIC_MODEL?.trim();
            return (
              <button
                key={`${idPrefix}:preset:${p.name}`}
                type="button"
                aria-label={`${idPrefix}:preset:${p.name}`}
                aria-pressed={active}
                title={pinned
                  ? t('sharedContext.management.processingPresetBundleModelTitle', { model: pinned })
                  : t('sharedContext.management.processingPresetBundleTitle', { preset: p.name })}
                style={presetChipStyle(active)}
                onClick={() => {
                  // Picking a preset pins its embedded model. User has to
                  // explicitly pick a built-in model chip below (or "(none)"
                  // + another chip) to override, which clears the preset
                  // so the two dimensions can't drift.
                  onChange({ model: pinned || trimmedModel, preset: p.name });
                }}
              >
                <span aria-hidden="true">⚙</span>
                <span>{p.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div style={compactChipRowStyle}>
        <span style={inlineDimensionLabelStyle}>{t('sharedContext.management.processingModelLabel')}</span>
        {activePreset ? (
          // Preset active — this row is read-only: the endpoint dictates
          // the model. Rendered with the teal "active" style so the user
          // sees WHICH model the preset pins without a misleading
          // "click to pick" affordance.
          <button
            key={`${backend}:preset-pinned`}
            type="button"
            aria-label={`model:${backend}:${presetPinnedModel || '(preset)'}`}
            aria-pressed={true}
            disabled
            title={t('sharedContext.management.processingModelPresetTitle')}
            style={{ ...modelChipStyle(true), cursor: 'default', opacity: 0.95 }}
          >
            {presetPinnedModel || t('sharedContext.management.processingModelDefinedByPreset')}
          </button>
        ) : (
          modelOptions.map((modelId) => {
            const active = trimmedModel === modelId;
            return (
              <button
                key={`${backend}:${modelId}`}
                type="button"
                aria-label={`model:${backend}:${modelId}`}
                aria-pressed={active}
                style={modelChipStyle(active)}
                onClick={() => onChange({ model: modelId, preset: '' })}
              >
                {modelId}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Vertical stack for the two-row (Preset / Model) selector. Tighter than
 *  `fieldLabelStyle`'s flex-column so the rows sit close together. */
const chipGroupStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
} as const;

function formatMemberIdentity(member: TeamDetail['members'][number]): string {
  const displayName = member.display_name?.trim();
  if (displayName) return displayName;
  const username = member.username?.trim();
  if (username) return `@${username}`;
  return member.user_id.length > 16 ? `${member.user_id.slice(0, 8)}…${member.user_id.slice(-4)}` : member.user_id;
}

const EMPTY_MEMORY_VIEW: ContextMemoryView = {
  stats: {
    totalRecords: 0,
    matchedRecords: 0,
    recentSummaryCount: 0,
    durableCandidateCount: 0,
    projectCount: 0,
    stagedEventCount: 0,
    dirtyTargetCount: 0,
    pendingJobCount: 0,
  },
  records: [],
  pendingRecords: [],
  projects: [],
};

function normalizeMemoryView(view: ContextMemoryView): ContextMemoryView {
  return {
    stats: {
      totalRecords: view.stats.totalRecords ?? 0,
      matchedRecords: view.stats.matchedRecords ?? 0,
      recentSummaryCount: view.stats.recentSummaryCount ?? 0,
      durableCandidateCount: view.stats.durableCandidateCount ?? 0,
      projectCount: view.stats.projectCount ?? 0,
      stagedEventCount: view.stats.stagedEventCount ?? 0,
      dirtyTargetCount: view.stats.dirtyTargetCount ?? 0,
      pendingJobCount: view.stats.pendingJobCount ?? 0,
    },
    records: view.records ?? [],
    pendingRecords: view.pendingRecords ?? [],
    projects: view.projects ?? [],
  };
}

function shouldCollapseMemoryContent(text: string): boolean {
  return text.split('\n').length > 3 || text.length > 220;
}

function getMemoryRecordClassLabel(
  t: (key: string) => string,
  projectionClass: 'recent_summary' | 'durable_memory_candidate' | 'master_summary',
): string {
  if (projectionClass === 'recent_summary') return t('sharedContext.management.memoryRecentSummary');
  if (projectionClass === 'master_summary') return t('sharedContext.management.memoryMasterSummary');
  return t('sharedContext.management.memoryDurableCandidate');
}

function memoryProjectOptionId(input: Pick<MemoryProjectOption, 'canonicalRepoId' | 'projectDir' | 'displayName'>): string {
  return input.canonicalRepoId?.trim()
    || input.projectDir?.trim()
    || input.displayName.trim();
}

function projectDirDisplayName(projectDir: string): string {
  const trimmed = projectDir.trim().replace(/\/+$/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || trimmed;
}

function memoryProjectDisplayNameFromId(projectId: string): string {
  const trimmed = projectId.trim();
  if (!trimmed) return trimmed;
  const parts = trimmed.split('/');
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return trimmed;
}

function memoryProjectOptionFromMemoryProject(project: ContextMemoryProjectView): MemoryProjectOption | null {
  const canonicalRepoId = project.projectId.trim();
  if (!canonicalRepoId) return null;
  return {
    id: canonicalRepoId,
    displayName: project.displayName?.trim() || memoryProjectDisplayNameFromId(canonicalRepoId),
    canonicalRepoId,
    source: 'memory_index',
    status: 'canonical_only',
    lastSeenAt: project.updatedAt,
  };
}

function memoryProjectOptionLabel(option: MemoryProjectOption, missingCanonical: string, missingDirectory: string): string {
  const identity = option.canonicalRepoId?.trim() || missingCanonical;
  const dir = option.projectDir?.trim() || missingDirectory;
  return `${option.displayName} — ${identity} — ${dir}`;
}

function clearTimeoutRef(ref: { current: TimeoutHandle | null }): void {
  if (ref.current === null) return;
  clearTimeout(ref.current);
  ref.current = null;
}

function mergeMemoryProjectOption(
  target: Map<string, MemoryProjectOption>,
  option: MemoryProjectOption,
): void {
  const id = memoryProjectOptionId(option);
  const existing = target.get(id);
  if (!existing) {
    target.set(id, { ...option, id });
    return;
  }
  target.set(id, {
    ...existing,
    ...option,
    id,
    displayName: option.displayName || existing.displayName,
    canonicalRepoId: option.canonicalRepoId || existing.canonicalRepoId,
    projectDir: option.projectDir || existing.projectDir,
    status: option.status === 'resolved' || existing.status !== 'resolved' ? option.status : existing.status,
    lastSeenAt: Math.max(existing.lastSeenAt ?? 0, option.lastSeenAt ?? 0) || undefined,
  });
}

export function SharedContextManagementPanel({ enterpriseId: initialEnterpriseId, serverId, ws, onEnterpriseChange, memoryProjectCandidates = [], activeProjectDir }: Props) {
  const { t } = useTranslation();
  const onEnterpriseChangeRef = useRef(onEnterpriseChange);
  onEnterpriseChangeRef.current = onEnterpriseChange;
  const personalMemoryRequestIdRef = useRef<string | null>(null);
  const memoryViewGenerationRef = useRef(0);
  const personalMemoryStatusTimerRef = useRef<TimeoutHandle | null>(null);
  const memoryFeaturesStatusTimerRef = useRef<TimeoutHandle | null>(null);
  const memoryAdminRequestIdsRef = useRef<Record<MemoryAdminRequestSurface, string | null>>({
    projectResolve: null,
    features: null,
    featureSet: null,
    preferences: null,
    skills: null,
    observations: null,
    prefCreate: null,
    prefDelete: null,
    skillRebuild: null,
    skillRead: null,
    skillDelete: null,
    mdIngest: null,
    observationPromote: null,
  });

  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [enterpriseId, setEnterpriseId] = useState(initialEnterpriseId ?? '');
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [workspaces, setWorkspaces] = useState<SharedWorkspace[]>([]);
  const [projects, setProjects] = useState<SharedProject[]>([]);
  const [documents, setDocuments] = useState<SharedDocument[]>([]);
  const [bindings, setBindings] = useState<SharedDocumentBinding[]>([]);
  const [loading, setLoading] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ManagementTab>('enterprise');

  const [newEnterpriseName, setNewEnterpriseName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [lastInviteToken, setLastInviteToken] = useState<string | null>(null);
  const [joinToken, setJoinToken] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [canonicalRepoId, setCanonicalRepoId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [scope, setScope] = useState<SharedScopeValue>('project_shared');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [selectedEnrollmentId, setSelectedEnrollmentId] = useState('');
  const [policy, setPolicy] = useState<SharedProjectPolicy>(defaultPolicyState);
  const [documentKind, setDocumentKind] = useState<KindOption>('coding_standard');
  const [documentTitle, setDocumentTitle] = useState('');
  const [selectedDocumentId, setSelectedDocumentId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [documentContent, setDocumentContent] = useState('');
  const [bindingMode, setBindingMode] = useState<'required' | 'advisory'>('required');
  const [bindingLanguage, setBindingLanguage] = useState('');
  const [bindingPathPattern, setBindingPathPattern] = useState('');
  const [processingLoading, setProcessingLoading] = useState(false);
  const [processingSaving, setProcessingSaving] = useState(false);
  const [processingSnapshot, setProcessingSnapshot] = useState<SharedContextRuntimeConfigSnapshot | null>(null);
  const [processingPrimaryBackend, setProcessingPrimaryBackend] = useState<SharedContextRuntimeBackend>(DEFAULT_PRIMARY_CONTEXT_BACKEND);
  const [processingPrimaryModel, setProcessingPrimaryModel] = useState(DEFAULT_PRIMARY_CONTEXT_MODEL);
  const [processingPrimaryPreset, setProcessingPrimaryPreset] = useState('');
  const [processingBackupBackend, setProcessingBackupBackend] = useState<SharedContextRuntimeBackend>(DEFAULT_PRIMARY_CONTEXT_BACKEND);
  const [processingBackupModel, setProcessingBackupModel] = useState('');
  const [processingBackupPreset, setProcessingBackupPreset] = useState('');
  const [processingMemoryRecallMinScore, setProcessingMemoryRecallMinScore] = useState(DEFAULT_MEMORY_RECALL_MIN_SCORE);
  const [processingMemoryScoringWeights, setProcessingMemoryScoringWeights] = useState<MemoryScoringWeights>({ ...DEFAULT_MEMORY_SCORING_WEIGHTS });
  const [memoryAdvancedVisible, setMemoryAdvancedVisible] = useState(false);
  const [processingPersonalSyncEnabled, setProcessingPersonalSyncEnabled] = useState(false);
  const [processingPresets, setProcessingPresets] = useState<Array<{ name: string; env: Record<string, string>; contextWindow?: number; initMessage?: string }>>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryProjectId, setMemoryProjectId] = useState('');
  const [selectedMemoryProjectId, setSelectedMemoryProjectId] = useState('');
  const [memoryBrowseProjectId, setMemoryBrowseProjectId] = useState('');
  const [memoryProjectSearch, setMemoryProjectSearch] = useState('');
  const [memoryIndexedProjects, setMemoryIndexedProjects] = useState<Record<string, MemoryProjectOption>>({});
  const [resolvedMemoryProjects, setResolvedMemoryProjects] = useState<Record<string, MemoryProjectOption>>({});
  const [resolvingMemoryProjectIds, setResolvingMemoryProjectIds] = useState<Set<string>>(new Set());
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryProjectionClass, setMemoryProjectionClass] = useState<'' | 'recent_summary' | 'durable_memory_candidate'>('');
  const [localPersonalMemory, setLocalPersonalMemory] = useState<ContextMemoryView>(EMPTY_MEMORY_VIEW);
  const [localPersonalMemoryStatus, setLocalPersonalMemoryStatus] = useState<MemoryResponseStatus>('idle');
  const [cloudPersonalMemory, setCloudPersonalMemory] = useState<ContextMemoryView>(EMPTY_MEMORY_VIEW);
  const [sharedMemory, setSharedMemory] = useState<ContextMemoryView>(EMPTY_MEMORY_VIEW);
  const [expandedMemoryRecordIds, setExpandedMemoryRecordIds] = useState<Set<string>>(new Set());
  const [memoryTopTab, setMemoryTopTab] = useState<MemoryTopTab>('personal');
  const [memoryToolTab, setMemoryToolTab] = useState<MemoryToolTab>('status');
  const [memoryPersonalSubTab, setMemoryPersonalSubTab] = useState<MemoryPersonalSubTab>('processed');
  const [memoryEnterpriseSubTab, setMemoryEnterpriseSubTab] = useState<MemoryEnterpriseSubTab>('shared-memory');
  const [showArchived, setShowArchived] = useState(false);
  const [deletingMemoryIds, setDeletingMemoryIds] = useState<Set<string>>(new Set());
  const [memoryFeatureRecords, setMemoryFeatureRecords] = useState<MemoryFeatureAdminRecord[]>([]);
  const [pendingMemoryFeatureFlags, setPendingMemoryFeatureFlags] = useState<Set<MemoryFeatureFlag>>(new Set());
  const [preferenceRecords, setPreferenceRecords] = useState<MemoryPreferenceAdminRecord[]>([]);
  const [preferenceFeatureEnabled, setPreferenceFeatureEnabled] = useState<boolean | null>(null);
  const preferenceUserId = 'server-derived';
  const [preferenceText, setPreferenceText] = useState('');
  const [preferenceSearch, setPreferenceSearch] = useState('');
  const [skillEntries, setSkillEntries] = useState<MemorySkillAdminRecord[]>([]);
  const [skillSearch, setSkillSearch] = useState('');
  const [skillsFeatureEnabled, setSkillsFeatureEnabled] = useState<boolean | null>(null);
  const [skillPreview, setSkillPreview] = useState<{ key: string; layer: string; content: string } | null>(null);
  const [memoryAdminProjectDir, setMemoryAdminProjectDir] = useState('');
  const [mdIngestProjectDir, setMdIngestProjectDir] = useState('');
  const [mdIngestCanonicalRepoId, setMdIngestCanonicalRepoId] = useState('');
  const [mdIngestScope, setMdIngestScope] = useState<MemoryScope>('personal');
  const [mdIngestFeatureEnabled, setMdIngestFeatureEnabled] = useState<boolean | null>(null);
  const [mdIngestResult, setMdIngestResult] = useState<{ filesChecked: number; observationsWritten: number } | null>(null);
  const [observationRecords, setObservationRecords] = useState<MemoryObservationAdminRecord[]>([]);
  const [observationSearch, setObservationSearch] = useState('');
  const [observationStoreFeatureEnabled, setObservationStoreFeatureEnabled] = useState<boolean | null>(null);
  const [observationScope, setObservationScope] = useState<'' | MemoryScope>('');
  const [observationClass, setObservationClass] = useState<MemoryObservationClassFilter>('');
  const [promotionTargetScope, setPromotionTargetScope] = useState<MemoryScope>('project_shared');
  const [promotionReason, setPromotionReason] = useState('');
  const [memoryFeaturesStatus, setMemoryFeaturesStatus] = useState<MemoryResponseStatus>('idle');
  const memoryFeatureRecordByFlag = useMemo(() => new Map<MemoryFeatureFlag, MemoryFeatureAdminRecord>(
    memoryFeatureRecords.map((record) => [record.flag, record]),
  ), [memoryFeatureRecords]);
  const applyMemoryFeatureRecords = useCallback((records: MemoryFeatureAdminRecord[]) => {
    setMemoryFeatureRecords(records);
    setPreferenceFeatureEnabled(records.find((record) => record.flag === MEMORY_FEATURE_FLAGS_BY_NAME.preferences)?.enabled ?? null);
    setSkillsFeatureEnabled(records.find((record) => record.flag === MEMORY_FEATURE_FLAGS_BY_NAME.skills)?.enabled ?? null);
    setMdIngestFeatureEnabled(records.find((record) => record.flag === MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest)?.enabled ?? null);
    setObservationStoreFeatureEnabled(records.find((record) => record.flag === MEMORY_FEATURE_FLAGS_BY_NAME.observationStore)?.enabled ?? null);
  }, []);
  const memoryFeatureKey = useCallback((flag: MemoryFeatureFlag): string => {
    switch (flag) {
      case MEMORY_FEATURE_FLAGS_BY_NAME.preferences:
        return 'preferences';
      case MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest:
        return 'mdIngest';
      case MEMORY_FEATURE_FLAGS_BY_NAME.skills:
        return 'skills';
      case MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation:
        return 'skillAutoCreation';
      case MEMORY_FEATURE_FLAGS_BY_NAME.observationStore:
        return 'observationStore';
      case MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry:
        return 'namespaceRegistry';
      default:
        return flag;
    }
  }, []);
  const memoryFeatureLabel = useCallback((flag: MemoryFeatureFlag): string => (
    t(`sharedContext.management.memoryFeatureLabel.${memoryFeatureKey(flag)}`)
  ), [memoryFeatureKey, t]);
  const memoryFeatureDisabledBehavior = useCallback((flag: MemoryFeatureFlag): string => (
    t(`sharedContext.management.memoryFeatureDisabledBehavior.${memoryFeatureKey(flag)}`)
  ), [memoryFeatureKey, t]);
  const memoryFeatureDisplay = useCallback((flag: MemoryFeatureFlag): { enabled: boolean | null; statusText: string; detail: string; blocked?: boolean } => {
    const record = memoryFeatureRecordByFlag.get(flag);
    if (!ws) {
      return {
        enabled: null,
        statusText: t('sharedContext.management.memoryFeatureUnavailable'),
        detail: t('sharedContext.management.memoryFeatureUnavailableDetail'),
      };
    }
    if (memoryFeaturesStatus === 'loading' || memoryFeaturesStatus === 'idle') {
      return {
        enabled: null,
        statusText: t('sharedContext.management.memoryFeatureLoading'),
        detail: t('sharedContext.management.memoryFeatureLoadingDetail'),
      };
    }
    if (memoryFeaturesStatus === 'timeout') {
      return {
        enabled: null,
        statusText: t('sharedContext.management.memoryFeatureNoResponse'),
        detail: t('sharedContext.management.memoryFeatureNoResponseDetail'),
      };
    }
    if (memoryFeaturesStatus === 'error') {
      return {
        enabled: null,
        statusText: t('sharedContext.management.memoryFeatureError'),
        detail: t('sharedContext.management.memoryFeatureErrorDetail'),
      };
    }
    if (!record) {
      return {
        enabled: null,
        statusText: t('sharedContext.management.memoryFeatureUnknown'),
        detail: t('sharedContext.management.memoryFeatureUnknownDetail'),
      };
    }
    if (record.enabled) {
      return {
        enabled: true,
        statusText: t('sharedContext.management.memoryFeatureEnabled'),
        detail: t('sharedContext.management.memoryFeatureEnabledDetail'),
      };
    }
    if (record.requested && record.dependencyBlocked?.length) {
      return {
        enabled: false,
        statusText: t('sharedContext.management.memoryFeatureBlocked'),
        blocked: true,
        detail: t('sharedContext.management.memoryFeatureDependencyBlockedHint', {
          deps: record.dependencyBlocked.map(memoryFeatureLabel).join(', '),
          behavior: memoryFeatureDisabledBehavior(flag),
        }),
      };
    }
    return {
      enabled: false,
      statusText: t('sharedContext.management.memoryFeatureDisabled'),
      detail: t('sharedContext.management.memoryFeatureDisabledHint', {
        env: record.envKey || memoryFeatureFlagEnvKey(flag),
        behavior: memoryFeatureDisabledBehavior(flag),
      }),
    };
  }, [memoryFeatureDisabledBehavior, memoryFeatureLabel, memoryFeatureRecordByFlag, memoryFeaturesStatus, t, ws]);
  const memoryAdminErrorMessage = useCallback((errorCode?: MemoryManagementErrorCode, fallback?: string): string => {
    if (errorCode) return t(`sharedContext.management.error.${errorCode}`);
    return fallback ?? t('sharedContext.management.memoryAdminActionFailed');
  }, [t]);
  const markMemoryAdminRequest = useCallback((surface: MemoryAdminRequestSurface): string => {
    const requestId = crypto.randomUUID();
    memoryAdminRequestIdsRef.current[surface] = requestId;
    return requestId;
  }, []);
  const isCurrentMemoryAdminResponse = useCallback((surface: MemoryAdminRequestSurface, requestId?: string): boolean => (
    !!requestId && memoryAdminRequestIdsRef.current[surface] === requestId
  ), []);
  const rememberMemoryProjectIndex = useCallback((projects?: readonly ContextMemoryProjectView[]) => {
    if (!projects?.length) return;
    setMemoryIndexedProjects((current) => {
      const next = new Map(Object.values(current).map((option) => [option.id, option] as const));
      for (const project of projects) {
        const option = memoryProjectOptionFromMemoryProject(project);
        if (option) mergeMemoryProjectOption(next, option);
      }
      return Object.fromEntries(next);
    });
  }, []);

  useEffect(() => {
    if (!ws) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'cc.presets.list_response') {
        setProcessingPresets((msg as { presets?: Array<{ name: string; env: Record<string, string>; contextWindow?: number; initMessage?: string }> }).presets ?? []);
      }
    });
    try { ws.send({ type: 'cc.presets.list' }); } catch {}
    return unsub;
  }, [ws]);

  const renderProcessedMemoryRecords = useCallback((
    view: ContextMemoryView,
    opts?: {
      allowArchiveRestore?: boolean;
      allowDelete?: boolean;
      onArchive?: (id: string, projectId?: string) => void;
      onRestore?: (id: string, projectId?: string) => void;
      onDelete?: (id: string, projectId?: string) => void;
    },
  ) => {
    const allowActions = opts?.allowArchiveRestore ?? false;
    const allowDelete = opts?.allowDelete ?? false;
    const onArchive = opts?.onArchive;
    const onRestore = opts?.onRestore;
    const onDelete = opts?.onDelete;
    const visibleRecords = showArchived ? view.records : view.records.filter((r) => (r.status ?? 'active') === 'active');
    const recentRecords = visibleRecords.filter((record) => record.projectionClass === 'recent_summary');
    const durableRecords = visibleRecords.filter((record) => record.projectionClass === 'durable_memory_candidate');
    const masterRecords = visibleRecords.filter((record) => record.projectionClass === 'master_summary');
    const sections = [
      {
        key: 'recent' as const,
        title: t('sharedContext.management.memoryRecentSummary'),
        description: t('sharedContext.management.memoryRecentDescription'),
        records: recentRecords,
      },
      {
        key: 'durable' as const,
        title: t('sharedContext.management.memoryDurableCandidate'),
        description: t('sharedContext.management.memoryDurableDescription'),
        records: durableRecords,
      },
      {
        key: 'master' as const,
        title: t('sharedContext.management.memoryMasterSummary'),
        description: undefined,
        records: masterRecords,
      },
    ].filter((section) => section.records.length > 0) satisfies Array<{
      key: 'recent' | 'durable' | 'master';
      title: string;
      description?: string;
      records: typeof visibleRecords;
    }>;

    if (sections.length === 0) {
      return <div style={helperTextStyle}>{t('sharedContext.empty')}</div>;
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {sections.map((section) => (
          <div key={section.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SectionHeading title={section.title} description={section.description} />
            <div style={resourceListStyle}>
              {section.records.map((record) => {
                const isArchived = (record.status ?? 'active') !== 'active';
                return (
                  <div key={record.id} style={{ ...resourceCardStyle, ...(isArchived ? { opacity: 0.6 } : {}) }}>
                    {/* Compact meta: inline chips */}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={metaChipStyle} title={record.projectId}>{record.projectId.split('/').pop()}</span>
                      <span style={metaChipStyle}>{getMemoryRecordClassLabel(t, record.projectionClass)}</span>
                      <span style={metaChipStyle}>{record.sourceEventCount} {t('sharedContext.management.memoryRecordSources').toLowerCase()}</span>
                      {isArchived ? (
                        <span style={archiveBadgeStyle}>{t('sharedContext.management.memoryArchived')}</span>
                      ) : null}
                      {(record.hitCount ?? 0) > 0 ? (
                        <span style={recallChipStyle}>{t('sharedContext.management.memoryRecalls', { count: record.hitCount })}</span>
                      ) : null}
                      <span style={{ color: DT.text.muted, fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}>
                        {new Date(record.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    {/* Recall time + archive/restore action row */}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ color: DT.text.muted, fontSize: 10 }}>
                        {record.lastUsedAt
                          ? t('sharedContext.management.memoryLastRecalled', { time: formatRelativeTime(record.lastUsedAt, t) })
                          : t('sharedContext.management.memoryNeverRecalled')}
                      </span>
                      {allowActions || allowDelete ? (
                        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                          {allowActions ? (
                            isArchived ? (
                              <button
                                type="button"
                                style={archiveRestoreButtonStyle}
                                onClick={() => onRestore?.(record.id, record.projectId)}
                              >
                                {t('sharedContext.management.memoryRestore')}
                              </button>
                            ) : (
                              <button
                                type="button"
                                style={archiveRestoreButtonStyle}
                                onClick={() => onArchive?.(record.id, record.projectId)}
                              >
                                {t('sharedContext.management.memoryArchive')}
                              </button>
                            )
                          ) : null}
                          {allowDelete ? (
                            <button
                              type="button"
                              style={deleteButtonStyle}
                              onClick={() => onDelete?.(record.id, record.projectId)}
                              disabled={deletingMemoryIds.has(record.id)}
                            >
                              {t('sharedContext.management.memoryDelete')}
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </div>
                    {/* Summary with integrated expand */}
                    {record.summary ? (
                      <MemoryRecordContent
                        id={record.id}
                        text={record.summary}
                        expanded={expandedMemoryRecordIds.has(record.id)}
                        expandLabel={t('sharedContext.management.memoryExpand')}
                        collapseLabel={t('sharedContext.management.memoryCollapse')}
                        onToggle={() => {
                          setExpandedMemoryRecordIds((current) => {
                            const next = new Set(current);
                            if (next.has(record.id)) next.delete(record.id);
                            else next.add(record.id);
                            return next;
                          });
                        }}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }, [deletingMemoryIds, expandedMemoryRecordIds, t, showArchived]);

  const selectedDocument = useMemo(
    () => documents.find((entry) => entry.id === selectedDocumentId) ?? null,
    [documents, selectedDocumentId],
  );
  const selectedProject = useMemo(
    () => projects.find((entry) => entry.id === selectedEnrollmentId) ?? null,
    [projects, selectedEnrollmentId],
  );
  const workspaceNameById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  );
  const scopePresentation = useMemo<Record<SharedScopeValue, { label: string; description: string }>>(() => ({
    project_shared: {
      label: t('sharedContext.management.scopeProjectLabel'),
      description: t('sharedContext.management.scopeProjectDescription'),
    },
    workspace_shared: {
      label: t('sharedContext.management.scopeWorkspaceLabel'),
      description: t('sharedContext.management.scopeWorkspaceDescription'),
    },
    org_shared: {
      label: t('sharedContext.management.scopeEnterpriseLabel'),
      description: t('sharedContext.management.scopeEnterpriseDescription'),
    },
  }), [t]);
  const currentScopePresentation = scopePresentation[scope];

  const tabs = useMemo<TabDef[]>(() => [
    { id: 'enterprise', label: t('sharedContext.management.tabs.enterprise') },
    { id: 'members', label: t('sharedContext.management.tabs.members') },
    { id: 'projects', label: t('sharedContext.management.tabs.projects') },
    { id: 'knowledge', label: t('sharedContext.management.tabs.knowledge') },
    { id: 'processing', label: t('sharedContext.management.tabs.processing') },
    { id: 'memory', label: t('sharedContext.management.tabs.memory') },
  ], [t]);

  const memoryTopTabs = useMemo(() => [
    { id: 'personal' as const, label: t('sharedContext.management.memoryTabPersonal'), count: localPersonalMemory.stats.totalRecords + (localPersonalMemory.pendingRecords?.length ?? 0) + cloudPersonalMemory.stats.totalRecords },
    { id: 'enterprise-memory' as const, label: t('sharedContext.management.memoryTabEnterprise'), count: sharedMemory.stats.totalRecords },
  ], [t, localPersonalMemory, cloudPersonalMemory, sharedMemory]);
  const memoryPersonalSubTabs = useMemo(() => [
    { id: 'unprocessed' as const, label: t('sharedContext.management.memoryTabLocalPending'), count: localPersonalMemory.pendingRecords?.length ?? 0 },
    { id: 'processed' as const, label: t('sharedContext.management.memoryTabLocalProcessed'), count: localPersonalMemory.stats.totalRecords },
    { id: 'cloud' as const, label: t('sharedContext.management.memoryTabCloud'), count: cloudPersonalMemory.stats.totalRecords },
  ], [t, localPersonalMemory, cloudPersonalMemory]);
  const memoryEnterpriseSubTabs = useMemo(() => [
    { id: 'shared-memory' as const, label: t('sharedContext.management.memoryTabSharedMemory'), count: sharedMemory.stats.totalRecords },
    { id: 'authored-context' as const, label: t('sharedContext.management.memoryTabAuthoredContext') },
  ], [t, sharedMemory]);

  const memoryProjectOptions = useMemo<MemoryProjectOption[]>(() => {
    const options = new Map<string, MemoryProjectOption>();

    for (const candidate of memoryProjectCandidates) {
      const projectDir = candidate.projectDir?.trim();
      const candidateCanonicalRepoId = candidate.canonicalRepoId?.trim();
      if (!projectDir && !candidateCanonicalRepoId) continue;
      const display = candidate.displayName?.trim()
        || (projectDir ? projectDirDisplayName(projectDir) : candidateCanonicalRepoId ?? '');
      mergeMemoryProjectOption(options, {
        id: candidateCanonicalRepoId || projectDir || display,
        displayName: display,
        canonicalRepoId: candidateCanonicalRepoId,
        projectDir,
        source: candidate.source ?? (projectDir === activeProjectDir ? 'active_session' : 'recent_session'),
        status: candidateCanonicalRepoId && projectDir ? 'resolved' : projectDir ? 'needs_resolution' : 'canonical_only',
        lastSeenAt: candidate.lastSeenAt,
      });
    }

    for (const project of projects) {
      if (project.status !== 'active') continue;
      const canonicalRepoId = project.canonicalRepoId.trim();
      if (!canonicalRepoId) continue;
      mergeMemoryProjectOption(options, {
        id: canonicalRepoId,
        displayName: project.displayName?.trim() || canonicalRepoId,
        canonicalRepoId,
        source: 'enterprise_enrollment',
        status: 'canonical_only',
      });
    }

    for (const option of Object.values(memoryIndexedProjects)) {
      mergeMemoryProjectOption(options, option);
    }

    for (const option of Object.values(resolvedMemoryProjects)) {
      mergeMemoryProjectOption(options, option);
    }

    return Array.from(options.values()).sort((a, b) => {
      if (a.projectDir === activeProjectDir) return -1;
      if (b.projectDir === activeProjectDir) return 1;
      return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.displayName.localeCompare(b.displayName);
    });
  }, [activeProjectDir, memoryIndexedProjects, memoryProjectCandidates, projects, resolvedMemoryProjects]);

  const selectedMemoryProject = useMemo(
    () => memoryProjectOptions.find((option) => option.id === selectedMemoryProjectId) ?? null,
    [memoryProjectOptions, selectedMemoryProjectId],
  );
  const selectedBrowseMemoryProject = useMemo(
    () => memoryProjectOptions.find((option) => option.id === memoryBrowseProjectId) ?? null,
    [memoryProjectOptions, memoryBrowseProjectId],
  );
  const selectedMemoryProjectCapabilities = useMemo(
    () => deriveMemoryProjectCapabilities(selectedMemoryProject),
    [selectedMemoryProject],
  );
  const browseCanonicalRepoId = selectedBrowseMemoryProject?.canonicalRepoId?.trim() || undefined;
  const selectedCanonicalRepoId = selectedMemoryProject?.canonicalRepoId?.trim() || memoryProjectId.trim() || undefined;
  const selectedProjectDir = selectedMemoryProject?.projectDir?.trim() || memoryAdminProjectDir.trim() || undefined;
  const selectedMdProjectDir = selectedMemoryProject?.projectDir?.trim() || mdIngestProjectDir.trim() || undefined;
  const selectedMdCanonicalRepoId = selectedMemoryProject?.canonicalRepoId?.trim() || mdIngestCanonicalRepoId.trim() || memoryProjectId.trim() || undefined;

  const filteredMemoryProjectOptions = useMemo(() => {
    const needle = memoryProjectSearch.trim().toLowerCase();
    if (!needle) return memoryProjectOptions;
    return memoryProjectOptions.filter((option) => [
      option.displayName,
      option.canonicalRepoId,
      option.projectDir,
      option.source,
      option.status,
    ].some((value) => value?.toLowerCase().includes(needle)));
  }, [memoryProjectOptions, memoryProjectSearch]);

  const filteredPreferenceRecords = useMemo(() => {
    const needle = preferenceSearch.trim().toLowerCase();
    if (!needle) return preferenceRecords;
    return preferenceRecords.filter((record) => [
      record.text,
      record.userId,
      record.state,
      record.origin,
      record.fingerprint,
    ].some((value) => value?.toLowerCase().includes(needle)));
  }, [preferenceRecords, preferenceSearch]);

  const filteredSkillEntries = useMemo(() => {
    const needle = skillSearch.trim().toLowerCase();
    if (!needle) return skillEntries;
    return skillEntries.filter((entry) => [
      entry.name,
      entry.key,
      entry.layer,
      entry.category,
      entry.description,
      entry.displayPath,
      entry.uri,
    ].some((value) => value?.toLowerCase().includes(needle)));
  }, [skillEntries, skillSearch]);

  const filteredObservationRecords = useMemo(() => {
    const needle = observationSearch.trim().toLowerCase();
    if (!needle) return observationRecords;
    return observationRecords.filter((record) => [
      record.text,
      record.scope,
      record.class,
      record.origin,
      record.state,
      record.namespaceId,
      record.fingerprint,
    ].some((value) => value?.toLowerCase().includes(needle)));
  }, [observationRecords, observationSearch]);

  useEffect(() => {
    if (selectedMemoryProjectId && memoryProjectOptions.some((option) => option.id === selectedMemoryProjectId)) return;
    const preferred = memoryProjectOptions.find((option) => option.projectDir === activeProjectDir)
      ?? memoryProjectOptions.find((option) => option.status === 'resolved')
      ?? memoryProjectOptions[0];
    if (preferred) setSelectedMemoryProjectId(preferred.id);
  }, [activeProjectDir, memoryProjectOptions, selectedMemoryProjectId]);

  useEffect(() => {
    if (!memoryBrowseProjectId) return;
    if (memoryProjectOptions.some((option) => option.id === memoryBrowseProjectId && option.canonicalRepoId?.trim())) return;
    setMemoryBrowseProjectId('');
  }, [memoryBrowseProjectId, memoryProjectOptions]);

  const memoryProjectStatusLabel = useCallback((status: MemoryProjectResolutionStatus): string => (
    t(`sharedContext.management.memoryProjectStatus.${status}`)
  ), [t]);

  const memoryProjectSourceLabel = useCallback((source: MemoryProjectOption['source']): string => (
    t(`sharedContext.management.memoryProjectSource.${source}`)
  ), [t]);

  const toggleMemoryFeatureFlag = useCallback((flag: MemoryFeatureFlag) => {
    if (!ws) return;
    const record = memoryFeatureRecordByFlag.get(flag);
    const nextEnabled = !(record?.requested ?? record?.enabled ?? false);
    const requestId = markMemoryAdminRequest('featureSet');
    setPendingMemoryFeatureFlags((current) => new Set(current).add(flag));
    ws.send({
      type: MEMORY_WS.FEATURES_SET,
      requestId,
      flag,
      enabled: nextEnabled,
    });
  }, [markMemoryAdminRequest, memoryFeatureRecordByFlag, ws]);

  const resolveMemoryProject = useCallback((option: MemoryProjectOption) => {
    if (!ws || !option.projectDir) return;
    const projectDir = option.projectDir.trim();
    if (!projectDir || resolvingMemoryProjectIds.has(projectDir)) return;
    const requestId = markMemoryAdminRequest('projectResolve');
    setResolvingMemoryProjectIds((current) => new Set(current).add(projectDir));
    ws.send({
      type: MEMORY_WS.PROJECT_RESOLVE,
      requestId,
      projectDir,
      canonicalRepoId: option.canonicalRepoId?.trim() || undefined,
    });
  }, [markMemoryAdminRequest, resolvingMemoryProjectIds, ws]);

  const refreshEnterpriseData = useCallback(async (nextEnterpriseId = enterpriseId) => {
    if (!nextEnterpriseId) {
      setTeam(null);
      setWorkspaces([]);
      setProjects([]);
      setDocuments([]);
      setBindings([]);
      setSelectedWorkspaceId('');
      setSelectedEnrollmentId('');
      setSelectedDocumentId('');
      setSelectedVersionId('');
      setPolicy(defaultPolicyState);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [teamDetail, nextWorkspaces, nextProjects, nextDocuments, nextBindings] = await Promise.all([
        getTeam(nextEnterpriseId),
        listSharedWorkspaces(nextEnterpriseId),
        listSharedProjects(nextEnterpriseId),
        listSharedDocuments(nextEnterpriseId),
        listSharedDocumentBindings(nextEnterpriseId),
      ]);
      setTeam(teamDetail);
      setWorkspaces(nextWorkspaces);
      setProjects(nextProjects);
      setDocuments(nextDocuments);
      setBindings(nextBindings);
      setSelectedWorkspaceId((prev) => (
        prev && nextWorkspaces.some((workspace) => workspace.id === prev)
          ? prev
          : (nextWorkspaces[0]?.id ?? '')
      ));
      setSelectedEnrollmentId((prev) => (
        prev && nextProjects.some((project) => project.id === prev)
          ? prev
          : (nextProjects[0]?.id ?? '')
      ));
      setSelectedDocumentId((prev) => (
        prev && nextDocuments.some((document) => document.id === prev)
          ? prev
          : (nextDocuments[0]?.id ?? '')
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [enterpriseId]);

  useEffect(() => {
    void listTeams()
      .then((nextTeams) => {
        setTeams(nextTeams);
        if (!enterpriseId && nextTeams[0]) {
          setEnterpriseId(nextTeams[0].id);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!enterpriseId) return;
    onEnterpriseChangeRef.current?.(enterpriseId);
    void refreshEnterpriseData(enterpriseId);
  }, [enterpriseId]);

  useEffect(() => {
    const versions = selectedDocument?.versions ?? [];
    if (versions.length === 0) {
      setSelectedVersionId('');
      return;
    }
    setSelectedVersionId((prev) => (
      prev && versions.some((version) => version.id === prev)
        ? prev
        : versions[0].id
    ));
  }, [selectedDocument]);

  useEffect(() => {
    if (!selectedEnrollmentId) {
      setPolicy(defaultPolicyState);
      return;
    }
    setPolicyLoading(true);
    setError(null);
    void getSharedProjectPolicy(selectedEnrollmentId)
      .then((nextPolicy) => setPolicy(nextPolicy))
      .catch((err) => {
        setPolicy(defaultPolicyState);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setPolicyLoading(false));
  }, [selectedEnrollmentId]);

  const handleAction = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.code ?? err.body);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  const applyProcessingSnapshot = useCallback((view: SharedContextRuntimeConfigView) => {
    setProcessingSnapshot(view.snapshot);
    setProcessingPrimaryBackend(view.snapshot.persisted.primaryContextBackend);
    setProcessingPrimaryModel(view.snapshot.persisted.primaryContextModel);
    setProcessingPrimaryPreset(view.snapshot.persisted.primaryContextPreset ?? '');
    setProcessingBackupBackend(view.snapshot.persisted.backupContextBackend ?? view.snapshot.persisted.primaryContextBackend);
    setProcessingBackupModel(view.snapshot.persisted.backupContextModel ?? '');
    setProcessingBackupPreset(view.snapshot.persisted.backupContextPreset ?? '');
    setProcessingMemoryRecallMinScore(view.snapshot.persisted.memoryRecallMinScore ?? DEFAULT_MEMORY_RECALL_MIN_SCORE);
    setProcessingMemoryScoringWeights(normalizeMemoryScoringWeights(view.snapshot.persisted.memoryScoringWeights ?? DEFAULT_MEMORY_SCORING_WEIGHTS));
    setProcessingPersonalSyncEnabled(view.snapshot.persisted.enablePersonalMemorySync === true);
  }, []);

  /** Defensive sync: if the persisted preset disappears from the loaded preset
   *  list (e.g. user deleted it elsewhere, or ws reload raced), clear the
   *  local preset bit so the UI never stays stuck on a non-existent preset.
   *  The model stays — it's independently valid. */
  useEffect(() => {
    const names = new Set(processingPresets.map((p) => p.name));
    if (processingPrimaryPreset && !names.has(processingPrimaryPreset)) {
      setProcessingPrimaryPreset('');
    }
    if (processingBackupPreset && !names.has(processingBackupPreset)) {
      setProcessingBackupPreset('');
    }
  }, [processingPresets, processingPrimaryPreset, processingBackupPreset]);

  const reloadProcessingConfig = useCallback(async () => {
    if (!serverId) {
      setProcessingSnapshot(null);
      setProcessingPrimaryBackend(DEFAULT_PRIMARY_CONTEXT_BACKEND);
      setProcessingPrimaryModel(DEFAULT_PRIMARY_CONTEXT_MODEL);
      setProcessingPrimaryPreset('');
      setProcessingBackupBackend(DEFAULT_PRIMARY_CONTEXT_BACKEND);
      setProcessingBackupModel('');
      setProcessingBackupPreset('');
      setProcessingMemoryRecallMinScore(DEFAULT_MEMORY_RECALL_MIN_SCORE);
      setProcessingMemoryScoringWeights({ ...DEFAULT_MEMORY_SCORING_WEIGHTS });
      setProcessingPersonalSyncEnabled(false);
      return;
    }
    setProcessingLoading(true);
    setError(null);
    try {
      const view = await fetchSharedContextRuntimeConfig(serverId);
      applyProcessingSnapshot(view);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessingLoading(false);
    }
  }, [applyProcessingSnapshot, serverId]);

  useEffect(() => {
    if (activeTab !== 'processing' && activeTab !== 'memory') return;
    void reloadProcessingConfig();
  }, [activeTab, reloadProcessingConfig]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      if (msg.type !== MEMORY_WS.PERSONAL_RESPONSE) return;
      if (msg.requestId !== personalMemoryRequestIdRef.current) return;
      clearTimeoutRef(personalMemoryStatusTimerRef);
      rememberMemoryProjectIndex(msg.projects ?? []);
      setLocalPersonalMemory(normalizeMemoryView({
        stats: msg.stats,
        records: msg.records,
        pendingRecords: msg.pendingRecords ?? [],
        projects: msg.projects ?? [],
      }));
      setLocalPersonalMemoryStatus(msg.errorCode ? 'error' : 'ready');
    });
  }, [rememberMemoryProjectIndex, ws]);

  const loadMemoryViews = useCallback(async () => {
    const generation = memoryViewGenerationRef.current + 1;
    memoryViewGenerationRef.current = generation;
    setMemoryLoading(true);
    setError(null);
    try {
      const queryInput = {
        ...(browseCanonicalRepoId ? { projectId: browseCanonicalRepoId } : {}),
        projectionClass: memoryProjectionClass || undefined,
        query: memoryQuery.trim() || undefined,
        limit: 25,
      };
      if (ws) {
        const requestId = crypto.randomUUID();
        personalMemoryRequestIdRef.current = requestId;
        clearTimeoutRef(personalMemoryStatusTimerRef);
        setLocalPersonalMemoryStatus('loading');
        personalMemoryStatusTimerRef.current = setTimeout(() => {
          personalMemoryStatusTimerRef.current = null;
          if (personalMemoryRequestIdRef.current === requestId) {
            setLocalPersonalMemoryStatus((current) => (current === 'loading' ? 'timeout' : current));
          }
        }, 8000);
        ws.send({
          type: MEMORY_WS.PERSONAL_QUERY,
          requestId,
          ...(browseCanonicalRepoId ? { canonicalRepoId: browseCanonicalRepoId } : {}),
          ...queryInput,
          includeArchived: showArchived,
        });
      } else {
        clearTimeoutRef(personalMemoryStatusTimerRef);
        setLocalPersonalMemory(EMPTY_MEMORY_VIEW);
        setLocalPersonalMemoryStatus('unavailable');
      }

      const cloudView = normalizeMemoryView(await getPersonalCloudMemory(queryInput));
      if (memoryViewGenerationRef.current !== generation) return;
      rememberMemoryProjectIndex(cloudView.projects ?? []);
      setCloudPersonalMemory(cloudView);

      if (enterpriseId) {
        const enterpriseView = normalizeMemoryView(await getEnterpriseSharedMemory(enterpriseId, {
          ...(browseCanonicalRepoId ? { canonicalRepoId: browseCanonicalRepoId } : {}),
          projectionClass: memoryProjectionClass || undefined,
          query: memoryQuery.trim() || undefined,
          limit: 25,
        }));
        if (memoryViewGenerationRef.current !== generation) return;
        rememberMemoryProjectIndex(enterpriseView.projects ?? []);
        setSharedMemory(enterpriseView);
      } else {
        if (memoryViewGenerationRef.current !== generation) return;
        setSharedMemory(EMPTY_MEMORY_VIEW);
      }
    } catch (err) {
      if (memoryViewGenerationRef.current === generation) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (memoryViewGenerationRef.current === generation) setMemoryLoading(false);
    }
  }, [browseCanonicalRepoId, enterpriseId, memoryProjectionClass, memoryQuery, rememberMemoryProjectIndex, ws, showArchived]);

  const loadMemoryAdminViews = useCallback(() => {
    if (!ws) {
      clearTimeoutRef(memoryFeaturesStatusTimerRef);
      setMemoryFeaturesStatus('unavailable');
      return;
    }
    const projectDir = selectedProjectDir;
    const canonicalRepoId = selectedCanonicalRepoId;
    const featuresRequestId = markMemoryAdminRequest('features');
    clearTimeoutRef(memoryFeaturesStatusTimerRef);
    setMemoryFeaturesStatus('loading');
    memoryFeaturesStatusTimerRef.current = setTimeout(() => {
      memoryFeaturesStatusTimerRef.current = null;
      if (memoryAdminRequestIdsRef.current.features === featuresRequestId) {
        setMemoryFeaturesStatus((current) => (current === 'loading' ? 'timeout' : current));
      }
    }, 8000);
    ws.send({ type: MEMORY_WS.FEATURES_QUERY, requestId: featuresRequestId });
    ws.send({ type: MEMORY_WS.PREF_QUERY, requestId: markMemoryAdminRequest('preferences') });
    ws.send({ type: MEMORY_WS.SKILL_QUERY, requestId: markMemoryAdminRequest('skills'), projectDir, canonicalRepoId });
    ws.send({
      type: MEMORY_WS.OBSERVATION_QUERY,
      requestId: markMemoryAdminRequest('observations'),
      projectDir,
      canonicalRepoId,
      scope: observationScope || undefined,
      class: observationClass || undefined,
      limit: 50,
    });
  }, [markMemoryAdminRequest, observationClass, observationScope, selectedCanonicalRepoId, selectedProjectDir, ws]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      if (msg.type === MEMORY_WS.PROJECT_RESOLVE_RESPONSE) {
        const resolveMsg = msg as unknown as {
          requestId?: string;
          success: boolean;
          projectDir?: string;
          canonicalRepoId?: string;
          displayName?: string;
          status?: MemoryProjectResolutionStatus;
          error?: string;
          errorCode?: MemoryManagementErrorCode;
        };
        if (!isCurrentMemoryAdminResponse('projectResolve', resolveMsg.requestId)) return;
        const projectDir = resolveMsg.projectDir?.trim();
        const canonicalRepoId = resolveMsg.canonicalRepoId?.trim();
        const displayName = resolveMsg.displayName?.trim()
          || (projectDir ? projectDirDisplayName(projectDir) : canonicalRepoId)
          || t('sharedContext.management.memoryProjectUnknown');
        if (projectDir) {
          setResolvingMemoryProjectIds((current) => {
            const next = new Set(current);
            next.delete(projectDir);
            return next;
          });
        }
        const option: MemoryProjectOption = {
          id: canonicalRepoId || projectDir || displayName,
          displayName,
          canonicalRepoId,
          projectDir,
          source: 'resolved_directory',
          status: resolveMsg.status ?? (resolveMsg.success ? 'resolved' : 'error'),
          lastSeenAt: Date.now(),
        };
        const key = projectDir || canonicalRepoId || option.id;
        setResolvedMemoryProjects((current) => ({ ...current, [key]: option }));
        if (resolveMsg.success && canonicalRepoId) {
          setSelectedMemoryProjectId(memoryProjectOptionId(option));
          setMemoryProjectId(canonicalRepoId);
          if (projectDir) {
            setMemoryAdminProjectDir(projectDir);
            setMdIngestProjectDir(projectDir);
          }
          setMdIngestCanonicalRepoId(canonicalRepoId);
        } else {
          setError(memoryAdminErrorMessage(resolveMsg.errorCode, resolveMsg.error));
        }
        return;
      }
      if (msg.type === MEMORY_WS.FEATURES_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('features', msg.requestId)) return;
        clearTimeoutRef(memoryFeaturesStatusTimerRef);
        const records = msg.records ?? [];
        setMemoryFeaturesStatus('ready');
        applyMemoryFeatureRecords(records);
        return;
      }
      if (msg.type === MEMORY_WS.FEATURES_SET_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('featureSet', msg.requestId)) return;
        const flag = msg.flag as MemoryFeatureFlag | undefined;
        if (flag) {
          setPendingMemoryFeatureFlags((current) => {
            const next = new Set(current);
            next.delete(flag);
            return next;
          });
        } else {
          setPendingMemoryFeatureFlags(new Set());
        }
        if (msg.success) {
          const records = msg.records ?? [];
          if (records.length) applyMemoryFeatureRecords(records);
          if (flag) {
            setNotice(t(msg.requested === false
              ? 'sharedContext.notice.memoryFeatureDisabled'
              : 'sharedContext.notice.memoryFeatureEnabled', {
              flag: memoryFeatureLabel(flag),
            }));
          }
          loadMemoryAdminViews();
        } else {
          setError(memoryAdminErrorMessage(msg.errorCode, msg.error));
        }
        return;
      }
      if (msg.type === MEMORY_WS.PREF_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('preferences', msg.requestId)) return;
        setPreferenceRecords(msg.records ?? []);
        if (msg.featureEnabled !== undefined) setPreferenceFeatureEnabled(msg.featureEnabled);
        return;
      }
      if (msg.type === MEMORY_WS.SKILL_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('skills', msg.requestId)) return;
        setSkillEntries(msg.entries ?? []);
        if (msg.featureEnabled !== undefined) setSkillsFeatureEnabled(msg.featureEnabled);
        return;
      }
      if (msg.type === MEMORY_WS.OBSERVATION_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('observations', msg.requestId)) return;
        setObservationRecords(msg.records ?? []);
        if (msg.featureEnabled !== undefined) setObservationStoreFeatureEnabled(msg.featureEnabled);
        return;
      }
      if (msg.type === MEMORY_WS.PREF_CREATE_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('prefCreate', msg.requestId)) return;
        if (msg.success) {
          setPreferenceText('');
          setNotice(t('sharedContext.notice.memoryPreferenceSaved'));
          loadMemoryAdminViews();
        } else setError(memoryAdminErrorMessage(msg.errorCode, msg.error));
        return;
      }
      if (msg.type === MEMORY_WS.PREF_DELETE_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('prefDelete', msg.requestId)) return;
        if (msg.success) {
          setNotice(t('sharedContext.notice.memoryPreferenceDeleted'));
          loadMemoryAdminViews();
        } else setError(memoryAdminErrorMessage(msg.errorCode, msg.error));
        return;
      }
      if (msg.type === MEMORY_WS.SKILL_REBUILD_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('skillRebuild', msg.requestId)) return;
        if (msg.success) {
          setNotice(t('sharedContext.notice.memorySkillRegistryRebuilt'));
          loadMemoryAdminViews();
        } else setError(memoryAdminErrorMessage(msg.errorCode, msg.error));
        return;
      }
      if (msg.type === MEMORY_WS.SKILL_READ_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('skillRead', msg.requestId)) return;
        if (msg.success && msg.key && msg.layer) {
          setSkillPreview({ key: msg.key, layer: msg.layer, content: msg.content ?? '' });
        } else setError(memoryAdminErrorMessage(msg.errorCode, msg.error));
        return;
      }
      if (msg.type === MEMORY_WS.SKILL_DELETE_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('skillDelete', msg.requestId)) return;
        if (msg.success) {
          setSkillPreview(null);
          setNotice(t('sharedContext.notice.memorySkillDeleted'));
          loadMemoryAdminViews();
        } else setError(memoryAdminErrorMessage(msg.errorCode, msg.error));
        return;
      }
      if (msg.type === MEMORY_WS.MD_INGEST_RUN_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('mdIngest', msg.requestId)) return;
        if (msg.featureEnabled !== undefined) setMdIngestFeatureEnabled(msg.featureEnabled);
        if (msg.success) {
          setMdIngestResult({ filesChecked: msg.filesChecked ?? 0, observationsWritten: msg.observationsWritten ?? 0 });
          setNotice(t('sharedContext.notice.memoryMdIngestCompleted'));
          void loadMemoryViews();
          loadMemoryAdminViews();
        } else setError(memoryAdminErrorMessage(msg.errorCode, msg.error));
        return;
      }
      if (msg.type === MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE) {
        if (!isCurrentMemoryAdminResponse('observationPromote', msg.requestId)) return;
        if (msg.success) {
          setNotice(t('sharedContext.notice.memoryObservationPromoted'));
          loadMemoryAdminViews();
        } else setError(memoryAdminErrorMessage(msg.errorCode, msg.error));
      }
    });
  }, [applyMemoryFeatureRecords, isCurrentMemoryAdminResponse, loadMemoryAdminViews, loadMemoryViews, memoryAdminErrorMessage, memoryFeatureLabel, t, ws]);

  useEffect(() => {
    if (!selectedMemoryProject || selectedMemoryProject.status !== 'needs_resolution') return;
    resolveMemoryProject(selectedMemoryProject);
  }, [resolveMemoryProject, selectedMemoryProject]);

  useEffect(() => () => {
    clearTimeoutRef(personalMemoryStatusTimerRef);
    clearTimeoutRef(memoryFeaturesStatusTimerRef);
  }, []);

  useEffect(() => {
    if (activeTab !== 'memory') return;
    void loadMemoryViews();
  }, [activeTab, loadMemoryViews]);

  useEffect(() => {
    if (activeTab !== 'memory') return;
    loadMemoryAdminViews();
  }, [activeTab, loadMemoryAdminViews]);

  const handleMemoryArchive = useCallback((id: string, recordProjectId?: string) => {
    if (!ws) return;
    const requestId = crypto.randomUUID();
    ws.send({ type: MEMORY_WS.ARCHIVE, requestId, id, canonicalRepoId: recordProjectId || selectedCanonicalRepoId });
    const unsub = ws.onMessage((msg) => {
      if (msg.type !== MEMORY_WS.ARCHIVE_RESPONSE || msg.requestId !== requestId) return;
      unsub();
      if (msg.success) void loadMemoryViews();
    });
  }, [ws, loadMemoryViews, selectedCanonicalRepoId]);

  const handleMemoryRestore = useCallback((id: string, recordProjectId?: string) => {
    if (!ws) return;
    const requestId = crypto.randomUUID();
    ws.send({ type: MEMORY_WS.RESTORE, requestId, id, canonicalRepoId: recordProjectId || selectedCanonicalRepoId });
    const unsub = ws.onMessage((msg) => {
      if (msg.type !== MEMORY_WS.RESTORE_RESPONSE || msg.requestId !== requestId) return;
      unsub();
      if (msg.success) void loadMemoryViews();
    });
  }, [ws, loadMemoryViews, selectedCanonicalRepoId]);


  const confirmMemoryDelete = useCallback((recordId: string) => {
    const confirmed = globalThis.confirm?.(t('sharedContext.management.memoryDeleteConfirm')) ?? true;
    if (!confirmed) return false;
    setDeletingMemoryIds((current) => new Set(current).add(recordId));
    return true;
  }, [t]);

  const finishMemoryDelete = useCallback((recordId: string) => {
    setDeletingMemoryIds((current) => {
      const next = new Set(current);
      next.delete(recordId);
      return next;
    });
  }, []);

  const handleLocalMemoryDelete = useCallback((id: string, recordProjectId?: string) => {
    if (!ws || !confirmMemoryDelete(id)) return;
    const requestId = crypto.randomUUID();
    ws.send({ type: MEMORY_WS.DELETE, requestId, id, canonicalRepoId: recordProjectId || selectedCanonicalRepoId });
    const unsub = ws.onMessage((msg) => {
      if (msg.type !== MEMORY_WS.DELETE_RESPONSE || msg.requestId !== requestId) return;
      unsub();
      finishMemoryDelete(id);
      if (msg.success) void loadMemoryViews();
      else setError(msg.error || t('sharedContext.management.memoryDeleteFailed'));
    });
  }, [confirmMemoryDelete, finishMemoryDelete, loadMemoryViews, selectedCanonicalRepoId, t, ws]);

  const handleCloudMemoryDelete = useCallback(async (id: string) => {
    if (!confirmMemoryDelete(id)) return;
    try {
      await deletePersonalCloudMemory(id);
      await loadMemoryViews();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      finishMemoryDelete(id);
    }
  }, [confirmMemoryDelete, finishMemoryDelete, loadMemoryViews]);

  const handleEnterpriseMemoryDelete = useCallback(async (id: string) => {
    if (!enterpriseId || !confirmMemoryDelete(id)) return;
    try {
      await deleteEnterpriseSharedMemory(enterpriseId, id);
      await loadMemoryViews();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      finishMemoryDelete(id);
    }
  }, [confirmMemoryDelete, enterpriseId, finishMemoryDelete, loadMemoryViews]);

  const getProcessingPresetValue = useCallback((
    backend: SharedContextRuntimeBackend,
    model: string,
    preset: string,
  ) => (
    model.trim() && doesSharedContextBackendSupportPresets(backend)
      ? (preset || undefined)
      : undefined
  ), []);

  const buildProcessingConfigPayload = useCallback(() => ({
    primaryContextBackend: processingPrimaryBackend,
    primaryContextModel: processingPrimaryModel.trim(),
    primaryContextPreset: getProcessingPresetValue(
      processingPrimaryBackend,
      processingPrimaryModel,
      processingPrimaryPreset,
    ),
    backupContextBackend: processingBackupModel.trim() ? processingBackupBackend : undefined,
    backupContextModel: processingBackupModel.trim() || undefined,
    backupContextPreset: processingBackupModel.trim()
      ? getProcessingPresetValue(processingBackupBackend, processingBackupModel, processingBackupPreset)
      : undefined,
    memoryRecallMinScore: processingMemoryRecallMinScore,
    memoryScoringWeights: normalizeMemoryScoringWeights(processingMemoryScoringWeights),
    enablePersonalMemorySync: processingPersonalSyncEnabled,
  }), [
    getProcessingPresetValue,
    processingBackupBackend,
    processingBackupModel,
    processingBackupPreset,
    processingMemoryRecallMinScore,
    processingMemoryScoringWeights,
    processingPersonalSyncEnabled,
    processingPrimaryBackend,
    processingPrimaryModel,
    processingPrimaryPreset,
  ]);

  const handleProcessingPrimaryBackendChange = useCallback((nextBackend: SharedContextRuntimeBackend) => {
    setProcessingPrimaryBackend((prevBackend) => {
      setProcessingPrimaryModel((prevModel) => resolveProcessingModelForBackend(nextBackend, prevModel, prevBackend));
      if (!doesSharedContextBackendSupportPresets(nextBackend)) setProcessingPrimaryPreset('');
      return nextBackend;
    });
  }, []);

  const handleProcessingBackupBackendChange = useCallback((nextBackend: SharedContextRuntimeBackend) => {
    setProcessingBackupBackend((prevBackend) => {
      setProcessingBackupModel((prevModel) => resolveProcessingModelForBackend(nextBackend, prevModel, prevBackend));
      if (!doesSharedContextBackendSupportPresets(nextBackend)) setProcessingBackupPreset('');
      return nextBackend;
    });
  }, []);

  const localToolDisabledReason = useCallback((featureEnabled: boolean | null, flag: MemoryFeatureFlag): string | null => {
    if (!ws) return t('sharedContext.management.memoryToolDisabledNoDaemon');
    if (featureEnabled !== true) {
      return featureEnabled === false
        ? t('sharedContext.management.memoryToolDisabledFeature', { env: memoryFeatureFlagEnvKey(flag) })
        : t('sharedContext.management.memoryToolDisabledFeatureUnknown');
    }
    if (!selectedProjectDir || !selectedCanonicalRepoId || (selectedMemoryProject && !selectedMemoryProjectCapabilities.canRunLocalTools)) {
      return t('sharedContext.management.memoryToolDisabledProjectRequired');
    }
    return null;
  }, [selectedCanonicalRepoId, selectedMemoryProject, selectedMemoryProjectCapabilities.canRunLocalTools, selectedProjectDir, t, ws]);

  const skillToolDisabledReason = localToolDisabledReason(skillsFeatureEnabled, MEMORY_FEATURE_FLAGS_BY_NAME.skills);
  const mdIngestDisabledReason = localToolDisabledReason(mdIngestFeatureEnabled, MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest);
  const observationPromoteDisabledReason = localToolDisabledReason(observationStoreFeatureEnabled, MEMORY_FEATURE_FLAGS_BY_NAME.observationStore);
  const preferenceFeatureDisplay = memoryFeatureDisplay(MEMORY_FEATURE_FLAGS_BY_NAME.preferences);
  const skillsFeatureDisplay = memoryFeatureDisplay(MEMORY_FEATURE_FLAGS_BY_NAME.skills);
  const mdIngestFeatureDisplay = memoryFeatureDisplay(MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest);
  const observationStoreFeatureDisplay = memoryFeatureDisplay(MEMORY_FEATURE_FLAGS_BY_NAME.observationStore);
  const preferenceDisabledReason = !ws
    ? t('sharedContext.management.memoryToolDisabledNoDaemon')
    : preferenceFeatureEnabled === false
      ? t('sharedContext.management.memoryToolDisabledFeature', { env: memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.preferences) })
      : preferenceFeatureEnabled === null
        ? t('sharedContext.management.memoryToolDisabledFeatureUnknown')
        : null;
  const localMemoryStatusNotice = localPersonalMemoryStatus === 'loading'
    ? t('sharedContext.management.memoryLocalStatusLoading')
    : localPersonalMemoryStatus === 'unavailable'
      ? t('sharedContext.management.memoryLocalStatusUnavailable')
      : localPersonalMemoryStatus === 'timeout'
        ? t('sharedContext.management.memoryLocalStatusNoResponse')
        : localPersonalMemoryStatus === 'error'
          ? t('sharedContext.management.memoryLocalStatusError')
          : null;
  const localMemoryUnavailable = localPersonalMemoryStatus === 'unavailable'
    || localPersonalMemoryStatus === 'timeout'
    || localPersonalMemoryStatus === 'error';

  const renderMemoryProjectPicker = () => (
    <div style={{ ...resourceCardStyle, gap: DT.space.sm }}>
      <SectionHeading
        title={t('sharedContext.management.memoryProjectPickerTitle')}
        description={t('sharedContext.management.memoryProjectPickerDescription')}
      />
      <div style={adminFormRowStyle}>
        <label style={fieldLabelStyle}>
          <span>{t('sharedContext.management.memoryBrowseProjectFilter')}</span>
          <select
            value={memoryBrowseProjectId}
            onInput={(e) => {
              const next = (e.currentTarget as HTMLSelectElement).value;
              setMemoryBrowseProjectId(next);
            }}
            aria-label={t('sharedContext.management.memoryBrowseProjectFilter')}
            style={inputStyle}
          >
            <option value="">{t('sharedContext.management.memoryBrowseAllProjects')}</option>
            {memoryProjectOptions.map((option) => (
              <option key={`browse:${option.id}`} value={option.id} disabled={!option.canonicalRepoId?.trim()}>
                {memoryProjectOptionLabel(
                  option,
                  t('sharedContext.management.memoryProjectNoCanonicalId'),
                  t('sharedContext.management.memoryProjectNoDirectory'),
                )}
              </option>
            ))}
          </select>
        </label>
        <span style={pillStyle}>
          {memoryBrowseProjectId && selectedBrowseMemoryProject
            ? t('sharedContext.management.memoryActiveProjectFilter', { project: selectedBrowseMemoryProject.displayName })
            : t('sharedContext.management.memoryAllProjectsActive')}
        </span>
        {memoryBrowseProjectId ? (
          <button type="button" style={subtleButtonStyle} onClick={() => setMemoryBrowseProjectId('')}>
            {t('sharedContext.management.memoryClearProjectFilter')}
          </button>
        ) : null}
      </div>
      <div style={adminFormRowStyle}>
        <label style={fieldLabelStyle}>
          <span>{t('sharedContext.management.memoryToolProjectSelector')}</span>
          <select
            value={selectedMemoryProjectId}
            onInput={(e) => {
              const next = (e.currentTarget as HTMLSelectElement).value;
              setSelectedMemoryProjectId(next);
              const option = memoryProjectOptions.find((candidate) => candidate.id === next);
              if (!option) return;
              if (option.canonicalRepoId) {
                setMemoryProjectId(option.canonicalRepoId);
                setMdIngestCanonicalRepoId(option.canonicalRepoId);
              }
              if (option.projectDir) {
                setMemoryAdminProjectDir(option.projectDir);
                setMdIngestProjectDir(option.projectDir);
              }
              if (option.status === 'needs_resolution') resolveMemoryProject(option);
            }}
            aria-label={t('sharedContext.management.memoryToolProjectSelector')}
            style={inputStyle}
          >
            <option value="">{t('sharedContext.management.memoryToolProjectNone')}</option>
            {memoryProjectOptions.map((option) => (
              <option key={`tool:${option.id}`} value={option.id}>
                {memoryProjectOptionLabel(
                  option,
                  t('sharedContext.management.memoryProjectNoCanonicalId'),
                  t('sharedContext.management.memoryProjectNoDirectory'),
                )}
              </option>
            ))}
          </select>
        </label>
        {selectedMemoryProject ? (
          <span style={pillStyle}>
            {t('sharedContext.management.memoryProjectSelected')}: {selectedMemoryProject.displayName}
          </span>
        ) : null}
      </div>
      <div style={helperTextStyle}>{t('sharedContext.management.memoryProjectPickerSplitHelp')}</div>
      <details style={{ color: DT.text.secondary }}>
        <summary style={{ cursor: 'pointer' }}>{t('sharedContext.management.memoryProjectKnownProjects')}</summary>
        <div style={{ ...adminFormRowStyle, marginTop: DT.space.sm }}>
          <input
            value={memoryProjectSearch}
            onInput={(e) => setMemoryProjectSearch((e.currentTarget as HTMLInputElement).value)}
            placeholder={t('sharedContext.management.memoryProjectSearchPlaceholder')}
            aria-label={t('sharedContext.management.memoryProjectSearchPlaceholder')}
            style={inputStyle}
          />
        </div>
      <div style={{ ...resourceListStyle, maxHeight: 220, overflowY: 'auto' }}>
        {filteredMemoryProjectOptions.length > 0 ? filteredMemoryProjectOptions.map((option) => {
          const active = selectedMemoryProject?.id === option.id;
          const resolving = Boolean(option.projectDir && resolvingMemoryProjectIds.has(option.projectDir));
          return (
            <button
              key={option.id}
              type="button"
              style={{
                ...resourceCardStyle,
                textAlign: 'left',
                cursor: 'pointer',
                border: active ? `1px solid ${DT.text.accent}` : resourceCardStyle.border,
                background: active ? 'rgba(37,99,235,0.12)' : resourceCardStyle.background,
              }}
              onClick={() => {
                setSelectedMemoryProjectId(option.id);
                if (option.canonicalRepoId) setMemoryProjectId(option.canonicalRepoId);
                if (option.projectDir) {
                  setMemoryAdminProjectDir(option.projectDir);
                  setMdIngestProjectDir(option.projectDir);
                }
                if (option.canonicalRepoId) setMdIngestCanonicalRepoId(option.canonicalRepoId);
                if (option.status === 'needs_resolution') resolveMemoryProject(option);
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <strong style={{ color: DT.text.primary }}>{option.displayName}</strong>
                <span style={pillStyle}>{memoryProjectStatusLabel(resolving ? 'needs_resolution' : option.status)}</span>
              </div>
              <div style={metaGridStyle}>
                <MetaCard label={t('sharedContext.management.memoryProjectCanonicalId')} value={option.canonicalRepoId || '—'} />
                <MetaCard label={t('sharedContext.management.memoryProjectDirectory')} value={option.projectDir || '—'} />
                <MetaCard label={t('sharedContext.management.memoryProjectSourceLabel')} value={memoryProjectSourceLabel(option.source)} />
              </div>
              {option.status === 'needs_resolution' || resolving ? (
                <div style={helperTextStyle}>{resolving ? t('sharedContext.management.memoryProjectResolving') : t('sharedContext.management.memoryProjectNeedsResolve')}</div>
              ) : null}
              {option.status === 'canonical_only' ? (
                <div style={helperTextStyle}>{t('sharedContext.management.memoryProjectCanonicalOnlyNotice')}</div>
              ) : null}
            </button>
          );
        }) : (
          <div style={helperTextStyle}>{t('sharedContext.management.memoryProjectEmpty')}</div>
        )}
      </div>
      </details>
      <details style={{ color: DT.text.secondary }}>
        <summary style={{ cursor: 'pointer' }}>{t('sharedContext.management.memoryProjectAdvanced')}</summary>
        <div style={{ ...adminFormRowStyle, marginTop: DT.space.sm }}>
          <input
            value={memoryProjectId}
            onInput={(e) => {
              const next = (e.currentTarget as HTMLInputElement).value;
              setMemoryProjectId(next);
              setMdIngestCanonicalRepoId(next);
            }}
            placeholder={t('sharedContext.management.memoryProjectPlaceholder')}
            style={inputStyle}
          />
          <input
            value={memoryAdminProjectDir}
            onInput={(e) => {
              const next = (e.currentTarget as HTMLInputElement).value;
              setMemoryAdminProjectDir(next);
              setMdIngestProjectDir(next);
            }}
            placeholder={t('sharedContext.management.memoryProjectDirPlaceholder')}
            style={inputStyle}
          />
        </div>
        <div style={helperTextStyle}>{t('sharedContext.management.memoryProjectAdvancedDescription')}</div>
      </details>
      {selectedMemoryProject && !selectedMemoryProjectCapabilities.canRunLocalTools ? (
        <div style={memoryProcessedNoteStyle}>{t('sharedContext.management.memoryProjectLocalToolsDisabled')}</div>
      ) : null}
    </div>
  );

  return (
    <div style={shellStyle}>
      <div style={heroStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: DT.space.md, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: DT.space.xs, flex: '1 1 auto', minWidth: SC_IS_MOBILE ? 0 : 240 }}>
            <strong style={{ fontSize: SC_IS_MOBILE ? 16 : 20, fontWeight: 600, letterSpacing: '-0.01em', color: DT.text.primary }}>
              {t('sharedContext.management.title')}
            </strong>
            <span style={{ ...helperTextStyle, fontSize: 13 }}>
              {t('sharedContext.management.heroDescription')}
            </span>
          </div>
          <button style={subtleButtonStyle} onClick={() => void refreshEnterpriseData()}>
            {t('sharedContext.refresh')}
          </button>
        </div>
        <div style={rowStyle}>
          <select value={enterpriseId} onChange={(e) => setEnterpriseId((e.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
            <option value="">{t('sharedContext.management.selectEnterprise')}</option>
            {teams.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name} ({entry.role})</option>
            ))}
          </select>
          <input
            value={newEnterpriseName}
            onInput={(e) => setNewEnterpriseName((e.currentTarget as HTMLInputElement).value)}
            placeholder={t('sharedContext.management.enterpriseNamePlaceholder')}
            style={inputStyle}
          />
          <button
            style={buttonStyle}
            onClick={() => void handleAction(t('sharedContext.notice.enterpriseCreated'), async () => {
              const created = await createTeam(newEnterpriseName.trim());
              const nextTeams = await listTeams();
              setTeams(nextTeams);
              setEnterpriseId(created.id);
              setNewEnterpriseName('');
            })}
          >
            {t('sharedContext.management.createEnterprise')}
          </button>
        </div>
        <div style={statGridStyle}>
          <StatCard
            label={t('sharedContext.management.statEnterprise')}
            value={team?.name ?? t('sharedContext.management.noneValue')}
            detail={team
              ? t('sharedContext.management.statRole', { role: t(`sharedContext.roles.${team.myRole}`) })
              : t('sharedContext.management.statChooseOrCreateEnterprise')}
          />
          <StatCard label={t('sharedContext.management.statMembers')} value={team?.members?.length ?? 0} />
          <StatCard label={t('sharedContext.management.statProjects')} value={projects.length} />
          <StatCard label={t('sharedContext.management.statKnowledgeDocs')} value={documents.length} />
          <StatCard
            label={t('sharedContext.management.statServer')}
            value={formatServerScopeValue(serverId, t('sharedContext.management.serverUnbound'))}
            detail={serverId ? t('sharedContext.management.statCloudSyncedRuntimeSettings') : t('sharedContext.management.statSelectServerToSync')}
          />
        </div>
      </div>

      <div style={{
        ...tabBarStyle,
        position: SC_IS_MOBILE ? 'relative' : 'sticky',
        top: SC_IS_MOBILE ? undefined : 0,
        zIndex: 10,
        background: DT.bg.base,
        boxShadow: SC_IS_MOBILE ? 'none' : '0 2px 8px rgba(0,0,0,0.4)',
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            style={activeTab === tab.id ? tabActiveStyle : tabStyle}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {loading && <div style={helperTextStyle}>{t('sharedContext.loading')}</div>}
      {error && <div style={{ color: '#fca5a5' }}>{error}</div>}
      {notice && <div style={{ color: '#86efac' }}>{notice}</div>}

      {activeTab === 'enterprise' && (
        <div style={splitSectionStyle}>
          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.invites')}
              description={t('sharedContext.management.inviteDescription')}
            />
            <InfoCard title={t('sharedContext.management.inviteFlowTitle')}>
              <div>{t('sharedContext.management.inviteFlowLine1')}</div>
              <div>{t('sharedContext.management.inviteFlowLine2')}</div>
            </InfoCard>
            <div style={rowStyle}>
              <input
                value={inviteEmail}
                onInput={(e) => setInviteEmail((e.currentTarget as HTMLInputElement).value)}
                placeholder={t('sharedContext.management.inviteEmailPlaceholder')}
                style={inputStyle}
              />
              <button
                style={buttonStyle}
                disabled={!enterpriseId}
                onClick={() => void handleAction(t('sharedContext.notice.inviteCreated'), async () => {
                  const created = await createTeamInvite(enterpriseId, 'member', inviteEmail.trim() || undefined);
                  setLastInviteToken(created.token);
                })}
              >
                {t('sharedContext.management.createInvite')}
              </button>
            </div>
            {lastInviteToken && (
              <div style={{ ...resourceCardStyle, gap: 6 }}>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>{t('sharedContext.management.inviteToken')}</span>
                <code style={{ color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{lastInviteToken}</code>
              </div>
            )}
            <div style={rowStyle}>
              <input
                value={joinToken}
                onInput={(e) => setJoinToken((e.currentTarget as HTMLInputElement).value)}
                placeholder={t('sharedContext.management.joinTokenPlaceholder')}
                style={inputStyle}
              />
              <button
                style={subtleButtonStyle}
                onClick={() => void handleAction(t('sharedContext.notice.joinedEnterprise'), async () => {
                  const joined = await joinTeamByToken(joinToken.trim());
                  setJoinToken('');
                  const nextTeams = await listTeams();
                  setTeams(nextTeams);
                  setEnterpriseId(joined.teamId);
                })}
              >
                {t('sharedContext.management.joinEnterprise')}
              </button>
            </div>
          </div>

          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.workspaces')}
              description={t('sharedContext.management.workspaceDescription')}
            />
            <div style={rowStyle}>
              <input
                value={workspaceName}
                onInput={(e) => setWorkspaceName((e.currentTarget as HTMLInputElement).value)}
                placeholder={t('sharedContext.management.workspaceNamePlaceholder')}
                style={inputStyle}
              />
              <button
                style={buttonStyle}
                disabled={!enterpriseId}
                onClick={() => void handleAction(t('sharedContext.notice.workspaceCreated'), async () => {
                  await createSharedWorkspace(enterpriseId, workspaceName.trim());
                  setWorkspaceName('');
                  await refreshEnterpriseData();
                })}
              >
                {t('sharedContext.management.createWorkspace')}
              </button>
            </div>
            {workspaces.length > 0 ? (
              <div style={cardGridStyle}>
                {workspaces.map((workspace) => (
                  <div key={workspace.id} style={resourceCardStyle}>
                    <strong>{workspace.name}</strong>
                    <div style={metaGridStyle}>
                      <MetaCard label={t('sharedContext.management.workspaceId')} value={<code>{workspace.id}</code>} />
                      <MetaCard label={t('sharedContext.management.projects')} value={projects.filter((project) => project.workspaceId === workspace.id).length} />
                    </div>
                  </div>
                ))}
              </div>
            ) : <div style={helperTextStyle}>{t('sharedContext.empty')}</div>}
          </div>
        </div>
      )}

      {activeTab === 'members' && (
        <div style={sectionStyle}>
          <SectionHeading
            title={t('sharedContext.management.members')}
            description={t('sharedContext.management.memberRolesDescription')}
            action={<span style={pillStyle}>{t('sharedContext.management.activeCount', { count: team?.members?.length ?? 0 })}</span>}
          />
          {team?.members?.length ? (
            <div style={resourceListStyle}>
              {team.members.map((member) => (
                <div key={member.user_id} style={resourceCardStyle}>
                  <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <strong>{formatMemberIdentity(member)}</strong>
                      <span style={helperTextStyle}>{member.username ? `@${member.username}` : member.user_id}</span>
                    </div>
                    <div style={metaGridStyle}>
                      <MetaCard label={t('sharedContext.management.role')} value={t(`sharedContext.roles.${member.role}`)} />
                      <MetaCard label={t('sharedContext.management.joined')} value={new Date(member.joined_at).toLocaleString()} />
                    </div>
                    {member.role !== 'owner' && (
                      <div style={rowStyle}>
                        <button
                          style={subtleButtonStyle}
                          onClick={() => void handleAction(t('sharedContext.notice.memberUpdated'), async () => {
                            await updateTeamMemberRole(enterpriseId, member.user_id, member.role === 'admin' ? 'member' : 'admin');
                            await refreshEnterpriseData();
                          })}
                        >
                          {member.role === 'admin' ? t('sharedContext.management.demoteMember') : t('sharedContext.management.promoteAdmin')}
                        </button>
                        <button
                          style={subtleButtonStyle}
                          onClick={() => void handleAction(t('sharedContext.notice.memberRemoved'), async () => {
                            await removeTeamMember(enterpriseId, member.user_id);
                            await refreshEnterpriseData();
                          })}
                        >
                          {t('sharedContext.management.removeMember')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : <div style={helperTextStyle}>{t('sharedContext.empty')}</div>}
        </div>
      )}

      {activeTab === 'projects' && (
        <>
          <InfoCard title={t('sharedContext.management.projectRelationshipTitle')}>
            <div>{t('sharedContext.management.projectRelationshipLine1')}</div>
            <div>{t('sharedContext.management.projectRelationshipLine2')}</div>
            <div>{t('sharedContext.management.projectRelationshipLine3')}</div>
            <div>{t('sharedContext.management.projectRelationshipLine4')}</div>
          </InfoCard>

          <div style={splitSectionStyle}>
            <InfoCard title={t('sharedContext.management.belongsToTitle')}>
              <div><strong>{t('sharedContext.management.belongsToEnterprise')}</strong> {team?.name ?? t('sharedContext.management.notSelected')}</div>
              <div><strong>{t('sharedContext.management.belongsToWorkspace')}</strong> {t('sharedContext.management.belongsToWorkspaceValue')}</div>
              <div><strong>{t('sharedContext.management.belongsToProject')}</strong> {t('sharedContext.management.belongsToProjectValue')}</div>
            </InfoCard>

            <InfoCard title={t('sharedContext.management.sharesWithTitle')}>
              <div><strong>{t('sharedContext.management.scopeProjectLabel')}</strong>: {t('sharedContext.management.sharesWithProjectValue')}</div>
              <div><strong>{t('sharedContext.management.scopeWorkspaceLabel')}</strong>: {t('sharedContext.management.sharesWithWorkspaceValue')}</div>
              <div><strong>{t('sharedContext.management.scopeEnterpriseLabel')}</strong>: {t('sharedContext.management.sharesWithEnterpriseValue')}</div>
            </InfoCard>
          </div>

          <div style={splitSectionStyle}>
            <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.projects')}
              description={t('sharedContext.management.enrollDescription')}
              action={selectedProject ? (
                <span style={pillStyle}>
                  {selectedProject.displayName ?? selectedProject.canonicalRepoId} · {selectedProject.status}
                </span>
              ) : undefined}
            />
            <InfoCard title={t('sharedContext.management.chooseSharingLevelTitle')}>
              <div><strong>{t('sharedContext.management.scopeProjectLabel')}</strong>: {t('sharedContext.management.chooseSharingLevelProject')}</div>
              <div><strong>{t('sharedContext.management.scopeWorkspaceLabel')}</strong>: {t('sharedContext.management.chooseSharingLevelWorkspace')}</div>
              <div><strong>{t('sharedContext.management.scopeEnterpriseLabel')}</strong>: {t('sharedContext.management.chooseSharingLevelEnterprise')}</div>
            </InfoCard>
            <div style={rowStyle}>
              <input value={canonicalRepoId} onInput={(e) => setCanonicalRepoId((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.canonicalRepoId')} style={inputStyle} />
              <input value={displayName} onInput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.displayName')} style={inputStyle} />
              <select value={scope} onChange={(e) => setScope((e.currentTarget as HTMLSelectElement).value as SharedScopeValue)} style={inputStyle}>
                {AUTHORED_CONTEXT_SCOPES.map((scopeValue) => (
                  <option key={scopeValue} value={scopeValue}>{scopePresentation[scopeValue].label}</option>
                ))}
              </select>
              <select value={selectedWorkspaceId} onChange={(e) => setSelectedWorkspaceId((e.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
                <option value="">{t('sharedContext.management.noWorkspace')}</option>
                {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
              </select>
              <button
                style={buttonStyle}
                disabled={!enterpriseId || !canonicalRepoId.trim()}
                onClick={() => void handleAction(t('sharedContext.notice.projectEnrolled'), async () => {
                  await enrollSharedProject(enterpriseId, {
                    canonicalRepoId: canonicalRepoId.trim(),
                    displayName: displayName.trim() || undefined,
                    workspaceId: selectedWorkspaceId || undefined,
                    scope,
                  });
                  setCanonicalRepoId('');
                  setDisplayName('');
                  await refreshEnterpriseData();
                })}
              >
                {t('sharedContext.management.enrollProject')}
              </button>
            </div>
            <div style={{ ...resourceCardStyle, gap: 6 }}>
              <strong>{currentScopePresentation.label}</strong>
              <span style={helperTextStyle}>{currentScopePresentation.description}</span>
              <span style={helperTextStyle}>
                {selectedWorkspaceId
                  ? t('sharedContext.management.scopeSourceWithWorkspace', {
                      workspace: workspaceNameById.get(selectedWorkspaceId) ?? selectedWorkspaceId,
                      enterprise: team?.name ?? t('sharedContext.management.selectedEnterprise'),
                    })
                  : t('sharedContext.management.scopeSourceWithoutWorkspace', {
                      enterprise: team?.name ?? t('sharedContext.management.selectedEnterprise'),
                    })}
              </span>
            </div>
            <div style={resourceListStyle}>
              {projects.map((project) => (
                <div key={project.id} style={resourceCardStyle}>
                  <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <strong>{project.displayName ?? project.canonicalRepoId}</strong>
                      <span style={helperTextStyle}>
                        {scopePresentation[project.scope as SharedScopeValue].label}
                      </span>
                      <div style={metaGridStyle}>
                        <MetaCard label={t('sharedContext.management.workspaceLabel')} value={project.workspaceId ? (workspaceNameById.get(project.workspaceId) ?? project.workspaceId) : t('sharedContext.management.noWorkspaceAssigned')} />
                        <MetaCard label={t('sharedContext.management.statusLabel')} value={project.status} />
                        <MetaCard label={t('sharedContext.management.scopeLabel')} value={scopePresentation[project.scope as SharedScopeValue].label} />
                        <MetaCard label={t('sharedContext.management.meaningLabel')} value={scopePresentation[project.scope as SharedScopeValue].description} />
                      </div>
                    </div>
                    <div style={rowStyle}>
                      <button
                        style={subtleButtonStyle}
                        onClick={() => {
                          setSelectedEnrollmentId(project.id);
                          setActiveTab('projects');
                        }}
                      >
                        {t('sharedContext.management.editPolicy')}
                      </button>
                      <button
                        style={subtleButtonStyle}
                        onClick={() => void handleAction(t('sharedContext.notice.projectPendingRemoval'), async () => {
                          await markSharedProjectPendingRemoval(project.id);
                          await refreshEnterpriseData();
                        })}
                      >
                        {t('sharedContext.management.pendingRemoval')}
                      </button>
                      <button
                        style={subtleButtonStyle}
                        onClick={() => void handleAction(t('sharedContext.notice.projectRemoved'), async () => {
                          await removeSharedProject(project.id);
                          await refreshEnterpriseData();
                        })}
                      >
                        {t('sharedContext.management.removeProject')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            </div>

            <div style={sectionStyle}>
              <SectionHeading
                title={t('sharedContext.management.policyTitle')}
                description={t('sharedContext.management.policyDescription')}
                action={policyLoading ? <span style={pillStyle}>{t('sharedContext.management.policyLoading')}</span> : undefined}
              />
              <InfoCard title={t('sharedContext.management.policyExplainTitle')}>
                <div>{t('sharedContext.management.policyExplainLine1')}</div>
                <div>{t('sharedContext.management.policyExplainLine2')}</div>
              </InfoCard>
              <div style={rowStyle}>
                <select value={selectedEnrollmentId} onChange={(e) => setSelectedEnrollmentId((e.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
                  <option value="">{t('sharedContext.management.selectProject')}</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.displayName ?? project.canonicalRepoId}</option>)}
                </select>
              </div>
              <div style={checkboxRowStyle}>
                <label style={policyOptionStyle}>
                  <span>
                    <input type="checkbox" checked={policy.allowDegradedProviderSupport} onChange={(e) => setPolicy((prev) => ({ ...prev, allowDegradedProviderSupport: (e.currentTarget as HTMLInputElement).checked }))} />
                    {' '}
                    {t('sharedContext.management.allowDegraded')}
                  </span>
                  <span style={{ color: '#94a3b8', fontSize: 13 }}>{t('sharedContext.management.allowDegradedHelp')}</span>
                </label>
                <label style={policyOptionStyle}>
                  <span>
                    <input type="checkbox" checked={policy.allowLocalFallback} onChange={(e) => setPolicy((prev) => ({ ...prev, allowLocalFallback: (e.currentTarget as HTMLInputElement).checked }))} />
                    {' '}
                    {t('sharedContext.management.allowLocalFallback')}
                  </span>
                  <span style={{ color: '#94a3b8', fontSize: 13 }}>{t('sharedContext.management.allowLocalFallbackHelp')}</span>
                </label>
                <label style={policyOptionStyle}>
                  <span>
                    <input type="checkbox" checked={policy.requireFullProviderSupport} onChange={(e) => setPolicy((prev) => ({ ...prev, requireFullProviderSupport: (e.currentTarget as HTMLInputElement).checked }))} />
                    {' '}
                    {t('sharedContext.management.requireFullSupport')}
                  </span>
                  <span style={{ color: '#94a3b8', fontSize: 13 }}>{t('sharedContext.management.requireFullSupportHelp')}</span>
                </label>
              </div>
              <button
                style={buttonStyle}
                disabled={!selectedEnrollmentId}
                onClick={() => void handleAction(t('sharedContext.notice.policySaved'), async () => {
                  await updateSharedProjectPolicy(selectedEnrollmentId, {
                    allowDegradedProviderSupport: policy.allowDegradedProviderSupport,
                    allowLocalFallback: policy.allowLocalFallback,
                    requireFullProviderSupport: policy.requireFullProviderSupport,
                  });
                  await refreshEnterpriseData();
                })}
              >
                {t('sharedContext.management.savePolicy')}
              </button>
            </div>
          </div>
        </>
      )}

      {activeTab === 'knowledge' && (
        <div style={splitSectionStyle}>
          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.documents')}
              description={t('sharedContext.management.knowledgeDescription')}
            />
            <div style={rowStyle}>
              <select value={documentKind} onChange={(e) => setDocumentKind((e.currentTarget as HTMLSelectElement).value as KindOption)} style={inputStyle}>
                <option value="coding_standard">{t('sharedContext.management.documentKind.coding_standard')}</option>
                <option value="architecture_guideline">{t('sharedContext.management.documentKind.architecture_guideline')}</option>
                <option value="repo_playbook">{t('sharedContext.management.documentKind.repo_playbook')}</option>
                <option value="knowledge_doc">{t('sharedContext.management.documentKind.knowledge_doc')}</option>
              </select>
              <input value={documentTitle} onInput={(e) => setDocumentTitle((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.documentTitle')} style={inputStyle} />
              <button
                style={buttonStyle}
                disabled={!enterpriseId || !documentTitle.trim()}
                onClick={() => void handleAction(t('sharedContext.notice.documentCreated'), async () => {
                  const created = await createSharedDocument(enterpriseId, { kind: documentKind, title: documentTitle.trim() });
                  setDocumentTitle('');
                  await refreshEnterpriseData();
                  setSelectedDocumentId(created.id);
                })}
              >
                {t('sharedContext.management.createDocument')}
              </button>
            </div>
            <div style={resourceListStyle}>
              {documents.map((document) => (
                <div key={document.id} style={resourceCardStyle}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <strong>{document.title}</strong>
                    <span style={helperTextStyle}>{document.kind}</span>
                  </div>
                  <div style={metaGridStyle}>
                    <MetaCard label={t('sharedContext.management.versions')} value={document.versions.length} />
                    <MetaCard label={t('sharedContext.management.activeVersion')} value={document.versions.find((version) => version.status === 'active')?.versionNumber ? `v${document.versions.find((version) => version.status === 'active')?.versionNumber}` : t('sharedContext.management.noneValue')} />
                  </div>
                  <div style={rowStyle}>
                    {document.versions.map((version) => (
                      <button
                        key={version.id}
                        style={version.status === 'active' ? buttonStyle : subtleButtonStyle}
                        onClick={() => void handleAction(t('sharedContext.notice.versionActivated'), async () => {
                          await activateSharedDocumentVersion(version.id);
                          await refreshEnterpriseData();
                          setSelectedDocumentId(document.id);
                          setSelectedVersionId(version.id);
                        })}
                      >
                        v{version.versionNumber} · {version.status}
                      </button>
                    ))}
                  </div>
                </div>
                ))}
              </div>
            <div style={{ ...resourceCardStyle, gap: 10 }}>
              <SectionHeading
                title={t('sharedContext.management.createVersion')}
                description={t('sharedContext.management.versionDescription')}
              />
              <div style={{ ...rowStyle, alignItems: 'stretch' }}>
              <select value={selectedDocumentId} onChange={(e) => setSelectedDocumentId((e.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
                <option value="">{t('sharedContext.management.selectDocument')}</option>
                {documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}
              </select>
              <select value={selectedVersionId} onChange={(e) => setSelectedVersionId((e.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
                <option value="">{t('sharedContext.management.selectVersion')}</option>
                {(selectedDocument?.versions ?? []).map((version) => <option key={version.id} value={version.id}>v{version.versionNumber} · {version.status}</option>)}
              </select>
              <textarea value={documentContent} onInput={(e) => setDocumentContent((e.currentTarget as HTMLTextAreaElement).value)} placeholder={t('sharedContext.management.documentContent')} style={{ ...inputStyle, minHeight: 92 }} />
              <button
                style={buttonStyle}
                disabled={!selectedDocumentId || !documentContent.trim()}
                onClick={() => void handleAction(t('sharedContext.notice.versionCreated'), async () => {
                  const created = await createSharedDocumentVersion(selectedDocumentId, { contentMd: documentContent.trim() });
                  setDocumentContent('');
                  await refreshEnterpriseData();
                  setSelectedVersionId(created.id);
                })}
              >
                {t('sharedContext.management.createVersion')}
              </button>
              </div>
            </div>
          </div>

          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.bindings')}
              description={t('sharedContext.management.bindingDescription')}
            />
            <div style={rowStyle}>
              <select value={selectedVersionId} onChange={(e) => setSelectedVersionId((e.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
                <option value="">{t('sharedContext.management.selectVersion')}</option>
                {documents.flatMap((document) => document.versions.map((version) => (
                  <option key={version.id} value={version.id}>{document.title} · v{version.versionNumber}</option>
                )))}
              </select>
              <select value={bindingMode} onChange={(e) => setBindingMode((e.currentTarget as HTMLSelectElement).value as 'required' | 'advisory')} style={inputStyle}>
                <option value="required">{t('sharedContext.management.required')}</option>
                <option value="advisory">{t('sharedContext.management.advisory')}</option>
              </select>
              <input value={bindingLanguage} onInput={(e) => setBindingLanguage((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.language')} style={inputStyle} />
              <input value={bindingPathPattern} onInput={(e) => setBindingPathPattern((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.pathPattern')} style={inputStyle} />
              <button
                style={buttonStyle}
                disabled={!enterpriseId || !selectedDocumentId || !selectedVersionId}
                onClick={() => void handleAction(t('sharedContext.notice.bindingCreated'), async () => {
                  await createSharedDocumentBinding(enterpriseId, {
                    documentId: selectedDocumentId,
                    versionId: selectedVersionId,
                    workspaceId: selectedWorkspaceId || undefined,
                    enrollmentId: selectedEnrollmentId || undefined,
                    mode: bindingMode,
                    applicabilityRepoId: canonicalRepoId.trim() || undefined,
                    applicabilityLanguage: bindingLanguage.trim() || undefined,
                    applicabilityPathPattern: bindingPathPattern.trim() || undefined,
                  });
                  await refreshEnterpriseData();
                })}
              >
                {t('sharedContext.management.createBinding')}
              </button>
            </div>
            {bindings.length > 0 ? (
              <div style={resourceListStyle}>
                {bindings.map((binding) => (
                  <div key={binding.id} style={resourceCardStyle}>
                    <strong>{binding.mode} · {binding.status}</strong>
                    <div style={metaGridStyle}>
                      <MetaCard label={t('sharedContext.management.documentLabel')} value={binding.documentId} />
                      <MetaCard label={t('sharedContext.management.versionLabel')} value={binding.versionId} />
                      <MetaCard label={t('sharedContext.management.language')} value={binding.applicabilityLanguage || t('sharedContext.management.anyValue')} />
                      <MetaCard label={t('sharedContext.management.pathLabel')} value={binding.applicabilityPathPattern || t('sharedContext.management.anyValue')} />
                    </div>
                  </div>
                ))}
              </div>
            ) : <div style={helperTextStyle}>{t('sharedContext.empty')}</div>}
          </div>
        </div>
      )}

      {activeTab === 'processing' && (
        <>
          <InfoCard title={t('sharedContext.management.processingSummaryTitle')}>
            <div>{t('sharedContext.management.processingSummaryLine1')}</div>
            <div>{t('sharedContext.management.processingSummaryLine2')}</div>
            <div>{t('sharedContext.management.processingSummaryLine3')}</div>
          </InfoCard>

          <InfoCard title={t('sharedContext.management.processingModelTitle')}>
            {serverId ? (
              <>
                <div style={processingGridStyle}>
                  <div style={processingCardStyle}>
                    <strong>{t('sharedContext.management.processingPrimaryCardTitle')}</strong>
                    <label style={fieldLabelStyle}>
                      <span>{t('sharedContext.management.processingPrimaryBackend')}</span>
                      <div style={backendChipRowStyle}>
                        {SHARED_CONTEXT_RUNTIME_BACKENDS.map((backend) => (
                          <button
                            key={`primary:${backend}`}
                            type="button"
                            aria-label={`${t('sharedContext.management.processingPrimaryBackend')}: ${backend}`}
                            aria-pressed={processingPrimaryBackend === backend}
                            style={processingChipStyle(processingPrimaryBackend === backend)}
                            onClick={() => handleProcessingPrimaryBackendChange(backend)}
                          >
                            {backend}
                          </button>
                        ))}
                      </div>
                    </label>
                    <label style={fieldLabelStyle}>
                      <span>{t('sharedContext.management.processingPrimaryModel')}</span>
                      <ModelPresetChipSelector
                        backend={processingPrimaryBackend}
                        model={processingPrimaryModel}
                        preset={processingPrimaryPreset}
                        presets={processingPresets}
                        idPrefix="primary"
                        onChange={({ model, preset }) => {
                          setProcessingPrimaryModel(model);
                          setProcessingPrimaryPreset(preset);
                        }}
                      />
                    </label>
                  </div>
                  <div style={processingCardStyle}>
                    <strong>{t('sharedContext.management.processingBackupCardTitle')}</strong>
                    <label style={fieldLabelStyle}>
                      <span>{t('sharedContext.management.processingBackupBackend')}</span>
                      <div style={backendChipRowStyle}>
                        {SHARED_CONTEXT_RUNTIME_BACKENDS.map((backend) => (
                          <button
                            key={`backup:${backend}`}
                            type="button"
                            aria-label={`${t('sharedContext.management.processingBackupBackend')}: ${backend}`}
                            aria-pressed={processingBackupBackend === backend}
                            style={processingChipStyle(processingBackupBackend === backend)}
                            onClick={() => handleProcessingBackupBackendChange(backend)}
                          >
                            {backend}
                          </button>
                        ))}
                      </div>
                    </label>
                    <label style={fieldLabelStyle}>
                      <span>{t('sharedContext.management.processingBackupModel')}</span>
                      <ModelPresetChipSelector
                        backend={processingBackupBackend}
                        model={processingBackupModel}
                        preset={processingBackupPreset}
                        presets={processingPresets}
                        idPrefix="backup"
                        onChange={({ model, preset }) => {
                          setProcessingBackupModel(model);
                          setProcessingBackupPreset(preset);
                        }}
                      />
                    </label>
                  </div>
                </div>
                <div style={rowStyle}>
                  <button
                    style={buttonStyle}
                    disabled={processingSaving || !processingPrimaryModel.trim()}
                    onClick={() => void handleAction(t('sharedContext.notice.processingConfigSaved'), async () => {
                      setProcessingSaving(true);
                      try {
                        const view = await updateSharedContextRuntimeConfig(serverId, buildProcessingConfigPayload());
                        applyProcessingSnapshot(view);
                      } finally {
                        setProcessingSaving(false);
                      }
                    })}
                  >
                    {processingSaving ? t('sharedContext.management.processingSaving') : t('sharedContext.management.processingSave')}
                  </button>
                  <button
                    style={subtleButtonStyle}
                    disabled={processingLoading}
                    onClick={() => void reloadProcessingConfig()}
                  >
                    {processingLoading ? t('sharedContext.management.processingLoading') : t('sharedContext.management.processingReload')}
                  </button>
                </div>
                <LabeledValue
                  label={t('sharedContext.management.processingSavedPrimaryBackend')}
                  value={processingSnapshot?.persisted.primaryContextBackend ?? DEFAULT_PRIMARY_CONTEXT_BACKEND}
                />
                <LabeledValue
                  label={t('sharedContext.management.processingSavedPrimary')}
                  value={processingSnapshot?.persisted.primaryContextModel ?? DEFAULT_PRIMARY_CONTEXT_MODEL}
                />
                <LabeledValue
                  label={t('sharedContext.management.processingSavedBackupBackend')}
                  value={processingSnapshot?.persisted.backupContextBackend ?? t('sharedContext.management.processingUnsetValue')}
                />
                <LabeledValue
                  label={t('sharedContext.management.processingSavedBackup')}
                  value={processingSnapshot?.persisted.backupContextModel ?? t('sharedContext.management.processingUnsetValue')}
                />
                {serverId && <LabeledValue label={t('sharedContext.management.processingServerScope')} value={serverId} />}
                <div>{t('sharedContext.management.processingCloudSyncNote')}</div>
                <div>{t('sharedContext.management.processingProviderNote')}</div>
                <div>{t('sharedContext.management.processingBackendNote')}</div>
              </>
            ) : (
              <div>{t('sharedContext.management.processingServerRequired')}</div>
            )}
          </InfoCard>

          <InfoCard title={t('sharedContext.management.processingOperationalTitle')}>
            <div>{t('sharedContext.management.processingOperationalLine1')}</div>
            <div>{t('sharedContext.management.processingOperationalLine2')}</div>
            <div>{t('sharedContext.management.processingOperationalLine3')}</div>
          </InfoCard>
        </>
      )}

      {activeTab === 'memory' && (
        <>
          <InfoCard title={t('sharedContext.management.memorySummaryTitle')}>
            <div>{t('sharedContext.management.memorySummaryLine1')}</div>
            <div>{t('sharedContext.management.memorySummaryLine2')}</div>
            <div>{t('sharedContext.management.memorySummaryLine3')}</div>
          </InfoCard>

          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.personalSyncTitle')}
              description={t('sharedContext.management.personalSyncDescription')}
              action={serverId ? <span style={pillStyle}>{formatServerScopeValue(serverId, t('sharedContext.management.serverUnbound'))}</span> : undefined}
            />
            {serverId ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: DT.space.md,
                  padding: `${DT.space.md}px ${DT.space.lg}px`,
                  borderRadius: DT.radius.md,
                  border: `1px solid ${DT.border.subtle}`,
                  background: DT.bg.input,
                  cursor: processingSaving ? 'wait' : 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onClick={() => {
                  if (processingSaving || !processingSnapshot) return;
                  const next = !processingPersonalSyncEnabled;
                  setProcessingPersonalSyncEnabled(next);
                  void handleAction(t('sharedContext.notice.processingConfigSaved'), async () => {
                    setProcessingSaving(true);
                    try {
                      const view = await updateSharedContextRuntimeConfig(serverId, {
                        primaryContextBackend: processingPrimaryBackend,
                        primaryContextModel: processingPrimaryModel.trim(),
                        backupContextBackend: processingBackupModel.trim() ? processingBackupBackend : undefined,
                        backupContextModel: processingBackupModel.trim() || undefined,
                        memoryRecallMinScore: processingMemoryRecallMinScore,
                        memoryScoringWeights: normalizeMemoryScoringWeights(processingMemoryScoringWeights),
                        enablePersonalMemorySync: next,
                      });
                      applyProcessingSnapshot(view);
                    } catch {
                      setProcessingPersonalSyncEnabled(!next);
                    } finally {
                      setProcessingSaving(false);
                    }
                  });
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: SC_IS_MOBILE ? 13 : 14, color: DT.text.primary }}>{t('sharedContext.management.personalSyncToggle')}</span>
                  <span style={{ ...helperTextStyle, fontSize: SC_IS_MOBILE ? 11 : 12 }}>{t('sharedContext.management.personalSyncHelp')}</span>
                </div>
                <IOSToggle checked={processingPersonalSyncEnabled} disabled={processingSaving} />
              </div>
            ) : (
              <div style={helperTextStyle}>{t('sharedContext.management.processingServerRequired')}</div>
            )}
          </div>

          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.memoryRecallThresholdTitle')}
              description={t('sharedContext.management.memoryRecallThresholdDescription')}
              action={serverId ? <span style={pillStyle}>{formatServerScopeValue(serverId, t('sharedContext.management.serverUnbound'))}</span> : undefined}
            />
            {serverId ? (
              <>
                <label style={fieldLabelStyle}>
                  <span>{t('sharedContext.management.memoryRecallThresholdLabel')}</span>
                  <input
                    aria-label={t('sharedContext.management.memoryRecallThresholdLabel')}
                    type="number"
                    min={MEMORY_RECALL_MIN_SCORE_MIN}
                    max={MEMORY_RECALL_MIN_SCORE_MAX}
                    step={MEMORY_RECALL_MIN_SCORE_STEP}
                    value={processingMemoryRecallMinScore}
                    onInput={(e) => setProcessingMemoryRecallMinScore(normalizeMemoryRecallMinScore((e.currentTarget as HTMLInputElement).valueAsNumber))}
                    style={numberInputStyle}
                  />
                </label>
                <div style={helperTextStyle}>
                  {t('sharedContext.management.memoryRecallThresholdHelp', { defaultValue: DEFAULT_MEMORY_RECALL_MIN_SCORE.toFixed(2) })}
                </div>
                <div style={rowStyle}>
                  <button
                    style={buttonStyle}
                    disabled={processingSaving}
                    onClick={() => void handleAction(t('sharedContext.notice.processingConfigSaved'), async () => {
                      setProcessingSaving(true);
                      try {
                        const view = await updateSharedContextRuntimeConfig(serverId, buildProcessingConfigPayload());
                        applyProcessingSnapshot(view);
                      } finally {
                        setProcessingSaving(false);
                      }
                    })}
                  >
                    {processingSaving ? t('sharedContext.management.processingSaving') : t('sharedContext.management.processingSave')}
                  </button>
                  <button
                    style={subtleButtonStyle}
                    disabled={processingLoading}
                    onClick={() => setProcessingMemoryRecallMinScore(processingSnapshot?.persisted.memoryRecallMinScore ?? DEFAULT_MEMORY_RECALL_MIN_SCORE)}
                  >
                    {t('sharedContext.management.memoryRecallThresholdReset')}
                  </button>
                </div>
                <LabeledValue
                  label={t('sharedContext.management.memoryRecallThresholdSaved')}
                  value={(processingSnapshot?.persisted.memoryRecallMinScore ?? DEFAULT_MEMORY_RECALL_MIN_SCORE).toFixed(2)}
                />
              </>
            ) : (
              <div style={helperTextStyle}>{t('sharedContext.management.processingServerRequired')}</div>
            )}
          </div>

          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.memoryAdvancedScoringTitle')}
              description={t('sharedContext.management.memoryAdvancedScoringDescription')}
            />
            <button
              type="button"
              style={subtleButtonStyle}
              onClick={() => setMemoryAdvancedVisible((prev) => !prev)}
            >
              {memoryAdvancedVisible
                ? t('sharedContext.management.memoryAdvancedScoringHide')
                : t('sharedContext.management.memoryAdvancedScoringShow')}
            </button>
            {memoryAdvancedVisible ? (
              <>
                <div style={helperTextStyle}>{t('sharedContext.management.memoryAdvancedScoringHelp')}</div>
                <div style={helperTextStyle}>
                  {t('sharedContext.management.memoryAdvancedScoringSum', {
                    value: (
                      processingMemoryScoringWeights.similarity
                      + processingMemoryScoringWeights.recency
                      + processingMemoryScoringWeights.frequency
                      + processingMemoryScoringWeights.project
                    ).toFixed(2),
                  })}
                </div>
                <label style={fieldLabelStyle}>
                  <span>{t('sharedContext.management.memoryWeightSimilarity')}</span>
                  <input
                    aria-label={t('sharedContext.management.memoryWeightSimilarity')}
                    type="number"
                    min={MEMORY_SCORING_WEIGHT_MIN}
                    max={MEMORY_SCORING_WEIGHT_MAX}
                    step={MEMORY_SCORING_WEIGHT_INPUT_STEP}
                    value={processingMemoryScoringWeights.similarity}
                    onInput={(e) => setProcessingMemoryScoringWeights((prev) => {
                      const value = (e.currentTarget as HTMLInputElement).valueAsNumber;
                      return Number.isFinite(value)
                        ? { ...prev, similarity: Math.min(MEMORY_SCORING_WEIGHT_MAX, Math.max(MEMORY_SCORING_WEIGHT_MIN, value)) }
                        : prev;
                    })}
                    style={numberInputStyle}
                  />
                </label>
                <label style={fieldLabelStyle}>
                  <span>{t('sharedContext.management.memoryWeightRecency')}</span>
                  <input
                    aria-label={t('sharedContext.management.memoryWeightRecency')}
                    type="number"
                    min={MEMORY_SCORING_WEIGHT_MIN}
                    max={MEMORY_SCORING_WEIGHT_MAX}
                    step={MEMORY_SCORING_WEIGHT_INPUT_STEP}
                    value={processingMemoryScoringWeights.recency}
                    onInput={(e) => setProcessingMemoryScoringWeights((prev) => {
                      const value = (e.currentTarget as HTMLInputElement).valueAsNumber;
                      return Number.isFinite(value)
                        ? { ...prev, recency: Math.min(MEMORY_SCORING_WEIGHT_MAX, Math.max(MEMORY_SCORING_WEIGHT_MIN, value)) }
                        : prev;
                    })}
                    style={numberInputStyle}
                  />
                </label>
                <label style={fieldLabelStyle}>
                  <span>{t('sharedContext.management.memoryWeightFrequency')}</span>
                  <input
                    aria-label={t('sharedContext.management.memoryWeightFrequency')}
                    type="number"
                    min={MEMORY_SCORING_WEIGHT_MIN}
                    max={MEMORY_SCORING_WEIGHT_MAX}
                    step={MEMORY_SCORING_WEIGHT_INPUT_STEP}
                    value={processingMemoryScoringWeights.frequency}
                    onInput={(e) => setProcessingMemoryScoringWeights((prev) => {
                      const value = (e.currentTarget as HTMLInputElement).valueAsNumber;
                      return Number.isFinite(value)
                        ? { ...prev, frequency: Math.min(MEMORY_SCORING_WEIGHT_MAX, Math.max(MEMORY_SCORING_WEIGHT_MIN, value)) }
                        : prev;
                    })}
                    style={numberInputStyle}
                  />
                </label>
                <label style={fieldLabelStyle}>
                  <span>{t('sharedContext.management.memoryWeightProject')}</span>
                  <input
                    aria-label={t('sharedContext.management.memoryWeightProject')}
                    type="number"
                    min={MEMORY_SCORING_WEIGHT_MIN}
                    max={MEMORY_SCORING_WEIGHT_MAX}
                    step={MEMORY_SCORING_WEIGHT_INPUT_STEP}
                    value={processingMemoryScoringWeights.project}
                    onInput={(e) => setProcessingMemoryScoringWeights((prev) => {
                      const value = (e.currentTarget as HTMLInputElement).valueAsNumber;
                      return Number.isFinite(value)
                        ? { ...prev, project: Math.min(MEMORY_SCORING_WEIGHT_MAX, Math.max(MEMORY_SCORING_WEIGHT_MIN, value)) }
                        : prev;
                    })}
                    style={numberInputStyle}
                  />
                </label>
                <div style={rowStyle}>
                  <button
                    style={buttonStyle}
                    disabled={processingSaving || !serverId}
                    onClick={() => void handleAction(t('sharedContext.notice.processingConfigSaved'), async () => {
                      if (!serverId) return;
                      setProcessingSaving(true);
                      try {
                        const view = await updateSharedContextRuntimeConfig(serverId, buildProcessingConfigPayload());
                        applyProcessingSnapshot(view);
                      } finally {
                        setProcessingSaving(false);
                      }
                    })}
                  >
                    {processingSaving ? t('sharedContext.management.processingSaving') : t('sharedContext.management.processingSave')}
                  </button>
                  <button
                    type="button"
                    style={subtleButtonStyle}
                    onClick={() => setProcessingMemoryScoringWeights(normalizeMemoryScoringWeights(processingSnapshot?.persisted.memoryScoringWeights ?? DEFAULT_MEMORY_SCORING_WEIGHTS))}
                  >
                    {t('sharedContext.management.memoryAdvancedScoringReset')}
                  </button>
                </div>
              </>
            ) : null}
          </div>

          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.memoryQueryTitle')}
              description={t('sharedContext.management.memoryQueryDescription')}
              action={<button style={buttonStyle} onClick={() => void loadMemoryViews()}>{t('sharedContext.refresh')}</button>}
            />
            {renderMemoryProjectPicker()}
            <div style={memoryProcessedNoteStyle}>
              {t('sharedContext.management.memoryPersonalBreakdown', {
                processed: localPersonalMemory.stats.totalRecords,
                pending: localPersonalMemory.pendingRecords?.length ?? 0,
                cloud: cloudPersonalMemory.stats.totalRecords,
              })}
            </div>
            <div style={rowStyle}>
              <input
                value={memoryQuery}
                onInput={(e) => setMemoryQuery((e.currentTarget as HTMLInputElement).value)}
                placeholder={t('sharedContext.management.memoryQueryPlaceholder')}
                style={inputStyle}
              />
              <select
                value={memoryProjectionClass}
                onChange={(e) => setMemoryProjectionClass((e.currentTarget as HTMLSelectElement).value as '' | 'recent_summary' | 'durable_memory_candidate')}
                style={inputStyle}
              >
                <option value="">{t('sharedContext.management.memoryAllClasses')}</option>
                <option value="recent_summary">{t('sharedContext.management.memoryRecentSummary')}</option>
                <option value="durable_memory_candidate">{t('sharedContext.management.memoryDurableCandidate')}</option>
              </select>
            </div>
            {memoryLoading ? <div style={helperTextStyle}>{t('sharedContext.loading')}</div> : null}
            <div style={memoryProcessedNoteStyle}>{t('sharedContext.management.memoryProcessedNote')}</div>
          </div>

          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.memoryToolsTitle')}
              description={t('sharedContext.management.memoryToolsDescription')}
              action={<button style={subtleButtonStyle} onClick={() => loadMemoryAdminViews()} disabled={!ws}>{t('sharedContext.refresh')}</button>}
            />
            {!ws ? <div style={helperTextStyle}>{t('sharedContext.management.memoryAdminDaemonRequired')}</div> : null}
            <div style={tabBarStyle}>
              {[
                { id: 'status' as const, label: t('sharedContext.management.memoryToolTabStatus') },
                { id: 'preferences' as const, label: t('sharedContext.management.memoryToolTabPreferences'), count: preferenceRecords.length },
                { id: 'skills' as const, label: t('sharedContext.management.memoryToolTabSkills'), count: skillEntries.length },
                { id: 'md-ingest' as const, label: t('sharedContext.management.memoryToolTabMdIngest') },
                { id: 'observations' as const, label: t('sharedContext.management.memoryToolTabObservations'), count: observationRecords.length },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  style={memoryToolTab === tab.id ? tabActiveStyle : tabStyle}
                  onClick={() => setMemoryToolTab(tab.id)}
                >
                  {tab.label}{tab.count != null ? <span style={tabBadgeStyle}>{tab.count}</span> : null}
                </button>
              ))}
            </div>
            <div style={{ ...resourceCardStyle, display: memoryToolTab === 'status' ? 'flex' : 'none' }}>
              <SectionHeading
                title={t('sharedContext.management.memoryFeatureStatusTitle')}
                description={t('sharedContext.management.memoryFeatureStatusDescription')}
              />
              <div style={featureFlagGridStyle}>
                {[
                  MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
                  MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest,
                  MEMORY_FEATURE_FLAGS_BY_NAME.skills,
                  MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation,
                  MEMORY_FEATURE_FLAGS_BY_NAME.observationStore,
                  MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry,
                ].map((flag) => {
                  const display = memoryFeatureDisplay(flag);
                  const record = memoryFeatureRecordByFlag.get(flag);
                  const pending = pendingMemoryFeatureFlags.has(flag);
                  const requested = record?.requested ?? record?.enabled ?? false;
                  return (
                    <FeatureFlagCard
                      key={flag}
                      flag={flag}
                      label={memoryFeatureLabel(flag)}
                      enabled={display.enabled}
                      statusText={display.statusText}
                      detail={display.detail}
                      blocked={display.blocked === true}
                      actionLabel={pending
                        ? t('sharedContext.management.memoryFeatureToggleSaving')
                        : requested
                          ? t('sharedContext.management.memoryFeatureDisableAction')
                          : t('sharedContext.management.memoryFeatureEnableAction')}
                      actionPending={pending}
                      actionDisabled={!ws || memoryFeaturesStatus !== 'ready' || !record || (pendingMemoryFeatureFlags.size > 0 && !pending)}
                      onToggle={() => toggleMemoryFeatureFlag(flag)}
                    />
                  );
                })}
              </div>
            </div>
            <div style={{ ...cardGridStyle, display: memoryToolTab === 'preferences' || memoryToolTab === 'skills' ? 'grid' : 'none' }}>
              <div style={{ ...adminSubCardStyle(preferenceFeatureEnabled), display: memoryToolTab === 'preferences' ? 'flex' : 'none' }}>
                <SectionHeading
                  title={t('sharedContext.management.memoryPreferencesTitle')}
                  description={t('sharedContext.management.memoryPreferencesDescription')}
                  action={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={featurePillStyle(preferenceFeatureEnabled)}
                      title={`${preferenceFeatureDisplay.statusText} · ${preferenceRecords.length}`}
                      aria-label={`${preferenceFeatureDisplay.statusText} · ${preferenceRecords.length}`}
                    >
                      <span style={featureFlagDotStyle(preferenceFeatureEnabled)} />
                      {preferenceRecords.length}
                    </span>
                  </span>}
                />
                {preferenceDisabledReason ? (
                  <div style={memoryProcessedNoteStyle}>{preferenceDisabledReason}</div>
                ) : null}
                <div style={adminFormRowStyle}>
                  <input
                    value={preferenceUserId}
                    readOnly
                    disabled
                    placeholder={t('sharedContext.management.memoryPreferenceUserPlaceholder')}
                    style={inputStyle}
                  />
                  <input
                    value={preferenceText}
                    onInput={(e) => setPreferenceText((e.currentTarget as HTMLInputElement).value)}
                    placeholder={t('sharedContext.management.memoryPreferenceTextPlaceholder')}
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={!!preferenceDisabledReason || !preferenceText.trim()}
                    title={preferenceDisabledReason ?? undefined}
                    onClick={() => ws?.send({
                      type: MEMORY_WS.PREF_CREATE,
                      requestId: markMemoryAdminRequest('prefCreate'),
                      text: preferenceText.trim(),
                    })}
                  >
                    {t('sharedContext.management.memoryPreferenceSave')}
                  </button>
                </div>
                <input
                  value={preferenceSearch}
                  onInput={(e) => setPreferenceSearch((e.currentTarget as HTMLInputElement).value)}
                  placeholder={t('sharedContext.management.memoryPreferenceSearchPlaceholder')}
                  style={inputStyle}
                />
                <div style={resourceListStyle}>
                  {filteredPreferenceRecords.length > 0 ? filteredPreferenceRecords.map((record) => (
                    <div key={record.id} style={resourceCardStyle}>
                      <div style={metaGridStyle}>
                        <MetaCard label={t('sharedContext.management.memoryPreferenceUser')} value={record.userId} />
                        <MetaCard label={t('sharedContext.management.memoryRecordUpdated')} value={new Date(record.updatedAt).toLocaleString()} />
                        <MetaCard label={t('sharedContext.management.memoryRecordStatus')} value={record.state} />
                      </div>
                      <MemoryRecordContent
                        id={`pref-${record.id}`}
                        text={record.text}
                        expanded={expandedMemoryRecordIds.has(`pref-${record.id}`)}
                        expandLabel={t('sharedContext.management.memoryExpand')}
                        collapseLabel={t('sharedContext.management.memoryCollapse')}
                        onToggle={() => {
                          setExpandedMemoryRecordIds((current) => {
                            const next = new Set(current);
                            const key = `pref-${record.id}`;
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          });
                        }}
                      />
                      <div style={rowStyle}>
                        <button
                          type="button"
                          style={deleteButtonStyle}
                          disabled={!!preferenceDisabledReason}
                          title={preferenceDisabledReason ?? undefined}
                          onClick={() => {
                            const confirmed = globalThis.confirm?.(t('sharedContext.management.memoryPreferenceDeleteConfirm')) ?? true;
                            if (!confirmed) return;
                            ws?.send({ type: MEMORY_WS.PREF_DELETE, requestId: markMemoryAdminRequest('prefDelete'), id: record.id });
                          }}
                        >
                          {t('sharedContext.management.memoryDelete')}
                        </button>
                      </div>
                    </div>
                  )) : <div style={helperTextStyle}>{t('sharedContext.management.memoryPreferencesEmpty')}</div>}
                </div>
              </div>

              <div style={{ ...adminSubCardStyle(skillsFeatureEnabled), display: memoryToolTab === 'skills' ? 'flex' : 'none' }}>
                <SectionHeading
                  title={t('sharedContext.management.memorySkillsTitle')}
                  description={t('sharedContext.management.memorySkillsDescription')}
                  action={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={featurePillStyle(skillsFeatureEnabled)}
                      title={`${skillsFeatureDisplay.statusText} · ${skillEntries.length}`}
                      aria-label={`${skillsFeatureDisplay.statusText} · ${skillEntries.length}`}
                    >
                      <span style={featureFlagDotStyle(skillsFeatureEnabled)} />
                      {skillEntries.length}
                    </span>
                  </span>}
                />
                {skillToolDisabledReason ? (
                  <div style={memoryProcessedNoteStyle}>{skillToolDisabledReason}</div>
                ) : null}
                <div style={adminFormRowStyle}>
                  <button type="button" style={subtleButtonStyle} disabled={!ws} onClick={() => loadMemoryAdminViews()}>
                    {t('sharedContext.refresh')}
                  </button>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={!!skillToolDisabledReason}
                    title={skillToolDisabledReason ?? undefined}
                    onClick={() => ws?.send({
                      type: MEMORY_WS.SKILL_REBUILD,
                      requestId: markMemoryAdminRequest('skillRebuild'),
                      projectDir: selectedProjectDir,
                      canonicalRepoId: selectedCanonicalRepoId,
                    })}
                  >
                    {t('sharedContext.management.memorySkillRebuildRegistry')}
                  </button>
                </div>
                <input
                  value={skillSearch}
                  onInput={(e) => setSkillSearch((e.currentTarget as HTMLInputElement).value)}
                  placeholder={t('sharedContext.management.memorySkillSearchPlaceholder')}
                  style={inputStyle}
                />
                {!selectedMemoryProjectCapabilities.canRunLocalTools ? (
                  <div style={helperTextStyle}>{t('sharedContext.management.memoryProjectLocalToolsDisabled')}</div>
                ) : null}
                <div style={resourceListStyle}>
                  {filteredSkillEntries.length > 0 ? filteredSkillEntries.map((entry) => (
                    <div key={`${entry.layer}:${entry.key}:${entry.displayPath}`} style={resourceCardStyle}>
                      <div style={metaGridStyle}>
                        <MetaCard label={t('sharedContext.management.memorySkillName')} value={entry.name} />
                        <MetaCard label={t('sharedContext.management.memorySkillLayer')} value={entry.layer} />
                        <MetaCard label={t('sharedContext.management.memorySkillPath')} value={entry.displayPath} />
                        <MetaCard label={t('sharedContext.management.memoryRecordUpdated')} value={new Date(entry.updatedAt).toLocaleString()} />
                      </div>
                      {entry.description ? <div style={helperTextStyle}>{entry.description}</div> : null}
                      <div style={rowStyle}>
                        <button
                          type="button"
                          style={subtleButtonStyle}
                          disabled={!!skillToolDisabledReason}
                          title={skillToolDisabledReason ?? undefined}
                          onClick={() => ws?.send({
                            type: MEMORY_WS.SKILL_READ,
                            requestId: markMemoryAdminRequest('skillRead'),
                            key: entry.key,
                            layer: entry.layer,
                            projectDir: selectedProjectDir,
                            canonicalRepoId: selectedCanonicalRepoId,
                          })}
                        >
                          {t('sharedContext.management.memorySkillPreview')}
                        </button>
                        <button
                          type="button"
                          style={deleteButtonStyle}
                          disabled={!!skillToolDisabledReason}
                          title={skillToolDisabledReason ?? undefined}
                          onClick={() => {
                            const confirmed = globalThis.confirm?.(t('sharedContext.management.memorySkillDeleteConfirm')) ?? true;
                            if (!confirmed) return;
                            ws?.send({
                              type: MEMORY_WS.SKILL_DELETE,
                              requestId: markMemoryAdminRequest('skillDelete'),
                              key: entry.key,
                              layer: entry.layer,
                              projectDir: selectedProjectDir,
                              canonicalRepoId: selectedCanonicalRepoId,
                            });
                          }}
                        >
                          {t('sharedContext.management.memoryDelete')}
                        </button>
                      </div>
                    </div>
                  )) : <div style={helperTextStyle}>{t('sharedContext.management.memorySkillsEmpty')}</div>}
                </div>
                {skillPreview ? (
                  <div style={resourceCardStyle}>
                    <SectionHeading
                      title={t('sharedContext.management.memorySkillPreviewTitle')}
                      description={`${skillPreview.layer}:${skillPreview.key}`}
                      action={<button type="button" style={archiveRestoreButtonStyle} onClick={() => setSkillPreview(null)}>{t('sharedContext.management.memoryCollapse')}</button>}
                    />
                    <pre style={{ ...memoryContentExpandedStyle, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Menlo, monospace' }}>{skillPreview.content}</pre>
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ ...cardGridStyle, display: memoryToolTab === 'md-ingest' || memoryToolTab === 'observations' ? 'grid' : 'none' }}>
              <div style={{ ...adminSubCardStyle(mdIngestFeatureEnabled), display: memoryToolTab === 'md-ingest' ? 'flex' : 'none' }}>
                <SectionHeading
                  title={t('sharedContext.management.memoryMdIngestTitle')}
                  description={t('sharedContext.management.memoryMdIngestDescription')}
                  action={<span
                    style={featurePillStyle(mdIngestFeatureEnabled)}
                    title={mdIngestFeatureDisplay.statusText}
                    aria-label={mdIngestFeatureDisplay.statusText}
                  >
                    <span style={featureFlagDotStyle(mdIngestFeatureEnabled)} />
                    {mdIngestFeatureDisplay.statusText}
                  </span>}
                />
                {mdIngestDisabledReason ? (
                  <div style={memoryProcessedNoteStyle}>{mdIngestDisabledReason}</div>
                ) : null}
                <div style={adminFormRowStyle}>
                  <select value={mdIngestScope} onChange={(e) => setMdIngestScope((e.currentTarget as HTMLSelectElement).value as MemoryScope)} style={inputStyle}>
                    {MD_INGEST_UI_SCOPES.map((scopeValue) => (
                      <option key={scopeValue} value={scopeValue}>{t(`sharedContext.management.memoryScope.${scopeValue}`)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={!!mdIngestDisabledReason || (mdIngestScope !== 'personal' && mdIngestScope !== 'project_shared')}
                    title={mdIngestDisabledReason ?? undefined}
                    onClick={() => ws?.send({
                      type: MEMORY_WS.MD_INGEST_RUN,
                      requestId: markMemoryAdminRequest('mdIngest'),
                      projectDir: selectedMdProjectDir,
                      canonicalRepoId: selectedMdCanonicalRepoId,
                      scope: mdIngestScope,
                    })}
                  >
                    {t('sharedContext.management.memoryMdIngestRun')}
                  </button>
                </div>
                {mdIngestResult ? (
                  <div style={metaGridStyle}>
                    <MetaCard label={t('sharedContext.management.memoryMdFilesChecked')} value={mdIngestResult.filesChecked} />
                    <MetaCard label={t('sharedContext.management.memoryMdObservationsWritten')} value={mdIngestResult.observationsWritten} />
                  </div>
                ) : <div style={helperTextStyle}>{t('sharedContext.management.memoryMdIngestEmpty')}</div>}
              </div>

              <div style={{ ...adminSubCardStyle(observationStoreFeatureEnabled), display: memoryToolTab === 'observations' ? 'flex' : 'none' }}>
                <SectionHeading
                  title={t('sharedContext.management.memoryObservationsTitle')}
                  description={t('sharedContext.management.memoryObservationsDescription')}
                  action={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={featurePillStyle(observationStoreFeatureEnabled)}
                      title={`${observationStoreFeatureDisplay.statusText} · ${observationRecords.length}`}
                      aria-label={`${observationStoreFeatureDisplay.statusText} · ${observationRecords.length}`}
                    >
                      <span style={featureFlagDotStyle(observationStoreFeatureEnabled)} />
                      {observationRecords.length}
                    </span>
                  </span>}
                />
                {observationPromoteDisabledReason ? (
                  <div style={memoryProcessedNoteStyle}>{observationPromoteDisabledReason}</div>
                ) : null}
                <div style={adminFormRowStyle}>
                  <select value={observationScope} onChange={(e) => setObservationScope((e.currentTarget as HTMLSelectElement).value as '' | MemoryScope)} style={inputStyle}>
                    <option value="">{t('sharedContext.management.memoryAllScopes')}</option>
                    {MEMORY_SCOPES.map((scopeValue) => (
                      <option key={scopeValue} value={scopeValue}>{t(`sharedContext.management.memoryScope.${scopeValue}`)}</option>
                    ))}
                  </select>
                  <select value={observationClass} onChange={(e) => setObservationClass((e.currentTarget as HTMLSelectElement).value as MemoryObservationClassFilter)} style={inputStyle}>
                    <option value="">{t('sharedContext.management.memoryAllClasses')}</option>
                    {OBSERVATION_CLASSES.map((classValue) => (
                      <option key={classValue} value={classValue}>{t(`sharedContext.management.memoryObservationClass.${classValue}`)}</option>
                    ))}
                  </select>
                  <select value={promotionTargetScope} onChange={(e) => setPromotionTargetScope((e.currentTarget as HTMLSelectElement).value as MemoryScope)} style={inputStyle}>
                    {MEMORY_SCOPES.map((scopeValue) => (
                      <option key={scopeValue} value={scopeValue}>{t(`sharedContext.management.memoryScope.${scopeValue}`)}</option>
                    ))}
                  </select>
                  <input
                    value={promotionReason}
                    onInput={(e) => setPromotionReason((e.currentTarget as HTMLInputElement).value)}
                    placeholder={t('sharedContext.management.memoryPromotionReasonPlaceholder')}
                    style={inputStyle}
                  />
                  <button type="button" style={subtleButtonStyle} disabled={!ws} onClick={() => loadMemoryAdminViews()}>
                    {t('sharedContext.refresh')}
                  </button>
                </div>
                <input
                  value={observationSearch}
                  onInput={(e) => setObservationSearch((e.currentTarget as HTMLInputElement).value)}
                  placeholder={t('sharedContext.management.memoryObservationSearchPlaceholder')}
                  style={inputStyle}
                />
                <div style={resourceListStyle}>
                  {filteredObservationRecords.length > 0 ? filteredObservationRecords.map((record) => (
                    <div key={record.id} style={resourceCardStyle}>
                      <div style={metaGridStyle}>
                        <MetaCard label={t('sharedContext.management.memoryRecordClass')} value={t(`sharedContext.management.memoryObservationClass.${record.class}`)} />
                        <MetaCard label={t('sharedContext.management.memoryRecordStatus')} value={record.state} />
                        <MetaCard label={t('sharedContext.management.memoryScopeLabel')} value={t(`sharedContext.management.memoryScope.${record.scope}`)} />
                        <MetaCard label={t('sharedContext.management.memoryRecordUpdated')} value={new Date(record.updatedAt).toLocaleString()} />
                      </div>
                      <MemoryRecordContent
                        id={`observation-${record.id}`}
                        text={record.text}
                        expanded={expandedMemoryRecordIds.has(`observation-${record.id}`)}
                        expandLabel={t('sharedContext.management.memoryExpand')}
                        collapseLabel={t('sharedContext.management.memoryCollapse')}
                        onToggle={() => {
                          setExpandedMemoryRecordIds((current) => {
                            const next = new Set(current);
                            const key = `observation-${record.id}`;
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          });
                        }}
                      />
                      <div style={rowStyle}>
                        <button
                          type="button"
                          style={subtleButtonStyle}
                          disabled={!!observationPromoteDisabledReason}
                          title={observationPromoteDisabledReason ?? undefined}
                          onClick={() => ws?.send({
                            type: MEMORY_WS.OBSERVATION_PROMOTE,
                            requestId: markMemoryAdminRequest('observationPromote'),
                            id: record.id,
                            projectDir: selectedProjectDir,
                            canonicalRepoId: selectedCanonicalRepoId,
                            expectedFromScope: record.scope,
                            toScope: promotionTargetScope,
                            reason: promotionReason.trim() || undefined,
                          })}
                        >
                          {t('sharedContext.management.memoryObservationPromote')}
                        </button>
                      </div>
                    </div>
                  )) : <div style={helperTextStyle}>{t('sharedContext.management.memoryObservationsEmpty')}</div>}
                </div>
              </div>
            </div>
          </div>


          <div style={{ ...sectionStyle, gap: 12 }}>
            {/* Top level: Personal | Enterprise */}
            <div style={tabBarStyle}>
              {memoryTopTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  style={memoryTopTab === tab.id ? tabActiveStyle : tabStyle}
                  onClick={() => setMemoryTopTab(tab.id)}
                >
                  {tab.label}{tab.count != null ? <span style={tabBadgeStyle}>{tab.count}</span> : null}
                </button>
              ))}
            </div>

            {/* Sub-tabs for Personal */}
            {memoryTopTab === 'personal' ? (
              <div style={tabBarStyle}>
                {memoryPersonalSubTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    style={memoryPersonalSubTab === tab.id ? tabActiveStyle : tabStyle}
                    onClick={() => setMemoryPersonalSubTab(tab.id)}
                  >
                    {tab.label}{tab.count != null ? <span style={tabBadgeStyle}>{tab.count}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}

            {/* Sub-tabs for Enterprise */}
            {memoryTopTab === 'enterprise-memory' ? (
              <div style={tabBarStyle}>
                {memoryEnterpriseSubTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    style={memoryEnterpriseSubTab === tab.id ? tabActiveStyle : tabStyle}
                    onClick={() => setMemoryEnterpriseSubTab(tab.id)}
                  >
                    {tab.label}{'count' in tab && tab.count != null ? <span style={tabBadgeStyle}>{tab.count}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}

            {memoryTopTab === 'personal' && memoryPersonalSubTab === 'processed' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SectionHeading
                  title={t('sharedContext.management.memoryLocalTitle')}
                  description={t('sharedContext.management.memoryProcessedDescription')}
                  action={<span style={pillStyle}>{localPersonalMemory.records.length}</span>}
                />
                {localMemoryStatusNotice ? <div style={memoryProcessedNoteStyle}>{localMemoryStatusNotice}</div> : null}
                {!localMemoryUnavailable ? (
                  <div style={statGridStyle}>
                    <StatCard label={t('sharedContext.management.memoryStatTotal')} value={localPersonalMemory.stats.totalRecords} />
                    {memoryQuery.trim() ? <StatCard label={t('sharedContext.management.memoryStatHits')} value={localPersonalMemory.stats.matchedRecords} /> : null}
                    <StatCard label={t('sharedContext.management.memoryStatRecent')} value={localPersonalMemory.stats.recentSummaryCount} />
                    <StatCard
                      label={t('sharedContext.management.memoryStatDurable')}
                      value={localPersonalMemory.stats.durableCandidateCount}
                      detail={`${t('sharedContext.management.memoryStatProjects')}: ${localPersonalMemory.stats.projectCount}`}
                    />
                  </div>
                ) : null}
                {memoryBrowseProjectId && selectedBrowseMemoryProject ? (
                  <div style={memoryProcessedNoteStyle}>
                    {t('sharedContext.management.memoryFilteredByProject', { project: selectedBrowseMemoryProject.displayName })}
                    {' '}
                    <button type="button" style={archiveRestoreButtonStyle} onClick={() => setMemoryBrowseProjectId('')}>
                      {t('sharedContext.management.memoryClearProjectFilter')}
                    </button>
                  </div>
                ) : null}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: DT.space.sm,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  onClick={() => setShowArchived((v) => !v)}
                >
                  <IOSToggle checked={showArchived} disabled={false} />
                  <span style={{ ...helperTextStyle, fontSize: 12 }}>{t('sharedContext.management.memoryShowArchived')}</span>
                </div>
                {localMemoryUnavailable
                  ? null
                  : localPersonalMemory.records.length > 0
                  ? renderProcessedMemoryRecords(localPersonalMemory, { allowArchiveRestore: true, allowDelete: true, onArchive: handleMemoryArchive, onRestore: handleMemoryRestore, onDelete: handleLocalMemoryDelete })
                  : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={helperTextStyle}>
                        {cloudPersonalMemory.stats.totalRecords > 0
                          ? t('sharedContext.management.memoryProcessedEmptyWithCloud', { count: cloudPersonalMemory.stats.totalRecords })
                          : t('sharedContext.management.memoryProcessedEmptyPending')}
                      </div>
                      {cloudPersonalMemory.stats.totalRecords > 0 ? (
                        <button type="button" style={subtleButtonStyle} onClick={() => setMemoryPersonalSubTab('cloud')}>
                          {t('sharedContext.management.memoryViewPersonalCloud')}
                        </button>
                      ) : null}
                    </div>
                  )}
              </div>
            ) : null}

            {memoryTopTab === 'personal' && memoryPersonalSubTab === 'unprocessed' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SectionHeading
                  title={t('sharedContext.management.memoryPendingTitle')}
                  description={t('sharedContext.management.memoryPendingDescription')}
                  action={<span style={pillStyle}>{localPersonalMemory.pendingRecords?.length ?? 0}</span>}
                />
                {localMemoryStatusNotice ? <div style={memoryProcessedNoteStyle}>{localMemoryStatusNotice}</div> : null}
                {!localMemoryUnavailable ? (
                  <div style={statGridStyle}>
                    <StatCard label={t('sharedContext.management.memoryStatPending')} value={localPersonalMemory.stats.stagedEventCount} />
                    <StatCard label={t('sharedContext.management.memoryStatDirtyTargets')} value={localPersonalMemory.stats.dirtyTargetCount} />
                    <StatCard label={t('sharedContext.management.memoryStatPendingJobs')} value={localPersonalMemory.stats.pendingJobCount} />
                  </div>
                ) : null}
                {localMemoryUnavailable ? null : localPersonalMemory.pendingRecords && localPersonalMemory.pendingRecords.length > 0 ? (
                  <div style={resourceListStyle}>
                    {localPersonalMemory.pendingRecords.map((record) => (
                      <div key={record.id} style={resourceCardStyle}>
                        <div style={metaGridStyle}>
                          <MetaCard label={t('sharedContext.management.memoryRecordProject')} value={record.projectId} />
                          <MetaCard label={t('sharedContext.management.memoryRecordStatus')} value={t('sharedContext.management.memoryStatusPending')} />
                          <MetaCard label={t('sharedContext.management.memoryPendingEventType')} value={record.eventType} />
                          <MetaCard label={t('sharedContext.management.memoryPendingSession')} value={record.sessionName ?? '—'} />
                          <MetaCard label={t('sharedContext.management.memoryRecordUpdated')} value={new Date(record.createdAt).toLocaleString()} />
                        </div>
                        <MemoryRecordContent
                          id={`pending-${record.id}`}
                          text={record.content || '—'}
                          expanded={expandedMemoryRecordIds.has(`pending-${record.id}`)}
                          expandLabel={t('sharedContext.management.memoryExpand')}
                          collapseLabel={t('sharedContext.management.memoryCollapse')}
                          onToggle={() => {
                            setExpandedMemoryRecordIds((current) => {
                              const next = new Set(current);
                              const key = `pending-${record.id}`;
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={helperTextStyle}>
                    {(localPersonalMemory.stats.totalRecords > 0 || cloudPersonalMemory.stats.totalRecords > 0)
                      ? t('sharedContext.management.memoryUnprocessedEmptyWithData')
                      : t('sharedContext.empty')}
                  </div>
                )}
              </div>
            ) : null}

            {memoryTopTab === 'personal' && memoryPersonalSubTab === 'cloud' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SectionHeading
                  title={t('sharedContext.management.memoryCloudTitle')}
                  description={t('sharedContext.management.memoryProcessedDescription')}
                  action={<span style={pillStyle}>{cloudPersonalMemory.records.length}</span>}
                />
                <div style={statGridStyle}>
                  <StatCard label={t('sharedContext.management.memoryStatTotal')} value={cloudPersonalMemory.stats.totalRecords} />
                  {memoryQuery.trim() ? <StatCard label={t('sharedContext.management.memoryStatHits')} value={cloudPersonalMemory.stats.matchedRecords} /> : null}
                  <StatCard label={t('sharedContext.management.memoryStatRecent')} value={cloudPersonalMemory.stats.recentSummaryCount} />
                  <StatCard
                    label={t('sharedContext.management.memoryStatDurable')}
                    value={cloudPersonalMemory.stats.durableCandidateCount}
                    detail={`${t('sharedContext.management.memoryStatProjects')}: ${cloudPersonalMemory.stats.projectCount}`}
                  />
                </div>
                {renderProcessedMemoryRecords(cloudPersonalMemory, { allowDelete: true, onDelete: handleCloudMemoryDelete })}
              </div>
            ) : null}

            {memoryTopTab === 'enterprise-memory' && memoryEnterpriseSubTab === 'shared-memory' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SectionHeading
                  title={t('sharedContext.management.memorySharedTitle')}
                  description={t('sharedContext.management.memoryProcessedDescription')}
                  action={<span style={pillStyle}>{sharedMemory.records.length}</span>}
                />
                <div style={statGridStyle}>
                  <StatCard label={t('sharedContext.management.memoryStatTotal')} value={sharedMemory.stats.totalRecords} />
                  {memoryQuery.trim() ? <StatCard label={t('sharedContext.management.memoryStatHits')} value={sharedMemory.stats.matchedRecords} /> : null}
                  <StatCard label={t('sharedContext.management.memoryStatRecent')} value={sharedMemory.stats.recentSummaryCount} />
                  <StatCard
                    label={t('sharedContext.management.memoryStatDurable')}
                    value={sharedMemory.stats.durableCandidateCount}
                    detail={`${t('sharedContext.management.memoryStatProjects')}: ${sharedMemory.stats.projectCount}`}
                  />
                </div>
                {renderProcessedMemoryRecords(sharedMemory, { allowDelete: team?.myRole === 'owner' || team?.myRole === 'admin', onDelete: handleEnterpriseMemoryDelete })}
              </div>
            ) : null}

            {memoryTopTab === 'enterprise-memory' && memoryEnterpriseSubTab === 'authored-context' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SectionHeading
                  title={t('sharedContext.management.memoryAuthoredTitle')}
                  description={t('sharedContext.management.memoryAuthoredDescription')}
                />
                <div style={helperTextStyle}>
                  {t('sharedContext.management.memoryAuthoredSeeKnowledge')}
                </div>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function CornerFold({ expanded, onClick, expandLabel, collapseLabel }: { expanded: boolean; onClick: (e: Event) => void; expandLabel: string; collapseLabel: string }) {
  const size = 22;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: size,
        height: size,
        padding: 0,
        margin: 0,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        overflow: 'hidden',
      }}
      title={expanded ? collapseLabel : expandLabel}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
        {/* Corner dashed lines */}
        <path
          d={expanded
            ? `M${size} 0 L${size} ${size} L0 ${size}`   // ┘ collapse
            : `M${size - 2} 2 L${size - 2} ${size - 2} L2 ${size - 2}`}  // ┘ expand
          fill="none"
          stroke={DT.text.muted}
          strokeWidth="1.5"
          strokeDasharray="3 2"
          strokeLinecap="round"
        />
        {/* Small triangle hint */}
        <polygon
          points={expanded
            ? `${size},${size - 6} ${size},${size} ${size - 6},${size}`
            : `${size},${size - 8} ${size},${size} ${size - 8},${size}`}
          fill={DT.text.muted}
          opacity="0.5"
        />
      </svg>
    </button>
  );
}

function MemoryRecordContent({
  id,
  text,
  expanded,
  onToggle,
  expandLabel,
  collapseLabel,
}: {
  id: string;
  text: string;
  expanded: boolean;
  onToggle: () => void;
  expandLabel: string;
  collapseLabel: string;
}) {
  const collapsible = shouldCollapseMemoryContent(text);
  const showExpanded = expanded || !collapsible;
  return (
    <div
      style={{ position: 'relative', cursor: collapsible ? 'pointer' : undefined }}
      onClick={collapsible ? onToggle : undefined}
    >
      <div
        data-testid={`memory-record-content-${id}`}
        style={showExpanded ? memoryContentExpandedStyle : memoryContentCollapsedStyle}
      >
        <ChatMarkdown text={text} />
      </div>
      {collapsible ? (
        <CornerFold
          expanded={expanded}
          expandLabel={expandLabel}
          collapseLabel={collapseLabel}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
        />
      ) : null}
    </div>
  );
}
