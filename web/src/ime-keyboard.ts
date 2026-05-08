type MaybeKeyboardEvent = {
  isComposing?: boolean;
  key?: string;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

export function isImeComposingKeyEvent(event: MaybeKeyboardEvent): boolean {
  return event.isComposing === true
    || event.nativeEvent?.isComposing === true
    || event.keyCode === 229
    || event.nativeEvent?.keyCode === 229
    || event.key === 'Process';
}
