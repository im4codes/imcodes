import {
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
} from './transport/file-transfer.js';
import {
  MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
  MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
} from './machine-direct-file-transfer-capabilities.js';
import { REMOTE_DESKTOP_CAPABILITY } from './remote-desktop.js';
import { CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY } from './controlled-node-service.js';

export const CONTROLLED_NODE_CAPABILITIES = [
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
  MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
  REMOTE_DESKTOP_CAPABILITY,
  CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY,
] as const;

export type ControlledNodeCapability = typeof CONTROLLED_NODE_CAPABILITIES[number];
export const CONTROLLED_NODE_CAPABILITY_MAX_ITEMS = 16;

export function isControlledNodeCapability(value: unknown): value is ControlledNodeCapability {
  return typeof value === 'string'
    && (CONTROLLED_NODE_CAPABILITIES as readonly string[]).includes(value);
}

export type ControlledNodeCapabilitiesValidation =
  | { ok: true; value: ControlledNodeCapability[] }
  | { ok: false };

/** Exact known versions only; absence remains valid for pre-capability nodes. */
export function validateControlledNodeCapabilities(value: unknown): ControlledNodeCapabilitiesValidation {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > CONTROLLED_NODE_CAPABILITY_MAX_ITEMS) return { ok: false };
  if (!value.every(isControlledNodeCapability)) return { ok: false };
  return { ok: true, value: [...new Set(value)] };
}
