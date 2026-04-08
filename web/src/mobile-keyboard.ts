export interface MobileKeyboardState {
  kbOpen: boolean;
  hideInputUi: boolean;
  hadKeyboardOpen: boolean;
}

export function getMobileKeyboardState(inputFocused: boolean, shrink: number, hadKeyboardOpen: boolean): MobileKeyboardState {
  const kbOpen = shrink > 40 || (inputFocused && shrink > 15);
  const nextHadKeyboardOpen = inputFocused ? (hadKeyboardOpen || kbOpen) : false;
  const hideInputUi = inputFocused && (!nextHadKeyboardOpen || kbOpen);
  return {
    kbOpen,
    hideInputUi,
    hadKeyboardOpen: nextHadKeyboardOpen,
  };
}
