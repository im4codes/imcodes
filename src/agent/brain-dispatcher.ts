export type CoreCommand =
  | { type: 'worker'; workerId: string; message: string }
  | { type: 'brain'; message: string }
  | { type: 'status'; args: string[] }
  | { type: 'screen'; args: string[] }
  | { type: 'reply'; message: string }
  | { type: 'ask'; workerId: string; question: string };

export type ExtensionCommand =
  | { type: 'audit'; workerId: string }
  | { type: 'approve'; workerId: string }
  | { type: 'reject'; workerId: string; findings: string }
  | { type: 'merge'; workerId: string }
  | { type: 'custom'; name: string; args: string[] };

export type BrainCommand = CoreCommand | ExtensionCommand;

export interface BrainDispatcherOpts {
  projectName: string;
  sendToWorker: (workerId: string, message: string) => Promise<void>;
  sendToBrain: (message: string) => Promise<void>;
}

type CommandHandler = (args: string[]) => Promise<unknown> | unknown;

export class BrainDispatcher {
  private projectName: string;
  private sendToWorker: (workerId: string, message: string) => Promise<void>;
  private sendToBrain: (message: string) => Promise<void>;
  private commandHandlers: Map<string, CommandHandler> = new Map();
  private autoFixEnabled = false;

  constructor(opts: BrainDispatcherOpts) {
    this.projectName = opts.projectName;
    this.sendToWorker = opts.sendToWorker;
    this.sendToBrain = opts.sendToBrain;
  }

  /** Register a per-command-type handler. Called with parsed args as string array. */
  registerCommand(type: string, handler: CommandHandler): void {
    this.commandHandlers.set(type, handler);
  }

  /** Enable auto-fix extension commands (@audit, @approve, @reject, @merge) */
  registerAutoFixExtensions(): void {
    this.autoFixEnabled = true;
  }

  /** Parse a single line. Returns undefined if not a recognized command. */
  parseLine(line: string): BrainCommand | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('@')) return undefined;

    let m: RegExpMatchArray | null;

    // @w<N> <message>
    m = trimmed.match(/^@w(\d+)\s+(.+)$/is);
    if (m) {
      this._callHandler('worker', [`w${m[1]}`, m[2].trim()]);
      return { type: 'worker', workerId: `w${m[1]}`, message: m[2].trim() };
    }

    // @brain <message>
    m = trimmed.match(/^@brain\s+(.+)$/is);
    if (m) {
      this._callHandler('brain', [m[1].trim()]);
      return { type: 'brain', message: m[1].trim() };
    }

    // @status
    if (/^@status\s*$/i.test(trimmed)) {
      this._callHandler('status', []);
      return { type: 'status', args: [] };
    }

    // @screen w<N>
    m = trimmed.match(/^@screen\s+(w\d+)\s*$/i);
    if (m) {
      this._callHandler('screen', [m[1]]);
      return { type: 'screen', args: [m[1]] };
    }

    // @reply <message>
    m = trimmed.match(/^@reply\s+(.+)$/is);
    if (m) {
      this._callHandler('reply', [m[1].trim()]);
      return { type: 'reply', message: m[1].trim() };
    }

    // @ask w<N> <question>
    m = trimmed.match(/^@ask\s+(w\d+)\s+(.+)$/is);
    if (m) {
      this._callHandler('ask', [m[1], m[2].trim()]);
      return { type: 'ask', workerId: m[1], question: m[2].trim() };
    }

    // Auto-fix extension commands
    if (this.autoFixEnabled) {
      m = trimmed.match(/^@audit\s+(w\d+)\s*$/i);
      if (m) {
        this._callHandler('audit', [m[1]]);
        return { type: 'audit', workerId: m[1] };
      }

      m = trimmed.match(/^@approve\s+(w\d+)\s*$/i);
      if (m) {
        this._callHandler('approve', [m[1]]);
        return { type: 'approve', workerId: m[1] };
      }

      m = trimmed.match(/^@reject\s+(w\d+)\s+(.+)$/is);
      if (m) {
        this._callHandler('reject', [m[1], m[2].trim()]);
        return { type: 'reject', workerId: m[1], findings: m[2].trim() };
      }

      m = trimmed.match(/^@merge\s+(w\d+)\s*$/i);
      if (m) {
        this._callHandler('merge', [m[1]]);
        return { type: 'merge', workerId: m[1] };
      }
    }

    // Custom registered commands: @<name> [args...]
    for (const [name] of this.commandHandlers) {
      const pattern = new RegExp(`^@${name}(?:\\s+(.+))?$`, 'is');
      m = trimmed.match(pattern);
      if (m) {
        const args = m[1] ? m[1].trim().split(/\s+/) : [];
        this._callHandler(name, args);
        return { type: 'custom', name, args };
      }
    }

    return undefined;
  }

  private _callHandler(type: string, args: string[]): void {
    const handler = this.commandHandlers.get(type);
    if (handler) void Promise.resolve(handler(args));
  }

  /** Parse a line, execute built-in routing, and call registered handlers */
  async dispatch(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed.startsWith('@')) return;

    const cmd = this.parseLine(trimmed);
    if (!cmd) return;

    switch (cmd.type) {
      case 'worker':
        await this.sendToWorker(cmd.workerId, cmd.message);
        break;
      case 'brain':
        await this.sendToBrain(cmd.message);
        break;
      case 'ask':
        await this.sendToWorker(cmd.workerId, cmd.question);
        break;
      case 'reply':
        await this.sendToBrain(cmd.message);
        break;
    }
  }

  /** Dispatch all @commands found in multi-line screen output */
  async dispatchAll(screenText: string): Promise<void> {
    const lines = screenText.split('\n');
    for (const line of lines) {
      await this.dispatch(line);
    }
  }
}
