import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  AGY_HISTORY_LIMIT as LIMIT, AGY_NATIVE_FIELD as FIELD, AGY_NATIVE_STEP as STEP, AGY_NATIVE_DONE, AGY_NATIVE_ERROR,
  type AgyHistoryRequest, type AgyRecoveredResponse,
} from '../../shared/agy-native-history.js';
import { AGY_INDIVIDUAL_QUOTA_ERROR_PREFIX } from '../../shared/agy-agent.js';
import { spawnChildProcessWorker, type ChildProcessWorkerHandle } from '../util/child-process-worker.js';
import { resolveWorkerRuntime } from '../util/worker-runtime-port.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';

export function hashAgyPrompt(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Minimal, bounded protobuf wire reader. No heuristic text extraction. */
function fields(bytes: Uint8Array): Map<number, number | Uint8Array> {
  let offset = 0;
  const result = new Map<number, number | Uint8Array>();
  function integer(): number {
    let n = 0;
    for (let shift = 0; shift <= 49 && offset < bytes.length; shift += 7) {
      const b = bytes[offset++];
      n += (b & 127) * 2 ** shift;
      if (b < 128 && Number.isSafeInteger(n)) return n;
    }
    throw new Error('invalid protobuf varint');
  }
  while (offset < bytes.length) {
    const tag = integer();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!field) throw new Error('invalid protobuf field');
    if (result.has(field)) throw new Error('ambiguous protobuf field');
    if (wire === 0) result.set(field, integer());
    else if (wire === 2) {
      const length = integer();
      if (length > bytes.length - offset) throw new Error('truncated protobuf');
      result.set(field, bytes.subarray(offset, offset + length));
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('truncated protobuf');
    } else throw new Error('unsupported protobuf wire');
  }
  return result;
}
function blob(value: number | Uint8Array | undefined): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('missing protobuf message');
  return value;
}
function text(value: number | Uint8Array | undefined): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(blob(value));
}
function timestamp(metadata: Uint8Array, field: number): number {
  const stamp = fields(blob(fields(metadata).get(field)));
  const seconds = stamp.get(FIELD.SECONDS);
  const nanos = stamp.get(FIELD.NANOS) ?? 0;
  if (typeof seconds !== 'number' || typeof nanos !== 'number' || nanos >= 1e9) throw new Error('invalid timestamp');
  return seconds * 1000 + nanos / 1e6;
}
function validConversationId(id: string): boolean {
  return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
}
interface Row {
  idx: number; step_type: number; status: number; metadata: Uint8Array;
  error_bytes: number; payload_bytes: number;
}

/** ONLY called in the isolated reader process (also exported for fixture tests).
 * One SQLite snapshot, read-only, bounded tail. Never retries or alters a turn. */
export function recoverAgyResponseSync(request: AgyHistoryRequest): AgyRecoveredResponse | undefined {
  if (!path.isAbsolute(request.home) || !validConversationId(request.conversationId)
    || !/^[a-f\d]{64}$/.test(request.promptHash) || !request.error.startsWith(AGY_INDIVIDUAL_QUOTA_ERROR_PREFIX)
    || !Number.isFinite(request.sentAt) || !Number.isFinite(request.resultAt) || request.resultAt < request.sentAt) return;
  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    suppressSqliteExperimentalWarning();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new DatabaseSync(path.join(request.home, '.gemini', 'antigravity-cli', 'conversations', `${request.conversationId}.db`), { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0; BEGIN');
    const meta = db.prepare('SELECT cascade_id FROM trajectory_meta').all();
    if (meta.length !== 1 || meta[0].cascade_id !== request.conversationId) return;
    // Read only small headers, then the candidate input and final answer. Never
    // materialize a long conversation/tool transcript (production DBs exceed 200 MB).
    const rows = db.prepare(`SELECT idx,step_type,status,
      CASE WHEN length(metadata)<=? THEN metadata END AS metadata,
      COALESCE(length(error_details),0) AS error_bytes, COALESCE(length(step_payload),0) AS payload_bytes
      FROM steps ORDER BY idx DESC LIMIT ?`).all(LIMIT.METADATA_BYTES, LIMIT.ROWS) as unknown as Row[];
    rows.reverse();
    const candidates = rows.filter(row => row.step_type === STEP.USER_INPUT && row.status === AGY_NATIVE_DONE
      && row.error_bytes === 0 && row.metadata && timestamp(row.metadata, FIELD.CREATED_AT) >= request.sentAt
      && timestamp(row.metadata, FIELD.CREATED_AT) <= request.resultAt);
    if (candidates.length > LIMIT.INPUT_CANDIDATES) return;
    const payload = (row: Row): Uint8Array => {
      if (!row.payload_bytes || row.payload_bytes > LIMIT.ROW_BYTES) throw new Error('unsupported payload size');
      return db!.prepare('SELECT step_payload FROM steps WHERE idx=?').get(row.idx)!.step_payload as Uint8Array;
    };
    const matches = candidates.filter(row => {
      const user = fields(payload(row));
      return user.get(FIELD.TYPE) === STEP.USER_INPUT && user.get(FIELD.STATUS) === AGY_NATIVE_DONE
        && hashAgyPrompt(text(fields(blob(user.get(FIELD.USER))).get(FIELD.USER_TEXT))) === request.promptHash;
    });
    // Identical queued/concurrent inputs are deliberately ambiguous, not guessed.
    if (matches.length !== 1) return;
    const user = matches[0];
    const nextUser = rows.find(row => row.idx > user.idx && row.step_type === STEP.USER_INPUT);
    const turn = rows.filter(row => row.idx > user.idx && (!nextUser || row.idx < nextUser.idx));
    const last = turn.at(-1);
    if (!last || last.step_type !== STEP.AGENT_RESPONSE || turn.some((row, i) => row.status !== AGY_NATIVE_DONE
      || row.step_type === STEP.SYSTEM_ERROR || row.error_bytes > 0 || row.idx !== user.idx + i + 1)
      || turn.reduce((sum,row) => sum+row.payload_bytes,0) > LIMIT.TOTAL_BYTES) return;
    // The old error must be an ACTUAL native system-error step, not quoted text.
    const history = db.prepare(`SELECT status, metadata, step_payload FROM steps WHERE step_type=? AND idx<?
      AND length(step_payload)+COALESCE(length(metadata),0)<=? ORDER BY idx DESC LIMIT 1`).get(STEP.SYSTEM_ERROR, user.idx, LIMIT.ROW_BYTES);
    if (!history || history.status !== AGY_NATIVE_ERROR || timestamp(history.metadata as Uint8Array, FIELD.CREATED_AT) >= request.sentAt
      || !Buffer.from(history.step_payload as Uint8Array).includes(Buffer.from(request.error))) return;
    const historicalStep = fields(history.step_payload as Uint8Array);
    if (historicalStep.get(FIELD.TYPE) !== STEP.SYSTEM_ERROR || historicalStep.get(FIELD.STATUS) !== AGY_NATIVE_ERROR) return;
    const endedAt = timestamp(last.metadata, FIELD.ENDED_AT);
    if (endedAt < request.sentAt || endedAt > request.resultAt) return;
    const response = fields(payload(last));
    if (response.get(FIELD.TYPE) !== STEP.AGENT_RESPONSE || response.get(FIELD.STATUS) !== AGY_NATIVE_DONE) return;
    const body = fields(blob(response.get(FIELD.RESPONSE)));
    const answer = text(body.get(FIELD.RESPONSE_TEXT));
    // Verified versions persist two copies. Refuse changed/partial/unknown formats.
    if (!answer.trim() || answer !== text(body.get(FIELD.RESPONSE_TEXT_COPY))) return;
    return { userStepIndex: user.idx, responseStepIndex: last.idx, text: answer };
  } catch {
    return; // Missing DB, busy/changed schema, malformed/unknown protobuf: preserve CLI failure.
  } finally {
    db?.close();
  }
}

/** Lazy, reused OS worker: SQLite and native decoding never block the daemon. */
export class AgyHistoryReader {
  private worker?: ChildProcessWorkerHandle;
  private serial = 0;
  private pending = new Map<number, { finish: (value?: AgyRecoveredResponse) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly createWorker: typeof spawnChildProcessWorker = spawnChildProcessWorker) {}

  read(request: AgyHistoryRequest): Promise<AgyRecoveredResponse | undefined> {
    if (!validConversationId(request.conversationId)) return Promise.resolve(undefined);
    if (!this.worker) {
      try {
        const worker = this.createWorker(new URL('./agy-native-history-worker-bootstrap.mjs', import.meta.url));
        this.worker = worker;
        worker.unref();
        worker.on('message', (message: { id: number; response?: AgyRecoveredResponse }) => {
          if (this.worker !== worker) return;
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          pending.finish(message.response);
        });
        const down = () => { if (this.worker === worker) this.close(); };
        worker.on('error', down);
        worker.on('exit', down);
      } catch { return Promise.resolve(undefined); }
    }
    const id = ++this.serial;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.close(), LIMIT.TIMEOUT_MS);
      this.pending.set(id, { finish: resolve, timer });
      try { this.worker!.postMessage({ id, request }); } catch { this.close(); }
    });
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.close();
    if (worker) await new Promise<void>(resolve => {
      // The worker is unref'd. A referenced deadline keeps short-lived callers
      // alive until its physical exit, and also bounds shutdown if it is wedged.
      const timer = setTimeout(resolve, LIMIT.TIMEOUT_MS);
      void worker.terminate().catch(() => undefined).then(() => { clearTimeout(timer); resolve(); });
    });
  }

  close(): void {
    const worker = this.worker;
    this.worker = undefined;
    worker?.forceKill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.finish(undefined);
    }
    this.pending.clear();
  }
}

export function runAgyHistoryWorker(): void {
  const { port } = resolveWorkerRuntime();
  port.on('message', (message: { id: number; request: AgyHistoryRequest }) => {
    port.postMessage({ id: message.id, response: recoverAgyResponseSync(message.request) });
  });
}
