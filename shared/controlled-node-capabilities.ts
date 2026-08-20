import {
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
} from './transport/file-transfer.js';
import {
  MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
  MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
} from './machine-direct-file-transfer-capabilities.js';
import { REMOTE_DESKTOP_CAPABILITY } from './remote-desktop.js';
import { CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY } from './controlled-node-service.js';
import { CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY } from './controlled-node-auto-unlock.js';

export const CONTROLLED_NODE_CAPABILITIES = [
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
  MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
  REMOTE_DESKTOP_CAPABILITY,
  CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY,
  CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY,
] as const;

export type ControlledNodeCapability = typeof CONTROLLED_NODE_CAPABILITIES[number];
export const CONTROLLED_NODE_CAPABILITY_MAX_ITEMS = 16;
export const CONTROLLED_NODE_CAPABILITY_MAX_LENGTH = 128;
const CONTROLLED_NODE_CAPABILITY_ADVERTISEMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

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

/**
 * Parses a daemon's forward-compatible capability advertisement. Unknown,
 * well-formed versions are ignored and never become authorization grants;
 * malformed or unbounded advertisements still reject the authentication.
 */
export function parseAdvertisedControlledNodeCapabilities(value: unknown): ControlledNodeCapabilitiesValidation {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > CONTROLLED_NODE_CAPABILITY_MAX_ITEMS) return { ok: false };
  if (!value.every((item) => typeof item === 'string'
    && item.length <= CONTROLLED_NODE_CAPABILITY_MAX_LENGTH
    && CONTROLLED_NODE_CAPABILITY_ADVERTISEMENT_PATTERN.test(item))) {
    return { ok: false };
  }
  return { ok: true, value: [...new Set(value.filter(isControlledNodeCapability))] };
}
