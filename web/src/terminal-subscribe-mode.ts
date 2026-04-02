export type TerminalSubscribeViewMode = 'terminal' | 'chat';

export function shouldSubscribeTerminalRaw(activeSurface: boolean, viewMode: TerminalSubscribeViewMode): boolean {
  return activeSurface && viewMode === 'terminal';
}
