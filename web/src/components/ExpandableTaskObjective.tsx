import { useCallback, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

export type TaskObjectiveOverflowMeasure = (element: HTMLElement) => boolean;

/** Public seam used by jsdom tests and the browser measurement path alike. */
export const taskObjectiveOverflows = (element: HTMLElement): boolean =>
  element.scrollHeight > element.clientHeight + 1;

export function ExpandableTaskObjective(props: {
  text: string;
  className?: string;
  textClassName?: string;
  id?: string;
  measureOverflow?: TaskObjectiveOverflowMeasure;
  onActivate?: () => void;
  activateExpanded?: boolean;
  activateControls?: string;
}) {
  const { t } = useTranslation();
  const generatedId = useId().replace(/[^A-Za-z0-9_-]/gu, '');
  const textId = props.id ?? `task-objective-${generatedId}`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const measureOverflow = props.measureOverflow ?? taskObjectiveOverflows;

  const measure = useCallback(() => {
    const element = textRef.current;
    if (!element) return;
    // The visible node is unclamped while expanded. Temporarily force the
    // three-line geometry so resize/font measurements still answer whether a
    // collapse control is needed, without duplicating the objective offscreen.
    element.classList.add('is-measuring-clamped');
    const next = measureOverflow(element);
    element.classList.remove('is-measuring-clamped');
    setOverflowing(next);
    if (!next) setExpanded(false);
  }, [measureOverflow]);

  useLayoutEffect(() => {
    setExpanded(false);
    measure();
    const root = rootRef.current;
    const resizeObserver = root && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(measure)
      : undefined;
    if (root && resizeObserver) resizeObserver.observe(root);

    const fonts = document.fonts;
    let disposed = false;
    void fonts?.ready.then(() => {
      if (!disposed) measure();
    });
    fonts?.addEventListener?.('loadingdone', measure);
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      fonts?.removeEventListener?.('loadingdone', measure);
    };
  }, [measure, props.text]);

  const action = expanded
    ? t('delegation.objective_collapse')
    : t('delegation.objective_expand');
  const textNode = (
    <strong
      ref={textRef}
      id={textId}
      class={`expandable-task-objective-text ${props.textClassName ?? ''}${!expanded ? ' is-clamped' : ' is-expanded'}`.trim()}
      data-testid="expandable-task-objective-text"
    >
      {props.text}
    </strong>
  );
  return (
    <span
      ref={rootRef}
      class={`expandable-task-objective${expanded ? ' is-expanded' : ''}${props.className ? ` ${props.className}` : ''}`}
      data-objective-overflow={overflowing ? 'true' : 'false'}
    >
      {props.onActivate ? (
        <button
          type="button"
          class="expandable-task-objective-activate"
          aria-expanded={props.activateExpanded}
          aria-controls={props.activateControls}
          onClick={props.onActivate}
        >
          {textNode}
        </button>
      ) : textNode}
      {overflowing ? (
        <button
          type="button"
          class="expandable-task-objective-toggle"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={action}
          title={action}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((current) => !current);
          }}
        >
          <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
          <span>{action}</span>
        </button>
      ) : null}
    </span>
  );
}
