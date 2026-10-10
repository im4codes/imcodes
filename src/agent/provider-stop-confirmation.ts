import type { ChildProcess } from 'node:child_process';
import { TRANSPORT_STOP_QUEUE_TIMEOUT_MS } from '../../shared/transport-queue-types.js';

interface StopProof { confirmed: boolean; listeners: Set<() => void>; isCurrent: () => boolean; mark: () => void }
const stopProofs = new WeakMap<Promise<void>, StopProof>();
const childProofs = new WeakMap<ChildProcess, StopProof>();

/** Called by the adapter's existing captured-child lifecycle listener. */
export function confirmCapturedChildExit(child: ChildProcess): void { childProofs.get(child)?.mark(); }
export function bindCapturedChildStop(child: ChildProcess, operation: Promise<void>): void {
  const proof = stopProofs.get(operation);
  if (proof) childProofs.set(child, proof);
}
export function preserveProviderStopProof(operation: Promise<void>, wrapped: Promise<void>): Promise<void> {
  const proof = stopProofs.get(operation);
  if (proof) stopProofs.set(wrapped, proof);
  return wrapped;
}
export function providerStopTerminal(operation: Promise<void>): Promise<void> {
  return new Promise((resolve) => onConfirmedProviderStop(operation, resolve));
}

/** Late physical proof is distinct from the expired outward operation. */
export function onConfirmedProviderStop(operation: Promise<void>, callback: () => void): () => void {
  const proof = stopProofs.get(operation);
  if (!proof) return () => {};
  if (proof.confirmed) { callback(); return () => {}; }
  proof.listeners.add(callback);
  return () => proof.listeners.delete(callback);
}

/** Only call complete at a physical/provider terminal boundary, never a local
 * watchdog or an interrupt request ACK. Targets are captured instance objects. */
export class ProviderStopConfirmation {
  private readonly terminals = new Map<object, () => void>();
  private readonly operations = new Map<object, Promise<void>>();
  private readonly proofs = new WeakMap<object, StopProof>();

  complete(target: object): void {
    const proof = this.proofs.get(target);
    if (proof?.isCurrent()) {
      proof.confirmed = true;
      for (const callback of proof.listeners) {
        // One observer must not prevent terminal settlement or other observers.
        try { callback(); } catch { /* physical proof remains authoritative */ }
      }
      proof.listeners.clear();
    }
    this.terminals.get(target)?.();
  }

  confirm(target: object, request: () => Promise<void>, isCurrent: () => boolean): Promise<void> {
    const existing = this.operations.get(target);
    if (existing) return existing;
    const proof: StopProof = { confirmed: false, listeners: new Set(), isCurrent, mark: () => this.complete(target) };
    this.proofs.set(target, proof);
    let timer: ReturnType<typeof setTimeout>;
    const terminal = new Promise<void>((resolve, reject) => {
      this.terminals.set(target, resolve);
      timer = setTimeout(() => reject(new Error('Provider stop terminal confirmation timed out')), TRANSPORT_STOP_QUEUE_TIMEOUT_MS);
    });
    const operation = Promise.all([terminal, Promise.resolve().then(request)]).then(() => {
      if (!isCurrent()) throw new Error('Provider instance changed during stop confirmation');
    }).finally(() => {
      clearTimeout(timer);
      this.terminals.delete(target);
      this.operations.delete(target);
    });
    this.operations.set(target, operation);
    stopProofs.set(operation, proof);
    return operation;
  }
}

/** A successful kill() call is not proof; require the captured child exit. */
export function confirmChildStop(child: ChildProcess, request: () => Promise<void>, isCurrent: () => boolean): Promise<void> {
  const confirmation = new ProviderStopConfirmation();
  const onExit = () => confirmation.complete(child);
  child.once('exit', onExit);
  child.once('close', onExit);
  const operation = confirmation.confirm(child, async () => {
    await request();
    if (child.exitCode != null || child.signalCode != null) confirmation.complete(child);
  }, isCurrent);
  bindCapturedChildStop(child, operation);
  return preserveProviderStopProof(operation, operation.finally(() => { child.removeListener('exit', onExit); child.removeListener('close', onExit); }));
}

/** Captured long-lived SDK prompt/iterator completion, not its send-start ACK. */
export function confirmPromiseStop(target: object, terminal: Promise<unknown>, request: () => Promise<void>, isCurrent: () => boolean): Promise<void> {
  const confirmation = new ProviderStopConfirmation();
  const operation = confirmation.confirm(target, request, isCurrent);
  void terminal.then(() => confirmation.complete(target)).catch(() => {});
  return operation;
}
