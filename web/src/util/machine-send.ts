/**
 * Compose-time machine-resolution attach for the send path, mirroring
 * `alias-send.ts`. Produces the out-of-band `resolvedMachines` map (marker
 * ref_name → target serverId) that rides as a top-level field of the `send`
 * command payload, alongside `resolvedAliases`.
 *
 * Unlike aliases (a secret value expanded out of band), the `^^(name)` marker
 * stays LITERAL/visible in the delivered text so the agent sees the referenced
 * machine; only the resolution hint travels out of band, and the server
 * re-validates each serverId against the owner's machines.
 */
import { buildResolvedMachines, type MachineRef, type SendMachineResolution } from '@shared/machine-reference.js';

export interface MachineSendExtra {
  resolvedMachines?: SendMachineResolution;
  [k: string]: unknown;
}

/**
 * Build the `resolvedMachines` send-extra for `bodyText` against `machineList`.
 * Returns a spread-safe empty object when the body has no resolvable markers so
 * the field is omitted from the payload entirely (parity with `buildAliasSendExtra`).
 */
export function buildMachineSendExtra(bodyText: string, machineList: readonly MachineRef[]): MachineSendExtra {
  const { resolvedMachines } = buildResolvedMachines(bodyText, machineList);
  if (Object.keys(resolvedMachines).length === 0) return {};
  return { resolvedMachines };
}
