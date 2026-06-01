/**
 * AgentTodoList — a compact, live checklist of the agent's current task list.
 *
 * Reads the session's timeline events and renders the LATEST TodoWrite /
 * todo_write / update_plan list (see ../timeline/agent-todos.ts) as a pinned,
 * auto-updating checklist. Renders nothing when the session has no current list.
 */
import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent } from '../ws-client.js';
import { deriveLatestTodoList, countCompleted, type AgentTodoStatus } from '../timeline/agent-todos.js';

const STATUS_ICON: Record<AgentTodoStatus, string> = {
  pending: '☐',      // ☐
  in_progress: '◐',  // ◐
  completed: '☑',    // ☑
};

interface Props {
  events: readonly TimelineEvent[];
}

export function AgentTodoList({ events }: Props) {
  const { t } = useTranslation();
  const list = useMemo(() => deriveLatestTodoList(events), [events]);
  if (!list) return null;

  const total = list.items.length;
  const done = countCompleted(list.items);
  // Once every item is completed the checklist has served its purpose — hide it
  // so a finished list doesn't linger pinned at the top of the chat.
  if (total > 0 && done === total) return null;

  return (
    <div class="agent-todos">
      <div class="agent-todos-header">
        <span class="agent-todos-title">{t('todos.title')}</span>
        <span class="agent-todos-count">{t('todos.progress', { done, total })}</span>
      </div>
      <ul class="agent-todos-list">
        {list.items.map((item, idx) => (
          <li key={`${list.eventId}:${idx}`} class={`agent-todos-item agent-todos-item-${item.status}`}>
            <span class="agent-todos-icon" aria-hidden="true">{STATUS_ICON[item.status]}</span>
            <span class="agent-todos-text">{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
