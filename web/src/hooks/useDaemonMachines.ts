import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { apiFetch } from '../api.js';
import { isServerOnline, type OnlineServerInfo } from '../server-selection.js';

export interface DaemonMachine extends OnlineServerInfo {
  name: string;
}

/**
 * The signed-in user's daemons (/api/server lists full daemons only), with the
 * online ones and a name lookup -- what a per-machine management panel needs.
 */
export function useDaemonMachines() {
  const [machines, setMachines] = useState<DaemonMachine[]>([]);
  useEffect(() => {
    void apiFetch<{ servers?: DaemonMachine[] }>('/api/server')
      .then((response) => setMachines(Array.isArray(response.servers) ? response.servers : []))
      .catch(() => setMachines([]));
  }, []);
  const onlineMachines = useMemo(() => machines.filter((machine) => isServerOnline(machine)), [machines]);
  const machineName = useCallback(
    (id: string) => machines.find((machine) => machine.id === id)?.name ?? id,
    [machines],
  );
  return { machines, onlineMachines, machineName };
}

/** A set of machine ids to act on, starting with the machine on screen. */
export function useMachineTargets(initial?: string) {
  const [targets, setTargets] = useState<Set<string>>(() => new Set(initial ? [initial] : []));
  useEffect(() => {
    setTargets(new Set(initial ? [initial] : []));
  }, [initial]);
  const toggle = useCallback((id: string) => {
    setTargets((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  return { targets, toggle };
}
