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

  it('renders all 11 harness guide sections with pain points, solutions, and tips', () => {
    render(<GuidePage />);

    expect(screen.getByTestId('guide-page')).toBeDefined();
    expect(screen.getByText('guide.title')).toBeDefined();

    for (const id of GUIDE_SECTION_IDS) {
      expect(screen.getByText(`guide.sections.${id}.pill`)).toBeDefined();
      expect(screen.getByText(`guide.sections.${id}.title`)).toBeDefined();
      expect(screen.getByText(`guide.sections.${id}.pain`)).toBeDefined();
      expect(screen.getByText(`guide.sections.${id}.solution`)).toBeDefined();
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
    expect(screen.queryByText('guide.sections.controlledNodes.pain')).toBeNull();

    const pillBtn = screen.getByRole('button', { name: /guide\.sections\.controlledNodes\.pill/ });
    fireEvent.click(pillBtn);

    expect(pillBtn.getAttribute('aria-current')).toBe('location');
    expect(screen.getByText('guide.sections.controlledNodes.pain')).toBeDefined();
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});
