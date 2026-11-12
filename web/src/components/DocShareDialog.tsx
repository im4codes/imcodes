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
  type SharedWithMeDocItem,
} from '../api.js';
import OfficePreview from './OfficePreview.js';

export interface DocShareDialogProps {
  serverId: string;
  targetPath: string;
  targetKind: DocShareTargetKind;
  onClose: () => void;
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
}: DocShareDialogProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'internal' | 'external' | 'relay'>('internal');
  const [shares, setShares] = useState<DocumentShareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tab 1: Internal / Team state
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

  const loadShares = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listDocumentShares(serverId, targetPath);
      setShares(res.shares);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [serverId, targetPath]);

  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  const teamShare = shares.find((s) => s.shareMode === 'team' && s.targetUserId === '*' && !s.revokedAt);
  const internalUserShares = shares.filter((s) => s.shareMode === 'user' && s.targetUserId !== '*' && !s.revokedAt);
  const externalShares = shares.filter(
    (s) => (s.shareMode === 'external_link' || s.shareMode === 'magic_invite') && !s.revokedAt,
  );

  const handleToggleTeamShare = async () => {
    setError(null);
    try {
      if (teamShare) {
        await revokeDocumentShareApi(serverId, teamShare.id);
      } else {
        await createDocumentShareApi(serverId, {
          targetKind,
          targetPath,
          shareMode: 'team',
          role: 'viewer',
          allowDownload: true,
        });
      }
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddInternalUser = async (e: Event) => {
    e.preventDefault();
    if (!targetUsername.trim()) return;
    setError(null);
    try {
      await createDocumentShareApi(serverId, {
        targetKind,
        targetPath,
        shareMode: 'user',
        targetUser: targetUsername.trim(),
        role: internalRole,
        allowDownload: internalAllowDownload,
      });
      setTargetUsername('');
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateExternalShare = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await createDocumentShareApi(serverId, {
        targetKind,
        targetPath,
        shareMode: externalMode,
        participantLabel: participantLabel.trim() || undefined,
        accessCode: accessCode.trim() || undefined,
        deviceLockEnabled: externalMode === 'external_link' ? deviceLockEnabled : false,
        role: externalRole,
        allowDownload: externalAllowDownload,
      });
      if (res.sharePath || res.shareUrl) {
        const fullUrl =
          res.shareUrl ||
          (typeof window !== 'undefined' ? `${window.location.origin}${res.sharePath}` : res.sharePath!);
        setGeneratedLink({
          url: fullUrl,
          label: participantLabel.trim() || t('doc_share.external_collaborator', 'External Collaborator'),
          mode: externalMode,
        });
      }
      setParticipantLabel('');
      setAccessCode('');
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpdateShare = async (
    shareId: string,
    patch: { role?: DocShareRole; allowDownload?: boolean; resetDeviceLock?: boolean },
  ) => {
    setError(null);
    try {
      await updateDocumentShareApi(serverId, shareId, patch);
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevokeShare = async (shareId: string) => {
    setError(null);
    try {
      await revokeDocumentShareApi(serverId, shareId);
      await loadShares();
    } catch (err) {
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
                ? t('doc_share.dialog_title_folder', 'Folder Sharing & Document Permissions')
                : t('doc_share.dialog_title_file', 'Document Sharing & Permissions')}
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
            {t('doc_share.tab_internal', '1. Team & Internal Members')}
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
            {t('doc_share.tab_external', '2. External Links & Magic Invite')}
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
            {t('doc_share.tab_relay', '3. Key-Free OAuth Relay')}
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
              {/* All-Team Share Toggle */}
              <div
                style={{
                  padding: 12,
                  background: '#1e293b',
                  borderRadius: 8,
                  border: '1px solid #334155',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {t('doc_share.team_all_members', 'Team All-Member Share (*)')}
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                    {targetKind === 'folder'
                      ? t('doc_share.team_folder_hint', 'All internal members inherit access to files in this folder unless overridden on a single file.')
                      : t('doc_share.team_file_hint', 'Overrides parent folder permissions for this specific document.')}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {teamShare && (
                    <>
                      <select
                        value={teamShare.role}
                        onChange={(e) =>
                          void handleUpdateShare(teamShare.id, {
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
                        <option value="viewer">{t('doc_share.role_viewer', 'Viewer (Read-Only)')}</option>
                        <option value="editor">{t('doc_share.role_editor', 'Editor (Co-Edit)')}</option>
                      </select>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={teamShare.allowDownload}
                          onChange={(e) =>
                            void handleUpdateShare(teamShare.id, {
                              allowDownload: (e.target as HTMLInputElement).checked,
                            })
                          }
                        />
                        {t('doc_share.allow_download', 'Allow Download')}
                      </label>
                    </>
                  )}
                  <button
                    type="button"
                    data-testid="doc-share-toggle-team"
                    onClick={() => void handleToggleTeamShare()}
                    style={{
                      padding: '5px 12px',
                      background: teamShare ? '#dc2626' : '#2563eb',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    {teamShare
                      ? t('doc_share.disable_team_share', 'Revoke Team Share')
                      : t('doc_share.enable_team_share', 'Enable Team Share')}
                  </button>
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
                  placeholder={t('doc_share.username_placeholder', 'Enter username or user ID...')}
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
                  <option value="viewer">{t('doc_share.role_viewer', 'Viewer (Read-Only)')}</option>
                  <option value="editor">{t('doc_share.role_editor', 'Editor (Co-Edit)')}</option>
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={internalAllowDownload}
                    onChange={(e) => setInternalAllowDownload((e.target as HTMLInputElement).checked)}
                  />
                  {t('doc_share.allow_download', 'Allow Download')}
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
                  {t('doc_share.add_member', 'Add Member')}
                </button>
              </form>

              {/* Existing Internal Member Grants */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>
                  {t('doc_share.member_list_title', 'Authorized Members')} ({internalUserShares.length})
                </div>
                {loading ? (
                  <div style={{ color: '#64748b', fontSize: 12 }}>…</div>
                ) : internalUserShares.length === 0 ? (
                  <div style={{ color: '#64748b', fontSize: 12 }}>
                    {t('doc_share.no_members_yet', 'No individual member overrides yet.')}
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
                          <option value="viewer">{t('doc_share.role_viewer', 'Viewer')}</option>
                          <option value="editor">{t('doc_share.role_editor', 'Editor')}</option>
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
                          {t('doc_share.allow_download', 'Download')}
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
                          {t('doc_share.revoke', 'Revoke')}
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
                  {t('doc_share.create_external_title', 'Generate Per-Person External Link or Magic Invite (No API Key Required)')}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    data-testid="doc-share-participant-label"
                    value={participantLabel}
                    onInput={(e) => setParticipantLabel((e.target as HTMLInputElement).value)}
                    placeholder={t('doc_share.participant_label_placeholder', 'Collaborator name/remark (e.g. Finance-Wang, Client-Li)')}
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
                      {t('doc_share.mode_external_link', 'Scheme 1: Dedicated Link + Device Lock')}
                    </option>
                    <option value="magic_invite">
                      {t('doc_share.mode_magic_invite', 'Scheme 3: One-Time Magic Invite Link')}
                    </option>
                  </select>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    data-testid="doc-share-access-code"
                    value={accessCode}
                    onInput={(e) => setAccessCode((e.target as HTMLInputElement).value)}
                    placeholder={t('doc_share.access_code_placeholder', 'Optional access code / PIN')}
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
                    <option value="viewer">{t('doc_share.role_viewer', 'Viewer (Read-Only)')}</option>
                    <option value="editor">{t('doc_share.role_editor', 'Editor (Co-Edit)')}</option>
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={externalAllowDownload}
                      onChange={(e) => setExternalAllowDownload((e.target as HTMLInputElement).checked)}
                    />
                    {t('doc_share.allow_download', 'Allow Download')}
                  </label>
                  {externalMode === 'external_link' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        data-testid="doc-share-device-lock"
                        checked={deviceLockEnabled}
                        onChange={(e) => setDeviceLockEnabled((e.target as HTMLInputElement).checked)}
                      />
                      {t('doc_share.device_lock_label', 'Lock to first device / Passkey (anti-forwarding)')}
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
                    {t('doc_share.generate_link_btn', 'Generate Link')}
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
                        ? t('doc_share.mode_magic_invite', 'One-Time Magic Invite')
                        : t('doc_share.mode_external_link', 'Dedicated External Link')}
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
                      ? t('doc_share.copied', 'Copied!')
                      : t('doc_share.copy_link', 'Copy Link')}
                  </button>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>
                  {t('doc_share.external_list_title', 'Active External Collaborator Links')} ({externalShares.length})
                </div>
                {externalShares.length === 0 ? (
                  <div style={{ color: '#64748b', fontSize: 12 }}>
                    {t('doc_share.no_external_links', 'No external links created yet.')}
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
                              ? t('doc_share.badge_magic', 'Magic Invite')
                              : t('doc_share.badge_external', 'External Link')}
                          </span>
                          {item.deviceLockEnabled && (
                            <span>
                              {item.isDeviceBound
                                ? t('doc_share.device_bound', 'Device Locked')
                                : t('doc_share.device_pending', 'Locks on 1st Open')}
                            </span>
                          )}
                          {item.redeemedAt && (
                            <span>{t('doc_share.redeemed', 'Redeemed')}</span>
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
                          <option value="viewer">{t('doc_share.role_viewer', 'Viewer')}</option>
                          <option value="editor">{t('doc_share.role_editor', 'Editor')}</option>
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
                          {t('doc_share.allow_download', 'Download')}
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
                            {t('doc_share.reset_device', 'Reset Device')}
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
                          {t('doc_share.revoke', 'Revoke')}
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
                {t('doc_share.relay_title', 'Scheme 2: Central Auth Relay Key-Free OAuth Login')}
              </div>
              <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.6 }}>
                {t(
                  'doc_share.relay_description',
                  'Self-hosted IM.codes servers do not need to register Google or GitHub OAuth Client IDs. External collaborators can sign in via the central Auth Relay (or direct OAuth when configured) and bind their verified identity to shared documents.',
                )}
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
                  {t('doc_share.login_google_relay', 'Sign in with Google (Auth Relay)')}
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
                  {t('doc_share.login_github_relay', 'Sign in with GitHub (Auth Relay)')}
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
  const requestEpochRef = useRef(0);
  const selectedShareIdRef = useRef<string>('');
  selectedShareIdRef.current = selectedShareId;
  const [serverId, setServerId] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [rootPath, setRootPath] = useState<string>('');
  const [entries, setEntries] = useState<DocShareBrowseEntry[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newItemName, setNewItemName] = useState('');
  const [newItemKind, setNewItemKind] = useState<'docx' | 'xlsx' | 'pptx' | 'md' | 'folder'>('docx');

  // Reset per-token state when the route token changes
  useEffect(() => {
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
    setServerId('');
    setCurrentPath('');
    setRootPath('');
    setEntries([]);
    setActiveFilePath(null);
    setNeedsVerify(false);
    setError(null);
  }, [token]);

  const loadExternalBrowse = useCallback(
    async (subPath?: string, customDevToken?: string, customCode?: string) => {
      const epoch = ++requestEpochRef.current;
      setLoading(true);
      setError(null);
      try {
        if (!token) {
          const listRes = await listDocsSharedWithMe();
          if (epoch !== requestEpochRef.current) return;
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
          setRootPath(currentShare.targetPath);
          const browsePath = (subPath && subPath.startsWith(currentShare.targetPath)) ? subPath : currentShare.targetPath;
          setCurrentPath(browsePath);
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
            if (epoch !== requestEpochRef.current || selectedShareIdRef.current !== currentShare.id) return;
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
        if (epoch !== requestEpochRef.current) return;
        setShareInfo(res.share);
        setServerId(res.serverId);
        setRootPath(res.rootPath);
        setCurrentPath(res.path);
        setEntries(res.entries);
        setNeedsVerify(false);
        if (res.targetKind === 'file') {
          setActiveFilePath(res.path);
        } else if (!subPath) {
          setActiveFilePath(null);
        }
      } catch (err) {
        if (epoch !== requestEpochRef.current) return;
        setNeedsVerify(Boolean(token));
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (epoch === requestEpochRef.current) {
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
    const actionEpoch = requestEpochRef.current;
    const actionToken = token;
    setError(null);
    try {
      const res = await verifyExternalDocShare(actionToken, {
        accessCode: accessCode.trim() || undefined,
        deviceToken: deviceToken || undefined,
      });
      if (actionEpoch !== requestEpochRef.current || actionToken !== token) return;
      setDeviceToken(res.deviceToken);
      try {
        localStorage.setItem(`imcodes_doc_dev_${actionToken}`, res.deviceToken);
      } catch {
        // Ignore storage errors
      }
      await loadExternalBrowse(undefined, res.deviceToken, accessCode.trim() || undefined);
    } catch (err) {
      if (actionEpoch !== requestEpochRef.current || actionToken !== token) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRedeemMagicLink = async (e: Event) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    const actionEpoch = requestEpochRef.current;
    const actionToken = token;
    setError(null);
    try {
      const res = await redeemMagicInviteDocShare(actionToken, {
        displayName: displayName.trim(),
        accessCode: accessCode.trim() || undefined,
      });
      if (actionEpoch !== requestEpochRef.current || actionToken !== token) return;
      setServerId(res.share.serverId);
      await loadExternalBrowse();
    } catch (err) {
      if (actionEpoch !== requestEpochRef.current || actionToken !== token) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateItem = async (e: Event) => {
    e.preventDefault();
    if (!newItemName.trim() || !serverId || !currentPath) return;
    const actionEpoch = requestEpochRef.current;
    const actionShareId = selectedShareIdRef.current;
    const actionServerId = serverId;
    const actionParentDir = currentPath;
    const actionToken = token;
    setError(null);
    try {
      const base = newItemName.trim();
      const finalName =
        newItemKind === 'folder'
          ? base
          : base.toLowerCase().endsWith(`.${newItemKind}`)
            ? base
            : `${base}.${newItemKind}`;
      const res = await createSharedDocItem(actionServerId, {
        parentDir: actionParentDir,
        name: finalName,
        kind: newItemKind === 'folder' ? 'folder' : 'file',
        shareToken: actionToken,
        deviceToken: deviceToken || undefined,
      });
      if (
        actionEpoch !== requestEpochRef.current ||
        actionShareId !== selectedShareIdRef.current ||
        actionServerId !== serverId ||
        actionToken !== token
      ) {
        return;
      }
      setNewItemName('');
      await loadExternalBrowse(actionParentDir);
      if (
        actionEpoch === requestEpochRef.current &&
        actionShareId === selectedShareIdRef.current &&
        actionServerId === serverId &&
        actionToken === token
      ) {
        if (res.kind === 'file') {
          setActiveFilePath(res.path);
        }
      }
    } catch (err) {
      if (
        actionEpoch !== requestEpochRef.current ||
        actionShareId !== selectedShareIdRef.current ||
        actionServerId !== serverId ||
        actionToken !== token
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
            {t('doc_share.external_space_title', 'IM.codes Shared Document Workspace')}
          </div>
          {shareInfo && (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              {shareInfo.label} ({shareInfo.role === 'editor' ? t('doc_share.role_editor', 'Editor') : t('doc_share.role_viewer', 'Viewer')})
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
            {t('doc_share.login_google_relay', 'Google Auth Relay')}
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
            {t('doc_share.login_github_relay', 'GitHub Auth Relay')}
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
            {t('doc_share.verify_access_title', 'Verify External Collaborator Access')}
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
              placeholder={t('doc_share.access_code_placeholder', 'Access code (if required)')}
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
              {t('doc_share.verify_and_bind_btn', 'Verify & Bind Current Device / Passkey')}
            </button>
          </form>

          <div style={{ borderTop: '1px solid #1e293b', paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
              {t('doc_share.magic_redeem_hint', 'Or redeem a one-time Magic Invite Link with your display name:')}
            </div>
            <form onSubmit={(e) => void handleRedeemMagicLink(e)} style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                data-testid="external-share-display-name-input"
                value={displayName}
                onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                placeholder={t('doc_share.your_display_name', 'Your name (e.g. Li Ming)')}
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
                {t('doc_share.redeem_magic_btn', 'Redeem Invite')}
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
                      const parent = currentPath.split('/').slice(0, -1).join('/') || rootPath;
                      void loadExternalBrowse(parent.startsWith(rootPath) ? parent : rootPath);
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
                    ↑ {t('doc_share.up_dir', 'Up')}
                  </button>
                )}
              </div>

              {shareInfo.role === 'editor' && (
                <form onSubmit={(e) => void handleCreateItem(e)} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={newItemName}
                    onInput={(e) => setNewItemName((e.target as HTMLInputElement).value)}
                    placeholder={t('doc_share.new_file_name', 'New name...')}
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
                    <option value="folder">{t('doc_share.folder', 'Folder')}</option>
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
                      const epoch = ++requestEpochRef.current;
                      const targetId = item.id;
                      setSelectedShareId(item.id);
                      selectedShareIdRef.current = item.id;
                      setServerId(item.serverId);
                      setRootPath(item.targetPath);
                      setCurrentPath(item.targetPath);
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
                          if (epoch !== requestEpochRef.current || selectedShareIdRef.current !== targetId) return;
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
                {t('doc_share.select_document_prompt', 'Select a document on the left to preview or co-edit in ONLYOFFICE.')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DocShareDialog;
