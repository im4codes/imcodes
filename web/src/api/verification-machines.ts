import {
  VERIFICATION_MACHINE_API_PATH,
  type VerificationMachineKind,
  type VerificationMachineProfile,
  type VerificationMachineScope,
} from '@shared/verification-machine.js';
import { apiFetch } from '../api.js';

export async function listVerificationMachines(projectKey?: string): Promise<VerificationMachineProfile[]> {
  const query = new URLSearchParams();
  if (projectKey?.trim()) query.set('projectKey', projectKey.trim());
  const result = await apiFetch<{ profiles: VerificationMachineProfile[] }>(
    `${VERIFICATION_MACHINE_API_PATH}${query.size ? `?${query}` : ''}`,
  );
  return Array.isArray(result.profiles) ? result.profiles : [];
}

export async function setVerificationMachine(input: {
  id?: string;
  scope: VerificationMachineScope;
  scopeKey: string;
  alias: string;
  kind: VerificationMachineKind;
  target: string;
  enabled?: boolean;
  expectedRevision?: number;
}): Promise<VerificationMachineProfile> {
  const result = await apiFetch<{ profile: VerificationMachineProfile }>(VERIFICATION_MACHINE_API_PATH, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return result.profile;
}

export async function removeVerificationMachine(id: string, expectedRevision?: number): Promise<void> {
  const query = expectedRevision === undefined ? '' : `?expectedRevision=${expectedRevision}`;
  await apiFetch(`${VERIFICATION_MACHINE_API_PATH}/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
}
