/**
 * Terminal text extraction from raw PTY stream.
 * RawStreamParser handles chunk-boundary UTF-8/ANSI fragments and CR/LF semantics.
 * Completed lines are classified and throttled into assistant.text timeline events.
 */

import { timelineEmitter } from './timeline-emitter.js';

// ── ANSI stripping ───────────────────────────────────────────────────────────

const ANSI_CSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const ANSI_OSC = /\x1b\].*?\x07/g;
const ANSI_OTHER = /\x1b[^[\]].?/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, '').replace(ANSI_OSC, '').replace(ANSI_OTHER, '');
}

// ── Line classification ──────────────────────────────────────────────────────

export type LineClass = 'HIDE' | 'MUTED' | 'KEEP';

const BRAILLE_RANGE = /^[\u2800-\u28FF\s]+$/;
const HIDE_EXACT = new Set([
  'How is Claude doing this session?',
  'How is Claude doing this session',
]);

// Box-drawing: U+2500-U+257F
const BOX_DRAWING = /[\u2500-\u257F]/g;

// Claude Code UI chrome patterns — these are tool/status lines, not assistant text
const CC_CHROME_PATTERNS = [
  /^[>❯]\s*(Read|Edit|Write|Bash|Grep|Glob|Agent|Skill|WebFetch|WebSearch|LSP|NotebookEdit|TodoWrite|AskUserQuestion|TaskCreate|TaskUpdate|TaskGet|TaskList|TaskOutput|TaskStop|ToolSearch|EnterPlanMode|ExitPlanMode)\b/,
  /^[<]\s*(done|error|result)/i,
  /^[*●○◉⬤]\s*(Accomplishing|Thinking|Working|Reading|Searching|Running|Generating|Planning|Waiting)/i,
  // "Agent working.•." / "Agent idle - waiting for input" / "Agent running..." Claude Code status lines
  /^Agent\s+(working|idle|running|thinking|stopped|paused|waiting)/i,
  /^Agent\s+idle\s*[-–]/i,
  /^\s*[LI⎿├│└┌─]\s/,  // tree/indent markers
  /^Running\.*\s*\(\d/,  // "Running... (23s..."
  /^thought for/i,
  /^\d+[smh]\s*[·•]\s*(timeout|tokens)/,  // "23s · timeout 2m 30s"
  /^ctrl\+/i,  // "ctrl+b ctrl+b..."
  /^Co-Authored-By:/,
  /^EOF$/,
  // Claude Code TUI tool-execution status lines (ink full-screen redraw emits these every tick)
  /^[\u23F5\u23F8\u23F9\u25B6\u25A0]/,  // ⏵ ⏸ ⏹ ▶ ■ — tool spinner/status prefixes
  /\(running\)\s*$/,                     // "... (running)"
  /\(\d+(\.\d+)?s(\s+elapsed)?\)\s*$/,  // "... (5s)" or "... (5s elapsed)"
  /^[✓✗]\s*(Read|Edit|Write|Bash|Grep|Glob|Agent|Skill|WebFetch|WebSearch|LSP|NotebookEdit|TodoWrite|AskUserQuestion|TaskCreate|TaskUpdate|TaskGet|TaskList|TaskOutput|TaskStop|ToolSearch)\b/, // tool result lines
  /^⎿/,                                  // result indent (U+2B3F)
  /^[·•]\s*(done|error|result|output|result)/i,
  /^\s*Context\s+[\u2580-\u259F\u2588█░▒▓]/,  // "Context ████░░░" progress bar
  /^\s*(Context|Usage)\s+\d+%/,          // "Context 75%" / "Usage 66%"
  /^\s*\d+\s+(CLAUDE\.md|hooks?)/i,      // "1 CLAUDE.md | 4 hooks"
  /^\s*[✓✗]\s+Bash\s+×/,                // "✓ Bash ×11"
];

export function classifyLine(stripped: string): LineClass {
  const trimmed = stripped.trim();
  if (!trimmed) return 'HIDE';

  if (HIDE_EXACT.has(trimmed)) return 'HIDE';

  for (const pat of CC_CHROME_PATTERNS) {
    if (pat.test(trimmed)) return 'HIDE';
  }

  if (BRAILLE_RANGE.test(trimmed)) return 'HIDE';

  const nonWs = trimmed.replace(/\s/g, '');
  if (nonWs.length > 0) {
    const boxCount = (nonWs.match(BOX_DRAWING) ?? []).length;
    if (boxCount / nonWs.length > 0.8) return 'MUTED';
  }

  return 'KEEP';
}

// ── RawStreamParser ──────────────────────────────────────────────────────────

/**
 * Per-session streaming parser for raw PTY bytes.
 * Handles UTF-8 multi-byte fragments, ANSI escape fragments, and CR/LF semantics
 * across arbitrary chunk boundaries.
 *
 * CR semantics:
 *   \r\n  → CRLF: emit current line as completed
 *   \r<X> → pure CR overwrite: discard current line (spinner/progress bar redraw)
 *   \n    → LF only: emit current line as completed
 */
export class RawStreamParser {
  private utf8Pending: number[] = [];     // incomplete multi-byte UTF-8 sequence
  private ansiBuffer = '';               // incomplete ANSI escape sequence
  private inAnsi = false;                // currently inside an ANSI sequence
  private currentLine = '';             // accumulated text for current line
  private crPending = false;            // last char was \r, waiting to see next

  /**
   * Feed a raw PTY chunk. Returns completed new lines (stripped of ANSI,
   * after carriage-return overwrite logic applied).
   */
  feed(chunk: Buffer): string[] {
    // 1. Prepend any pending UTF-8 bytes from previous chunk
    let buf: Buffer;
    if (this.utf8Pending.length > 0) {
      buf = Buffer.concat([Buffer.from(this.utf8Pending), chunk]);
      this.utf8Pending = [];
    } else {
      buf = chunk;
    }

    // 2. Split off incomplete trailing UTF-8 sequence
    const split = splitIncompleteUtf8(buf);
    if (split.pending.length > 0) {
      this.utf8Pending = Array.from(split.pending);
    }

    // 3. Decode safe portion to string
    const str = split.safe.toString('utf8');

    // 4. Scan characters
    const completed: string[] = [];

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];

      // ANSI sequence handling
      if (this.inAnsi) {
        this.ansiBuffer += ch;
        // ANSI sequences end with a letter (C0 letters, m, J, H, etc.)
        if (/[a-zA-Z]/.test(ch)) {
          this.inAnsi = false;
          this.ansiBuffer = '';
        }
        continue;
      }

      if (ch === '\x1b') {
        // Start of escape sequence
        this.inAnsi = true;
        this.ansiBuffer = ch;
        continue;
      }

      if (ch === '\r') {
        if (this.crPending) {
          // Double CR — treat first CR as overwrite (discard line), start fresh
          this.currentLine = '';
        }
        this.crPending = true;
        continue;
      }

      if (ch === '\n') {
        if (this.crPending) {
          // CRLF: emit current line
          completed.push(this.currentLine);
          this.currentLine = '';
          this.crPending = false;
        } else {
          // Pure LF: emit current line
          completed.push(this.currentLine);
          this.currentLine = '';
        }
        continue;
      }

      // Regular character
      if (this.crPending) {
        // Pure CR (not followed by \n): overwrite — discard current line
        this.currentLine = '';
        this.crPending = false;
      }

      this.currentLine += ch;
    }

    return completed;
  }

  /** Currently accumulated (not yet completed) line text. */
  pending(): string {
    return this.currentLine;
  }

  /** Reset all parser state (e.g. on session restart). */
  reset(): void {
    this.utf8Pending = [];
    this.ansiBuffer = '';
    this.inAnsi = false;
    this.currentLine = '';
    this.crPending = false;
  }
}

/**
 * Split a buffer at the last complete UTF-8 character boundary.
 * Returns { safe: complete bytes, pending: incomplete trailing bytes }.
 */
function splitIncompleteUtf8(buf: Buffer): { safe: Buffer; pending: Buffer } {
  if (buf.length === 0) return { safe: buf, pending: Buffer.alloc(0) };

  // Find where trailing incomplete sequence starts (if any)
  let i = buf.length - 1;
  while (i >= 0 && i >= buf.length - 4) {
    const b = buf[i];
    if ((b & 0x80) === 0) {
      // ASCII byte — fully valid, no pending
      return { safe: buf, pending: Buffer.alloc(0) };
    }
    if ((b & 0xC0) === 0xC0) {
      // Start of multi-byte sequence
      const seqLen = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : 2;
      const remaining = buf.length - i;
      if (remaining < seqLen) {
        // Incomplete sequence at end
        return { safe: buf.slice(0, i), pending: buf.slice(i) };
      }
      // Complete sequence
      return { safe: buf, pending: Buffer.alloc(0) };
    }
    // Continuation byte (0x80-0xBF) — keep scanning backwards
    i--;
  }

  return { safe: buf, pending: Buffer.alloc(0) };
}

// ── Per-session parser instances ─────────────────────────────────────────────

const parsers = new Map<string, RawStreamParser>();

function getOrCreateParser(sessionName: string): RawStreamParser {
  let parser = parsers.get(sessionName);
  if (!parser) {
    parser = new RawStreamParser();
    parsers.set(sessionName, parser);
  }
  return parser;
}

export function resetParser(sessionName: string): void {
  parsers.get(sessionName)?.reset();
  parsers.delete(sessionName);
}

// ── Streaming text accumulator (per-session throttle) ────────────────────────

const THROTTLE_MS = 500;

interface SessionAcc {
  pendingText: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** Lines seen in current throttle window — prevents duplicate lines from TUI redraws. */
  seenLines: Set<string>;
}

const accumulators = new Map<string, SessionAcc>();

function getAcc(sessionName: string): SessionAcc {
  let acc = accumulators.get(sessionName);
  if (!acc) {
    acc = { pendingText: '', timer: null, seenLines: new Set() };
    accumulators.set(sessionName, acc);
  }
  return acc;
}

function flushAcc(sessionName: string): void {
  const acc = accumulators.get(sessionName);
  if (!acc || !acc.pendingText) return;

  timelineEmitter.emit(sessionName, 'assistant.text', {
    text: acc.pendingText,
    streaming: true,
  }, {
    source: 'terminal-parse',
    confidence: 'low',
  });

  acc.pendingText = '';
  acc.timer = null;
  acc.seenLines.clear();
}

/**
 * Process a raw PTY data chunk for a session.
 * Feeds into per-session RawStreamParser, classifies completed lines,
 * and throttles assistant.text emission.
 */
export function processRawPtyData(sessionName: string, data: Buffer): void {
  const parser = getOrCreateParser(sessionName);
  const newLines = parser.feed(data);

  if (newLines.length === 0) return;

  const acc = getAcc(sessionName);

  for (const line of newLines) {
    const stripped = stripAnsi(line).trimEnd();
    const cls = classifyLine(stripped);
    if (cls === 'KEEP' && !acc.seenLines.has(stripped)) {
      acc.seenLines.add(stripped);
      if (acc.pendingText) {
        acc.pendingText += '\n' + stripped;
      } else {
        acc.pendingText = stripped;
      }
    }
  }

  if (acc.pendingText && !acc.timer) {
    acc.timer = setTimeout(() => flushAcc(sessionName), THROTTLE_MS);
  }
}
