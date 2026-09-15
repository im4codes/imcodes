import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_INSTALL_STATE,
  isCapabilityInstallCancellable,
  isCapabilityInstallTerminal,
} from '@shared/capability-management.js';
import {
  cancelCapabilityOperation,
  decideCapabilityOperation,
  getCapabilityOperation,
  listCapabilities,
} from '../api/capabilities.js';
import {
  setCapabilityOperationSnapshot,
  setCapabilityOperationSnapshots,
  useCapabilityOperationSnapshot,
} from '../capability-operation-store.js';

const STATUS_POLL_MS = 2_000;
const DISCOVERY_POLL_MS = 4_000;
const STORAGE_PREFIX = 'imcodes_capability_last_operation_v2:';

function storageKey(serverId: string): string {
  return `${STORAGE_PREFIX}${serverId}`;
}

export function useCapabilityOperationController(serverId?: string | null) {
  const operation = useCapabilityOperationSnapshot(serverId);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const timerRef = useRef<number | null>(null);
  const verifiedOperationIdsRef = useRef(new Set<string>());

  const publish = useCallback((next: typeof operation) => {
    setCapabilityOperationSnapshot(serverId, next);
    if (serverId && next?.id) localStorage.setItem(storageKey(serverId), next.id);
  }, [serverId]);

  const discover = useCallback(async () => {
    if (!serverId || !online) return;
    try {
      const response = await listCapabilities(serverId);
      if (response.operations) setCapabilityOperationSnapshots(serverId, response.operations, true);
      const active = response.operations?.find((candidate) => !candidate.terminal && !isCapabilityInstallTerminal(candidate.state));
      if (active) {
        verifiedOperationIdsRef.current.add(active.id);
        publish(active);
        setError(null);
        return;
      }
      if (operation && !verifiedOperationIdsRef.current.has(operation.id)) {
        try {
          const verified = await getCapabilityOperation(operation.id, serverId);
          verifiedOperationIdsRef.current.add(verified.id);
          publish(verified);
        } catch {
          publish(null);
          localStorage.removeItem(storageKey(serverId));
        }
      }
      if (!operation) {
        const savedId = localStorage.getItem(storageKey(serverId));
        if (savedId) {
          try {
            const restored = await getCapabilityOperation(savedId, serverId);
            verifiedOperationIdsRef.current.add(restored.id);
            publish(restored);
          } catch {
            localStorage.removeItem(storageKey(serverId));
          }
        }
      }
      setError(null);
    } catch {
      setError('load');
    }
  }, [online, operation, publish, serverId]);

  const refresh = useCallback(async () => {
    if (!serverId || !operation || !online) return;
    try {
      publish(await getCapabilityOperation(operation.id, serverId));
      verifiedOperationIdsRef.current.add(operation.id);
      setError(null);
    } catch {
      setError('status');
    }
  }, [online, operation, publish, serverId]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    verifiedOperationIdsRef.current.clear();
  }, [serverId]);

  useEffect(() => {
    if (serverId && operation?.id) localStorage.setItem(storageKey(serverId), operation.id);
  }, [operation?.id, serverId]);

  useEffect(() => {
    if (online) void discover();
  }, [online, serverId]);

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (!serverId || !online) return;
    const active = operation && !operation.terminal && !isCapabilityInstallTerminal(operation.state);
    timerRef.current = window.setTimeout(() => {
      if (active) void refresh();
      else void discover();
    }, active ? STATUS_POLL_MS : DISCOVERY_POLL_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [discover, online, operation, refresh, serverId]);

  const install = useCallback(async () => {
    if (!operation || !serverId || !online) return;
    setBusy(true);
    setInstalling(true);
    setError(null);
    try {
      publish(await decideCapabilityOperation(operation, CAPABILITY_CONFIRMATION_DECISION.INSTALL, serverId));
    } catch {
      try { publish(await getCapabilityOperation(operation.id, serverId)); } catch { /* Status polling retains the uncertain irreversible boundary. */ }
      setError('confirmation');
    } finally {
      setInstalling(false);
      setBusy(false);
    }
  }, [online, operation, publish, serverId]);

  const cancel = useCallback(async () => {
    if (!operation || !serverId || !isCapabilityInstallCancellable(operation.state)) return;
    setBusy(true);
    setError(null);
    try {
      publish(await cancelCapabilityOperation(operation, serverId));
    } catch {
      try { publish(await getCapabilityOperation(operation.id, serverId)); } catch { /* Keep the last authoritative server snapshot. */ }
      setError('confirmation');
    } finally {
      setBusy(false);
    }
  }, [operation, publish, serverId]);

  const visibleOperation = operation && installing ? {
    ...operation,
    state: CAPABILITY_INSTALL_STATE.INSTALLING,
    canConfirm: false,
    canCancel: false,
  } : operation;
  return { operation: visibleOperation, busy, error, online, install, cancel, refresh, discover, publish };
}
