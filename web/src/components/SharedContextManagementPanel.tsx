import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from '@shared/context-model-defaults.js';
import type { SharedContextRuntimeBackend } from '@shared/context-types.js';
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
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS } from '../../../src/shared/models/options.js';

const sectionStyle = {
  border: '1px solid #334155',
  borderRadius: 8,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
} as const;

const rowStyle = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'center',
} as const;

const inputStyle = {
  flex: '1 1 180px',
  minWidth: 0,
  background: '#0f172a',
  color: '#e2e8f0',
  border: '1px solid #334155',
  borderRadius: 6,
  padding: '6px 8px',
} as const;

const buttonStyle = {
  background: '#1d4ed8',
  color: '#eff6ff',
  border: 'none',
  borderRadius: 6,
  padding: '6px 10px',
  cursor: 'pointer',
} as const;

const subtleButtonStyle = {
  ...buttonStyle,
  background: '#334155',
  color: '#e2e8f0',
} as const;

const tabStyle = {
  ...subtleButtonStyle,
  padding: '8px 12px',
  fontWeight: 600,
} as const;

const tabActiveStyle = {
  ...buttonStyle,
  padding: '8px 12px',
  fontWeight: 600,
} as const;

const pillStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  borderRadius: 999,
  background: '#0f172a',
  border: '1px solid #334155',
  color: '#cbd5e1',
  fontSize: 12,
} as const;

const checkboxRowStyle = {
  ...rowStyle,
  alignItems: 'flex-start',
} as const;

const policyOptionStyle = {
  flex: '1 1 260px',
  minWidth: 240,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid #334155',
  background: '#0f172a',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
} as const;

const fieldLabelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  color: '#cbd5e1',
  fontSize: 13,
} as const;

const fieldInputStyle = {
  ...inputStyle,
  width: '100%',
} as const;

const processingGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 12,
  alignItems: 'start',
} as const;

const processingCardStyle = {
  border: '1px solid #334155',
  borderRadius: 12,
  padding: 12,
  background: '#0f172a',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
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

type KindOption = SharedDocument['kind'];
type ManagementTab = 'enterprise' | 'members' | 'projects' | 'knowledge' | 'processing';

interface Props {
  enterpriseId?: string;
  serverId?: string;
  onEnterpriseChange?: (enterpriseId: string) => void;
}

interface TabDef {
  id: ManagementTab;
  label: string;
}

function InfoCard(props: { title: string; children: ComponentChildren }) {
  return (
    <div style={{ ...sectionStyle, background: '#111827' }}>
      <strong>{props.title}</strong>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, color: '#cbd5e1', fontSize: 13, lineHeight: 1.5 }}>
        {props.children}
      </div>
    </div>
  );
}

function LabeledValue({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ color: '#94a3b8' }}>{label}</span>
      <code style={{ color: '#e2e8f0' }}>{value}</code>
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

export function SharedContextManagementPanel({ enterpriseId: initialEnterpriseId, serverId, onEnterpriseChange }: Props) {
  const { t } = useTranslation();
  const onEnterpriseChangeRef = useRef(onEnterpriseChange);
  onEnterpriseChangeRef.current = onEnterpriseChange;

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
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [inviteEmail, setInviteEmail] = useState('');
  const [lastInviteToken, setLastInviteToken] = useState<string | null>(null);
  const [joinToken, setJoinToken] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [canonicalRepoId, setCanonicalRepoId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [scope, setScope] = useState<'project_shared' | 'workspace_shared' | 'org_shared'>('project_shared');
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

  const tabs = useMemo<TabDef[]>(() => [
    { id: 'enterprise', label: t('sharedContext.management.tabs.enterprise') },
    { id: 'members', label: t('sharedContext.management.tabs.members') },
    { id: 'projects', label: t('sharedContext.management.tabs.projects') },
    { id: 'knowledge', label: t('sharedContext.management.tabs.knowledge') },
    { id: 'processing', label: t('sharedContext.management.tabs.processing') },
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
  }, []);

  const reloadProcessingConfig = useCallback(async () => {
    if (!serverId) {
      setProcessingSnapshot(null);
      setProcessingPrimaryBackend(DEFAULT_PRIMARY_CONTEXT_BACKEND);
      setProcessingPrimaryModel(DEFAULT_PRIMARY_CONTEXT_MODEL);
      setProcessingBackupBackend(DEFAULT_PRIMARY_CONTEXT_BACKEND);
      setProcessingBackupModel('');
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
    if (activeTab !== 'processing') return;
    void reloadProcessingConfig();
  }, [activeTab, reloadProcessingConfig]);

  const handleProcessingPrimaryBackendChange = useCallback((nextBackend: SharedContextRuntimeBackend) => {
    setProcessingPrimaryBackend((prevBackend) => {
      setProcessingPrimaryModel((prevModel) => resolveProcessingModelForBackend(nextBackend, prevModel, prevBackend));
      return nextBackend;
    });
  }, []);

  const handleProcessingBackupBackendChange = useCallback((nextBackend: SharedContextRuntimeBackend) => {
    setProcessingBackupBackend((prevBackend) => {
      setProcessingBackupModel((prevModel) => {
        if (!prevModel.trim()) return '';
        return resolveProcessingModelForBackend(nextBackend, prevModel, prevBackend);
      });
      return nextBackend;
    });
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 8, color: '#e2e8f0', overflow: 'auto' }}>
      <div style={sectionStyle}>
        <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
          <strong>{t('sharedContext.management.title')}</strong>
          <button style={subtleButtonStyle} onClick={() => void refreshEnterpriseData()}>{t('sharedContext.refresh')}</button>
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
        <div style={{ ...rowStyle, gap: 6 }}>
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
        {loading && <div>{t('sharedContext.loading')}</div>}
        {error && <div style={{ color: '#fca5a5' }}>{error}</div>}
        {notice && <div style={{ color: '#86efac' }}>{notice}</div>}
      </div>

      {activeTab === 'enterprise' && (
        <>
          <div style={sectionStyle}>
            <strong>{t('sharedContext.management.invites')}</strong>
            <div style={rowStyle}>
              <select value={inviteRole} onChange={(e) => setInviteRole((e.currentTarget as HTMLSelectElement).value as 'member' | 'admin')} style={inputStyle}>
                <option value="member">{t('sharedContext.roles.member')}</option>
                <option value="admin">{t('sharedContext.roles.admin')}</option>
              </select>
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
                  const created = await createTeamInvite(enterpriseId, inviteRole, inviteEmail.trim() || undefined);
                  setLastInviteToken(created.token);
                })}
              >
                {t('sharedContext.management.createInvite')}
              </button>
            </div>
            {lastInviteToken && <div>{t('sharedContext.management.inviteToken')}: <code>{lastInviteToken}</code></div>}
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
            <strong>{t('sharedContext.management.workspaces')}</strong>
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
            {workspaces.length > 0 ? workspaces.map((workspace) => <div key={workspace.id}>{workspace.name} · <code>{workspace.id}</code></div>) : <div>{t('sharedContext.empty')}</div>}
          </div>
        </>
      )}

      {activeTab === 'members' && (
        <div style={sectionStyle}>
          <strong>{t('sharedContext.management.members')}</strong>
          {team?.members?.length ? team.members.map((member) => (
            <div key={member.user_id} style={{ ...rowStyle, justifyContent: 'space-between' }}>
              <span>{formatMemberIdentity(member)} · {member.role}</span>
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
          )) : <div>{t('sharedContext.empty')}</div>}
        </div>
      )}

      {activeTab === 'projects' && (
        <>
          <InfoCard title={t('sharedContext.management.projectRelationshipTitle')}>
            <div>{t('sharedContext.management.projectRelationshipLine1')}</div>
            <div>{t('sharedContext.management.projectRelationshipLine2')}</div>
            <div>{t('sharedContext.management.projectRelationshipLine3')}</div>
          </InfoCard>

          <div style={sectionStyle}>
            <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
              <strong>{t('sharedContext.management.projects')}</strong>
              {selectedProject && (
                <span style={pillStyle}>
                  {selectedProject.displayName ?? selectedProject.canonicalRepoId} · {selectedProject.status}
                </span>
              )}
            </div>
            <div style={rowStyle}>
              <input value={canonicalRepoId} onInput={(e) => setCanonicalRepoId((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.canonicalRepoId')} style={inputStyle} />
              <input value={displayName} onInput={(e) => setDisplayName((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.displayName')} style={inputStyle} />
              <select value={scope} onChange={(e) => setScope((e.currentTarget as HTMLSelectElement).value as typeof scope)} style={inputStyle}>
                <option value="project_shared">project_shared</option>
                <option value="workspace_shared">workspace_shared</option>
                <option value="org_shared">org_shared</option>
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
            {projects.map((project) => (
              <div key={project.id} style={{ ...rowStyle, justifyContent: 'space-between' }}>
                <span>
                  {project.displayName ?? project.canonicalRepoId}
                  {' · '}
                  {project.scope}
                  {' · '}
                  {project.workspaceId ? `${t('sharedContext.management.workspaceLabel')}: ${workspaceNameById.get(project.workspaceId) ?? project.workspaceId}` : t('sharedContext.management.noWorkspaceAssigned')}
                  {' · '}
                  {project.status}
                </span>
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
            ))}
          </div>

          <div style={sectionStyle}>
            <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
              <strong>{t('sharedContext.management.policyTitle')}</strong>
              {policyLoading && <span style={{ color: '#94a3b8' }}>{t('sharedContext.management.policyLoading')}</span>}
            </div>
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
        </>
      )}

      {activeTab === 'knowledge' && (
        <>
          <div style={sectionStyle}>
            <strong>{t('sharedContext.management.documents')}</strong>
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
            {documents.map((document) => (
              <div key={document.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div>{document.title} · {document.kind}</div>
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

          <div style={sectionStyle}>
            <strong>{t('sharedContext.management.bindings')}</strong>
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
            {bindings.length > 0 ? bindings.map((binding) => (
              <div key={binding.id}>{binding.mode} · {binding.documentId} · {binding.versionId} · {binding.status}</div>
            )) : <div>{t('sharedContext.empty')}</div>}
          </div>
        </>
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
                        style={fieldInputStyle}
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
                        style={fieldInputStyle}
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
    </div>
  );
}
