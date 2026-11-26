/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { GUIDE_SECTION_IDS, GuidePage } from '../../src/pages/GuidePage.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('GuidePage', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders all 11 concise feature guide sections with summaries and tips (without pain points)', () => {
    render(<GuidePage />);

    expect(screen.getByTestId('guide-page')).toBeDefined();
    expect(screen.getByText('guide.title')).toBeDefined();
    expect(document.querySelector('.guide-block-pain')).toBeNull();
    expect(screen.queryByText('guide.pain_label')).toBeNull();

    for (const id of GUIDE_SECTION_IDS) {
      expect(screen.getByText(`guide.sections.${id}.pill`)).toBeDefined();
      expect(screen.getByText(`guide.sections.${id}.title`)).toBeDefined();
      expect(screen.getByText(`guide.sections.${id}.summary`)).toBeDefined();
      expect(screen.queryByText(`guide.sections.${id}.pain`)).toBeNull();
      expect(screen.getByText(`guide.sections.${id}.tip_1`)).toBeDefined();
      expect(screen.getByText(`guide.sections.${id}.tip_2`)).toBeDefined();
      expect(screen.getByText(`guide.sections.${id}.tip_3`)).toBeDefined();
    }
  });

  it('supports collapsing all, expanding via quick-jump pill, and scrolling to the section', () => {
    render(<GuidePage />);

    const targetCard = document.querySelector('[data-guide-section="controlledNodes"]') as HTMLElement;
    const scrollIntoViewMock = vi.fn();
    targetCard.scrollIntoView = scrollIntoViewMock;

    fireEvent.click(screen.getByRole('button', { name: 'guide.collapse_all' }));
    expect(screen.queryByText('guide.sections.controlledNodes.summary')).toBeNull();

    const pillBtn = screen.getByRole('button', { name: /guide\.sections\.controlledNodes\.pill/ });
    fireEvent.click(pillBtn);

    expect(pillBtn.getAttribute('aria-current')).toBe('location');
    expect(screen.getByText('guide.sections.controlledNodes.summary')).toBeDefined();
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});
