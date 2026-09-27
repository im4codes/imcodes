import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { parseTaskPairChecklist } from '@shared/task-pair-checklist.js';
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

export function TaskPairBrief(props: { brief?: string; taskId: string; className?: string; defaultOpen?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => props.defaultOpen === true);
  const [copied, setCopied] = useState(false);
  const brief = typeof props.brief === 'string' ? props.brief.trim() : '';
  if (!brief) return null;
  const checklist = parseTaskPairChecklist(brief);
  const implementedCount = checklist.filter((item) => item.implemented).length;
  const auditedCount = checklist.filter((item) => item.audited).length;
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(brief);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = brief; textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed'; textarea.style.opacity = '0';
        document.body.appendChild(textarea); textarea.select(); document.execCommand('copy'); textarea.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  };
  return (
    <section class={`task-pair-brief${props.className ? ` ${props.className}` : ''}`} data-testid={`task-pair-brief-${props.taskId}`}>
      <div class="task-pair-brief-actions">
        <button type="button" class="task-pair-brief-toggle" aria-expanded={open} aria-controls={`task-pair-brief-content-${props.taskId}`} onClick={() => setOpen((value) => !value)}>
          {t(open ? 'taskPair.brief_collapse' : 'taskPair.brief_expand')}
        </button>
        <button type="button" class="task-pair-brief-copy" onClick={() => { void copy(); }} aria-label={t('taskPair.brief_copy')}>
          {copied ? t('taskPair.brief_copied') : t('taskPair.brief_copy')}
        </button>
        {checklist.length > 0 && <span class="task-pair-brief-checklist-summary" aria-label={`${t('taskPair.implemented')} ${implementedCount}/${checklist.length}, ${t('taskPair.audited')} ${auditedCount}/${checklist.length}`}>
          {t('taskPair.implemented')}: {implementedCount}/{checklist.length} · {t('taskPair.audited')}: {auditedCount}/{checklist.length}
        </span>}
      </div>
      {open && <div id={`task-pair-brief-content-${props.taskId}`} class="task-pair-brief-content" role="region" aria-label={t('taskPair.brief_content')}>
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
