import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { parseTaskPairChecklist } from '@shared/task-pair-checklist.js';
import {
  getCachedTaskPairBrief,
  requestTaskPairBrief,
  subscribeTaskPairBriefs,
  taskPairBriefStatus,
  type TaskPairBriefStatus,
} from '../task-pair-brief-store.js';
import { ChatMarkdown } from './ChatMarkdown.js';

/** Remove checklist rows from the markdown body: the separate checklist uses a
 * two-column implemented/audited view so both boxes remain understandable. */
function markdownWithoutChecklist(brief: string): string {
  let fenced = false;
  let fenceChar = '';
  return brief.split(/\r?\n/u).filter((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fence) {
      const char = fence[1]![0]!;
      if (!fenced) { fenced = true; fenceChar = char; }
      else if (char === fenceChar) fenced = false;
      return true;
    }
    if (fenced) return true;
    return !/^\s*-\s+\[[ xX]\](?:\[[ xX]\])?\s+/u.test(line);
  }).join('\n').trim();
}

/**
 * The brief text for a row that carries only `briefRevision`: cached by
 * revision, requested from the daemon only once a viewer wants it (opens the
 * section or copies), and re-rendered when the answer arrives.
 */
function useLazyBrief(taskId: string, revision: string, wanted: boolean): { text: string | undefined; status: TaskPairBriefStatus } {
  const [, rerender] = useState(0);
  const lastStatus = useRef<TaskPairBriefStatus>('idle');
  useEffect(() => {
    if (!revision) return undefined;
    lastStatus.current = taskPairBriefStatus(revision);
    return subscribeTaskPairBriefs(() => {
      const next = taskPairBriefStatus(revision);
      if (next === lastStatus.current) return;
      lastStatus.current = next;
      rerender((value) => value + 1);
    });
  }, [revision]);
  useEffect(() => {
    if (revision && wanted) requestTaskPairBrief(taskId, revision);
  }, [taskId, revision, wanted]);
  return revision
    ? { text: getCachedTaskPairBrief(revision), status: taskPairBriefStatus(revision) }
    : { text: undefined, status: 'idle' };
}

type TaskPairBriefProps = {
  /** Full text (legacy payloads). Absent when the row only carries a revision. */
  brief?: string;
  /** Content hash of the brief the daemon holds; the text is fetched on demand. */
  briefRevision?: string;
  /** Daemon-computed counts, shown without the text. */
  checklist?: { total: number; implemented: number; audited: number };
  taskId: string;
  className?: string;
  defaultOpen?: boolean;
};

export function TaskPairBrief(props: TaskPairBriefProps) {
  return <TaskPairBriefView key={props.taskId} {...props} />;
}

function TaskPairBriefView(props: TaskPairBriefProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => props.defaultOpen === true);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const contentId = useId();
  const checklistId = useId();
  const [copied, setCopied] = useState(false);
  const [copyRequested, setCopyRequested] = useState(false);
  const inline = typeof props.brief === 'string' ? props.brief.trim() : '';
  const revision = !inline && typeof props.briefRevision === 'string' ? props.briefRevision : '';
  const lazy = useLazyBrief(props.taskId, revision, open || checklistOpen || copyRequested);
  const brief = inline || (lazy.text ?? '').trim();
  const available = !!inline || lazy.text !== undefined;
  const copy = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = text; textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed'; textarea.style.opacity = '0';
        document.body.appendChild(textarea); textarea.select(); document.execCommand('copy'); textarea.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  };
  // A copy asked for before the text arrived completes as soon as it does.
  useEffect(() => {
    if (!copyRequested) return;
    if (lazy.text !== undefined) { setCopyRequested(false); void copy(lazy.text.trim()); }
    else if (lazy.status === 'failed') setCopyRequested(false);
  }, [copyRequested, lazy.text, lazy.status]);
  const parsed = useMemo(() => brief ? parseTaskPairChecklist(brief) : [], [brief]);
  const markdown = useMemo(() => open ? markdownWithoutChecklist(brief) : '', [brief, open]);
  const parsedCounts = useMemo(() => ({ total: parsed.length, implemented: parsed.filter((item) => item.implemented).length, audited: parsed.filter((item) => item.audited).length }), [parsed]);
  if (!inline && !revision) return null;
  const counts = available ? parsedCounts : props.checklist ?? { total: 0, implemented: 0, audited: 0 };
  const checklist = parsed;
  const implementedCount = counts.implemented;
  const auditedCount = counts.audited;
  const countsKnown = (available || !!props.checklist)
    && [counts.total, implementedCount, auditedCount].every(value => Number.isSafeInteger(value) && value >= 0)
    && implementedCount <= counts.total && auditedCount <= counts.total;
  const checklistLabel = countsKnown
    ? `${t('taskPair.checklist_toggle')}: ${t('taskPair.implemented')} ${implementedCount}/${counts.total}, ${t('taskPair.audited')} ${auditedCount}/${counts.total}`
    : t('taskPair.checklist_toggle');
  const loading = !available && (lazy.status === 'loading' || lazy.status === 'idle');
  return (
    <section onClick={(event) => event.stopPropagation()} class={`task-pair-brief${props.className ? ` ${props.className}` : ''}`} data-testid={`task-pair-brief-${props.taskId}`}>
      <div class="task-pair-brief-actions">
        <button type="button" class="task-pair-brief-toggle" aria-expanded={open} aria-controls={contentId} onClick={() => { if (!open && revision && lazy.status === 'failed') requestTaskPairBrief(props.taskId, revision); setOpen((value) => !value); }}>
          {t(open ? 'taskPair.brief_collapse' : 'taskPair.brief_expand')}
        </button>
        <button type="button" class="task-pair-brief-copy" onClick={() => { if (brief) void copy(brief); else setCopyRequested(true); }} aria-label={t(copied ? 'taskPair.brief_copied' : 'taskPair.brief_copy')} title={t(copied ? 'taskPair.brief_copied' : 'taskPair.brief_copy')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            {copied ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>}
          </svg>
        </button>
        <button type="button" class="task-pair-brief-checklist-toggle" aria-label={checklistLabel} title={checklistLabel} aria-expanded={checklistOpen} aria-controls={checklistId} onClick={() => { if (!checklistOpen && revision && lazy.status === 'failed') requestTaskPairBrief(props.taskId, revision); setChecklistOpen((value) => !value); }}>
          <span class="task-pair-brief-checklist-summary" aria-hidden="true">
            {countsKnown ? `${implementedCount}/${counts.total} : ${auditedCount}/${counts.total}` : '— : —'}
          </span>
        </button>
      </div>
      {checklistOpen && <div id={checklistId} class="task-pair-brief-checklist-panel task-pair-brief-content" role="region" aria-label={t('taskPair.checklist_toggle')} aria-busy={!available && loading} tabIndex={0}>
        {!available && <span class="task-pair-brief-status">{loading ? t('taskPair.brief_loading') : t('taskPair.brief_unavailable')}</span>}
        {available && checklist.length === 0 && <span class="task-pair-brief-status">{t('taskPair.checklist_empty')}</span>}
        {checklist.length > 0 && <div class="task-pair-brief-checklist">
          <div class="task-pair-brief-checklist-heading"><span title={t('taskPair.implemented')}>{t('taskPair.implemented')}</span><span title={t('taskPair.audited')}>{t('taskPair.audited')}</span><span>{t('taskPair.brief_checklist')}</span></div>
          {checklist.map((item) => <div class="task-pair-brief-checklist-row" key={item.index}>
            <input type="checkbox" checked={item.implemented} readOnly disabled aria-label={t('taskPair.implemented')} />
            {item.hasAuditBox ? <input type="checkbox" checked={item.audited} readOnly disabled aria-label={t('taskPair.audited')} /> : <span title={t('taskPair.checklist_no_audit')} aria-label={t('taskPair.checklist_no_audit')}>—</span>}
            <span>{item.index}. {item.text}</span>
          </div>)}
        </div>}
      </div>}
      {open && <div id={contentId} class="task-pair-brief-content" role="region" aria-label={t('taskPair.brief_content')} aria-busy={!available && loading} tabIndex={0}>
        {!available && <span class="task-pair-brief-status">{loading ? t('taskPair.brief_loading') : t('taskPair.brief_unavailable')}</span>}
        {markdown && <ChatMarkdown text={markdown} cacheKey={`task-pair-brief:${props.taskId}`} />}
      </div>}
    </section>
  );
}
