/**
 * Numbers only, by construction: subsystems register a probe that reports how much they hold (counts, bytes,
 * depths); the memory guard writes them into its diagnostic. A probe can never leak content, because a value that
 * is not a finite number is dropped, and a probe that throws or hangs cannot stop the guard.
 */
export type MemoryProbe = () => Record<string, number | boolean | undefined>;

const probes = new Map<string, MemoryProbe>();

export function registerMemoryProbe(name: string, probe: MemoryProbe): () => void {
  probes.set(name, probe);
  return () => { if (probes.get(name) === probe) probes.delete(name); };
}

export function collectMemoryProbes(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [name, probe] of probes) {
    try {
      const raw = probe();
      const clean: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
        else if (typeof value === 'boolean') clean[key] = value ? 1 : 0;
      }
      out[name] = clean;
    } catch {
      out[name] = { probeFailed: 1 };
    }
  }
  return out;
}

export function resetMemoryProbesForTests(): void {
  probes.clear();
}
