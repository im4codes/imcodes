import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { useSessionRepoContext } from '../session-repo-context-store.js';

interface Props {
  sessionId?: string | null;
  projectDir?: string | null;
  onOpenRepo?: () => void;
  className?: string;
}

export function SessionRepoBranchSummary({ sessionId, projectDir, onOpenRepo, className }: Props) {
  const { t } = useTranslation();
  const context = useSessionRepoContext(sessionId, projectDir);
  const [open, setOpen] = useState(false);
  const branch = context?.currentBranch?.trim();

  if (!branch || !projectDir) return null;

  const repoIdentity = context?.info?.owner && context.info.repo
    ? `${context.info.owner}/${context.info.repo}`
    : null;

  const handleClick = () => {
    if (onOpenRepo) {
      onOpenRepo();
      return;
    }
    setOpen((value) => !value);
  };

  return (
    <span
      class={className}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: 0,
        maxWidth: '100%',
      }}
    >
      <button
        type="button"
        class="session-repo-branch-summary"
        title={t('repo.branch_summary_title', { branch })}
        aria-label={t('repo.branch_summary_label', { branch })}
        aria-expanded={open}
        onClick={handleClick}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          minWidth: 0,
          maxWidth: 180,
          height: 24,
          padding: '0 8px',
          borderRadius: 6,
          border: '1px solid rgba(96,165,250,0.28)',
          background: 'rgba(15,23,42,0.82)',
          color: '#bfdbfe',
          fontSize: 11,
          lineHeight: '22px',
          cursor: 'pointer',
        }}
      >
        <span aria-hidden="true" style={{ flexShrink: 0, fontSize: 12 }}>⎇</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {branch}
        </span>
      </button>
      {open && !onOpenRepo && (
        <div
          role="dialog"
          aria-label={t('repo.info_title')}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 'calc(100% + 6px)',
            zIndex: 30,
            width: 280,
            maxWidth: 'calc(100vw - 24px)',
            padding: 12,
            borderRadius: 8,
            border: '1px solid rgba(148,163,184,0.24)',
            background: '#0f172a',
            boxShadow: '0 16px 40px rgba(0,0,0,0.36)',
            color: '#cbd5e1',
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>{t('repo.info_title')}</div>
          <InfoRow label={t('repo.info_current_branch')} value={branch} />
          <InfoRow label={t('repo.info_project_dir')} value={projectDir} />
          {repoIdentity && <InfoRow label={t('repo.info_repository')} value={repoIdentity} />}
          {context?.info?.provider && <InfoRow label={t('repo.info_provider')} value={context.info.provider} />}
          {context?.defaultBranch && <InfoRow label={t('repo.info_default_branch')} value={context.defaultBranch} />}
        </div>
      )}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '92px minmax(0,1fr)', gap: 8, marginTop: 6 }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}
