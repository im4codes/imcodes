export interface PreviewReadFanOutClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface PreviewReadFanOutRecord<TMessage> {
  requestId: string;
  rawPath: string;
  deadlineAt: number;
  onTimeout: () => TMessage;
}

export interface PreviewReadFanOutRequestView {
  requestId: string;
  rawPath: string;
  deadlineAt: number;
  terminal: boolean;
  terminalReason?: string;
}

interface FanOutRecord<TMessage> extends PreviewReadFanOutRecord<TMessage> {
  terminal: boolean;
  terminalReason?: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PreviewReadFanOutOptions<TMessage> {
  clock?: PreviewReadFanOutClock;
  send(message: TMessage): void | Promise<void>;
  onTerminal?: (requestId: string, reason: string) => void;
  onSendError?: (error: unknown) => void;
}

const realClock: PreviewReadFanOutClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class PreviewReadFanOutDispatcher<TMessage> {
  private readonly clock: PreviewReadFanOutClock;
  private readonly sendImpl: (message: TMessage) => void | Promise<void>;
  private readonly onTerminal?: (requestId: string, reason: string) => void;
  private readonly onSendError?: (error: unknown) => void;
  private readonly records = new Map<string, FanOutRecord<TMessage>>();
  private sendTail: Promise<void> = Promise.resolve();

  constructor(options: PreviewReadFanOutOptions<TMessage>) {
    this.clock = options.clock ?? realClock;
    this.sendImpl = options.send;
    this.onTerminal = options.onTerminal;
    this.onSendError = options.onSendError;
  }

  register(record: PreviewReadFanOutRecord<TMessage>): boolean {
    if (this.records.has(record.requestId)) return false;
    const delayMs = Math.max(0, record.deadlineAt - this.clock.now());
    const fanOutRecord: FanOutRecord<TMessage> = {
      ...record,
      terminal: false,
      timer: null,
    };
    fanOutRecord.timer = this.clock.setTimeout(() => {
      this.timeoutRecord(record.requestId);
    }, delayMs);
    this.records.set(record.requestId, fanOutRecord);
    return true;
  }

  has(requestId: string): boolean {
    return this.records.has(requestId);
  }

  getRequestView(requestId: string): PreviewReadFanOutRequestView | null {
    const record = this.records.get(requestId);
    if (!record) return null;
    return {
      requestId: record.requestId,
      rawPath: record.rawPath,
      deadlineAt: record.deadlineAt,
      terminal: record.terminal,
      ...(record.terminalReason ? { terminalReason: record.terminalReason } : {}),
    };
  }

  sendTerminal(requestId: string, buildMessage: () => TMessage, reason = 'complete'): boolean {
    const record = this.records.get(requestId);
    if (!record || record.terminal) return false;
    this.enqueue(async () => {
      const current = this.records.get(requestId);
      if (!current || current.terminal) return;
      if (this.clock.now() >= current.deadlineAt) {
        const message = current.onTimeout();
        this.markTerminal(current, 'timeout');
        await this.safeSend(message);
        return;
      }
      const message = buildMessage();
      this.markTerminal(current, reason);
      await this.safeSend(message);
    });
    return true;
  }

  sendTerminalMany(
    requestIds: Iterable<string>,
    buildMessage: (requestId: string) => TMessage,
    reason = 'complete',
  ): number {
    let count = 0;
    for (const requestId of requestIds) {
      if (this.sendTerminal(requestId, () => buildMessage(requestId), reason)) count += 1;
    }
    return count;
  }

  forceTerminal(requestId: string, buildMessage: () => TMessage, reason = 'forced'): boolean {
    const record = this.records.get(requestId);
    if (!record || record.terminal) return false;
    const message = buildMessage();
    this.markTerminal(record, reason);
    this.enqueue(async () => {
      await this.safeSend(message);
    });
    return true;
  }

  sendDetached(message: TMessage): void {
    this.enqueue(async () => {
      await this.safeSend(message);
    });
  }

  cancel(requestId: string, reason = 'cancelled'): boolean {
    const record = this.records.get(requestId);
    if (!record || record.terminal) return false;
    this.markTerminal(record, reason);
    return true;
  }

  async flush(): Promise<void> {
    await this.sendTail;
  }

  clear(): void {
    for (const record of this.records.values()) {
      if (record.timer) this.clock.clearTimeout(record.timer);
    }
    this.records.clear();
  }

  private timeoutRecord(requestId: string): void {
    const record = this.records.get(requestId);
    if (!record || record.terminal) return;
    const message = record.onTimeout();
    this.markTerminal(record, 'timeout');
    this.enqueue(async () => {
      await this.safeSend(message);
    });
  }

  private markTerminal(record: FanOutRecord<TMessage>, reason: string): void {
    if (record.terminal) return;
    record.terminal = true;
    record.terminalReason = reason;
    if (record.timer) {
      this.clock.clearTimeout(record.timer);
      record.timer = null;
    }
    this.records.delete(record.requestId);
    this.onTerminal?.(record.requestId, reason);
  }

  private enqueue(operation: () => Promise<void>): void {
    this.sendTail = this.sendTail
      .then(operation, operation)
      .catch((error) => {
        this.onSendError?.(error);
      });
  }

  private async safeSend(message: TMessage): Promise<void> {
    try {
      await this.sendImpl(message);
    } catch (error) {
      this.onSendError?.(error);
    }
  }
}
