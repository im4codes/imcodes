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
  const branch = context?.currentBranch?.trim();

  if (!branch || !projectDir) return null;

  const handleClick = () => {
    onOpenRepo?.();
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
        onClick={handleClick}
        disabled={!onOpenRepo}
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
          cursor: onOpenRepo ? 'pointer' : 'default',
          opacity: onOpenRepo ? 1 : 0.72,
        }}
      >
        <span aria-hidden="true" style={{ flexShrink: 0, fontSize: 12 }}>⎇</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {branch}
        </span>
      </button>
    </span>
  );
}
