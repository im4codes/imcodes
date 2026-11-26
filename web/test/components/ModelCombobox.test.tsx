/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { ModelCombobox } from '../../src/components/ModelCombobox.js';

describe('ModelCombobox', () => {
  afterEach(cleanup);

  it('shows the complete catalog on focus even when a default is pre-filled', () => {
    render(<ModelCombobox value="default-model" options={['default-model', 'other-model', 'third-model']} onChange={vi.fn()} />);
    const input = screen.getByRole('combobox');
    expect((input as HTMLInputElement).value).toBe('default-model');
    fireEvent.focus(input);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('option', { name: 'default-model' }).getAttribute('aria-selected')).toBe('true');
  });

  it('filters only after editing and selecting an option updates the value', () => {
    const onChange = vi.fn();
    render(<ModelCombobox value="default-model" options={['default-model', 'other-model', 'third-model']} onChange={onChange} />);
    const input = screen.getAllByRole('combobox')[0];
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: 'third' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: 'third-model' }));
    expect(onChange).toHaveBeenLastCalledWith('third-model');
  });

  it('keeps custom model ids as free text', () => {
    const onChange = vi.fn();
    render(<ModelCombobox value="default-model" options={['default-model']} onChange={onChange} />);
    fireEvent.input(screen.getAllByRole('combobox')[0], { target: { value: 'vendor/custom-model' } });
    expect(onChange).toHaveBeenLastCalledWith('vendor/custom-model');
  });
});
