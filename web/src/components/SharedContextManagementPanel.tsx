import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from '@shared/context-model-defaults.js';
import type { ContextMemoryView, SharedContextRuntimeBackend } from '@shared/context-types.js';
import { QWEN_MODEL_IDS } from '@shared/qwen-models.js';
import {
  DEFAULT_PRIMARY_CONTEXT_BACKEND,
  getDefaultSharedContextModelForBackend,
  isKnownSharedContextModelForBackend,
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
  gap: DT.space.lg,
  padding: DT.space.lg,
  color: DT.text.primary,
  overflow: 'auto',
  background: `radial-gradient(ellipse at top, rgba(37,99,235,0.08), transparent 40%), ${DT.bg.base}`,
  fontSize: 13,
  lineHeight: 1.5,
} as const;

const sectionStyle = {
  border: `1px solid ${DT.border.subtle}`,
  borderRadius: DT.radius.xl,
  padding: `${DT.space.lg}px ${DT.space.xl}px`,
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
} as const;

const rowStyle = {
  display: 'flex',
  gap: DT.space.sm,
  flexWrap: 'wrap',
  alignItems: 'center',
} as const;

const inputStyle = {
  flex: '1 1 180px',
  minWidth: 0,
  background: DT.bg.input,
  color: DT.text.primary,
  border: `1px solid ${DT.border.default}`,
  borderRadius: DT.radius.sm,
  padding: '8px 12px',
  fontSize: 13,
  transition: 'border-color 0.15s, box-shadow 0.15s',
  outline: 'none',
} as const;

const buttonStyle = {
  background: '#2563eb',
  color: '#ffffff',
  border: 'none',
  borderRadius: DT.radius.sm,
  padding: '8px 14px',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  transition: 'background 0.15s, transform 0.1s',
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
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 500,
  borderRadius: DT.radius.md,
  cursor: 'pointer',
  transition: 'background 0.15s, color 0.15s',
  display: 'inline-flex',
  alignItems: 'center',
} as const;

const tabActiveStyle = {
  ...tabStyle,
  background: 'rgba(37,99,235,0.15)',
  color: DT.text.primary,
  fontWeight: 600,
} as const;

const tabBarStyle = {
  display: 'flex',
  gap: DT.space.xs,
  flexWrap: 'wrap',
  alignItems: 'center',
  padding: DT.space.xs,
  borderRadius: DT.radius.md,
  background: DT.bg.input,
  border: `1px solid ${DT.border.subtle}`,
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
  flex: '1 1 260px',
  minWidth: 240,
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

const fieldInputStyle = {
  ...inputStyle,
  width: '100%',
} as const;

const processingModelInputStyle = {
  ...fieldInputStyle,
  height: 40,
  minHeight: 40,
  padding: '8px 10px',
  lineHeight: '22px',
  boxSizing: 'border-box',
} as const;

const statGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: DT.space.sm,
} as const;

const statCardStyle = {
  borderRadius: DT.radius.md,
  padding: `${DT.space.md}px ${DT.space.lg}px`,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.input,
  display: 'flex',
  flexDirection: 'column',
  gap: DT.space.xs,
  transition: 'border-color 0.15s',
} as const;

const resourceListStyle = {
  display: 'grid',
  gap: DT.space.md,
} as const;

const resourceCardStyle = {
  borderRadius: DT.radius.lg,
  padding: DT.space.lg,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.surfaceElev,
  display: 'flex',
  flexDirection: 'column',
  gap: DT.space.md,
  transition: 'border-color 0.15s, transform 0.1s',
} as const;

const memoryContentCollapsedStyle = {
  maxHeight: '4.8em',
  overflowY: 'hidden',
  padding: `${DT.space.md}px ${DT.space.lg}px`,
  borderRadius: DT.radius.md,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.input,
  lineHeight: 1.6,
  fontSize: 13,
  color: DT.text.primary,
  position: 'relative',
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
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: DT.space.md,
  alignItems: 'start',
} as const;

const cardGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: DT.space.md,
} as const;

const metaGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: DT.space.sm,
} as const;

const metaCardStyle = {
  borderRadius: DT.radius.sm,
  border: `1px solid ${DT.border.subtle}`,
  background: DT.bg.input,
  padding: `${DT.space.sm}px ${DT.space.md}px`,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
} as const;

const helperTextStyle = {
  color: DT.text.secondary,
  fontSize: 12,
  lineHeight: 1.5,
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
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: DT.space.md,
  alignItems: 'start',
} as const;

const processingCardStyle = {
  border: `1px solid ${DT.border.subtle}`,
  borderRadius: DT.radius.lg,
  padding: DT.space.lg,
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

const modelChipRowStyle = {
  display: 'flex',
  gap: 6,
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
        padding: '4px 8px',
        fontSize: 12,
        fontWeight: 700,
        background: '#0f766e',
      }
    : {
        ...subtleButtonStyle,
        padding: '4px 8px',
        fontSize: 12,
        fontWeight: 600,
        background: '#1e293b',
      };
}

const defaultPolicyState: SharedProjectPolicy = {
  enrollmentId: '',
  enterpriseId: '',
  allowDegradedProviderSupport: true,
  allowLocalFallback: false,
  requireFullProviderSupport: false,
};

const PROCESSING_MODEL_OPTIONS = Array.from(new Set([
  DEFAULT_PRIMARY_CONTEXT_MODEL,
  ...CLAUDE_CODE_MODEL_IDS,
  ...CODEX_MODEL_IDS,
  ...QWEN_MODEL_IDS,
]));

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

function formatServerScopeValue(serverId?: string): string {
  if (!serverId) return 'Unbound';
  if (serverId.length <= 12) return serverId;
  return `${serverId.slice(0, 8)}…${serverId.slice(-4)}`;
}

type KindOption = SharedDocument['kind'];
type ManagementTab = 'enterprise' | 'members' | 'projects' | 'knowledge' | 'processing' | 'memory';
type MemoryTopTab = 'personal' | 'enterprise-memory';
type MemoryPersonalSubTab = 'unprocessed' | 'processed' | 'cloud';
type MemoryEnterpriseSubTab = 'shared-memory' | 'authored-context';

interface Props {
  enterpriseId?: string;
  serverId?: string;
  ws?: WsClient | null;
  onEnterpriseChange?: (enterpriseId: string) => void;
}

interface TabDef {
  id: ManagementTab;
  label: string;
}

type SharedScopeValue = 'project_shared' | 'workspace_shared' | 'org_shared';

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
      <span style={{ color: DT.text.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>{label}</span>
      <strong style={{ fontSize: 22, lineHeight: 1.1, color: DT.text.primary, fontWeight: 600 }}>{value}</strong>
      {detail ? <span style={{ color: DT.text.secondary, fontSize: 11 }}>{detail}</span> : null}
    </div>
  );
}

function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ComponentChildren }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: DT.space.md, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 auto', minWidth: 200 }}>
        <strong style={{ fontSize: 15, fontWeight: 600, color: DT.text.primary }}>{title}</strong>
        {description ? <span style={helperTextStyle}>{description}</span> : null}
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div style={metaCardStyle}>
      <span style={{ color: DT.text.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 500 }}>{label}</span>
      <span style={{ color: DT.text.primary, fontSize: 12, lineHeight: 1.4, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function ModelChipSelector({
  backend,
  value,
  onSelect,
}: {
  backend: SharedContextRuntimeBackend;
  value: string;
  onSelect: (model: string) => void;
}) {
  const options = PROCESSING_MODEL_OPTIONS_BY_BACKEND[backend] ?? [];
  if (options.length === 0) return null;
  return (
    <div style={modelChipRowStyle}>
      {options.map((modelId) => (
        <button
          key={`${backend}:${modelId}`}
          type="button"
          aria-label={`model:${backend}:${modelId}`}
          style={modelChipStyle(value.trim() === modelId)}
          onClick={() => onSelect(modelId)}
        >
          {modelId}
        </button>
      ))}
    </div>
  );
}

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
  };
}

function shouldCollapseMemoryContent(text: string): boolean {
  return text.split('\n').length > 3 || text.length > 220;
}

function getMemoryRecordClassLabel(
  t: (key: string) => string,
  projectionClass: 'recent_summary' | 'durable_memory_candidate',
): string {
  return projectionClass === 'recent_summary'
    ? t('sharedContext.management.memoryRecentSummary')
    : t('sharedContext.management.memoryDurableCandidate');
}

export function SharedContextManagementPanel({ enterpriseId: initialEnterpriseId, serverId, ws, onEnterpriseChange }: Props) {
  const { t } = useTranslation();
  const onEnterpriseChangeRef = useRef(onEnterpriseChange);
  onEnterpriseChangeRef.current = onEnterpriseChange;
  const personalMemoryRequestIdRef = useRef<string | null>(null);

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
  const [processingBackupBackend, setProcessingBackupBackend] = useState<SharedContextRuntimeBackend>(DEFAULT_PRIMARY_CONTEXT_BACKEND);
  const [processingBackupModel, setProcessingBackupModel] = useState('');
  const [processingPersonalSyncEnabled, setProcessingPersonalSyncEnabled] = useState(false);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryProjectId, setMemoryProjectId] = useState('');
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryProjectionClass, setMemoryProjectionClass] = useState<'' | 'recent_summary' | 'durable_memory_candidate'>('');
  const [localPersonalMemory, setLocalPersonalMemory] = useState<ContextMemoryView>(EMPTY_MEMORY_VIEW);
  const [cloudPersonalMemory, setCloudPersonalMemory] = useState<ContextMemoryView>(EMPTY_MEMORY_VIEW);
  const [sharedMemory, setSharedMemory] = useState<ContextMemoryView>(EMPTY_MEMORY_VIEW);
  const [expandedMemoryRecordIds, setExpandedMemoryRecordIds] = useState<Set<string>>(new Set());
  const [memoryTopTab, setMemoryTopTab] = useState<MemoryTopTab>('personal');
  const [memoryPersonalSubTab, setMemoryPersonalSubTab] = useState<MemoryPersonalSubTab>('processed');
  const [memoryEnterpriseSubTab, setMemoryEnterpriseSubTab] = useState<MemoryEnterpriseSubTab>('shared-memory');

  const renderProcessedMemoryRecords = useCallback((view: ContextMemoryView) => {
    const recentRecords = view.records.filter((record) => record.projectionClass === 'recent_summary');
    const durableRecords = view.records.filter((record) => record.projectionClass === 'durable_memory_candidate');
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
    ].filter((section) => section.records.length > 0) satisfies Array<{
      key: 'recent' | 'durable';
      title: string;
      description: string;
      records: typeof view.records;
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
              {section.records.map((record) => (
                <div key={record.id} style={resourceCardStyle}>
                  <div style={metaGridStyle}>
                    <MetaCard label={t('sharedContext.management.memoryRecordProject')} value={record.projectId} />
                    <MetaCard label={t('sharedContext.management.memoryRecordStatus')} value={t('sharedContext.management.memoryStatusProcessed')} />
                    <MetaCard label={t('sharedContext.management.memoryRecordClass')} value={getMemoryRecordClassLabel(t, record.projectionClass)} />
                    <MetaCard label={t('sharedContext.management.memoryRecordSources')} value={record.sourceEventCount} />
                    <MetaCard label={t('sharedContext.management.memoryRecordUpdated')} value={new Date(record.updatedAt).toLocaleString()} />
                  </div>
                  {record.summary ? (
                    <MemoryRecordContent
                      id={record.id}
                      text={record.summary}
                      expanded={expandedMemoryRecordIds.has(record.id)}
                      onToggle={() => {
                        setExpandedMemoryRecordIds((current) => {
                          const next = new Set(current);
                          if (next.has(record.id)) next.delete(record.id);
                          else next.add(record.id);
                          return next;
                        });
                      }}
                      t={t}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }, [expandedMemoryRecordIds, t]);

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
    { id: 'personal' as const, label: t('sharedContext.management.memoryTabPersonal'), count: localPersonalMemory.records.length + (localPersonalMemory.pendingRecords?.length ?? 0) + cloudPersonalMemory.records.length },
    { id: 'enterprise-memory' as const, label: t('sharedContext.management.memoryTabEnterprise'), count: sharedMemory.records.length },
  ], [t, localPersonalMemory, cloudPersonalMemory, sharedMemory]);
  const memoryPersonalSubTabs = useMemo(() => [
    { id: 'unprocessed' as const, label: t('sharedContext.management.memoryTabUnprocessed'), count: localPersonalMemory.pendingRecords?.length ?? 0 },
    { id: 'processed' as const, label: t('sharedContext.management.memoryTabProcessed'), count: localPersonalMemory.records.length },
    { id: 'cloud' as const, label: t('sharedContext.management.memoryTabCloud'), count: cloudPersonalMemory.records.length },
  ], [t, localPersonalMemory, cloudPersonalMemory]);
  const memoryEnterpriseSubTabs = useMemo(() => [
    { id: 'shared-memory' as const, label: t('sharedContext.management.memoryTabSharedMemory'), count: sharedMemory.records.length },
    { id: 'authored-context' as const, label: t('sharedContext.management.memoryTabAuthoredContext') },
  ], [t]);

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
    setProcessingBackupBackend(view.snapshot.persisted.backupContextBackend ?? view.snapshot.persisted.primaryContextBackend);
    setProcessingBackupModel(view.snapshot.persisted.backupContextModel ?? '');
    setProcessingPersonalSyncEnabled(view.snapshot.persisted.enablePersonalMemorySync === true);
  }, []);

  const reloadProcessingConfig = useCallback(async () => {
    if (!serverId) {
      setProcessingSnapshot(null);
      setProcessingPrimaryBackend(DEFAULT_PRIMARY_CONTEXT_BACKEND);
      setProcessingPrimaryModel(DEFAULT_PRIMARY_CONTEXT_MODEL);
      setProcessingBackupBackend(DEFAULT_PRIMARY_CONTEXT_BACKEND);
      setProcessingBackupModel('');
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
      if (msg.type !== 'shared_context.personal_memory.response') return;
      if (msg.requestId !== personalMemoryRequestIdRef.current) return;
      setLocalPersonalMemory(normalizeMemoryView({
        stats: msg.stats,
        records: msg.records,
        pendingRecords: msg.pendingRecords ?? [],
      }));
    });
  }, [ws]);

  const loadMemoryViews = useCallback(async () => {
    setMemoryLoading(true);
    setError(null);
    try {
      const queryInput = {
        projectId: memoryProjectId.trim() || undefined,
        projectionClass: memoryProjectionClass || undefined,
        query: memoryQuery.trim() || undefined,
        limit: 25,
      };
      if (ws) {
        const requestId = crypto.randomUUID();
        personalMemoryRequestIdRef.current = requestId;
        ws.send({
          type: 'shared_context.personal_memory.query',
          requestId,
          ...queryInput,
        });
      } else {
        setLocalPersonalMemory(EMPTY_MEMORY_VIEW);
      }

      setCloudPersonalMemory(normalizeMemoryView(await getPersonalCloudMemory(queryInput)));

      if (enterpriseId) {
        setSharedMemory(normalizeMemoryView(await getEnterpriseSharedMemory(enterpriseId, {
          canonicalRepoId: memoryProjectId.trim() || undefined,
          projectionClass: memoryProjectionClass || undefined,
          query: memoryQuery.trim() || undefined,
          limit: 25,
        })));
      } else {
        setSharedMemory(EMPTY_MEMORY_VIEW);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryLoading(false);
    }
  }, [enterpriseId, memoryProjectId, memoryProjectionClass, memoryQuery, serverId, ws]);

  useEffect(() => {
    if (activeTab !== 'memory') return;
    void loadMemoryViews();
  }, [activeTab, loadMemoryViews]);

  const handleProcessingPrimaryBackendChange = useCallback((nextBackend: SharedContextRuntimeBackend) => {
    setProcessingPrimaryBackend((prevBackend) => {
      setProcessingPrimaryModel((prevModel) => resolveProcessingModelForBackend(nextBackend, prevModel, prevBackend));
      return nextBackend;
    });
  }, []);

  const handleProcessingBackupBackendChange = useCallback((nextBackend: SharedContextRuntimeBackend) => {
    setProcessingBackupBackend((prevBackend) => {
      setProcessingBackupModel((prevModel) => resolveProcessingModelForBackend(nextBackend, prevModel, prevBackend));
      return nextBackend;
    });
  }, []);

  return (
    <div style={shellStyle}>
      <div style={heroStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: DT.space.md, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: DT.space.xs, flex: '1 1 auto', minWidth: 240 }}>
            <strong style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: DT.text.primary }}>
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
          <StatCard label="Enterprise" value={team?.name ?? 'None'} detail={team ? `Role: ${team.myRole}` : 'Choose or create one'} />
          <StatCard label="Members" value={team?.members?.length ?? 0} />
          <StatCard label="Projects" value={projects.length} />
          <StatCard label="Knowledge Docs" value={documents.length} />
          <StatCard label="Server" value={formatServerScopeValue(serverId)} detail={serverId ? 'Cloud-synced runtime settings' : 'Select a server to sync processing config'} />
        </div>
        <div style={tabBarStyle}>
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
      </div>

      {activeTab === 'enterprise' && (
        <div style={splitSectionStyle}>
          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.invites')}
              description={t('sharedContext.management.inviteDescription')}
            />
            <InfoCard title={t('sharedContext.management.inviteFlowTitle')}>
              <div>New invitations create member access only.</div>
              <div>Admin role changes happen after join, from the member management section.</div>
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
                      <MetaCard label="Workspace ID" value={<code>{workspace.id}</code>} />
                      <MetaCard label="Projects" value={projects.filter((project) => project.workspaceId === workspace.id).length} />
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
            action={<span style={pillStyle}>{team?.members?.length ?? 0} active</span>}
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
                      <MetaCard label="Role" value={member.role} />
                      <MetaCard label="Joined" value={new Date(member.joined_at).toLocaleString()} />
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
                <option value="project_shared">{t('sharedContext.management.scopeProjectLabel')}</option>
                <option value="workspace_shared">{t('sharedContext.management.scopeWorkspaceLabel')}</option>
                <option value="org_shared">{t('sharedContext.management.scopeEnterpriseLabel')}</option>
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
                        <MetaCard label="Workspace" value={project.workspaceId ? (workspaceNameById.get(project.workspaceId) ?? project.workspaceId) : t('sharedContext.management.noWorkspaceAssigned')} />
                        <MetaCard label="Status" value={project.status} />
                        <MetaCard label="Scope" value={scopePresentation[project.scope as SharedScopeValue].label} />
                        <MetaCard label="Meaning" value={scopePresentation[project.scope as SharedScopeValue].description} />
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
                <option value="coding_standard">coding_standard</option>
                <option value="architecture_guideline">architecture_guideline</option>
                <option value="repo_playbook">repo_playbook</option>
                <option value="knowledge_doc">knowledge_doc</option>
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
                    <MetaCard label="Versions" value={document.versions.length} />
                    <MetaCard label="Active" value={document.versions.find((version) => version.status === 'active')?.versionNumber ? `v${document.versions.find((version) => version.status === 'active')?.versionNumber}` : 'None'} />
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
                      <MetaCard label="Document" value={binding.documentId} />
                      <MetaCard label="Version" value={binding.versionId} />
                      <MetaCard label="Language" value={binding.applicabilityLanguage || 'Any'} />
                      <MetaCard label="Path" value={binding.applicabilityPathPattern || 'Any'} />
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
                      <input
                        aria-label={t('sharedContext.management.processingPrimaryModel')}
                        list={`shared-context-model-options-${processingPrimaryBackend}`}
                        value={processingPrimaryModel}
                        onInput={(e) => setProcessingPrimaryModel((e.currentTarget as HTMLInputElement).value)}
                        placeholder={DEFAULT_PRIMARY_CONTEXT_MODEL}
                        style={processingModelInputStyle}
                      />
                      <ModelChipSelector
                        backend={processingPrimaryBackend}
                        value={processingPrimaryModel}
                        onSelect={setProcessingPrimaryModel}
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
                      <input
                        aria-label={t('sharedContext.management.processingBackupModel')}
                        list={`shared-context-model-options-${processingBackupBackend}`}
                        value={processingBackupModel}
                        onInput={(e) => setProcessingBackupModel((e.currentTarget as HTMLInputElement).value)}
                        placeholder={t('sharedContext.management.processingBackupPlaceholder')}
                        style={processingModelInputStyle}
                      />
                      <ModelChipSelector
                        backend={processingBackupBackend}
                        value={processingBackupModel}
                        onSelect={setProcessingBackupModel}
                      />
                    </label>
                  </div>
                </div>
                {SHARED_CONTEXT_RUNTIME_BACKENDS.map((backend) => (
                  <datalist id={`shared-context-model-options-${backend}`} key={backend}>
                    {(PROCESSING_MODEL_OPTIONS_BY_BACKEND[backend] ?? PROCESSING_MODEL_OPTIONS).map((modelId) => (
                      <option key={`${backend}:${modelId}`} value={modelId} />
                    ))}
                  </datalist>
                ))}
                <div style={rowStyle}>
                  <button
                    style={buttonStyle}
                    disabled={processingSaving || !processingPrimaryModel.trim()}
                    onClick={() => void handleAction(t('sharedContext.notice.processingConfigSaved'), async () => {
                      setProcessingSaving(true);
                      try {
                        const view = await updateSharedContextRuntimeConfig(serverId, {
                          primaryContextBackend: processingPrimaryBackend,
                          primaryContextModel: processingPrimaryModel.trim(),
                          backupContextBackend: processingBackupModel.trim() ? processingBackupBackend : undefined,
                          backupContextModel: processingBackupModel.trim() || undefined,
                          enablePersonalMemorySync: processingPersonalSyncEnabled,
                        });
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
              action={serverId ? <span style={pillStyle}>{formatServerScopeValue(serverId)}</span> : undefined}
            />
            {serverId ? (
              <div style={rowStyle}>
                <label style={{ ...policyOptionStyle, flex: '1 1 360px' }}>
                  <span style={{ fontWeight: 600 }}>{t('sharedContext.management.personalSyncToggle')}</span>
                  <span style={helperTextStyle}>{t('sharedContext.management.personalSyncHelp')}</span>
                  <input
                    type="checkbox"
                    checked={processingPersonalSyncEnabled}
                    onChange={(e) => setProcessingPersonalSyncEnabled((e.currentTarget as HTMLInputElement).checked)}
                  />
                </label>
                <button
                  style={buttonStyle}
                  disabled={processingSaving || !processingSnapshot}
                  onClick={() => void handleAction(t('sharedContext.notice.processingConfigSaved'), async () => {
                    setProcessingSaving(true);
                    try {
                      const view = await updateSharedContextRuntimeConfig(serverId, {
                        primaryContextBackend: processingPrimaryBackend,
                        primaryContextModel: processingPrimaryModel.trim(),
                        backupContextBackend: processingBackupModel.trim() ? processingBackupBackend : undefined,
                        backupContextModel: processingBackupModel.trim() || undefined,
                        enablePersonalMemorySync: processingPersonalSyncEnabled,
                      });
                      applyProcessingSnapshot(view);
                    } finally {
                      setProcessingSaving(false);
                    }
                  })}
                >
                  {processingSaving ? t('sharedContext.management.processingSaving') : t('sharedContext.management.personalSyncSave')}
                </button>
              </div>
            ) : (
              <div style={helperTextStyle}>{t('sharedContext.management.processingServerRequired')}</div>
            )}
          </div>

          <div style={sectionStyle}>
            <SectionHeading
              title={t('sharedContext.management.memoryQueryTitle')}
              description={t('sharedContext.management.memoryQueryDescription')}
              action={<button style={buttonStyle} onClick={() => void loadMemoryViews()}>{t('sharedContext.refresh')}</button>}
            />
            <div style={rowStyle}>
              <input
                value={memoryProjectId}
                onInput={(e) => setMemoryProjectId((e.currentTarget as HTMLInputElement).value)}
                placeholder={t('sharedContext.management.memoryProjectPlaceholder')}
                style={inputStyle}
              />
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
                <div style={statGridStyle}>
                  <StatCard label={t('sharedContext.management.memoryStatTotal')} value={localPersonalMemory.stats.totalRecords} />
                  <StatCard label={t('sharedContext.management.memoryStatHits')} value={localPersonalMemory.stats.matchedRecords} />
                  <StatCard label={t('sharedContext.management.memoryStatRecent')} value={localPersonalMemory.stats.recentSummaryCount} />
                  <StatCard
                    label={t('sharedContext.management.memoryStatDurable')}
                    value={localPersonalMemory.stats.durableCandidateCount}
                    detail={`${t('sharedContext.management.memoryStatProjects')}: ${localPersonalMemory.stats.projectCount}`}
                  />
                </div>
                {localPersonalMemory.records.length > 0
                  ? renderProcessedMemoryRecords(localPersonalMemory)
                  : <div style={helperTextStyle}>{t('sharedContext.management.memoryProcessedEmptyPending')}</div>}
              </div>
            ) : null}

            {memoryTopTab === 'personal' && memoryPersonalSubTab === 'unprocessed' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SectionHeading
                  title={t('sharedContext.management.memoryPendingTitle')}
                  description={t('sharedContext.management.memoryPendingDescription')}
                  action={<span style={pillStyle}>{localPersonalMemory.pendingRecords?.length ?? 0}</span>}
                />
                <div style={statGridStyle}>
                  <StatCard label={t('sharedContext.management.memoryStatPending')} value={localPersonalMemory.stats.stagedEventCount} />
                  <StatCard label={t('sharedContext.management.memoryStatDirtyTargets')} value={localPersonalMemory.stats.dirtyTargetCount} />
                  <StatCard label={t('sharedContext.management.memoryStatPendingJobs')} value={localPersonalMemory.stats.pendingJobCount} />
                </div>
                {localPersonalMemory.pendingRecords && localPersonalMemory.pendingRecords.length > 0 ? (
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
                          onToggle={() => {
                            setExpandedMemoryRecordIds((current) => {
                              const next = new Set(current);
                              const key = `pending-${record.id}`;
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            });
                          }}
                          t={t}
                        />
                      </div>
                    ))}
                  </div>
                ) : <div style={helperTextStyle}>{t('sharedContext.empty')}</div>}
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
                  <StatCard label={t('sharedContext.management.memoryStatHits')} value={cloudPersonalMemory.stats.matchedRecords} />
                  <StatCard label={t('sharedContext.management.memoryStatRecent')} value={cloudPersonalMemory.stats.recentSummaryCount} />
                  <StatCard
                    label={t('sharedContext.management.memoryStatDurable')}
                    value={cloudPersonalMemory.stats.durableCandidateCount}
                    detail={`${t('sharedContext.management.memoryStatProjects')}: ${cloudPersonalMemory.stats.projectCount}`}
                  />
                </div>
                {renderProcessedMemoryRecords(cloudPersonalMemory)}
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
                  <StatCard label={t('sharedContext.management.memoryStatHits')} value={sharedMemory.stats.matchedRecords} />
                  <StatCard label={t('sharedContext.management.memoryStatRecent')} value={sharedMemory.stats.recentSummaryCount} />
                  <StatCard
                    label={t('sharedContext.management.memoryStatDurable')}
                    value={sharedMemory.stats.durableCandidateCount}
                    detail={`${t('sharedContext.management.memoryStatProjects')}: ${sharedMemory.stats.projectCount}`}
                  />
                </div>
                {renderProcessedMemoryRecords(sharedMemory)}
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

function MemoryRecordContent({
  id,
  text,
  expanded,
  onToggle,
  t,
}: {
  id: string;
  text: string;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}) {
  const collapsible = shouldCollapseMemoryContent(text);
  const showExpanded = expanded || !collapsible;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        data-testid={`memory-record-content-${id}`}
        style={showExpanded ? memoryContentExpandedStyle : memoryContentCollapsedStyle}
      >
        <ChatMarkdown text={text} />
      </div>
      {collapsible ? (
        <div>
          <button type="button" style={subtleButtonStyle} onClick={onToggle}>
            {expanded ? t('sharedContext.management.memoryCollapse') : t('sharedContext.management.memoryExpand')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
