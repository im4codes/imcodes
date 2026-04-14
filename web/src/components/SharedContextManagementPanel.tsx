import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  createSharedDocument,
  createSharedDocumentBinding,
  createSharedDocumentVersion,
  createSharedWorkspace,
  createTeam,
  createTeamInvite,
  activateSharedDocumentVersion,
  enrollSharedProject,
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
  type SharedDocument,
  type SharedDocumentBinding,
  type SharedProject,
  type SharedWorkspace,
  type TeamDetail,
  type TeamSummary,
  updateSharedProjectPolicy,
  updateTeamMemberRole,
} from '../api.js';

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

type KindOption = SharedDocument['kind'];

interface Props {
  enterpriseId?: string;
  onEnterpriseChange?: (enterpriseId: string) => void;
}

export function SharedContextManagementPanel({ enterpriseId: initialEnterpriseId, onEnterpriseChange }: Props) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [enterpriseId, setEnterpriseId] = useState(initialEnterpriseId ?? '');
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [workspaces, setWorkspaces] = useState<SharedWorkspace[]>([]);
  const [projects, setProjects] = useState<SharedProject[]>([]);
  const [documents, setDocuments] = useState<SharedDocument[]>([]);
  const [bindings, setBindings] = useState<SharedDocumentBinding[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
  const [policy, setPolicy] = useState({
    allowDegradedProviderSupport: true,
    allowLocalFallback: false,
    requireFullProviderSupport: false,
  });
  const [documentKind, setDocumentKind] = useState<KindOption>('coding_standard');
  const [documentTitle, setDocumentTitle] = useState('');
  const [selectedDocumentId, setSelectedDocumentId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [documentContent, setDocumentContent] = useState('');
  const [bindingMode, setBindingMode] = useState<'required' | 'advisory'>('required');
  const [bindingLanguage, setBindingLanguage] = useState('');
  const [bindingPathPattern, setBindingPathPattern] = useState('');

  const selectedDocument = useMemo(
    () => documents.find((entry) => entry.id === selectedDocumentId) ?? null,
    [documents, selectedDocumentId],
  );

  const refreshEnterpriseData = useCallback(async (nextEnterpriseId = enterpriseId) => {
    if (!nextEnterpriseId) {
      setTeam(null);
      setWorkspaces([]);
      setProjects([]);
      setDocuments([]);
      setBindings([]);
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
      if (!selectedWorkspaceId && nextWorkspaces[0]) setSelectedWorkspaceId(nextWorkspaces[0].id);
      if (!selectedEnrollmentId && nextProjects[0]) setSelectedEnrollmentId(nextProjects[0].id);
      if (!selectedDocumentId && nextDocuments[0]) {
        setSelectedDocumentId(nextDocuments[0].id);
        if (nextDocuments[0].versions[0]) setSelectedVersionId(nextDocuments[0].versions[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [enterpriseId, selectedDocumentId, selectedEnrollmentId, selectedWorkspaceId]);

  useEffect(() => {
    void listTeams()
      .then((nextTeams) => {
        setTeams(nextTeams);
        if (!enterpriseId && nextTeams[0]) {
          setEnterpriseId(nextTeams[0].id);
          onEnterpriseChange?.(nextTeams[0].id);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!enterpriseId) return;
    onEnterpriseChange?.(enterpriseId);
    void refreshEnterpriseData(enterpriseId);
  }, [enterpriseId, onEnterpriseChange, refreshEnterpriseData]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 8, color: '#e2e8f0', overflow: 'auto' }}>
      <div style={sectionStyle}>
        <div style={rowStyle}>
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
        {loading && <div>{t('sharedContext.loading')}</div>}
        {error && <div style={{ color: '#fca5a5' }}>{error}</div>}
        {notice && <div style={{ color: '#86efac' }}>{notice}</div>}
      </div>

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
        <strong>{t('sharedContext.management.members')}</strong>
        {team?.members?.length ? team.members.map((member) => (
          <div key={member.user_id} style={{ ...rowStyle, justifyContent: 'space-between' }}>
            <span>{member.user_id} · {member.role}</span>
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
        {workspaces.map((workspace) => <div key={workspace.id}>{workspace.name} · <code>{workspace.id}</code></div>)}
      </div>

      <div style={sectionStyle}>
        <strong>{t('sharedContext.management.projects')}</strong>
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
            <span>{project.displayName ?? project.canonicalRepoId} · {project.scope} · {project.status}</span>
            <div style={rowStyle}>
              <button
                style={subtleButtonStyle}
                onClick={() => {
                  setSelectedEnrollmentId(project.id);
                  setPolicy({
                    allowDegradedProviderSupport: true,
                    allowLocalFallback: false,
                    requireFullProviderSupport: false,
                  });
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
        <div style={rowStyle}>
          <select value={selectedEnrollmentId} onChange={(e) => setSelectedEnrollmentId((e.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
            <option value="">{t('sharedContext.management.selectProject')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.displayName ?? project.canonicalRepoId}</option>)}
          </select>
          <label><input type="checkbox" checked={policy.allowDegradedProviderSupport} onChange={(e) => setPolicy((prev) => ({ ...prev, allowDegradedProviderSupport: (e.currentTarget as HTMLInputElement).checked }))} /> {t('sharedContext.management.allowDegraded')}</label>
          <label><input type="checkbox" checked={policy.allowLocalFallback} onChange={(e) => setPolicy((prev) => ({ ...prev, allowLocalFallback: (e.currentTarget as HTMLInputElement).checked }))} /> {t('sharedContext.management.allowLocalFallback')}</label>
          <label><input type="checkbox" checked={policy.requireFullProviderSupport} onChange={(e) => setPolicy((prev) => ({ ...prev, requireFullProviderSupport: (e.currentTarget as HTMLInputElement).checked }))} /> {t('sharedContext.management.requireFullSupport')}</label>
          <button
            style={buttonStyle}
            disabled={!selectedEnrollmentId}
            onClick={() => void handleAction(t('sharedContext.notice.policySaved'), async () => {
              await updateSharedProjectPolicy(selectedEnrollmentId, policy);
              await refreshEnterpriseData();
            })}
          >
            {t('sharedContext.management.savePolicy')}
          </button>
        </div>
      </div>

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
        {bindings.map((binding) => (
          <div key={binding.id}>{binding.mode} · {binding.documentId} · {binding.versionId} · {binding.status}</div>
        ))}
      </div>
    </div>
  );
}
