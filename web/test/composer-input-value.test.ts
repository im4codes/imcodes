import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readComposerInputValue, writeComposerInputValue } from '../src/composer-input-value.js';

describe('composer input value adapter', () => {
  it('uses textarea.value for the macOS native host and textContent for contenteditable', () => {
    const textarea = document.createElement('textarea');
    textarea.textContent = 'stale markup';
    textarea.value = 'native draft';
    expect(readComposerInputValue(textarea)).toBe('native draft');
    writeComposerInputValue(textarea, 'updated draft');
    expect(textarea.value).toBe('updated draft');
    expect(textarea.textContent).toBe('stale markup');

    const contenteditable = document.createElement('div');
    contenteditable.textContent = 'editable draft';
    expect(readComposerInputValue(contenteditable)).toBe('editable draft');
    writeComposerInputValue(contenteditable, 'updated editable');
    expect(contenteditable.textContent).toBe('updated editable');
  });

  it('keeps external file insertion and execution-clone reads on the adapter', () => {
    const sourceFiles = [
      'src/components/SessionPane.tsx',
      'src/components/SubSessionWindow.tsx',
      'src/components/pinnedPanelTypes.tsx',
      'src/app.tsx',
    ].map((file) => readFileSync(resolve(__dirname, '..', file), 'utf8'));
    expect(sourceFiles[0]).toContain('readComposerInputValue(inputRef.current)');
    expect(sourceFiles[1]).toContain('readComposerInputValue(inputRef.current)');
    expect(sourceFiles[2]).toContain('writeComposerInputValue(inputEl');
    expect(sourceFiles[3]).toContain('writeComposerInputValue(element');
    expect(sourceFiles.join('\n')).not.toContain('inputEl.textContent');
  });
});
