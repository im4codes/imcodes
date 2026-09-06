import {
  MEMORY_MCP_RESOURCE_ERROR,
  TASK_ADMISSION,
  TASK_ADMISSION_QUEUE_RATIO,
  type TaskAdmission,
} from '../../shared/session-resource-lifecycle.js';

export interface MemoryMcpResourceGuardOptions {
  maxConcurrent: number;
  maxRssBytes: number;
  requestTimeoutMs: number;
  memoryUsage?: () => { rss: number };
  cpuStrikeLimit?: number;
  cpuRatioThreshold?: number;
  onSustainedCpu?: (details: { cpuRatio: number; strikes: number }) => void;
}

export interface DaemonTaskAdmissionSnapshot {
  daemonRssBytes: number;
  daemonMaxRssBytes: number;
  sessionReservedBytes: number;
  sessionMaxBytes: number;
  systemFreeBytes: number;
  systemMinFreeBytes: number;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_${name}`);
  return value;
}

export class MemoryMcpResourceGuard {
  private active = 0;
  private cpuStrikes = 0;
  private cpuAlarmRaised = false;
  private readonly options: Required<Omit<MemoryMcpResourceGuardOptions, 'onSustainedCpu'>>
    & Pick<MemoryMcpResourceGuardOptions, 'onSustainedCpu'>;

  constructor(options: MemoryMcpResourceGuardOptions) {
    this.options = {
      maxConcurrent: positiveFinite(options.maxConcurrent, 'max_concurrent'),
      maxRssBytes: positiveFinite(options.maxRssBytes, 'max_rss_bytes'),
      requestTimeoutMs: positiveFinite(options.requestTimeoutMs, 'request_timeout_ms'),
      memoryUsage: options.memoryUsage ?? process.memoryUsage,
      cpuStrikeLimit: positiveFinite(options.cpuStrikeLimit ?? 3, 'cpu_strike_limit'),
      cpuRatioThreshold: positiveFinite(options.cpuRatioThreshold ?? 0.9, 'cpu_ratio_threshold'),
      onSustainedCpu: options.onSustainedCpu,
    };
  }

  async run<T>(operationName: string, operation: () => Promise<T> | T): Promise<T> {
    if (!operationName) throw new Error('invalid_memory_mcp_operation');
    if (this.active >= this.options.maxConcurrent) throw new Error(MEMORY_MCP_RESOURCE_ERROR.CONCURRENCY_LIMIT);
    if (this.options.memoryUsage().rss > this.options.maxRssBytes) throw new Error(MEMORY_MCP_RESOURCE_ERROR.MEMORY_LIMIT);
    this.active += 1;
    let timeout: NodeJS.Timeout | undefined;
    const underlying = Promise.resolve().then(operation);
    void underlying.finally(() => { this.active -= 1; }).catch(() => {});
    try {
      return await Promise.race([
        underlying,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`${MEMORY_MCP_RESOURCE_ERROR.REQUEST_TIMEOUT}:${operationName}`)), this.options.requestTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  observeCpuWindow(cpuMicros: number, wallMs: number): void {
    if (!Number.isFinite(cpuMicros) || cpuMicros < 0 || !Number.isFinite(wallMs) || wallMs <= 0) return;
    const cpuRatio = cpuMicros / (wallMs * 1_000);
    if (cpuRatio >= this.options.cpuRatioThreshold) {
      this.cpuStrikes += 1;
      if (!this.cpuAlarmRaised && this.cpuStrikes >= this.options.cpuStrikeLimit) {
        this.cpuAlarmRaised = true;
        this.options.onSustainedCpu?.({ cpuRatio, strikes: this.cpuStrikes });
      }
      return;
    }
    this.cpuStrikes = 0;
    this.cpuAlarmRaised = false;
  }

  memoryLimitExceeded(): boolean {
    return this.options.memoryUsage().rss > this.options.maxRssBytes;
  }
}

function invalidAdmissionSnapshot(snapshot: DaemonTaskAdmissionSnapshot): boolean {
  return Object.values(snapshot).some((value) => !Number.isFinite(value) || value < 0)
    || snapshot.daemonMaxRssBytes <= 0 || snapshot.sessionMaxBytes <= 0;
}

export function evaluateDaemonTaskAdmission(snapshot: DaemonTaskAdmissionSnapshot): TaskAdmission {
  if (invalidAdmissionSnapshot(snapshot)) return TASK_ADMISSION.REJECT;
  if (snapshot.daemonRssBytes >= snapshot.daemonMaxRssBytes
    || snapshot.sessionReservedBytes >= snapshot.sessionMaxBytes
    || snapshot.systemFreeBytes <= snapshot.systemMinFreeBytes) return TASK_ADMISSION.REJECT;
  if (snapshot.daemonRssBytes >= snapshot.daemonMaxRssBytes * TASK_ADMISSION_QUEUE_RATIO
    || snapshot.sessionReservedBytes >= snapshot.sessionMaxBytes * TASK_ADMISSION_QUEUE_RATIO
    || snapshot.systemFreeBytes <= snapshot.systemMinFreeBytes / TASK_ADMISSION_QUEUE_RATIO) return TASK_ADMISSION.QUEUE;
  return TASK_ADMISSION.ACCEPT;
}
