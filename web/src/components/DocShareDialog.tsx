import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  browseExternalDocShare,
  browseSharedDocFolder,
  buildDocAuthRelayUrl,
  createDocumentShareApi,
  createSharedDocItem,
  listDocsSharedWithMe,
  listDocumentShares,
  redeemMagicInviteDocShare,
  revokeDocumentShareApi,
  updateDocumentShareApi,
  verifyExternalDocShare,
  type DocShareBrowseEntry,
  type DocShareRole,
  type DocShareTargetKind,
  type DocumentShareItem,
  type ExternalShareView,
  type ServerDocGroup,
  type SharedWithMeDocItem,
} from '../api.js';
import OfficePreview from './OfficePreview.js';

export interface DocShareDialogProps {
  serverId: string;
  targetPath: string;
  targetKind: DocShareTargetKind;
  onClose: () => void;
  onOpenNodeGroups?: () => void;
}

function guessMimeTypeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.md')) return 'text/markdown';
  return 'application/octet-stream';
}

export function DocShareDialog({
  serverId,
  targetPath,
  targetKind,
  onClose,
  onOpenNodeGroups,
}: DocShareDialogProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'internal' | 'external' | 'relay'>('internal');
  const [shares, setShares] = useState<DocumentShareItem[]>([]);
  const [groups, setGroups] = useState<ServerDocGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tab 1: Controlled Node Group & Internal User state
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [teamRole, setTeamRole] = useState<DocShareRole>('viewer');
  const [teamAllowDownload, setTeamAllowDownload] = useState(true);
  const [targetUsername, setTargetUsername] = useState('');
  const [internalRole, setInternalRole] = useState<DocShareRole>('viewer');
  const [internalAllowDownload, setInternalAllowDownload] = useState(true);

  // Tab 2: External Link / Magic Link state
  const [participantLabel, setParticipantLabel] = useState('');
  const [externalMode, setExternalMode] = useState<'external_link' | 'magic_invite'>('external_link');
  const [externalRole, setExternalRole] = useState<DocShareRole>('editor');
  const [externalAllowDownload, setExternalAllowDownload] = useState(true);
  const [accessCode, setAccessCode] = useState('');
  const [deviceLockEnabled, setDeviceLockEnabled] = useState(true);
  const [generatedLink, setGeneratedLink] = useState<{ url: string; label: string; mode: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Guards async responses across serverId/targetPath switches and unmount/close so late responses never pollute new state.
  const activeTargetRef = useRef({
    serverId,
    targetPath,
    seq: 0,
    mounted: true,
  });

  useEffect(() => {
    return () => {
      activeTargetRef.current.mounted = false;
      activeTargetRef.current.seq += 1;
    };
  }, []);

  const isCurrentTarget = useCallback((seq: number, reqServerId: string, reqPath: string): boolean => {
    const cur = activeTargetRef.current;
    return cur.mounted && cur.seq === seq && cur.serverId === reqServerId && cur.targetPath === reqPath;
  }, []);

  const loadShares = useCallback(async () => {
    const reqServerId = serverId;
    const reqPath = targetPath;
    const seq = activeTargetRef.current.seq;
    setLoading(true);
    setError(null);
    try {
      const res = await listDocumentShares(reqServerId, reqPath);
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      const nextShares = Array.isArray(res.shares) ? res.shares : [];
      const nextGroups = Array.isArray(res.groups) ? res.groups : [];
      setShares(nextShares);
      setGroups(nextGroups);
      setSelectedTeamId((prev) => {
        if (prev && nextGroups.some((g) => g.id === prev)) return prev;
        const firstBound = nextGroups.find((g) => g.boundToServer);
        return firstBound?.id ?? nextGroups[0]?.id ?? '';
      });
    } catch (err) {
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrentTarget(seq, reqServerId, reqPath)) {
        setLoading(false);
      }
    }
  }, [serverId, targetPath, isCurrentTarget]);

  useEffect(() => {
    activeTargetRef.current.serverId = serverId;
    activeTargetRef.current.targetPath = targetPath;
    activeTargetRef.current.seq += 1;
    setShares([]);
    setGroups([]);
    setSelectedTeamId('');
    setTeamRole('viewer');
    setTeamAllowDownload(true);
    setError(null);
    setGeneratedLink(null);
    void loadShares();
  }, [serverId, targetPath, loadShares]);

  const boundGroups = groups.filter((g) => g.boundToServer);
  const selectedGroup = groups.find((g) => g.id === selectedTeamId) ?? null;
  const groupNameById = new Map(groups.map((g) => [g.id, g.name]));
  const teamGroupShares = shares.filter(
    (s) =>
      !s.revokedAt &&
      (s.shareMode === 'team' || s.targetUserId === '*' || s.targetUserId.startsWith('team:')),
  );
  const internalUserShares = shares.filter(
    (s) =>
      !s.revokedAt &&
      s.shareMode === 'user' &&
      s.targetUserId !== '*' &&
      !s.targetUserId.startsWith('team:'),
  );
  const externalShares = shares.filter(
    (s) => (s.shareMode === 'external_link' || s.shareMode === 'magic_invite') && !s.revokedAt,
  );

  const handleAddTeamGroupShare = async (e: Event) => {
    e.preventDefault();
    if (!selectedTeamId) return;
    const reqServerId = serverId;
    const reqPath = targetPath;
    const seq = activeTargetRef.current.seq;
    setError(null);
    try {
      await createDocumentShareApi(reqServerId, {
        targetKind,
        targetPath: reqPath,
        shareMode: 'team',
        targetTeamId: selectedTeamId,
        role: teamRole,
        allowDownload: teamAllowDownload,
      });
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      await loadShares();
    } catch (err) {
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddInternalUser = async (e: Event) => {
    e.preventDefault();
    if (!targetUsername.trim()) return;
    const reqServerId = serverId;
    const reqPath = targetPath;
    const seq = activeTargetRef.current.seq;
    setError(null);
    try {
      await createDocumentShareApi(reqServerId, {
        targetKind,
        targetPath: reqPath,
        shareMode: 'user',
        targetUser: targetUsername.trim(),
        role: internalRole,
        allowDownload: internalAllowDownload,
      });
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      setTargetUsername('');
      await loadShares();
    } catch (err) {
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateExternalShare = async (e: Event) => {
    e.preventDefault();
    const reqServerId = serverId;
    const reqPath = targetPath;
    const seq = activeTargetRef.current.seq;
    setError(null);
    try {
      const res = await createDocumentShareApi(reqServerId, {
        targetKind,
        targetPath: reqPath,
        shareMode: externalMode,
        participantLabel: participantLabel.trim() || undefined,
        accessCode: accessCode.trim() || undefined,
        deviceLockEnabled: externalMode === 'external_link' ? deviceLockEnabled : false,
        role: externalRole,
        allowDownload: externalAllowDownload,
      });
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      if (res.sharePath || res.shareUrl) {
        const fullUrl =
          res.shareUrl ||
          (typeof window !== 'undefined' ? `${window.location.origin}${res.sharePath}` : res.sharePath!);
        setGeneratedLink({
          url: fullUrl,
          label: participantLabel.trim() || t('doc_share.external_collaborator'),
          mode: externalMode,
        });
      }
      setParticipantLabel('');
      setAccessCode('');
      await loadShares();
    } catch (err) {
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpdateShare = async (
    shareId: string,
    patch: { role?: DocShareRole; allowDownload?: boolean; resetDeviceLock?: boolean },
  ) => {
    const reqServerId = serverId;
    const reqPath = targetPath;
    const seq = activeTargetRef.current.seq;
    setError(null);
    try {
      await updateDocumentShareApi(reqServerId, shareId, patch);
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      await loadShares();
    } catch (err) {
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevokeShare = async (shareId: string) => {
    const reqServerId = serverId;
    const reqPath = targetPath;
    const seq = activeTargetRef.current.seq;
    setError(null);
    try {
      await revokeDocumentShareApi(reqServerId, shareId);
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      await loadShares();
    } catch (err) {
      if (!isCurrentTarget(seq, reqServerId, reqPath)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyText = async (text: string, id: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Ignore clipboard failures in headless test environments
    }
  };

  return (
    <div
      data-testid="doc-share-dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(2, 6, 23, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 680,
          maxHeight: '88vh',
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: 10,
          color: '#e2e8f0',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid #1e293b',
            background: '#1e293b',
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {targetKind === 'folder'
                ? t('doc_share.dialog_title_folder')
                : t('doc_share.dialog_title_file')}
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, wordBreak: 'break-all' }}>
              {targetPath}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: 18,
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid #1e293b',
            background: '#0f172a',
            padding: '0 12px',
          }}
        >
          <button
            type="button"
            data-testid="doc-share-tab-internal"
            onClick={() => setActiveTab('internal')}
            style={{
              padding: '10px 14px',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'internal' ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === 'internal' ? '#60a5fa' : '#94a3b8',
              fontWeight: activeTab === 'internal' ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('doc_share.tab_team')}
          </button>
          <button
            type="button"
            data-testid="doc-share-tab-external"
            onClick={() => setActiveTab('external')}
            style={{
              padding: '10px 14px',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'external' ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === 'external' ? '#60a5fa' : '#94a3b8',
              fontWeight: activeTab === 'external' ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('doc_share.tab_external')}
          </button>
          <button
            type="button"
            data-testid="doc-share-tab-relay"
            onClick={() => setActiveTab('relay')}
            style={{
              padding: '10px 14px',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'relay' ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === 'relay' ? '#60a5fa' : '#94a3b8',
              fontWeight: activeTab === 'relay' ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('doc_share.tab_relay')}
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: 18, overflowY: 'auto', flex: 1, fontSize: 13 }}>
          {error && (
            <div
              style={{
                padding: '8px 12px',
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid #ef4444',
                borderRadius: 6,
                color: '#fca5a5',
                marginBottom: 12,
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {activeTab === 'internal' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Controlled Node Group Sharing */}
              <div
                style={{
                  padding: 12,
                  background: '#1e293b',
                  borderRadius: 8,
                  border: '1px solid #334155',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontWeight: 600 }}>
                      {t('doc_share.group_share_title')}
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, lineHeight: 1.5 }}>
                      {t('doc_share.group_share_desc')}
                    </div>
                  </div>
                  {onOpenNodeGroups && (
                    <button
                      type="button"
                      data-testid="doc-share-open-node-groups-btn"
                      onClick={() => {
                        onClose();
                        onOpenNodeGroups();
                      }}
                      style={{
                        padding: '5px 10px',
                        background: '#334155',
                        color: '#e2e8f0',
                        border: '1px solid #475569',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t('doc_share.manage_node_groups_btn')}
                    </button>
                  )}
                </div>

                {/* Bound group badges */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
                  <span style={{ color: '#94a3b8' }}>{t('doc_share.bound_groups_label')}</span>
                  {boundGroups.length > 0 ? (
                    boundGroups.map((g) => (
                      <span
                        key={g.id}
                        data-testid="doc-share-bound-group-badge"
                        style={{
                          padding: '2px 8px',
                          borderRadius: 999,
                          background: 'rgba(37, 99, 235, 0.18)',
                          border: '1px solid #3b82f6',
                          color: '#93c5fd',
                          fontSize: 11,
                          fontWeight: 500,
                        }}
                      >
                        {g.name} ({t('doc_share.group_member_count', { count: g.memberCount })})
                      </span>
                    ))
                  ) : (
                    <span data-testid="doc-share-no-bound-groups" style={{ color: '#cbd5e1', fontSize: 12 }}>
                      {t('doc_share.no_bound_groups_hint')}
                    </span>
                  )}
                </div>

                {groups.length === 0 ? (
                  <div
                    data-testid="doc-share-no-groups-empty"
                    style={{
                      padding: '8px 10px',
                      background: '#0f172a',
                      borderRadius: 6,
                      border: '1px dashed #475569',
                      color: '#94a3b8',
                      fontSize: 12,
                    }}
                  >
                    {t('doc_share.no_groups_available')}
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => void handleAddTeamGroupShare(e)}
                    style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <select
                        data-testid="doc-share-group-select"
                        aria-label={t('doc_share.group_select_label')}
                        value={selectedTeamId}
                        onChange={(e) => setSelectedTeamId((e.target as HTMLSelectElement).value)}
                        style={{
                          flex: 1,
                          minWidth: 180,
                          padding: '6px 8px',
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid #475569',
                          borderRadius: 4,
                          fontSize: 12,
                        }}
                      >
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.boundToServer
                              ? t('doc_share.group_option_bound', { name: g.name, count: g.memberCount })
                              : t('doc_share.group_option_unbound', { name: g.name, count: g.memberCount })}
                          </option>
                        ))}
                      </select>
                      <select
                        data-testid="doc-share-group-role"
                        value={teamRole}
                        onChange={(e) => setTeamRole((e.target as HTMLSelectElement).value as DocShareRole)}
                        style={{
                          padding: '6px 8px',
                          background: '#0f172a',
                          color: '#e2e8f0',
                          border: '1px solid #475569',
                          borderRadius: 4,
                          fontSize: 12,
                        }}
                      >
                        <option value="viewer">{t('doc_share.role_viewer')}</option>
                        <option value="editor">{t('doc_share.role_editor')}</option>
                      </select>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          data-testid="doc-share-group-download"
                          checked={teamAllowDownload}
                          onChange={(e) => setTeamAllowDownload((e.target as HTMLInputElement).checked)}
                        />
                        {t('doc_share.allow_download')}
                      </label>
                      <button
                        type="submit"
                        data-testid="doc-share-add-group-btn"
                        disabled={!selectedTeamId}
                        style={{
                          padding: '6px 14px',
                          background: '#2563eb',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 4,
                          cursor: selectedTeamId ? 'pointer' : 'not-allowed',
                          fontSize: 12,
                        }}
                      >
                        {t('doc_share.add_group_share_btn')}
                      </button>
                    </div>
                    {selectedGroup && !selectedGroup.boundToServer && (
                      <div data-testid="doc-share-unbound-group-hint" style={{ fontSize: 11, color: '#fbbf24' }}>
                        {t('doc_share.unbound_group_hint')}
                      </div>
                    )}
                  </form>
                )}

                {/* Active group & legacy wildcard rules */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid #334155', paddingTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>
                    {t('doc_share.active_group_shares_title')} ({teamGroupShares.length})
                  </div>
                  {teamGroupShares.length === 0 ? (
                    <div style={{ color: '#64748b', fontSize: 12 }}>
                      {t('doc_share.no_group_shares_yet')}
                    </div>
                  ) : (
                    teamGroupShares.map((item) => {
                      const teamId =
                        item.targetTeamId ??
                        (item.targetUserId.startsWith('team:') ? item.targetUserId.slice(5) : null);
                      const displayGroupLabel = teamId
                        ? `${t('doc_share.group_badge_prefix')}: ${item.targetTeamName || groupNameById.get(teamId) || teamId}`
                        : t('doc_share.legacy_all_members');
                      return (
                        <div
                          key={item.id}
                          data-testid="doc-share-group-rule-item"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            background: '#0f172a',
                            borderRadius: 6,
                            border: '1px solid #334155',
                            gap: 8,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span style={{ fontWeight: 600, color: '#e2e8f0' }}>
                            {displayGroupLabel}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <select
                              value={item.role}
                              onChange={(e) =>
                                void handleUpdateShare(item.id, {
                                  role: (e.target as HTMLSelectElement).value as DocShareRole,
                                })
                              }
                              style={{
                                padding: '4px 8px',
                                background: '#1e293b',
                                color: '#e2e8f0',
                                border: '1px solid #475569',
                                borderRadius: 4,
                                fontSize: 12,
                              }}
                            >
                              <option value="viewer">{t('doc_share.role_viewer')}</option>
                              <option value="editor">{t('doc_share.role_editor')}</option>
                            </select>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                              <input
                                type="checkbox"
                                checked={item.allowDownload}
                                onChange={(e) =>
                                  void handleUpdateShare(item.id, {
                                    allowDownload: (e.target as HTMLInputElement).checked,
                                  })
                                }
                              />
                              {t('doc_share.allow_download')}
                            </label>
                            <button
                              type="button"
                              onClick={() => void handleRevokeShare(item.id)}
                              style={{
                                padding: '4px 10px',
                                background: '#7f1d1d',
                                color: '#fecaca',
                                border: 'none',
                                borderRadius: 4,
                                cursor: 'pointer',
                                fontSize: 11,
                              }}
                            >
                              {t('doc_share.revoke')}
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Add Specific Member */}
              <form
                onSubmit={(e) => void handleAddInternalUser(e)}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: 12,
                  background: '#1e293b',
                  borderRadius: 8,
                  border: '1px solid #334155',
                }}
              >
                <input
                  type="text"
                  data-testid="doc-share-username-input"
                  value={targetUsername}
                  onInput={(e) => setTargetUsername((e.target as HTMLInputElement).value)}
                  placeholder={t('doc_share.member_placeholder')}
                  style={{
                    flex: 1,
                    minWidth: 160,
                    padding: '6px 10px',
                    background: '#0f172a',
                    color: '#e2e8f0',
                    border: '1px solid #475569',
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                />
                <select
                  value={internalRole}
                  onChange={(e) => setInternalRole((e.target as HTMLSelectElement).value as DocShareRole)}
                  style={{
                    padding: '6px 8px',
                    background: '#0f172a',
                    color: '#e2e8f0',
                    border: '1px solid #475569',
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  <option value="viewer">{t('doc_share.role_viewer')}</option>
                  <option value="editor">{t('doc_share.role_editor')}</option>
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={internalAllowDownload}
                    onChange={(e) => setInternalAllowDownload((e.target as HTMLInputElement).checked)}
                  />
                  {t('doc_share.allow_download')}
                </label>
                <button
                  type="submit"
                  data-testid="doc-share-add-member-btn"
                  style={{
                    padding: '6px 14px',
                    background: '#2563eb',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  {t('doc_share.add_btn')}
                </button>
              </form>

              {/* Existing Internal Member Grants */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>
                  {t('doc_share.active_internal_list')} ({internalUserShares.length})
                </div>
                {loading ? (
                  <div style={{ color: '#64748b', fontSize: 12 }}>…</div>
                ) : internalUserShares.length === 0 ? (
                  <div style={{ color: '#64748b', fontSize: 12 }}>
                    {t('doc_share.no_internal_shares')}
                  </div>
                ) : (
                  internalUserShares.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        background: '#1e293b',
                        borderRadius: 6,
                        border: '1px solid #334155',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div>
                        <span style={{ fontWeight: 600 }}>
                          {item.targetDisplayName || item.targetUsername || item.participantLabel || item.targetUserId}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <select
                          value={item.role}
                          onChange={(e) =>
                            void handleUpdateShare(item.id, {
                              role: (e.target as HTMLSelectElement).value as DocShareRole,
                            })
                          }
                          style={{
                            padding: '4px 8px',
                            background: '#0f172a',
                            color: '#e2e8f0',
                            border: '1px solid #475569',
                            borderRadius: 4,
                            fontSize: 12,
                          }}
                        >
                          <option value="viewer">{t('doc_share.role_viewer')}</option>
                          <option value="editor">{t('doc_share.role_editor')}</option>
                        </select>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={item.allowDownload}
                            onChange={(e) =>
                              void handleUpdateShare(item.id, {
                                allowDownload: (e.target as HTMLInputElement).checked,
                              })
                            }
                          />
                          {t('doc_share.allow_download')}
                        </label>
                        <button
                          type="button"
                          onClick={() => void handleRevokeShare(item.id)}
                          style={{
                            padding: '4px 10px',
                            background: '#7f1d1d',
                            color: '#fecaca',
                            border: 'none',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 11,
                          }}
                        >
                          {t('doc_share.revoke')}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {activeTab === 'external' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <form
                onSubmit={(e) => void handleCreateExternalShare(e)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: 14,
                  background: '#1e293b',
                  borderRadius: 8,
                  border: '1px solid #334155',
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {t('doc_share.create_external_title')}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    data-testid="doc-share-participant-label"
                    value={participantLabel}
                    onInput={(e) => setParticipantLabel((e.target as HTMLInputElement).value)}
                    placeholder={t('doc_share.participant_placeholder')}
                    style={{
                      flex: 1,
                      minWidth: 200,
                      padding: '6px 10px',
                      background: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid #475569',
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  />
                  <select
                    data-testid="doc-share-external-mode"
                    value={externalMode}
                    onChange={(e) =>
                      setExternalMode((e.target as HTMLSelectElement).value as 'external_link' | 'magic_invite')
                    }
                    style={{
                      padding: '6px 8px',
                      background: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid #475569',
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  >
                    <option value="external_link">
                      {t('doc_share.mode_external_link')}
                    </option>
                    <option value="magic_invite">
                      {t('doc_share.mode_magic_invite')}
                    </option>
                  </select>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    data-testid="doc-share-access-code"
                    value={accessCode}
                    onInput={(e) => setAccessCode((e.target as HTMLInputElement).value)}
                    placeholder={t('doc_share.access_code_placeholder')}
                    style={{
                      width: 170,
                      padding: '6px 10px',
                      background: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid #475569',
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  />
                  <select
                    value={externalRole}
                    onChange={(e) => setExternalRole((e.target as HTMLSelectElement).value as DocShareRole)}
                    style={{
                      padding: '6px 8px',
                      background: '#0f172a',
                      color: '#e2e8f0',
                      border: '1px solid #475569',
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  >
                    <option value="viewer">{t('doc_share.role_viewer')}</option>
                    <option value="editor">{t('doc_share.role_editor')}</option>
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={externalAllowDownload}
                      onChange={(e) => setExternalAllowDownload((e.target as HTMLInputElement).checked)}
                    />
                    {t('doc_share.allow_download')}
                  </label>
                  {externalMode === 'external_link' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        data-testid="doc-share-device-lock"
                        checked={deviceLockEnabled}
                        onChange={(e) => setDeviceLockEnabled((e.target as HTMLInputElement).checked)}
                      />
                      {t('doc_share.device_lock_enable')}
                    </label>
                  )}
                  <button
                    type="submit"
                    data-testid="doc-share-generate-link-btn"
                    style={{
                      padding: '6px 14px',
                      background: '#2563eb',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 12,
                      marginLeft: 'auto',
                    }}
                  >
                    {t('doc_share.generate_link_btn')}
                  </button>
                </div>
              </form>

              {generatedLink && (
                <div
                  data-testid="doc-share-generated-link-box"
                  style={{
                    padding: 12,
                    background: 'rgba(16, 185, 129, 0.12)',
                    border: '1px solid #10b981',
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#6ee7b7' }}>
                      {generatedLink.label} —{' '}
                      {generatedLink.mode === 'magic_invite'
                        ? t('doc_share.mode_magic_invite')
                        : t('doc_share.mode_external_link')}
                    </div>
                    <div
                      data-testid="doc-share-generated-url"
                      style={{ fontSize: 12, color: '#e2e8f0', wordBreak: 'break-all', marginTop: 4 }}
                    >
                      {generatedLink.url}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyText(generatedLink.url, 'latest')}
                    style={{
                      padding: '6px 12px',
                      background: '#059669',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    {copiedId === 'latest'
                      ? t('doc_share.copied')
                      : t('doc_share.copy_link')}
                  </button>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>
                  {t('doc_share.active_external_list')} ({externalShares.length})
                </div>
                {externalShares.length === 0 ? (
                  <div style={{ color: '#64748b', fontSize: 12 }}>
                    {t('doc_share.no_external_shares')}
                  </div>
                ) : (
                  externalShares.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        background: '#1e293b',
                        borderRadius: 6,
                        border: '1px solid #334155',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          {item.participantLabel || item.label || item.id}
                        </div>
                        <div style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 8, marginTop: 2 }}>
                          <span>
                            {item.shareMode === 'magic_invite'
                              ? t('doc_share.badge_magic')
                              : t('doc_share.badge_ext_link')}
                          </span>
                          {item.deviceLockEnabled && (
                            <span>
                              {item.isDeviceBound
                                ? t('doc_share.device_bound')
                                : t('doc_share.device_awaiting')}
                            </span>
                          )}
                          {item.redeemedAt && (
                            <span>{t('doc_share.redeemed')}</span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <select
                          value={item.role}
                          onChange={(e) =>
                            void handleUpdateShare(item.id, {
                              role: (e.target as HTMLSelectElement).value as DocShareRole,
                            })
                          }
                          style={{
                            padding: '4px 8px',
                            background: '#0f172a',
                            color: '#e2e8f0',
                            border: '1px solid #475569',
                            borderRadius: 4,
                            fontSize: 12,
                          }}
                        >
                          <option value="viewer">{t('doc_share.role_viewer')}</option>
                          <option value="editor">{t('doc_share.role_editor')}</option>
                        </select>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={item.allowDownload}
                            onChange={(e) =>
                              void handleUpdateShare(item.id, {
                                allowDownload: (e.target as HTMLInputElement).checked,
                              })
                            }
                          />
                          {t('doc_share.allow_download')}
                        </label>
                        {item.isDeviceBound && (
                          <button
                            type="button"
                            onClick={() => void handleUpdateShare(item.id, { resetDeviceLock: true })}
                            style={{
                              padding: '4px 8px',
                              background: '#334155',
                              color: '#e2e8f0',
                              border: 'none',
                              borderRadius: 4,
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                          >
                            {t('doc_share.reset_device')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleRevokeShare(item.id)}
                          style={{
                            padding: '4px 10px',
                            background: '#7f1d1d',
                            color: '#fecaca',
                            border: 'none',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 11,
                          }}
                        >
                          {t('doc_share.revoke')}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {activeTab === 'relay' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                padding: 14,
                background: '#1e293b',
                borderRadius: 8,
                border: '1px solid #334155',
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {t('doc_share.relay_title')}
              </div>
              <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.6 }}>
                {t('doc_share.relay_desc')}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <a
                  href={buildDocAuthRelayUrl('google')}
                  data-testid="doc-share-relay-google"
                  style={{
                    padding: '8px 14px',
                    background: '#2563eb',
                    color: '#fff',
                    textDecoration: 'none',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {t('doc_share.relay_google_preview')}
                </a>
                <a
                  href={buildDocAuthRelayUrl('github')}
                  data-testid="doc-share-relay-github"
                  style={{
                    padding: '8px 14px',
                    background: '#334155',
                    color: '#e2e8f0',
                    textDecoration: 'none',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {t('doc_share.relay_github_preview')}
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Pure External Collaborator Shared Document Space (`/doc-share/<token>` or `?docShare=<token>`,
 * or logged-in `doc_collaborator` session).
 * Hides internal servers and AI sessions, rendering only the shared folder/document and embedded ONLYOFFICE editor.
 */
export function ExternalDocShareSpace({ token }: { token: string }) {
  const { t } = useTranslation();
  const [deviceToken, setDeviceToken] = useState<string>(() => {
    try {
      return token ? localStorage.getItem(`imcodes_doc_dev_${token}`) || '' : '';
    } catch {
      return '';
    }
  });
  const [accessCode, setAccessCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [shareInfo, setShareInfo] = useState<ExternalShareView | null>(null);
  const [sharedWithMeList, setSharedWithMeList] = useState<SharedWithMeDocItem[]>([]);
  const [selectedShareId, setSelectedShareId] = useState<string>('');
  const navEpochRef = useRef(0);
  const browseRequestIdRef = useRef(0);
  const selectedShareIdRef = useRef<string>('');
  selectedShareIdRef.current = selectedShareId;
  const [serverId, setServerId] = useState<string>('');
  const serverIdRef = useRef<string>('');
  serverIdRef.current = serverId;
  const [currentPath, setCurrentPath] = useState<string>('');
  const currentPathRef = useRef<string>('');
  currentPathRef.current = currentPath;
  const [rootPath, setRootPath] = useState<string>('');
  const rootPathRef = useRef<string>('');
  rootPathRef.current = rootPath;
  const [entries, setEntries] = useState<DocShareBrowseEntry[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newItemName, setNewItemName] = useState('');
  const [newItemKind, setNewItemKind] = useState<'docx' | 'xlsx' | 'pptx' | 'md' | 'folder'>('docx');

  // Reset per-token state when the route token changes
  useEffect(() => {
    ++navEpochRef.current;
    let savedDev = '';
    try {
      savedDev = token ? localStorage.getItem(`imcodes_doc_dev_${token}`) || '' : '';
    } catch {
      savedDev = '';
    }
    setDeviceToken(savedDev);
    setAccessCode('');
    setShareInfo(null);
    setSharedWithMeList([]);
    setSelectedShareId('');
    selectedShareIdRef.current = '';
    setServerId('');
    serverIdRef.current = '';
    setCurrentPath('');
    currentPathRef.current = '';
    setRootPath('');
    rootPathRef.current = '';
    setEntries([]);
    setActiveFilePath(null);
    setNeedsVerify(false);
    setError(null);
  }, [token]);

  const loadExternalBrowse = useCallback(
    async (subPath?: string, customDevToken?: string, customCode?: string) => {
      const reqId = ++browseRequestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        if (!token) {
          const listRes = await listDocsSharedWithMe();
          if (reqId !== browseRequestIdRef.current) return;
          setSharedWithMeList(listRes.shares);
          const currentShare =
            (selectedShareIdRef.current ? listRes.shares.find((s) => s.id === selectedShareIdRef.current) : null) ||
            listRes.shares[0];
          if (!currentShare) {
            setNeedsVerify(false);
            return;
          }
          if (currentShare.id !== selectedShareIdRef.current) {
            setSelectedShareId(currentShare.id);
            selectedShareIdRef.current = currentShare.id;
          }
          setServerId(currentShare.serverId);
          serverIdRef.current = currentShare.serverId;
          setRootPath(currentShare.targetPath);
          rootPathRef.current = currentShare.targetPath;
          const browsePath = (subPath && subPath.startsWith(currentShare.targetPath)) ? subPath : currentShare.targetPath;
          setCurrentPath(browsePath);
          currentPathRef.current = browsePath;
          setShareInfo({
            id: currentShare.id,
            serverId: currentShare.serverId,
            targetKind: currentShare.targetKind,
            targetPath: currentShare.targetPath,
            label: currentShare.label || currentShare.targetPath.split('/').pop() || currentShare.targetPath,
            shareMode: currentShare.shareMode,
            participantLabel: currentShare.participantLabel,
            role: currentShare.role,
            allowDownload: currentShare.allowDownload,
            deviceLockEnabled: false,
            isDeviceBound: false,
            hasAccessCode: false,
            redeemedAt: currentShare.redeemedAt,
            expiresAt: currentShare.expiresAt,
            revokedAt: currentShare.revokedAt,
          });
          setNeedsVerify(false);
          if (currentShare.targetKind === 'file') {
            setActiveFilePath(currentShare.targetPath);
            setEntries([]);
          } else {
            const folderRes = await browseSharedDocFolder(currentShare.serverId, browsePath);
            if (reqId !== browseRequestIdRef.current || selectedShareIdRef.current !== currentShare.id) return;
            setEntries(folderRes.entries);
            if (!subPath) {
              setActiveFilePath(null);
            }
          }
          return;
        }

        const res = await browseExternalDocShare(token, {
          path: subPath,
          deviceToken: customDevToken ?? (deviceToken || undefined),
          accessCode: customCode ?? (accessCode || undefined),
        });
        if (reqId !== browseRequestIdRef.current) return;
        setShareInfo(res.share);
        setServerId(res.serverId);
        serverIdRef.current = res.serverId;
        setRootPath(res.rootPath);
        rootPathRef.current = res.rootPath;
        setCurrentPath(res.path);
        currentPathRef.current = res.path;
        setEntries(res.entries);
        setNeedsVerify(false);
        if (res.targetKind === 'file') {
          setActiveFilePath(res.path);
        } else if (!subPath) {
          setActiveFilePath(null);
        }
      } catch (err) {
        if (reqId !== browseRequestIdRef.current) return;
        setNeedsVerify(Boolean(token));
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (reqId === browseRequestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [token, deviceToken, accessCode, selectedShareId],
  );

  useEffect(() => {
    void loadExternalBrowse();
  }, [loadExternalBrowse]);

  const handleVerifyDevice = async (e: Event) => {
    e.preventDefault();
    const actionEpoch = navEpochRef.current;
    const actionToken = token;
    setError(null);
    try {
      const res = await verifyExternalDocShare(actionToken, {
        accessCode: accessCode.trim() || undefined,
        deviceToken: deviceToken || undefined,
      });
      if (actionEpoch !== navEpochRef.current || actionToken !== token) return;
      setDeviceToken(res.deviceToken);
      try {
        localStorage.setItem(`imcodes_doc_dev_${actionToken}`, res.deviceToken);
      } catch {
        // Ignore storage errors
      }
      await loadExternalBrowse(undefined, res.deviceToken, accessCode.trim() || undefined);
    } catch (err) {
      if (actionEpoch !== navEpochRef.current || actionToken !== token) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRedeemMagicLink = async (e: Event) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    const actionEpoch = navEpochRef.current;
    const actionToken = token;
    setError(null);
    try {
      const res = await redeemMagicInviteDocShare(actionToken, {
        displayName: displayName.trim(),
        accessCode: accessCode.trim() || undefined,
      });
      if (actionEpoch !== navEpochRef.current || actionToken !== token) return;
      setServerId(res.share.serverId);
      serverIdRef.current = res.share.serverId;
      await loadExternalBrowse();
    } catch (err) {
      if (actionEpoch !== navEpochRef.current || actionToken !== token) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateItem = async (e: Event) => {
    e.preventDefault();
    if (!newItemName.trim() || !serverId || !currentPath) return;
    const snapshot = {
      navEpoch: navEpochRef.current,
      serverId: serverIdRef.current,
      shareId: selectedShareIdRef.current,
      targetRoot: rootPathRef.current,
      parentDir: currentPathRef.current,
      token,
    };
    setError(null);
    try {
      const base = newItemName.trim();
      const finalName =
        newItemKind === 'folder'
          ? base
          : base.toLowerCase().endsWith(`.${newItemKind}`)
            ? base
            : `${base}.${newItemKind}`;
      const res = await createSharedDocItem(snapshot.serverId, {
        parentDir: snapshot.parentDir,
        name: finalName,
        kind: newItemKind === 'folder' ? 'folder' : 'file',
        shareToken: snapshot.token,
        deviceToken: deviceToken || undefined,
      });
      if (
        snapshot.navEpoch !== navEpochRef.current ||
        snapshot.serverId !== serverIdRef.current ||
        snapshot.shareId !== selectedShareIdRef.current ||
        snapshot.parentDir !== currentPathRef.current ||
        snapshot.token !== token
      ) {
        return;
      }
      setNewItemName('');
      await loadExternalBrowse(snapshot.parentDir);
      if (
        snapshot.navEpoch === navEpochRef.current &&
        snapshot.serverId === serverIdRef.current &&
        snapshot.shareId === selectedShareIdRef.current &&
        snapshot.parentDir === currentPathRef.current &&
        snapshot.token === token
      ) {
        if (res.kind === 'file') {
          setActiveFilePath(res.path);
        }
      }
    } catch (err) {
      if (
        snapshot.navEpoch !== navEpochRef.current ||
        snapshot.serverId !== serverIdRef.current ||
        snapshot.shareId !== selectedShareIdRef.current ||
        snapshot.parentDir !== currentPathRef.current ||
        snapshot.token !== token
      ) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      data-testid="external-doc-share-space"
      style={{
        width: '100%',
        minHeight: '100vh',
        background: '#020617',
        color: '#e2e8f0',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top Banner */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          background: '#0f172a',
          borderBottom: '1px solid #1e293b',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {t('doc_share.ext_workspace_title')}
          </div>
          {shareInfo && (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              {shareInfo.label} ({shareInfo.role === 'editor' ? t('doc_share.role_editor') : t('doc_share.role_viewer')})
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <a
            href={buildDocAuthRelayUrl('google', token, `/doc-share/${token}`)}
            style={{
              padding: '5px 10px',
              background: '#1e293b',
              color: '#cbd5e1',
              border: '1px solid #334155',
              borderRadius: 4,
              textDecoration: 'none',
              fontSize: 12,
            }}
          >
            {t('doc_share.google_login')}
          </a>
          <a
            href={buildDocAuthRelayUrl('github', token, `/doc-share/${token}`)}
            style={{
              padding: '5px 10px',
              background: '#1e293b',
              color: '#cbd5e1',
              border: '1px solid #334155',
              borderRadius: 4,
              textDecoration: 'none',
              fontSize: 12,
            }}
          >
            {t('doc_share.github_login')}
          </a>
        </div>
      </div>

      {/* Verification / Magic Link Gate */}
      {needsVerify && (
        <div
          style={{
            maxWidth: 440,
            margin: '40px auto',
            padding: 20,
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {t('doc_share.verify_access_title')}
          </div>
          {error && (
            <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>
          )}
          <form onSubmit={(e) => void handleVerifyDevice(e)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              type="password"
              data-testid="external-share-access-code-input"
              value={accessCode}
              onInput={(e) => setAccessCode((e.target as HTMLInputElement).value)}
              placeholder={t('doc_share.access_code_placeholder')}
              style={{
                padding: '8px 10px',
                background: '#1e293b',
                color: '#e2e8f0',
                border: '1px solid #475569',
                borderRadius: 4,
                fontSize: 13,
              }}
            />
            <button
              type="submit"
              data-testid="external-share-verify-btn"
              style={{
                padding: '8px 14px',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {t('doc_share.verify_and_open')}
            </button>
          </form>

          <div style={{ borderTop: '1px solid #1e293b', paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
              {t('doc_share.magic_redeem_label')}
            </div>
            <form onSubmit={(e) => void handleRedeemMagicLink(e)} style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                data-testid="external-share-display-name-input"
                value={displayName}
                onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                placeholder={t('doc_share.magic_display_name_placeholder')}
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  background: '#1e293b',
                  color: '#e2e8f0',
                  border: '1px solid #475569',
                  borderRadius: 4,
                  fontSize: 12,
                }}
              />
              <button
                type="submit"
                data-testid="external-share-redeem-btn"
                style={{
                  padding: '6px 12px',
                  background: '#059669',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {t('doc_share.redeem_and_enter')}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Main Shared Workspace */}
      {!needsVerify && !loading && shareInfo && (
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {shareInfo.targetKind === 'folder' && (
            <div
              style={{
                width: 280,
                borderRight: '1px solid #1e293b',
                background: '#0f172a',
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>
                  {currentPath}
                </span>
                {currentPath !== rootPath && (
                  <button
                    type="button"
                    onClick={() => {
                      ++navEpochRef.current;
                      const parent = currentPath.split('/').slice(0, -1).join('/') || rootPath;
                      const target = parent.startsWith(rootPath) ? parent : rootPath;
                      currentPathRef.current = target;
                      void loadExternalBrowse(target);
                    }}
                    style={{
                      padding: '2px 8px',
                      background: '#1e293b',
                      color: '#cbd5e1',
                      border: '1px solid #334155',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 11,
                    }}
                  >
                    ↑ {t('doc_share.up_dir')}
                  </button>
                )}
              </div>

              {shareInfo.role === 'editor' && (
                <form onSubmit={(e) => void handleCreateItem(e)} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={newItemName}
                    onInput={(e) => setNewItemName((e.target as HTMLInputElement).value)}
                    placeholder={t('doc_share.new_file_name')}
                    style={{
                      flex: 1,
                      minWidth: 100,
                      padding: '4px 8px',
                      background: '#1e293b',
                      color: '#e2e8f0',
                      border: '1px solid #334155',
                      borderRadius: 4,
                      fontSize: 11,
                    }}
                  />
                  <select
                    value={newItemKind}
                    onChange={(e) => setNewItemKind((e.target as HTMLSelectElement).value as any)}
                    style={{
                      padding: '4px',
                      background: '#1e293b',
                      color: '#e2e8f0',
                      border: '1px solid #334155',
                      borderRadius: 4,
                      fontSize: 11,
                    }}
                  >
                    <option value="docx">.docx</option>
                    <option value="xlsx">.xlsx</option>
                    <option value="pptx">.pptx</option>
                    <option value="md">.md</option>
                    <option value="folder">{t('doc_share.kind_folder')}</option>
                  </select>
                  <button
                    type="submit"
                    style={{
                      padding: '4px 8px',
                      background: '#2563eb',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 11,
                    }}
                  >
                    +
                  </button>
                </form>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' }}>
                {entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => {
                      if (entry.isDir) {
                        ++navEpochRef.current;
                        currentPathRef.current = entry.path;
                        void loadExternalBrowse(entry.path);
                      } else {
                        setActiveFilePath(entry.path);
                      }
                    }}
                    style={{
                      textAlign: 'left',
                      padding: '6px 8px',
                      background: activeFilePath === entry.path ? '#1e293b' : 'transparent',
                      color: '#e2e8f0',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 12,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span>{entry.isDir ? `📁 ${entry.name}` : `📄 ${entry.name}`}</span>
                    <span style={{ fontSize: 10, color: '#64748b' }}>{entry.role}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 520 }}>
            {sharedWithMeList.length > 1 && (
              <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
                {sharedWithMeList.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`shared-tab-${item.id}`}
                    onClick={() => {
                      ++navEpochRef.current;
                      const reqId = ++browseRequestIdRef.current;
                      const targetId = item.id;
                      setSelectedShareId(item.id);
                      selectedShareIdRef.current = item.id;
                      setServerId(item.serverId);
                      serverIdRef.current = item.serverId;
                      setRootPath(item.targetPath);
                      rootPathRef.current = item.targetPath;
                      setCurrentPath(item.targetPath);
                      currentPathRef.current = item.targetPath;
                      setShareInfo({
                        id: item.id,
                        serverId: item.serverId,
                        targetKind: item.targetKind,
                        targetPath: item.targetPath,
                        label: item.label || item.targetPath.split('/').pop() || item.targetPath,
                        shareMode: item.shareMode,
                        participantLabel: item.participantLabel,
                        role: item.role,
                        allowDownload: item.allowDownload,
                        deviceLockEnabled: false,
                        isDeviceBound: false,
                        hasAccessCode: false,
                        redeemedAt: item.redeemedAt,
                        expiresAt: item.expiresAt,
                        revokedAt: item.revokedAt,
                      });
                      if (item.targetKind === 'file') {
                        setActiveFilePath(item.targetPath);
                        setEntries([]);
                      } else {
                        setActiveFilePath(null);
                        setEntries([]);
                        void browseSharedDocFolder(item.serverId, item.targetPath).then((r) => {
                          if (reqId !== browseRequestIdRef.current || selectedShareIdRef.current !== targetId) return;
                          setEntries(r.entries);
                        });
                      }
                    }}
                    style={{
                      padding: '4px 10px',
                      background: selectedShareId === item.id ? '#2563eb' : '#1e293b',
                      color: '#e2e8f0',
                      border: '1px solid #334155',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 11,
                    }}
                  >
                    {item.label || item.targetPath.split('/').pop()}
                  </button>
                ))}
              </div>
            )}
            {activeFilePath && serverId ? (
              <OfficePreview
                serverId={serverId}
                path={activeFilePath}
                mimeType={guessMimeTypeFromPath(activeFilePath)}
                shareToken={token || undefined}
                deviceToken={deviceToken || undefined}
              />
            ) : (
              <div style={{ padding: 32, color: '#64748b', textAlign: 'center', fontSize: 13 }}>
                {t('doc_share.select_file_prompt')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DocShareDialog;
