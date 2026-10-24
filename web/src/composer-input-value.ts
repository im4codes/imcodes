/** The external composer handle is a textarea on macOS and contenteditable elsewhere. */
export type ComposerInputElement = HTMLDivElement | HTMLTextAreaElement;

export function readComposerInputValue(input: ComposerInputElement | null | undefined): string {
  if (!input) return '';
  return input.tagName === 'TEXTAREA'
    ? (input as HTMLTextAreaElement).value
    : (input.textContent ?? '');
}

export function writeComposerInputValue(input: ComposerInputElement, value: string): void {
  if (input.tagName === 'TEXTAREA') (input as HTMLTextAreaElement).value = value;
  else input.textContent = value;
}
