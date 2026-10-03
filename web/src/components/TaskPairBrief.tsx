import { useEffect, useRef, useState } from 'preact/hooks';
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

/** Remove checklist rows from the markdown body: they are rendered below in a
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

export function TaskPairBrief(props: {
  /** Full text (legacy payloads). Absent when the row only carries a revision. */
  brief?: string;
  /** Content hash of the brief the daemon holds; the text is fetched on demand. */
  briefRevision?: string;
  /** Daemon-computed counts, shown without the text. */
  checklist?: { total: number; implemented: number; audited: number };
  taskId: string;
  className?: string;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => props.defaultOpen === true);
  const [copied, setCopied] = useState(false);
  const [copyRequested, setCopyRequested] = useState(false);
  const inline = typeof props.brief === 'string' ? props.brief.trim() : '';
  const revision = !inline && typeof props.briefRevision === 'string' ? props.briefRevision : '';
  const lazy = useLazyBrief(props.taskId, revision, open || copyRequested);
  const brief = inline || (lazy.text ?? '').trim();
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
  if (!inline && !revision) return null;
  const parsed = brief ? parseTaskPairChecklist(brief) : [];
  const counts = brief
    ? { total: parsed.length, implemented: parsed.filter((item) => item.implemented).length, audited: parsed.filter((item) => item.audited).length }
    : props.checklist ?? { total: 0, implemented: 0, audited: 0 };
  const checklist = parsed;
  const implementedCount = counts.implemented;
  const auditedCount = counts.audited;
  const loading = !brief && (lazy.status === 'loading' || lazy.status === 'idle');
  return (
    <section class={`task-pair-brief${props.className ? ` ${props.className}` : ''}`} data-testid={`task-pair-brief-${props.taskId}`}>
      <div class="task-pair-brief-actions">
        <button type="button" class="task-pair-brief-toggle" aria-expanded={open} aria-controls={`task-pair-brief-content-${props.taskId}`} onClick={() => setOpen((value) => !value)}>
          {t(open ? 'taskPair.brief_collapse' : 'taskPair.brief_expand')}
        </button>
        <button type="button" class="task-pair-brief-copy" onClick={() => { if (brief) void copy(brief); else setCopyRequested(true); }} aria-label={t('taskPair.brief_copy')}>
          {copied ? t('taskPair.brief_copied') : t('taskPair.brief_copy')}
        </button>
        {counts.total > 0 && <span class="task-pair-brief-checklist-summary" aria-label={`${t('taskPair.implemented')} ${implementedCount}/${counts.total}, ${t('taskPair.audited')} ${auditedCount}/${counts.total}`}>
          {t('taskPair.implemented')}: {implementedCount}/{counts.total} · {t('taskPair.audited')}: {auditedCount}/{counts.total}
        </span>}
      </div>
      {open && !brief && <div id={`task-pair-brief-content-${props.taskId}`} class="task-pair-brief-content" role="region" aria-label={t('taskPair.brief_content')} aria-busy={loading}>
        <span class="task-pair-brief-status">{loading ? t('taskPair.brief_loading') : t('taskPair.brief_unavailable')}</span>
      </div>}
      {open && brief && <div id={`task-pair-brief-content-${props.taskId}`} class="task-pair-brief-content" role="region" aria-label={t('taskPair.brief_content')}>
        {markdownWithoutChecklist(brief) && <ChatMarkdown text={markdownWithoutChecklist(brief)} cacheKey={`task-pair-brief:${props.taskId}`} />}
        {checklist.length > 0 && <div class="task-pair-brief-checklist">
          <div class="task-pair-brief-checklist-heading"><span>{t('taskPair.implemented')}</span><span>{t('taskPair.audited')}</span><span>{t('taskPair.brief_checklist')}</span></div>
          {checklist.map((item) => <div class="task-pair-brief-checklist-row" key={`${props.taskId}-${item.index}`}>
            <input type="checkbox" checked={item.implemented} readOnly aria-label={t('taskPair.implemented')} />
            <input type="checkbox" checked={item.audited} readOnly aria-label={t('taskPair.audited')} />
            <span>{item.text}</span>
          </div>)}
        </div>}
      </div>}
    </section>
  );
}
