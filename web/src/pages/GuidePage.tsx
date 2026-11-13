import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';

export const GUIDE_SECTION_IDS = [
  'overview',
  'team',
  'taskPairs',
  'executionPools',
  'controlledNodes',
  'remoteDesktopOcu',
  'quickInputVoice',
  'aliasesVerification',
  'isolationLiveness',
  'memoryIdentity',
  'autoCronMobile',
] as const;

export type GuideSectionId = (typeof GUIDE_SECTION_IDS)[number];

interface GuideSectionDef {
  id: GuideSectionId;
  num: string;
}

const GUIDE_SECTIONS: readonly GuideSectionDef[] = GUIDE_SECTION_IDS.map((id, idx) => ({
  id,
  num: String(idx + 1).padStart(2, '0'),
}));

const TIP_KEYS = ['tip_1', 'tip_2', 'tip_3'] as const;

export interface GuidePageProps {
  initialSection?: GuideSectionId;
}

/**
 * Standalone User Guide explaining IM.codes features and how the harness solves
 * real-world AI coding pain points across terminal and SDK agent workflows.
 */
export function GuidePage({ initialSection }: GuidePageProps = {}) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<GuideSectionId>(initialSection ?? 'overview');
  const [expandedIds, setExpandedIds] = useState<Record<GuideSectionId, boolean>>(() => {
    const initial = {} as Record<GuideSectionId, boolean>;
    for (const id of GUIDE_SECTION_IDS) initial[id] = true;
    return initial;
  });

  const allExpanded = GUIDE_SECTION_IDS.every((id) => expandedIds[id]);

  const handleToggleAll = () => {
    const nextState = !allExpanded;
    const next = {} as Record<GuideSectionId, boolean>;
    for (const id of GUIDE_SECTION_IDS) next[id] = nextState;
    setExpandedIds(next);
  };

  const handleToggleSection = (id: GuideSectionId) => {
    setActiveId(id);
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleJumpTo = (id: GuideSectionId) => {
    setActiveId(id);
    setExpandedIds((prev) => ({ ...prev, [id]: true }));
    const target = typeof document !== 'undefined'
      ? document.querySelector(`[data-guide-section="${id}"]`)
      : null;
    if (target && typeof (target as HTMLElement).scrollIntoView === 'function') {
      (target as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div class="guide-page" data-testid="guide-page">
      <section class="guide-hero">
        <div class="guide-hero-top">
          <div class="guide-hero-text">
            <div class="guide-kicker">{t('guide.kicker')}</div>
            <h2 class="guide-title">{t('guide.title')}</h2>
            <p class="guide-subtitle">{t('guide.subtitle')}</p>
          </div>
          <button
            type="button"
            class="guide-toggle-all-btn"
            onClick={handleToggleAll}
          >
            {allExpanded ? t('guide.collapse_all') : t('guide.expand_all')}
          </button>
        </div>

        <div class="guide-quick-jump-label">{t('guide.quick_jump')}</div>
        <nav class="guide-pills" aria-label={t('guide.quick_jump')}>
          {GUIDE_SECTIONS.map((section) => {
            const isActive = activeId === section.id;
            return (
              <button
                key={section.id}
                type="button"
                class={`guide-pill${isActive ? ' is-active' : ''}`}
                aria-current={isActive ? 'location' : undefined}
                onClick={() => handleJumpTo(section.id)}
              >
                <span class="guide-pill-num" aria-hidden="true">{section.num}</span>
                <span class="guide-pill-label">{t(`guide.sections.${section.id}.pill`)}</span>
              </button>
            );
          })}
        </nav>
      </section>

      <div class="guide-cards">
        {GUIDE_SECTIONS.map((section) => {
          const expanded = expandedIds[section.id];
          const isActive = activeId === section.id;
          return (
            <article
              key={section.id}
              data-guide-section={section.id}
              class={`guide-card${isActive ? ' is-active' : ''}${expanded ? ' is-expanded' : ''}`}
            >
              <button
                type="button"
                class="guide-card-header"
                aria-expanded={expanded}
                onClick={() => handleToggleSection(section.id)}
              >
                <span class="guide-card-num" aria-hidden="true">{section.num}</span>
                <span class="guide-card-heading">
                  <span class="guide-card-title">{t(`guide.sections.${section.id}.title`)}</span>
                  <span class="guide-card-tagline">{t(`guide.sections.${section.id}.tagline`)}</span>
                </span>
                <span class="guide-card-chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
              </button>

              {expanded && (
                <div class="guide-card-body">
                  <div class="guide-block guide-block-summary">
                    <p class="guide-block-text">{t(`guide.sections.${section.id}.summary`)}</p>
                  </div>

                  <div class="guide-block guide-block-tips">
                    <div class="guide-block-label">{t('guide.tips_label')}</div>
                    <ul class="guide-tips-list">
                      {TIP_KEYS.map((tipKey) => (
                        <li key={tipKey}>{t(`guide.sections.${section.id}.${tipKey}`)}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
