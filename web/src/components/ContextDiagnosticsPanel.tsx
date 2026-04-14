import { useCallback, useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  getRuntimeAuthoredContext,
  getSharedContextDiagnostics,
  listTeams,
  type RuntimeAuthoredContextBindingView,
  type SharedContextDiagnosticsView,
  type TeamSummary,
} from '../api.js';

const inputStyle = {
  flex: '1 1 160px',
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

interface Props {
  enterpriseId?: string;
  canonicalRepoId?: string;
  workspaceId?: string;
  enrollmentId?: string;
  language?: string;
  filePath?: string;
  persistedSnapshot?: {
    label: string;
    diagnostics: SharedContextDiagnosticsView;
    bindings: RuntimeAuthoredContextBindingView[];
  } | null;
  onStateChange?: (next: {
    enterpriseId: string;
    canonicalRepoId: string;
    workspaceId: string;
    enrollmentId: string;
    language: string;
    filePath: string;
  }) => void;
}

export function ContextDiagnosticsPanel(props: Props) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [enterpriseId, setEnterpriseId] = useState(props.enterpriseId ?? '');
  const [canonicalRepoId, setCanonicalRepoId] = useState(props.canonicalRepoId ?? '');
  const [workspaceId, setWorkspaceId] = useState(props.workspaceId ?? '');
  const [enrollmentId, setEnrollmentId] = useState(props.enrollmentId ?? '');
  const [language, setLanguage] = useState(props.language ?? '');
  const [filePath, setFilePath] = useState(props.filePath ?? '');
  const [diagnostics, setDiagnostics] = useState<SharedContextDiagnosticsView | null>(null);
  const [bindings, setBindings] = useState<RuntimeAuthoredContextBindingView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void listTeams()
      .then((nextTeams) => {
        setTeams(nextTeams);
        if (!enterpriseId && nextTeams[0]) setEnterpriseId(nextTeams[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const load = useCallback(async () => {
    if (!enterpriseId || !canonicalRepoId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const [nextDiagnostics, nextBindings] = await Promise.all([
        getSharedContextDiagnostics(enterpriseId, canonicalRepoId.trim(), {
          workspaceId: workspaceId.trim() || undefined,
          enrollmentId: enrollmentId.trim() || undefined,
          language: language.trim() || undefined,
          filePath: filePath.trim() || undefined,
        }),
        getRuntimeAuthoredContext(enterpriseId, {
          canonicalRepoId: canonicalRepoId.trim(),
          workspaceId: workspaceId.trim() || undefined,
          enrollmentId: enrollmentId.trim() || undefined,
          language: language.trim() || undefined,
          filePath: filePath.trim() || undefined,
        }),
      ]);
      setDiagnostics(nextDiagnostics);
      setBindings(nextBindings);
      props.onStateChange?.({
        enterpriseId,
        canonicalRepoId: canonicalRepoId.trim(),
        workspaceId,
        enrollmentId,
        language,
        filePath,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [canonicalRepoId, enterpriseId, enrollmentId, filePath, language, props, workspaceId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 8, color: '#e2e8f0', overflow: 'auto' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>{t('sharedContext.diagnostics.title')}</strong>
        <button style={buttonStyle} onClick={() => void load()}>{t('sharedContext.diagnostics.load')}</button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select value={enterpriseId} onChange={(e) => setEnterpriseId((e.currentTarget as HTMLSelectElement).value)} style={inputStyle}>
          <option value="">{t('sharedContext.management.selectEnterprise')}</option>
          {teams.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        <input value={canonicalRepoId} onInput={(e) => setCanonicalRepoId((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.canonicalRepoId')} style={inputStyle} />
        <input value={workspaceId} onInput={(e) => setWorkspaceId((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.diagnostics.workspaceId')} style={inputStyle} />
        <input value={enrollmentId} onInput={(e) => setEnrollmentId((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.diagnostics.enrollmentId')} style={inputStyle} />
        <input value={language} onInput={(e) => setLanguage((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.management.language')} style={inputStyle} />
        <input value={filePath} onInput={(e) => setFilePath((e.currentTarget as HTMLInputElement).value)} placeholder={t('sharedContext.diagnostics.filePath')} style={inputStyle} />
      </div>
      {loading && <div>{t('sharedContext.loading')}</div>}
      {error && <div style={{ color: '#fca5a5' }}>{error}</div>}
      {diagnostics && (
        <div style={{ border: '1px solid #334155', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div>{t('sharedContext.diagnostics.mode')}: {diagnostics.retrievalMode}</div>
          <div>{t('sharedContext.diagnostics.visibility')}: {diagnostics.visibilityState}</div>
          <div>{t('sharedContext.diagnostics.remoteProcessed')}: {diagnostics.remoteProcessedFreshness}</div>
          <div>{t('sharedContext.diagnostics.derivedOnDemand')}: {String(diagnostics.diagnostics.derivedOnDemand)}</div>
          <div>{t('sharedContext.diagnostics.persistedSnapshotAvailable')}: {String(diagnostics.diagnostics.persistedSnapshotAvailable)}</div>
          <div>{t('sharedContext.diagnostics.appliedVersions')}: {diagnostics.diagnostics.appliedDocumentVersionIds.join(', ') || t('sharedContext.empty')}</div>
        </div>
      )}
      <div style={{ border: '1px solid #334155', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <strong>{t('sharedContext.diagnostics.runtimeBindings')}</strong>
        {bindings.length === 0 ? <div>{t('sharedContext.empty')}</div> : bindings.map((binding) => (
          <div key={binding.bindingId}>
            {binding.mode} · {binding.scope} · {binding.documentVersionId}
            <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', color: '#cbd5e1' }}>{binding.content}</pre>
          </div>
        ))}
      </div>
      {props.persistedSnapshot && (
        <div style={{ border: '1px solid #475569', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong>{t('sharedContext.diagnostics.snapshotTitle')}: {props.persistedSnapshot.label}</strong>
          <div>{t('sharedContext.diagnostics.mode')}: {props.persistedSnapshot.diagnostics.retrievalMode}</div>
          <div>{t('sharedContext.diagnostics.snapshotBindings')}: {props.persistedSnapshot.bindings.length}</div>
        </div>
      )}
    </div>
  );
}
