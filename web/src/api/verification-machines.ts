import {
  VERIFICATION_MACHINE_API_PATH,
  type VerificationMachineKind,
  type VerificationMachineProfile,
  type VerificationMachineScope,
} from '@shared/verification-machine.js';
import { apiFetch } from '../api.js';

export async function listVerificationMachinesPage(
  projectKey?: string,
  options?: { includeAllProjects?: boolean; cursor?: string; limit?: number },
): Promise<{ profiles: VerificationMachineProfile[]; nextCursor?: string }> {
  const query = new URLSearchParams();
  if (projectKey?.trim()) query.set('projectKey', projectKey.trim());
  if (options?.includeAllProjects) query.set('includeAllProjects', '1');
  if (options?.cursor) query.set('cursor', options.cursor);
  if (options?.limit !== undefined) query.set('limit', String(options.limit));
  const result = await apiFetch<{ profiles: VerificationMachineProfile[]; nextCursor?: string }>(
    `${VERIFICATION_MACHINE_API_PATH}${query.size ? `?${query}` : ''}`,
  );
  return {
    profiles: Array.isArray(result.profiles) ? result.profiles : [],
    ...(typeof result.nextCursor === 'string' && result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function listVerificationMachines(
  projectKey?: string,
  options?: { includeAllProjects?: boolean },
): Promise<VerificationMachineProfile[]> {
  if (!options?.includeAllProjects) {
    const page = await listVerificationMachinesPage(projectKey);
    return page.profiles;
  }
  const all: VerificationMachineProfile[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await listVerificationMachinesPage(projectKey, {
      includeAllProjects: true,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.profiles) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        all.push(item);
      }
    }
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return all;
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
