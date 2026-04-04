import { hostname } from 'node:os';

export function getPodIdentity(): string {
  return process.env.HOSTNAME?.trim() || hostname();
}
