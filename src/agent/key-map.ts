/** Tmux key names → ANSI escape sequences. Shared by wezterm and conpty backends. */
export const TMUX_KEY_TO_ESCAPE: Record<string, string> = {
  'Enter': '\r',
  'Escape': '\x1b',
  'BSpace': '\x7f',
  'Up': '\x1b[A',
  'Down': '\x1b[B',
  'Right': '\x1b[C',
  'Left': '\x1b[D',
  'Home': '\x1b[H',
  'End': '\x1b[F',
  'DC': '\x1b[3~',    // Delete
  'IC': '\x1b[2~',    // Insert
  'PPage': '\x1b[5~', // Page Up
  'NPage': '\x1b[6~', // Page Down
  'BTab': '\x1b[Z',   // Shift+Tab
  'Tab': '\t',
  'Space': ' ',
  'F1': '\x1bOP', 'F2': '\x1bOQ', 'F3': '\x1bOR', 'F4': '\x1bOS',
  'F5': '\x1b[15~', 'F6': '\x1b[17~', 'F7': '\x1b[18~', 'F8': '\x1b[19~',
  'F9': '\x1b[20~', 'F10': '\x1b[21~', 'F11': '\x1b[23~', 'F12': '\x1b[24~',
};
