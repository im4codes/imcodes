import { useTranslation } from 'react-i18next';
import {
  FILE_BROWSER_FILTER_MAX_QUERY_CHARS,
  FILE_BROWSER_SORT_DIRECTIONS,
  FILE_BROWSER_SORT_KEYS,
  type FileBrowserSortKey,
  type FileBrowserSortState,
} from '@shared/file-browser-sort.js';
import { sortStateAfterHeaderClick } from '../file-browser-list-view.js';

/** The list view's columns, left to right. */
export const FILE_BROWSER_COLUMNS: readonly FileBrowserSortKey[] = [
  FILE_BROWSER_SORT_KEYS.NAME,
  FILE_BROWSER_SORT_KEYS.SIZE,
  FILE_BROWSER_SORT_KEYS.KIND,
  FILE_BROWSER_SORT_KEYS.MODIFIED,
  FILE_BROWSER_SORT_KEYS.CREATED,
];

export interface FileBrowserListChromeProps {
  sort: FileBrowserSortState;
  onSortChange: (next: FileBrowserSortState) => void;
  /** Why a column cannot be sorted by (an older machine, a platform without creation times); absent = sortable. */
  unavailableReasons: Partial<Record<FileBrowserSortKey, string>>;
  filterValue: string;
  onFilterInput: (value: string) => void;
  onFilterCompositionStart: () => void;
  onFilterCompositionEnd: (value: string) => void;
  onFilterClear: () => void;
  /** Wrap the headers as chips instead of aligning them over the columns. */
  narrow: boolean;
  /** One line under the headers: truncation, or "only the loaded items are filtered". */
  notice?: string;
}

export function FileBrowserListChrome({
  sort, onSortChange, unavailableReasons, filterValue, onFilterInput,
  onFilterCompositionStart, onFilterCompositionEnd, onFilterClear, narrow, notice,
}: FileBrowserListChromeProps) {
  const { t } = useTranslation();
  return (
    <div class={`fb-list-chrome${narrow ? ' is-narrow' : ''}`}>
      <div class="fb-list-filter">
        <input
          type="text"
          class="fb-list-filter-input"
          value={filterValue}
          maxLength={FILE_BROWSER_FILTER_MAX_QUERY_CHARS}
          placeholder={t('file_browser.filter_placeholder')}
          aria-label={t('file_browser.filter_label')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellcheck={false}
          enterKeyHint="search"
          onInput={(event) => onFilterInput((event.currentTarget as HTMLInputElement).value)}
          onCompositionStart={onFilterCompositionStart}
          onCompositionEnd={(event) => onFilterCompositionEnd((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            // Typing here is typing, not a shortcut for the panel around it.
            event.stopPropagation();
            // Escape while an IME is composing cancels the composition, nothing more.
            if (event.key === 'Escape' && !event.isComposing && filterValue) {
              event.preventDefault();
              onFilterClear();
            }
          }}
        />
        {filterValue && (
          <button
            type="button"
            class="fb-list-filter-clear"
            aria-label={t('file_browser.filter_clear')}
            title={t('file_browser.filter_clear')}
            onClick={onFilterClear}
          >✕</button>
        )}
        <label class="fb-list-dirs-first" title={t('file_browser.dirs_first')}>
          <input
            type="checkbox"
            checked={sort.dirsFirst}
            onChange={(event) => onSortChange({ ...sort, dirsFirst: (event.currentTarget as HTMLInputElement).checked })}
          />
          <span>{t('file_browser.dirs_first')}</span>
        </label>
      </div>
      <div class="fb-list-header" role="row">
        {FILE_BROWSER_COLUMNS.map((key) => {
          const active = sort.key === key;
          const reason = unavailableReasons[key];
          const ascending = sort.direction === FILE_BROWSER_SORT_DIRECTIONS.ASC;
          return (
            <button
              key={key}
              type="button"
              role="columnheader"
              class={`fb-list-header-cell fb-col-${key}${active ? ' is-active' : ''}${reason ? ' is-unavailable' : ''}`}
              aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}
              aria-disabled={reason ? true : undefined}
              disabled={Boolean(reason)}
              title={reason ?? t(active ? (ascending ? 'file_browser.sort_toggle_desc' : 'file_browser.sort_toggle_asc') : 'file_browser.sort_by')}
              onClick={() => onSortChange(sortStateAfterHeaderClick(sort, key))}
            >
              <span class="fb-list-header-label">{t(`file_browser.col.${key}`)}</span>
              {active && <span class="fb-list-header-arrow" aria-hidden="true">{ascending ? '▲' : '▼'}</span>}
            </button>
          );
        })}
      </div>
      {notice && <div class="fb-list-notice" role="status">{notice}</div>}
    </div>
  );
}
