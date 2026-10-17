import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  FILE_BROWSER_FILTER_MAX_QUERY_CHARS,
  FILE_BROWSER_SORT_DIRECTIONS,
  type FileBrowserSortKey,
  type FileBrowserSortState,
} from '@shared/file-browser-sort.js';
import { FILE_BROWSER_COLUMN_KEYS, FILE_BROWSER_HIDEABLE_COLUMNS, sortStateAfterHeaderClick } from '../file-browser-list-view.js';

export interface FileBrowserListToolbarProps {
  sort: FileBrowserSortState;
  onSortChange: (next: FileBrowserSortState) => void;
  filterValue: string;
  onFilterInput: (value: string) => void;
  onFilterCompositionStart: () => void;
  onFilterCompositionEnd: (value: string) => void;
  onFilterClear: () => void;
  hiddenColumns: ReadonlySet<FileBrowserSortKey>;
  /** The key the list is really ordered by (the remembered one falls back to the name when this machine cannot serve it). */
  effectiveSortKey: FileBrowserSortKey;
  onToggleColumn: (column: FileBrowserSortKey) => void;
  onShowAllColumns: () => void;
  /** One line under the controls: truncation, or "only the loaded items are filtered". */
  notice?: string;
}

/** Filter box, "folders first", the columns menu, and a note when the sorted column is not on screen. Never scrolls sideways with the table. */
export function FileBrowserListToolbar({
  sort, onSortChange, filterValue, onFilterInput, onFilterCompositionStart, onFilterCompositionEnd, onFilterClear,
  hiddenColumns, effectiveSortKey, onToggleColumn, onShowAllColumns, notice,
}: FileBrowserListToolbarProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [menuOpen]);

  const sortHidden = hiddenColumns.has(effectiveSortKey);
  const ascending = sort.direction === FILE_BROWSER_SORT_DIRECTIONS.ASC;
  return (
    <div class="fb-list-toolbar">
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
        <div class="fb-columns-menu" ref={menuRef}>
          <button
            type="button"
            class={`fb-columns-button${hiddenColumns.size > 0 ? ' has-hidden' : ''}`}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span>{t('file_browser.columns')}</span>
            {hiddenColumns.size > 0 && <span class="fb-columns-badge">{t('file_browser.columns_hidden', { n: hiddenColumns.size })}</span>}
          </button>
          {menuOpen && (
            <div class="fb-columns-popover" role="group" aria-label={t('file_browser.columns')}>
              {FILE_BROWSER_HIDEABLE_COLUMNS.map((column) => (
                <label key={column} class="fb-columns-item">
                  <input type="checkbox" checked={!hiddenColumns.has(column)} onChange={() => onToggleColumn(column)} />
                  <span>{t(`file_browser.col.${column}`)}</span>
                </label>
              ))}
              <button type="button" class="fb-columns-reset" disabled={hiddenColumns.size === 0} onClick={onShowAllColumns}>
                {t('file_browser.columns_show_all')}
              </button>
            </div>
          )}
        </div>
      </div>
      {sortHidden && (
        <div class="fb-list-sorted-by">
          {t('file_browser.sorted_by', { column: t(`file_browser.col.${effectiveSortKey}`) })} <span aria-hidden="true">{ascending ? '▲' : '▼'}</span>
        </div>
      )}
      {notice && <div class="fb-list-notice" role="status">{notice}</div>}
    </div>
  );
}

export interface FileBrowserListHeaderProps {
  sort: FileBrowserSortState;
  onSortChange: (next: FileBrowserSortState) => void;
  /** Why a column cannot be sorted by (an older machine, a platform without creation times); absent = sortable. */
  unavailableReasons: Partial<Record<FileBrowserSortKey, string>>;
  hiddenColumns: ReadonlySet<FileBrowserSortKey>;
}

/** The column headers: one aligned row above the entries, pinned to the top while the table scrolls, sideways with it. */
export function FileBrowserListHeader({ sort, onSortChange, unavailableReasons, hiddenColumns }: FileBrowserListHeaderProps) {
  const { t } = useTranslation();
  const ascending = sort.direction === FILE_BROWSER_SORT_DIRECTIONS.ASC;
  return (
    <div class="fb-list-header" role="row">
      {FILE_BROWSER_COLUMN_KEYS.filter((key) => !hiddenColumns.has(key)).map((key) => {
        const active = sort.key === key;
        const reason = unavailableReasons[key];
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
  );
}
